"""Small, single-process Stripe API simulator for bounded load tests.

State and idempotency records live in memory and reset when the process restarts.
Run one worker (see Dockerfile.simulator); this intentionally does not provide
durable payment state or multi-machine coordination.
"""

import asyncio
import hmac
import json
import math
import os
import random
import socket
import time
from copy import deepcopy
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, Path, Request
from fastapi.responses import JSONResponse

app = FastAPI(title="Stripe Simulator", version="2.0.0")
_INTENTS: dict[str, dict[str, Any]] = {}
_IDEMPOTENCY: dict[tuple[str, str], dict[str, Any]] = {}
_LOCK = asyncio.Lock()
_SMTP_MESSAGES = 0
_SMTP_SERVER = None


def _dual_stack_listener(port: int) -> socket.socket:
    """Bind one IPv6 socket that also accepts IPv4-mapped connections."""
    listener = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    try:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        listener.bind(("::", port))
        listener.listen(socket.SOMAXCONN)
        listener.setblocking(False)
        return listener
    except BaseException:
        listener.close()
        raise

_CONFIG_NAMES = (
    "STRIPE_SIM_CREATE_DELAY_MS", "STRIPE_SIM_CAPTURE_DELAY_MS",
    "STRIPE_SIM_CREATE_JITTER_MS", "STRIPE_SIM_CAPTURE_JITTER_MS",
    "STRIPE_SIM_CREATE_TAIL_RATE", "STRIPE_SIM_CREATE_TAIL_DELAY_MS",
    "STRIPE_SIM_CAPTURE_TAIL_RATE", "STRIPE_SIM_CAPTURE_TAIL_DELAY_MS",
    "STRIPE_SIM_CAPTURE_FAIL_RATE", "STRIPE_SIM_CAPTURE_TRANSIENT_RATE",
    "STRIPE_SIM_CAPTURE_RATE_LIMIT_RATE", "STRIPE_SIM_CAPTURE_POST_COMMIT_FAIL_RATE",
    "STRIPE_SIM_SEED",
)


def _number(name: str, default: float = 0.0) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _valid_rate(value: Any) -> bool:
    try:
        number = float(value)
        return math.isfinite(number) and 0 <= number <= 1
    except (TypeError, ValueError):
        return False


def _seed_rng() -> None:
    seed = os.environ.get("STRIPE_SIM_SEED")
    if seed is not None:
        random.seed(seed)


_seed_rng()


async def _delay(operation: str) -> None:
    fixed = max(0.0, _number(f"STRIPE_SIM_{operation}_DELAY_MS"))
    jitter = max(0.0, _number(f"STRIPE_SIM_{operation}_JITTER_MS"))
    tail_rate = min(1.0, max(0.0, _number(f"STRIPE_SIM_{operation}_TAIL_RATE")))
    tail_delay = max(0.0, _number(f"STRIPE_SIM_{operation}_TAIL_DELAY_MS"))
    ms = fixed + (random.uniform(0.0, jitter) if jitter else 0.0)
    if tail_delay and random.random() < tail_rate:
        ms += tail_delay
    if ms:
        await asyncio.sleep(ms / 1000)


def _error(code: str, message: str, status: int = 402, kind: str = "card_error") -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {
        "type": kind, "code": code, "message": message, "param": None,
        "decline_code": "generic_decline" if status == 402 else None,
    }})


def _invalid(message: str, status: int = 400) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {
        "type": "invalid_request_error", "message": message,
    }})


async def _body(request: Request) -> dict[str, Any]:
    if "application/json" in request.headers.get("content-type", ""):
        value = await request.json()
        return value if isinstance(value, dict) else {}
    form = await request.form()
    return dict(form)


def _idempotent_replay(operation: str, request: Request, body: dict[str, Any]):
    key = request.headers.get("Idempotency-Key")
    if not key:
        return None, None
    fingerprint = json.dumps(body, sort_keys=True, default=str, separators=(",", ":"))
    saved = _IDEMPOTENCY.get((operation, key))
    if saved is None:
        return None, fingerprint
    if saved["fingerprint"] != fingerprint:
        return JSONResponse(status_code=409, content={"error": {
            "type": "idempotency_error", "message": "Idempotency-Key reused with a different request body",
        }}), None
    return JSONResponse(status_code=saved["status"], content=deepcopy(saved["body"])), None


def _save_idempotency(operation: str, key: str | None, fingerprint: str | None,
                      response: JSONResponse) -> JSONResponse:
    if key and fingerprint:
        payload = json.loads(response.body)
        _IDEMPOTENCY[(operation, key)] = {
            "fingerprint": fingerprint, "status": response.status_code, "body": payload,
        }
    return response


def _pi_id() -> str:
    return f"pi_sim_{uuid4().hex[:20]}"


@app.middleware("http")
async def require_api_key(request: Request, call_next):
    denied = _authorization_error(request)
    if denied is not None:
        return denied
    return await call_next(request)


def _authorization_error(request: Request) -> JSONResponse | None:
    expected = os.environ.get("STRIPE_SIM_API_KEY")
    if os.environ.get("FLY_APP_NAME") and not expected and request.url.path != "/health":
        return JSONResponse(status_code=503, content={"error": {
            "type": "api_error", "message": "STRIPE_SIM_API_KEY must be configured on Fly",
        }})
    if expected and request.url.path != "/health":
        supplied = request.headers.get("authorization", "")
        if not hmac.compare_digest(supplied, f"Bearer {expected}"):
            return JSONResponse(status_code=401, content={"error": {
                "type": "authentication_error", "message": "Invalid or missing API key",
            }}, headers={"WWW-Authenticate": "Bearer"})
    return None


async def _smtp_discard(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    """Tiny SMTP sink for test mail: accept DATA and discard it."""
    global _SMTP_MESSAGES
    writer.write(b"220 stripe-simulator ESMTP ready\r\n")
    await writer.drain()
    in_data = False
    try:
        while line := await reader.readline():
            command = line.decode("utf-8", "replace").strip()
            upper = command.upper()
            if in_data:
                if command == ".":
                    _SMTP_MESSAGES += 1
                    writer.write(b"250 message accepted\r\n")
                    in_data = False
                continue
            if upper.startswith("EHLO"):
                writer.write(b"250-stripe-simulator\r\n250 8BITMIME\r\n")
            elif upper.startswith(("HELO", "MAIL FROM:", "RCPT TO:", "RSET")):
                writer.write(b"250 OK\r\n")
            elif upper == "DATA":
                in_data = True
                writer.write(b"354 end with <CRLF>.<CRLF>\r\n")
            elif upper == "QUIT":
                writer.write(b"221 bye\r\n")
                await writer.drain()
                break
            else:
                writer.write(b"250 OK\r\n")
            await writer.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except ConnectionError:
            pass


@app.on_event("startup")
async def start_smtp_sink() -> None:
    global _SMTP_SERVER
    enabled = os.environ.get("STRIPE_SIM_SMTP_ENABLED", "0").lower() in {"1", "true", "yes"}
    if enabled:
        port = int(os.environ.get("STRIPE_SIM_SMTP_PORT", "1025"))
        listener = _dual_stack_listener(port)
        _SMTP_SERVER = await asyncio.start_server(_smtp_discard, sock=listener)


@app.on_event("shutdown")
async def stop_smtp_sink() -> None:
    global _SMTP_SERVER
    if _SMTP_SERVER is not None:
        _SMTP_SERVER.close()
        await _SMTP_SERVER.wait_closed()
        _SMTP_SERVER = None


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "stripe-simulator"}


@app.post("/v1/payment_intents")
async def create_payment_intent(request: Request) -> JSONResponse:
    body = await _body(request)
    await _delay("CREATE")
    try:
        amount = int(body.get("amount", 0))
    except (TypeError, ValueError):
        return _invalid("amount must be an integer")
    if amount <= 0:
        return _invalid("amount must be greater than zero")
    currency = str(body.get("currency", "usd"))
    capture_method = str(body.get("capture_method", "automatic"))
    metadata = {k[9:-1]: str(v) for k, v in body.items()
                if k.startswith("metadata[") and k.endswith("]")}
    async with _LOCK:
        replay, fingerprint = _idempotent_replay("create", request, body)
        if replay is not None:
            return replay
        pi_id = _pi_id()
        intent = {
            "id": pi_id, "object": "payment_intent", "amount": amount,
            "currency": currency, "capture_method": capture_method,
            "status": "requires_payment_method", "client_secret": f"{pi_id}_secret_{uuid4().hex[:16]}",
            "metadata": metadata, "latest_charge": None, "amount_received": 0,
            "amount_refunded": 0, "created": int(time.time()), "livemode": False,
        }
        _INTENTS[pi_id] = intent
        result = JSONResponse(content=deepcopy(intent))
        return _save_idempotency("create", request.headers.get("Idempotency-Key"), fingerprint, result)


@app.get("/v1/payment_intents/{pi_id}")
async def retrieve_payment_intent(pi_id: str = Path(...)) -> JSONResponse:
    async with _LOCK:
        intent = _INTENTS.get(pi_id)
        if not intent:
            return _invalid(f"No such PaymentIntent: {pi_id}", 404)
        return JSONResponse(content=deepcopy(intent))


@app.post("/v1/payment_intents/{pi_id}/confirm")
async def confirm_payment_intent(pi_id: str = Path(...)) -> JSONResponse:
    async with _LOCK:
        intent = _INTENTS.get(pi_id)
        if not intent:
            return _invalid(f"No such PaymentIntent: {pi_id}", 404)
        if intent["status"] == "requires_payment_method":
            intent["status"] = "requires_capture" if intent["capture_method"] == "manual" else "succeeded"
        return JSONResponse(content={"paymentIntent": deepcopy(intent)})


@app.post("/v1/payment_intents/{pi_id}/capture")
async def capture_payment_intent(request: Request, pi_id: str = Path(...)) -> JSONResponse:
    body = await _body(request)
    await _delay("CAPTURE")
    async with _LOCK:
        operation = f"capture:{pi_id}"
        replay, fingerprint = _idempotent_replay(operation, request, body)
        if replay is not None:
            return replay
        intent = _INTENTS.get(pi_id)
        if not intent:
            return _invalid(f"No such PaymentIntent: {pi_id}", 404)
        if intent["status"] == "succeeded":
            result = JSONResponse(content=deepcopy(intent))
            return _save_idempotency(operation, request.headers.get("Idempotency-Key"), fingerprint, result)
        if intent["status"] != "requires_capture":
            return _invalid(f"PaymentIntent cannot be captured in status {intent['status']}")
        if random.random() < min(1.0, max(0.0, _number("STRIPE_SIM_CAPTURE_FAIL_RATE"))):
            result = _error("card_declined", "Your card was declined (simulated permanent failure)")
            return _save_idempotency(operation, request.headers.get("Idempotency-Key"), fingerprint, result)
        if random.random() < min(1.0, max(0.0, _number("STRIPE_SIM_CAPTURE_TRANSIENT_RATE"))):
            return _error("api_error", "Connection error (simulated transient failure)", 500, "api_error")
        if random.random() < min(1.0, max(0.0, _number("STRIPE_SIM_CAPTURE_RATE_LIMIT_RATE"))):
            return _error("rate_limit", "Rate limit exceeded (simulated)", 429, "rate_limit_error")
        charge_id = f"ch_sim_{uuid4().hex[:16]}"
        amount = int(body.get("amount_to_capture", intent["amount"]))
        if amount <= 0 or amount > intent["amount"]:
            return _invalid("amount_to_capture must be positive and no greater than the authorized amount")
        intent["status"] = "succeeded"
        intent["amount_received"] = amount
        intent["latest_charge"] = {"id": charge_id, "amount_captured": amount, "object": "charge"}
        result = JSONResponse(content=deepcopy(intent))
        response = _save_idempotency(operation, request.headers.get("Idempotency-Key"), fingerprint, result)
        if random.random() < min(1.0, max(0.0, _number("STRIPE_SIM_CAPTURE_POST_COMMIT_FAIL_RATE"))):
            return _error("api_error", "Connection error after simulated capture commit", 500, "api_error")
        return response


@app.post("/v1/payment_intents/{pi_id}/cancel")
async def cancel_payment_intent(pi_id: str = Path(...)) -> JSONResponse:
    async with _LOCK:
        intent = _INTENTS.get(pi_id)
        if not intent:
            return _invalid(f"No such PaymentIntent: {pi_id}", 404)
        if intent["status"] == "succeeded":
            return _invalid("A succeeded PaymentIntent cannot be canceled")
        if intent["status"] != "canceled":
            intent["status"] = "canceled"
        return JSONResponse(content=deepcopy(intent))


@app.post("/v1/refunds")
async def create_refund(request: Request) -> JSONResponse:
    body = await _body(request)
    pi_id = str(body.get("payment_intent", ""))
    async with _LOCK:
        replay, fingerprint = _idempotent_replay("refund", request, body)
        if replay is not None:
            return replay
        intent = _INTENTS.get(pi_id)
        if not intent:
            return _invalid(f"No such PaymentIntent: {pi_id}", 404)
        if intent["status"] != "succeeded":
            return _invalid("PaymentIntent must be succeeded before it can be refunded")
        try:
            amount = int(body.get("amount", intent["amount_received"] - intent["amount_refunded"]))
        except (TypeError, ValueError):
            return _invalid("amount must be an integer")
        remaining = intent["amount_received"] - intent["amount_refunded"]
        if amount <= 0 or amount > remaining:
            return _invalid("refund amount must be positive and no greater than the remaining captured amount")
        intent["amount_refunded"] += amount
        refund = {"id": f"re_sim_{uuid4().hex[:16]}", "object": "refund", "amount": amount,
                  "payment_intent": pi_id, "status": "succeeded", "created": int(time.time())}
        result = JSONResponse(content=refund)
        return _save_idempotency("refund", request.headers.get("Idempotency-Key"), fingerprint, result)


@app.delete("/v1/payment_intents")
async def clear_all() -> dict[str, int]:
    async with _LOCK:
        count = len(_INTENTS)
        _INTENTS.clear()
        _IDEMPOTENCY.clear()
        return {"cleared": count}


@app.api_route("/{path:path}", methods=["GET", "POST", "DELETE", "PATCH", "PUT"])
async def not_implemented(path: str, request: Request) -> JSONResponse:
    return JSONResponse(status_code=501, content={"error": {
        "type": "api_error", "message": f"stripe_simulator: route not implemented: {request.method} /{path}",
    }})
