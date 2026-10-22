"""Focused HTTP-level regression tests for the simulator's payment semantics."""

import asyncio
import os
import unittest
from unittest.mock import patch

import httpx
import uvicorn

import simulator_instrumented as instrumented
import stripe_simulator as sim


class SimulatorHTTPTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.env = patch.dict(os.environ, {"STRIPE_SIM_API_KEY": "dummykey"}, clear=False)
        self.env.start()
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=instrumented.app), base_url="http://test"
        )
        self.auth = {"Authorization": "Bearer dummykey"}
        await self.client.delete("/v1/payment_intents", headers=self.auth)
        await self.client.post("/__load__/config", headers=self.auth, json={
            "STRIPE_SIM_CREATE_DELAY_MS": 0, "STRIPE_SIM_CAPTURE_DELAY_MS": 0,
            "STRIPE_SIM_CREATE_JITTER_MS": 0, "STRIPE_SIM_CAPTURE_JITTER_MS": 0,
            "STRIPE_SIM_CREATE_TAIL_RATE": 0, "STRIPE_SIM_CREATE_TAIL_DELAY_MS": 0,
            "STRIPE_SIM_CAPTURE_TAIL_RATE": 0, "STRIPE_SIM_CAPTURE_TAIL_DELAY_MS": 0,
            "STRIPE_SIM_CAPTURE_FAIL_RATE": 0, "STRIPE_SIM_CAPTURE_TRANSIENT_RATE": 0,
            "STRIPE_SIM_CAPTURE_RATE_LIMIT_RATE": 0,
            "STRIPE_SIM_CAPTURE_POST_COMMIT_FAIL_RATE": 0,
        })

    async def asyncTearDown(self):
        await self.client.aclose()
        self.env.stop()

    async def make_intent(self, amount=1000):
        response = await self.client.post("/v1/payment_intents", headers=self.auth, data={
            "amount": amount, "currency": "usd", "capture_method": "manual",
        })
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def capture(self, pi_id, key=None):
        headers = dict(self.auth)
        if key:
            headers["Idempotency-Key"] = key
        return await self.client.post(f"/v1/payment_intents/{pi_id}/capture", headers=headers)

    async def test_auth_exempts_only_health_and_sdk_bearer_works(self):
        self.assertEqual((await self.client.get("/health")).status_code, 200)
        self.assertEqual((await self.client.get("/__load__/state")).status_code, 401)
        self.assertEqual((await self.client.get("/v1/payment_intents/pi_missing", headers=self.auth)).status_code, 404)

    async def test_create_idempotency_and_body_conflict(self):
        headers = {**self.auth, "Idempotency-Key": "create-1"}
        payload = {"amount": 1000, "currency": "usd", "capture_method": "manual"}
        first = await self.client.post("/v1/payment_intents", headers=headers, data=payload)
        second = await self.client.post("/v1/payment_intents", headers=headers, data=payload)
        self.assertEqual(first.json(), second.json())
        conflict = await self.client.post("/v1/payment_intents", headers=headers, data={**payload, "amount": 1100})
        self.assertEqual(conflict.status_code, 409)

    async def test_capture_is_once_only_and_post_commit_error_is_safe_to_retry(self):
        pi = await self.make_intent()
        await self.client.post(f"/v1/payment_intents/{pi['id']}/confirm", headers=self.auth)
        await self.client.post("/__load__/config", headers=self.auth, json={
            "STRIPE_SIM_CAPTURE_POST_COMMIT_FAIL_RATE": 1,
        })
        failed = await self.capture(pi["id"], "capture-1")
        self.assertEqual(failed.status_code, 500)
        first_state = (await self.client.get(f"/v1/payment_intents/{pi['id']}", headers=self.auth)).json()
        self.assertEqual(first_state["status"], "succeeded")
        self.assertEqual(first_state["amount_received"], 1000)
        await self.client.post("/__load__/config", headers=self.auth, json={
            "STRIPE_SIM_CAPTURE_POST_COMMIT_FAIL_RATE": 0,
        })
        retry = await self.capture(pi["id"], "capture-1")
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(retry.json()["latest_charge"], first_state["latest_charge"])
        repeat_without_key = await self.capture(pi["id"])
        self.assertEqual(repeat_without_key.json()["latest_charge"], first_state["latest_charge"])
        cancel = await self.client.post(f"/v1/payment_intents/{pi['id']}/cancel", headers=self.auth)
        self.assertEqual(cancel.status_code, 400)

    async def test_concurrent_captures_commit_one_charge(self):
        pi = await self.make_intent()
        await self.client.post(f"/v1/payment_intents/{pi['id']}/confirm", headers=self.auth)
        headers_a = {**self.auth, "Idempotency-Key": "parallel-a"}
        headers_b = {**self.auth, "Idempotency-Key": "parallel-b"}
        responses = await asyncio.gather(
            self.client.post(f"/v1/payment_intents/{pi['id']}/capture", headers=headers_a),
            self.client.post(f"/v1/payment_intents/{pi['id']}/capture", headers=headers_b),
        )
        self.assertEqual([response.status_code for response in responses], [200, 200])
        self.assertEqual(responses[0].json()["latest_charge"], responses[1].json()["latest_charge"])

    async def test_permanent_transient_and_rate_limit_capture_errors(self):
        for variable, expected in (
            ("STRIPE_SIM_CAPTURE_FAIL_RATE", 402),
            ("STRIPE_SIM_CAPTURE_TRANSIENT_RATE", 500),
            ("STRIPE_SIM_CAPTURE_RATE_LIMIT_RATE", 429),
        ):
            pi = await self.make_intent()
            await self.client.post(f"/v1/payment_intents/{pi['id']}/confirm", headers=self.auth)
            await self.client.post("/__load__/config", headers=self.auth, json={variable: 1})
            response = await self.capture(pi["id"])
            self.assertEqual(response.status_code, expected)
            await self.client.post("/__load__/config", headers=self.auth, json={variable: 0})

    async def test_preexecution_transient_is_not_cached_for_same_key(self):
        pi = await self.make_intent()
        await self.client.post(f"/v1/payment_intents/{pi['id']}/confirm", headers=self.auth)
        headers = {**self.auth, "Idempotency-Key": "retryable-transient"}
        await self.client.post("/__load__/config", headers=self.auth, json={
            "STRIPE_SIM_CAPTURE_TRANSIENT_RATE": 1,
        })
        first = await self.client.post(f"/v1/payment_intents/{pi['id']}/capture", headers=headers)
        self.assertEqual(first.status_code, 500)
        await self.client.post("/__load__/config", headers=self.auth, json={
            "STRIPE_SIM_CAPTURE_TRANSIENT_RATE": 0,
        })
        retry = await self.client.post(f"/v1/payment_intents/{pi['id']}/capture", headers=headers)
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(retry.json()["status"], "succeeded")

    async def test_config_validation_is_finite_and_atomic(self):
        before = os.environ["STRIPE_SIM_CREATE_DELAY_MS"]
        response = await self.client.post("/__load__/config", headers=self.auth, json={
            "STRIPE_SIM_CREATE_DELAY_MS": 25,
            "STRIPE_SIM_CAPTURE_JITTER_MS": -1,
        })
        self.assertEqual(response.status_code, 400)
        self.assertEqual(os.environ["STRIPE_SIM_CREATE_DELAY_MS"], before)
        response = await self.client.post("/__load__/config", content=(
            b'{"STRIPE_SIM_CREATE_DELAY_MS": NaN}'
        ), headers={**self.auth, "Content-Type": "application/json"})
        self.assertEqual(response.status_code, 400)

    async def test_actual_dual_stack_http_and_smtp_sockets(self):
        previous_smtp_enabled = os.environ.get("STRIPE_SIM_SMTP_ENABLED")
        previous_smtp_port = os.environ.get("STRIPE_SIM_SMTP_PORT")
        os.environ["STRIPE_SIM_SMTP_ENABLED"] = "1"
        os.environ["STRIPE_SIM_SMTP_PORT"] = "0"
        listener = sim._dual_stack_listener(0)
        config = uvicorn.Config(instrumented.app, log_level="critical")
        server = uvicorn.Server(config)
        server_task = asyncio.create_task(server.serve(sockets=[listener]))
        try:
            for _ in range(200):
                if server.started and sim._SMTP_SERVER is not None:
                    break
                await asyncio.sleep(0.01)
            self.assertTrue(server.started)
            http_port = listener.getsockname()[1]
            smtp_port = sim._SMTP_SERVER.sockets[0].getsockname()[1]

            async def http_status(host):
                reader, writer = await asyncio.open_connection(host, http_port)
                writer.write(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                await writer.drain()
                status = await reader.readline()
                writer.close()
                await writer.wait_closed()
                return status

            async def smtp_roundtrip(host):
                reader, writer = await asyncio.open_connection(host, smtp_port)
                self.assertTrue((await reader.readline()).startswith(b"220 "))
                writer.write(b"EHLO localhost\r\n")
                await writer.drain()
                while (line := await reader.readline()).startswith(b"250-"):
                    pass
                self.assertTrue(line.startswith(b"250 "))
                for command in (b"MAIL FROM:<test@example.test>\r\n", b"RCPT TO:<sink@example.test>\r\n"):
                    writer.write(command)
                    await writer.drain()
                    self.assertTrue((await reader.readline()).startswith(b"250 "))
                writer.write(b"DATA\r\n")
                await writer.drain()
                self.assertTrue((await reader.readline()).startswith(b"354 "))
                writer.write(b"Subject: smoke\r\n\r\nbody\r\n.\r\n")
                await writer.drain()
                self.assertTrue((await reader.readline()).startswith(b"250 "))
                writer.write(b"QUIT\r\n")
                await writer.drain()
                self.assertTrue((await reader.readline()).startswith(b"221 "))
                writer.close()
                await writer.wait_closed()

            self.assertTrue((await http_status("127.0.0.1")).startswith(b"HTTP/1.1 200"))
            self.assertTrue((await http_status("::1")).startswith(b"HTTP/1.1 200"))
            await smtp_roundtrip("127.0.0.1")
            await smtp_roundtrip("::1")
            self.assertEqual(sim._SMTP_MESSAGES, 2)
        finally:
            server.should_exit = True
            await server_task
            if previous_smtp_enabled is None:
                os.environ.pop("STRIPE_SIM_SMTP_ENABLED", None)
            else:
                os.environ["STRIPE_SIM_SMTP_ENABLED"] = previous_smtp_enabled
            if previous_smtp_port is None:
                os.environ.pop("STRIPE_SIM_SMTP_PORT", None)
            else:
                os.environ["STRIPE_SIM_SMTP_PORT"] = previous_smtp_port
    async def test_refunds_validate_accumulate_and_replay_idempotently(self):
        pi = await self.make_intent(1000)
        await self.client.post(f"/v1/payment_intents/{pi['id']}/confirm", headers=self.auth)
        await self.capture(pi["id"])
        headers = {**self.auth, "Idempotency-Key": "refund-1"}
        payload = {"payment_intent": pi["id"], "amount": 300}
        first = await self.client.post("/v1/refunds", headers=headers, data=payload)
        repeated = await self.client.post("/v1/refunds", headers=headers, data=payload)
        self.assertEqual(first.json(), repeated.json())
        self.assertEqual((await self.client.get(f"/v1/payment_intents/{pi['id']}", headers=self.auth)).json()["amount_refunded"], 300)
        second = await self.client.post("/v1/refunds", headers=self.auth, data={"payment_intent": pi["id"]})
        self.assertEqual(second.status_code, 200)
        excessive = await self.client.post("/v1/refunds", headers=self.auth, data={"payment_intent": pi["id"], "amount": 1})
        self.assertEqual(excessive.status_code, 400)


if __name__ == "__main__":
    unittest.main()
