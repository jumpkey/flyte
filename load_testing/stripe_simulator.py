"""
stripe_simulator.py — Minimal Stripe API stub for load/integration testing.

Implements only the endpoints exercised by the Flyte registration flow:

  POST /v1/payment_intents          (create)
  GET  /v1/payment_intents/{id}     (retrieve)
  POST /v1/payment_intents/{id}/capture
  POST /v1/payment_intents/{id}/cancel

Behavior is controlled by environment variables:

  STRIPE_SIM_CAPTURE_DELAY_MS   Artificial delay before returning capture response (default 0)
  STRIPE_SIM_CAPTURE_FAIL_RATE  0.0–1.0 fraction of captures to fail permanently (default 0.0)
  STRIPE_SIM_CAPTURE_TRANSIENT_RATE  0.0–1.0 fraction to fail transiently (default 0.0)
  STRIPE_SIM_CREATE_DELAY_MS    Artificial delay before returning create response (default 0)

Run standalone:
  uvicorn stripe_simulator:app --host 0.0.0.0 --port 12111

Or via docker-compose.load-test.yml (see that file).
"""

import asyncio
import os
import random
import time
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Path, Request, Response
from fastapi.responses import JSONResponse

app = FastAPI(title="Stripe Simulator", version="1.0.0")

# In-memory store of payment intent state.
# Keys: pi_id → dict with status, amount, currency, capture_method, metadata
_INTENTS: dict[str, dict[str, Any]] = {}

# ── Config ────────────────────────────────────────────────────────────────────

def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default

def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


# ── Helpers ───────────────────────────────────────────────────────────────────

def _pi_id() -> str:
    return f"pi_sim_{uuid4().hex[:20]}"

def _re_id() -> str:
    return f"re_sim_{uuid4().hex[:16]}"

def _error(code: str, message: str, http_status: int = 400) -> JSONResponse:
    return JSONResponse(
        status_code=http_status,
        content={
            "error": {
                "type": "card_error",
                "code": code,
                "message": message,
                "param": None,
                "decline_code": "generic_decline",
            }
        },
    )


def _api_error(message: str) -> JSONResponse:
    return JSONResponse(
        status_code=500,
        content={
            "error": {
                "type": "api_error",
                "message": message,
            }
        },
    )


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "stripe-simulator"}


@app.post("/v1/payment_intents")
async def create_payment_intent(request: Request) -> JSONResponse:
    delay_ms = _env_int("STRIPE_SIM_CREATE_DELAY_MS", 0)
    if delay_ms > 0:
        await asyncio.sleep(delay_ms / 1000)

    # Parse form-encoded or JSON body (Stripe SDK sends form-encoded)
    content_type = request.headers.get("content-type", "")
    if "application/json" in content_type:
        body = await request.json()
    else:
        form = await request.form()
        body = dict(form)

    amount = int(body.get("amount", 0))
    currency = str(body.get("currency", "usd"))
    capture_method = str(body.get("capture_method", "automatic"))
    metadata: dict[str, str] = {}
    # Stripe SDK sends metadata as metadata[key]=value in form encoding
    for k, v in body.items():
        if k.startswith("metadata[") and k.endswith("]"):
            meta_key = k[9:-1]
            metadata[meta_key] = str(v)

    pi_id = _pi_id()
    intent: dict[str, Any] = {
        "id": pi_id,
        "object": "payment_intent",
        "amount": amount,
        "currency": currency,
        "capture_method": capture_method,
        "status": "requires_payment_method",
        "client_secret": f"{pi_id}_secret_{uuid4().hex[:16]}",
        "metadata": metadata,
        "latest_charge": None,
        "amount_received": 0,
        "created": int(time.time()),
        "livemode": False,
    }
    _INTENTS[pi_id] = intent

    return JSONResponse(content=intent)


@app.get("/v1/payment_intents/{pi_id}")
async def retrieve_payment_intent(pi_id: str = Path(...)) -> JSONResponse:
    intent = _INTENTS.get(pi_id)
    if not intent:
        return JSONResponse(
            status_code=404,
            content={"error": {"type": "invalid_request_error", "message": f"No such PaymentIntent: {pi_id}"}},
        )
    return JSONResponse(content=intent)


@app.post("/v1/payment_intents/{pi_id}/confirm")
async def confirm_payment_intent(pi_id: str = Path(...)) -> JSONResponse:
    """
    Simulates what the Stripe.js browser SDK does when the user submits their card.
    In a real Stripe integration the browser calls stripe.confirmPayment() which
    transitions the PI from requires_payment_method → requires_capture (for
    capture_method=manual).  The load tester calls this endpoint directly to
    skip the browser step.
    """
    intent = _INTENTS.get(pi_id)
    if not intent:
        return JSONResponse(
            status_code=404,
            content={"error": {"type": "invalid_request_error", "message": f"No such PaymentIntent: {pi_id}"}},
        )
    intent["status"] = "requires_capture"
    return JSONResponse(content={"paymentIntent": intent})


@app.post("/v1/payment_intents/{pi_id}/capture")
async def capture_payment_intent(pi_id: str = Path(...)) -> JSONResponse:
    delay_ms = _env_int("STRIPE_SIM_CAPTURE_DELAY_MS", 0)
    if delay_ms > 0:
        await asyncio.sleep(delay_ms / 1000)

    intent = _INTENTS.get(pi_id)
    if not intent:
        return JSONResponse(
            status_code=404,
            content={"error": {"type": "invalid_request_error", "message": f"No such PaymentIntent: {pi_id}"}},
        )

    # Simulate permanent capture failure
    fail_rate = _env_float("STRIPE_SIM_CAPTURE_FAIL_RATE", 0.0)
    if fail_rate > 0.0 and random.random() < fail_rate:
        return _error("card_declined", "Your card was declined (simulated permanent failure)")

    # Simulate transient capture failure
    transient_rate = _env_float("STRIPE_SIM_CAPTURE_TRANSIENT_RATE", 0.0)
    if transient_rate > 0.0 and random.random() < transient_rate:
        return _api_error("Connection error (simulated transient failure)")

    net_amount = intent["amount"]
    charge_id = f"ch_sim_{uuid4().hex[:16]}"
    intent["status"] = "succeeded"
    intent["amount_received"] = net_amount
    intent["latest_charge"] = {
        "id": charge_id,
        "amount_captured": net_amount,
        "object": "charge",
    }

    return JSONResponse(content=intent)


@app.post("/v1/payment_intents/{pi_id}/cancel")
async def cancel_payment_intent(pi_id: str = Path(...)) -> JSONResponse:
    intent = _INTENTS.get(pi_id)
    if not intent:
        return JSONResponse(
            status_code=404,
            content={"error": {"type": "invalid_request_error", "message": f"No such PaymentIntent: {pi_id}"}},
        )
    intent["status"] = "canceled"
    return JSONResponse(content=intent)


@app.post("/v1/refunds")
async def create_refund(request: Request) -> JSONResponse:
    content_type = request.headers.get("content-type", "")
    if "application/json" in content_type:
        body = await request.json()
    else:
        form = await request.form()
        body = dict(form)

    pi_id = str(body.get("payment_intent", ""))
    amount = body.get("amount")
    intent = _INTENTS.get(pi_id)
    refund_amount = int(amount) if amount else (intent["amount"] if intent else 0)

    return JSONResponse(content={
        "id": _re_id(),
        "object": "refund",
        "amount": refund_amount,
        "payment_intent": pi_id,
        "status": "succeeded",
        "created": int(time.time()),
    })


@app.delete("/v1/payment_intents")
async def clear_all() -> dict[str, int]:
    """Test-only: reset all stored intents. Not part of the Stripe API."""
    count = len(_INTENTS)
    _INTENTS.clear()
    return {"cleared": count}


# ── Catch-all for unimplemented Stripe routes ─────────────────────────────────

@app.api_route("/{path:path}", methods=["GET", "POST", "DELETE", "PATCH", "PUT"])
async def not_implemented(path: str, request: Request) -> JSONResponse:
    return JSONResponse(
        status_code=501,
        content={
            "error": {
                "type": "api_error",
                "message": f"stripe_simulator: route not implemented: {request.method} /{path}",
            }
        },
    )
