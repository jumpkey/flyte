"""Load-test controls and sanitized state view for the Stripe simulator."""

import os
import math
from collections import Counter

from fastapi import Request
from fastapi.responses import JSONResponse

import stripe_simulator as sim

app = sim.app
counts: Counter[str] = Counter()
allowed = set(sim._CONFIG_NAMES)


@app.middleware("http")
async def monitor(request: Request, call_next):
    path = request.url.path
    denied = sim._authorization_error(request)
    if denied is not None:
        return denied
    if path == "/__load__/config" and request.method == "POST":
        body = await request.json()
        if not isinstance(body, dict) or not set(body) <= allowed:
            return JSONResponse({"error": "unsupported option"}, 400)
        updates = {}
        for key, value in body.items():
            if key.endswith("_RATE") and not sim._valid_rate(value):
                return JSONResponse({"error": f"{key} must be between 0 and 1"}, 400)
            if key.endswith("_DELAY_MS") or key.endswith("_JITTER_MS"):
                try:
                    number = float(value)
                    if not math.isfinite(number) or number < 0:
                        raise ValueError
                except (TypeError, ValueError):
                    return JSONResponse({"error": f"{key} must be nonnegative"}, 400)
            updates[key] = str(value)
        os.environ.update(updates)
        if "STRIPE_SIM_SEED" in body:
            sim.random.seed(str(body["STRIPE_SIM_SEED"]))
        return JSONResponse({key: os.environ.get(key, "0") for key in sorted(allowed)})
    if path == "/__load__/state" and request.method == "GET":
        async with sim._LOCK:
            intents = [
                {key: value.get(key) for key in (
                    "id", "amount", "amount_received", "amount_refunded", "status", "metadata", "latest_charge"
                )}
                for value in sim._INTENTS.values()
            ]
        return JSONResponse({
            "requests": dict(counts), "intent_count": len(intents), "intents": intents,
            "smtp_discarded_messages": sim._SMTP_MESSAGES,
            "config": {key: os.environ.get(key, "0") for key in sorted(allowed)},
        })
    response = await call_next(request)
    route = path
    if path.startswith("/v1/payment_intents/pi_"):
        parts = path.split("/")
        route = "/v1/payment_intents/:id" + ("/" + parts[4] if len(parts) > 4 else "")
    key = request.method + " " + route
    counts[key + " " + str(response.status_code)] += 1
    return response
