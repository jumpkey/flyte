"""Prevent false-positive load reports when transport and business state differ."""
import aiohttp
import unittest
from stress_test import (
    _classify_phase1, _classify_phase3, confirm_simulator_payment_intent,
)
from stripe_simulator import _error


class FakeResponse:
    def __init__(self, status, body=""):
        self.status = status
        self.body = body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def text(self):
        return self.body

    async def read(self):
        return self.body.encode()


class FakeRequest:
    def __init__(self, outcome):
        self.outcome = outcome

    async def __aenter__(self):
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        return await self.outcome.__aenter__()

    async def __aexit__(self, *args):
        return False


class FakeSession:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return FakeRequest(self.outcomes.pop(0))

class OutcomeTests(unittest.TestCase):
    def test_confirmation_requires_confirmed_state(self):
        self.assertEqual(_classify_phase3(200,'',{'status':'CONFIRMED'}),'SUCCESS')
        self.assertEqual(_classify_phase3(200,'',{'status':'PENDING_CAPTURE'}),'PENDING')
        self.assertEqual(_classify_phase3(200,'',{'status':'PAYMENT_FAILED'}),'PAYMENT_FAILED')
        self.assertEqual(_classify_phase3(200,'',{}),'UNVERIFIED')
    def test_redirect_is_not_proof_of_payment(self):
        self.assertEqual(_classify_phase3(302,'/registration/id/confirmed',{}),'UNVERIFIED_REDIRECT')
    def test_capacity_rejection_is_distinct_from_server_failure(self):
        self.assertEqual(_classify_phase1(409,{'error':'event_full'}),'FULL')
        self.assertEqual(_classify_phase1(409,{'error':'event_closed'}),'EVENT_CLOSED')
        self.assertEqual(_classify_phase1(500,{}),'ERROR')
    def test_simulator_declines_use_payment_required_status(self):
        self.assertEqual(_error('card_declined','Simulated decline').status_code,402)


class SimulatorConfirmRetryTests(unittest.IsolatedAsyncioTestCase):
    async def test_connection_error_then_success_retries_with_auth(self):
        session = FakeSession([
            aiohttp.ServerDisconnectedError("proxy dropped connection"),
            FakeResponse(200),
        ])
        status, error, retries, latency = await confirm_simulator_payment_intent(
            session, "https://simulator.example", "pi_test", aiohttp.ClientTimeout(total=1), "dummyBearer"
        )
        self.assertEqual(status, 200)
        self.assertIsNone(error)
        self.assertEqual(len(retries), 1)
        self.assertEqual(retries[0].status_code, 0)
        self.assertGreaterEqual(latency, 0)
        self.assertEqual(len(session.calls), 2)
        self.assertEqual(session.calls[0][1]["headers"], {"Authorization": "Bearer dummyBearer"})

    async def test_exhausted_transport_failures_are_reported(self):
        session = FakeSession([aiohttp.ServerDisconnectedError("proxy dropped") for _ in range(4)])
        status, error, retries, _ = await confirm_simulator_payment_intent(
            session, "https://simulator.example", "pi_exhausted", aiohttp.ClientTimeout(total=1), "key"
        )
        self.assertEqual(status, 0)
        self.assertIn("ServerDisconnectedError", error)
        self.assertEqual(len(retries), 3)
        self.assertEqual(len(session.calls), 4)

    async def test_http_429_and_5xx_are_retried(self):
        session = FakeSession([FakeResponse(429, "limited"), FakeResponse(503, "busy"), FakeResponse(201)])
        status, error, retries, _ = await confirm_simulator_payment_intent(
            session, "https://simulator.example", "pi_retry", aiohttp.ClientTimeout(total=1), None
        )
        self.assertEqual(status, 201)
        self.assertIsNone(error)
        self.assertEqual([retry.status_code for retry in retries], [429, 503])

if __name__=='__main__': unittest.main()
