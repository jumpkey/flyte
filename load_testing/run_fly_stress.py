#!/usr/bin/env python3
"""Bounded load harness for the explicitly authorized Flyte testbed.

This is deliberately separate from ``stress_test.py``: it creates clearly
tagged test events through the local Fly Postgres proxy, authenticates the
configured admin for read-only page probes, runs registrations without client
IP spoofing, and records raw responses before deciding whether outcomes look
unexpected. It never deletes data or deploys/configures the Fly application.

Example (after opening a Fly Postgres proxy):
  python load_testing/run_fly_stress.py --url https://flyte.fly.dev \
    --allow-app flyte --profile baseline --output work/fly-live-run

Required environment: FLY_LOAD_DATABASE_URL (loopback Fly proxy DSN),
STRIPE_SIMULATOR_URL, STRIPE_SIM_API_KEY, FLY_LOAD_ADMIN_EMAIL, and
FLY_LOAD_ADMIN_PASSWORD. The simulator key is used only for simulator probes;
``stress_test.py`` uses it for browser-side PI confirmation.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import re
import time
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, unquote

import aiohttp
import psycopg2
from psycopg2.extras import RealDictCursor

import stress_test as load


APP_HOST = "flyte.fly.dev"
SAFE_BATCHES = {5: 100, 20: 300, 50: 1000, 100: 2000, 250: 2000}
SOAK_POOL_SIZE = 200
SOAK_EVENT_CAPACITY = 100_000
SOAK_BATCH_TOTAL = 1000
SOAK_CONCURRENCY = 50
BASELINE_SIM_CONFIG: dict[str, Any] = {
    "STRIPE_SIM_CREATE_DELAY_MS": 0,
    "STRIPE_SIM_CAPTURE_DELAY_MS": 0,
    "STRIPE_SIM_CREATE_JITTER_MS": 0,
    "STRIPE_SIM_CAPTURE_JITTER_MS": 0,
    "STRIPE_SIM_CREATE_TAIL_RATE": 0,
    "STRIPE_SIM_CREATE_TAIL_DELAY_MS": 0,
    "STRIPE_SIM_CAPTURE_TAIL_RATE": 0,
    "STRIPE_SIM_CAPTURE_TAIL_DELAY_MS": 0,
    "STRIPE_SIM_CAPTURE_FAIL_RATE": 0,
    "STRIPE_SIM_CAPTURE_TRANSIENT_RATE": 0,
    "STRIPE_SIM_CAPTURE_RATE_LIMIT_RATE": 0,
    "STRIPE_SIM_CAPTURE_POST_COMMIT_FAIL_RATE": 0,
    "STRIPE_SIM_SEED": 20261022,
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, sort_keys=True, default=str) + "\n")
    tmp.replace(path)


def validate_args(args: argparse.Namespace) -> dict[str, str]:
    target = urlparse(args.url)
    if args.allow_app != "flyte":
        raise SystemExit("--allow-app must be exactly 'flyte' for this authorized run")
    if (target.scheme != "https" or target.hostname != APP_HOST or target.port not in (None, 443)
            or target.path not in {"", "/"} or target.query or target.fragment
            or target.username or target.password):
        raise SystemExit(f"Refusing target {args.url!r}; only https://{APP_HOST} is allowed")
    required = (
        "FLY_LOAD_DATABASE_URL", "STRIPE_SIMULATOR_URL", "STRIPE_SIM_API_KEY",
        "FLY_LOAD_ADMIN_EMAIL", "FLY_LOAD_ADMIN_PASSWORD",
    )
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        raise SystemExit("Missing required environment: " + ", ".join(missing))
    dsn = os.environ["FLY_LOAD_DATABASE_URL"]
    db_host = urlparse(dsn).hostname
    # Fly's proxy must be explicitly opened locally. Do not permit a direct
    # remote database connection or an arbitrary DSN in this harness.
    if db_host not in {"127.0.0.1", "localhost", "::1"}:
        raise SystemExit("FLY_LOAD_DATABASE_URL must use the local Fly Postgres proxy")
    simulator = urlparse(os.environ["STRIPE_SIMULATOR_URL"])
    if simulator.scheme not in {"https", "http"} or not simulator.netloc:
        raise SystemExit("STRIPE_SIMULATOR_URL must be an absolute HTTP(S) URL")
    if args.timeout <= 0:
        raise SystemExit("--timeout must be positive")
    if not 60 <= args.duration_s <= 600:
        raise SystemExit("--duration-s must be between 60 and 600")
    if args.concurrency is not None and args.concurrency not in SAFE_BATCHES:
        raise SystemExit(f"--concurrency must be one of {sorted(SAFE_BATCHES)}")
    if args.total is not None and not 1 <= args.total <= 2000:
        raise SystemExit("--total must be between 1 and 2000")
    if args.profile == "soak" and args.concurrency not in {None, SOAK_CONCURRENCY}:
        raise SystemExit(f"soak concurrency is fixed at {SOAK_CONCURRENCY}")
    if args.profile == "soak" and args.total is not None and args.total > SOAK_BATCH_TOTAL:
        raise SystemExit(f"soak batches are capped at {SOAK_BATCH_TOTAL} attempts")
    return {
        "dsn": dsn,
        "simulator_url": os.environ["STRIPE_SIMULATOR_URL"].rstrip("/"),
        "simulator_key": os.environ["STRIPE_SIM_API_KEY"],
        "admin_email": os.environ["FLY_LOAD_ADMIN_EMAIL"],
        "admin_password": os.environ["FLY_LOAD_ADMIN_PASSWORD"],
    }


def profile_config(profile: str) -> dict[str, Any]:
    cfg = dict(BASELINE_SIM_CONFIG)
    if profile == "stochastic":
        cfg.update({
            "STRIPE_SIM_CREATE_DELAY_MS": 50,
            "STRIPE_SIM_CAPTURE_DELAY_MS": 150,
            "STRIPE_SIM_CREATE_JITTER_MS": 100,
            "STRIPE_SIM_CAPTURE_JITTER_MS": 200,
            "STRIPE_SIM_CREATE_TAIL_RATE": 0.02,
            "STRIPE_SIM_CREATE_TAIL_DELAY_MS": 1500,
            "STRIPE_SIM_CAPTURE_TAIL_RATE": 0.02,
            "STRIPE_SIM_CAPTURE_TAIL_DELAY_MS": 1500,
            "STRIPE_SIM_CAPTURE_FAIL_RATE": 0.02,
            "STRIPE_SIM_CAPTURE_TRANSIENT_RATE": 0.05,
            "STRIPE_SIM_CAPTURE_RATE_LIMIT_RATE": 0.02,
            "STRIPE_SIM_CAPTURE_POST_COMMIT_FAIL_RATE": 0.02,
            "STRIPE_SIM_SEED": 20261022,
        })
    elif profile == "post-commit":
        cfg.update({"STRIPE_SIM_CAPTURE_POST_COMMIT_FAIL_RATE": 1.0})
    elif profile == "outage":
        # A fully transient capture failure models an unavailable processor:
        # the app should conservatively preserve PENDING_CAPTURE reservations.
        cfg.update({"STRIPE_SIM_CAPTURE_TRANSIENT_RATE": 1.0})
    return cfg


def profile_defaults(profile: str) -> tuple[int, int]:
    return {
        "baseline": (5, 100),
        "stochastic": (20, 300),
        "rate-limit": (5, 80),
        "sellout": (20, 25),
        "outage": (20, 100),
        "post-commit": (20, 40),
        "soak": (SOAK_CONCURRENCY, SOAK_BATCH_TOTAL),
    }[profile]


def batch_plan(args: argparse.Namespace) -> list[dict[str, Any]]:
    concurrency, total = profile_defaults(args.profile)
    if args.concurrency is not None:
        concurrency = args.concurrency
    if args.total is not None:
        total = args.total
    if args.profile == "baseline" and args.matrix and args.concurrency is None and args.total is None:
        return [
            {"name": f"baseline-c{workers}", "concurrency": workers, "total": count}
            for workers, count in SAFE_BATCHES.items()
        ]
    if args.profile == "soak":
        # run() repeats this batch continuously until --duration-s expires,
        # creating fresh event paths for each batch.
        return [{"name": "soak", "concurrency": concurrency, "total": total}]
    return [{"name": args.profile, "concurrency": concurrency, "total": total}]


def create_events(conn: Any, run_id: str, batch_name: str, count: int, capacity: int,
                  manifest: dict[str, Any], manifest_path: Path) -> list[str]:
    if count <= 0:
        return []
    was_autocommit = conn.autocommit
    conn.autocommit = False
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """INSERT INTO events
                   (name, event_date, total_capacity, available_slots,
                    registration_fee_cents, status)
                   SELECT 'Fly load ' || %s || ' ' || %s || ' ' || lpad(shard::text, 3, '0'),
                          now() + interval '30 days', %s, %s, 1200, 'OPEN'
                   FROM generate_series(1, %s) AS series(shard)
                   RETURNING event_id::text, name""",
                (run_id, batch_name, capacity, capacity, count),
            )
            rows = sorted(cur.fetchall(), key=lambda row: row["name"])
        event_ids = [row["event_id"] for row in rows]
        manifest["events"].extend({"event_id": row["event_id"], "name": row["name"],
                                   "batch": batch_name, "capacity": capacity}
                                  for row in rows)
        # One atomic manifest checkpoint per event batch avoids rewriting a
        # growing manifest hundreds of times during soak-pool preparation.
        write_json(manifest_path, manifest)
        conn.commit()
        return event_ids
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.autocommit = was_autocommit


def shard_count(total: int, profile: str) -> int:
    if profile in {"rate-limit", "sellout"}:
        return 1
    # Normal profiles remain below 40 attempts per event path/minute. Soak
    # batches are deliberately assigned fresh events for each batch.
    return max(1, math.ceil(total / 40))


async def configure_simulator(session: aiohttp.ClientSession, simulator_url: str,
                              key: str, config: dict[str, Any]) -> dict[str, Any]:
    async with session.post(simulator_url + "/__load__/config", json=config,
                            headers={"Authorization": f"Bearer {key}"}) as response:
        body = await response.json(content_type=None)
        return {"status": response.status, "body": body}


async def authenticate_admin(session: aiohttp.ClientSession, base_url: str,
                             email: str, password: str, timeout: float) -> dict[str, Any]:
    async with session.get(base_url + "/login", timeout=timeout) as response:
        html = await response.text()
        match = re.search(r'name="_csrf"\s+value="([^"]+)"', html)
        if not match:
            return {"ok": False, "step": "login_form", "status": response.status,
                    "error": "CSRF token not found"}
        csrf = match.group(1)
    async with session.post(base_url + "/login", data={"email": email, "password": password,
                                                        "_csrf": csrf},
                            allow_redirects=False, timeout=timeout) as response:
        body = await response.text()
        ok = response.status in {301, 302, 303} and response.headers.get("Location", "").startswith("/admin")
        if ok:
            async with session.get(base_url + "/admin/analytics", allow_redirects=False,
                                   timeout=timeout) as probe:
                ok = probe.status == 200
                return {"ok": ok, "status": probe.status, "login_status": response.status,
                        "location": response.headers.get("Location"),
                        "error": None if ok else "admin analytics probe rejected session"}
        return {"ok": False, "status": response.status,
                "location": response.headers.get("Location"),
                "error": "admin login did not redirect to /admin",
                "body_excerpt": body[:300]}


async def admin_probe_loop(base_url: str, session: aiohttp.ClientSession,
                           event_id: str, timeout: float, stop: asyncio.Event,
                           records: list[dict[str, Any]]) -> None:
    paths = ["/events", f"/events/{event_id}", "/admin/analytics"]
    while not stop.is_set():
        for path in paths:
            started = time.monotonic()
            try:
                async with session.get(base_url + path, timeout=timeout,
                                       allow_redirects=False) as response:
                    await response.read()
                    records.append({"at": utc_now(), "path": path, "status": response.status,
                                    "latency_ms": round((time.monotonic() - started) * 1000, 2)})
            except Exception as exc:  # retain probe failures in the report
                records.append({"at": utc_now(), "path": path, "status": 0,
                                "latency_ms": round((time.monotonic() - started) * 1000, 2),
                                "error": str(exc)})
        try:
            await asyncio.wait_for(stop.wait(), timeout=10)
        except asyncio.TimeoutError:
            pass


async def run_batch(base_url: str, simulator_url: str, simulator_key: str,
                    event_ids: list[str], profile: str, run_id: str,
                    concurrency: int, total: int, timeout: float,
                    output: Path, batch_name: str, admin_session: aiohttp.ClientSession,
                    admin_probes: list[dict[str, Any]]) -> dict[str, Any]:
    connector = aiohttp.TCPConnector(limit=concurrency + 10, limit_per_host=concurrency + 10)
    sessions: list[aiohttp.ClientSession] = []
    workers: list[load.RegistrationWorker] = []
    for worker_id in range(concurrency):
        session = aiohttp.ClientSession(connector=connector, connector_owner=False,
                                        cookie_jar=aiohttp.CookieJar(unsafe=True))
        sessions.append(session)
        workers.append(load.RegistrationWorker(
            worker_id=worker_id, session=session, base_url=base_url,
            event_id=event_ids[worker_id % len(event_ids)], phase="1+3", timeout=timeout,
            rate_limit_bypass=False, simulator_url=simulator_url,
        ))

    original_email = load._random_email
    safe_batch = re.sub(r"[^a-zA-Z0-9-]+", "-", batch_name).strip("-")
    load._random_email = lambda idx: f"fly-load-{run_id}-{safe_batch}-{idx}@example.invalid"
    results: list[load.RequestResult] = []
    session_ids: list[str] = []
    start = time.monotonic()
    try:
        # Bootstrap each worker on its assigned event before making any
        # registration requests. No proxy/IP headers are added.
        # Bootstrap every session before load begins; session CSRF state is
        # host-scoped and remains valid when a worker is assigned another
        # event path later in the batch.
        init = await asyncio.gather(*(worker._acquire_session() for worker in workers),
                                    return_exceptions=True)
        attempts = iter(range(total))
        async def worker_loop(worker: load.RegistrationWorker) -> None:
            for attempt in attempts:
                # Assign by attempt rather than by worker so no event path can
                # receive more than ceil(total/shards) requests, even if one
                # worker completes much faster than its peers.
                event_id = event_ids[attempt % len(event_ids)]
                worker.event_id = event_id
                try:
                    results.extend(await worker.run_one(attempt))
                except Exception as exc:
                    # Store unexpected exceptions as raw outcomes; never let an
                    # HTTP status or result check skip the evidence writer.
                    results.append(load.RequestResult(
                        worker_id=worker.worker_id, attempt=attempt, phase="harness",
                        status_code=0, latency_ms=0, outcome="HARNESS_ERROR", error=str(exc)))
        monitor_event = asyncio.Event()
        monitor_task = asyncio.create_task(admin_probe_loop(
            base_url, admin_session, event_ids[0], timeout, monitor_event, admin_probes))
        try:
            await asyncio.gather(*(worker_loop(worker) for worker in workers))
        finally:
            monitor_event.set()
            await monitor_task
    finally:
        load._random_email = original_email
        for session in sessions:
            session_ids.extend(unquote(cookie.value).rsplit('.', 1)[0] for cookie in session.cookie_jar if cookie.key == 'sid')
            await session.close()
        await connector.close()
    elapsed = time.monotonic() - start
    raw_results = [result_dict(row) for row in results]
    phase_summary = summarize_results(results, elapsed)
    init_failures = sum(row.phase == "init" for row in results) + sum(value is not True for value in init)
    write_json(output / f"{batch_name}-raw.json", {
        "run_id": run_id, "batch": batch_name, "event_ids": event_ids,
        "concurrency": concurrency, "total": total, "profile": profile,
        "elapsed_s": round(elapsed, 3), "summary": phase_summary,
        "worker_session_init": [{"ok": value is True,
                                 "error": str(value) if isinstance(value, Exception) else None}
                                for value in init],
        "session_uuids": session_ids,
        "results": raw_results,
    })
    return {"name": batch_name, "concurrency": concurrency, "total": total,
            "elapsed_s": round(elapsed, 3), "summary": phase_summary,
            "init_failures": init_failures,
            "http_success": http_success_by_phase(phase_summary),
            "financial_success": phase_summary.get("phase3", {}).get("outcomes", {}).get("SUCCESS", 0),
            "results_file": f"{batch_name}-raw.json"}


def result_dict(row: Any) -> dict[str, Any]:
    return {
        "worker_id": row.worker_id, "attempt": row.attempt, "phase": row.phase,
        "status_code": row.status_code, "latency_ms": round(row.latency_ms, 2),
        "outcome": row.outcome, "error": row.error,
        "registration_id": row.registration_id, "pi_id": row.pi_id,
    }


def summarize_results(results: list[Any], elapsed: float) -> dict[str, Any]:
    summary: dict[str, Any] = {"elapsed_s": round(elapsed, 3)}
    for phase in sorted({result.phase for result in results}):
        phase_results = [result for result in results if result.phase == phase]
        latencies = sorted(row.latency_ms for row in phase_results)
        summary[phase] = {
            "requests": len(phase_results),
            "http_2xx": sum(200 <= row.status_code < 300 for row in phase_results),
            "status_codes": dict(Counter(str(row.status_code) for row in phase_results)),
            "outcomes": dict(Counter(row.outcome for row in phase_results)),
            "latency_ms": {
                "p50": percentile(latencies, 0.50), "p95": percentile(latencies, 0.95),
                "p99": percentile(latencies, 0.99), "max": round(max(latencies), 2) if latencies else 0,
            },
        }
    return summary


def percentile(items: list[float], p: float) -> float:
    if not items:
        return 0
    return round(items[min(len(items) - 1, int((len(items) - 1) * p))], 2)


def http_success_by_phase(summary: dict[str, Any]) -> dict[str, int]:
    """Return HTTP counts while deliberately ignoring aggregate float fields."""
    return {phase: values.get("http_2xx", 0) for phase, values in summary.items()
            if isinstance(values, dict)}


def self_check_summary_helpers() -> None:
    """Small offline smoke checks for the reporting path before any load."""
    sample = [
        load.RequestResult(0, 0, "phase1", 200, 12.0, "SUCCESS"),
        load.RequestResult(0, 0, "phase3", 200, 25.0, "SUCCESS"),
        load.RequestResult(1, 1, "phase1", 429, 2.0, "RATE_LIMITED"),
    ]
    summary = summarize_results(sample, 1.5)
    assert summary["phase1"]["http_2xx"] == 1
    assert summary["phase1"]["status_codes"] == {"200": 1, "429": 1}
    assert http_success_by_phase(summary) == {"phase1": 1, "phase3": 1}
    assert percentile([], 0.95) == 0


async def collect_simulator(session: aiohttp.ClientSession, url: str, key: str) -> dict[str, Any]:
    async with session.get(url + "/__load__/state", headers={"Authorization": f"Bearer {key}"}) as resp:
        body = await resp.json(content_type=None)
        return {"status": resp.status, "body": body}


def collect_database(conn: Any, event_ids: list[str]) -> dict[str, Any]:
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""SELECT e.event_id::text,e.name,e.total_capacity,e.confirmed_count,
                           e.available_slots,e.status,
                           count(r.registration_id)::int AS registration_rows,
                           count(*) FILTER (WHERE r.status='CONFIRMED')::int AS confirmed_rows,
                           count(*) FILTER (WHERE r.status='PENDING_CAPTURE')::int AS pending_capture_rows,
                           count(*) FILTER (WHERE r.status='PENDING_PAYMENT')::int AS pending_payment_rows,
                           count(*) FILTER (WHERE r.status='PAYMENT_FAILED')::int AS payment_failed_rows
                    FROM events e LEFT JOIN registrations r ON r.event_id=e.event_id
                    WHERE e.event_id=ANY(%s::uuid[])
                    GROUP BY e.event_id ORDER BY e.name""", (event_ids,))
        events = [dict(row) for row in cur.fetchall()]
        cur.execute("""SELECT event_id::text,registration_id::text,payment_intent_id,status,
                           gross_amount_cents,net_amount_cents,email
                    FROM registrations WHERE event_id=ANY(%s::uuid[]) ORDER BY created_at""", (event_ids,))
        registrations = [dict(row) for row in cur.fetchall()]
    for event in events:
        reserved_rows = event["confirmed_rows"] + event["pending_capture_rows"]
        event["integrity"] = {
            "capacity_equation": event["available_slots"] + event["confirmed_count"] == event["total_capacity"],
            "confirmed_count_matches_confirmed_plus_pending_capture": event["confirmed_count"] == reserved_rows,
            "not_oversold": event["confirmed_count"] <= event["total_capacity"],
        }
    return {"events": events, "registrations": registrations}


def compare_simulator(database: dict[str, Any], simulator: dict[str, Any]) -> dict[str, Any]:
    state = simulator.get("body", {})
    intents = {item.get("id"): item for item in state.get("intents", [])}
    registrations = database["registrations"]
    registration_intent_ids = {row.get("payment_intent_id") for row in registrations
                               if row.get("payment_intent_id")}
    missing: list[str] = []
    amount_mismatches: list[str] = []
    confirmed_processor_mismatches: list[str] = []
    captured_unconfirmed: list[str] = []
    matched = 0
    for registration in registrations:
        pi_id = registration.get("payment_intent_id")
        if not pi_id:
            continue
        intent = intents.get(pi_id)
        if not intent:
            missing.append(pi_id)
            continue
        matched += 1
        if intent.get("amount") != registration["gross_amount_cents"]:
            amount_mismatches.append(pi_id)
        if registration["status"] == "CONFIRMED" and (
            intent.get("status") != "succeeded" or
            intent.get("amount_received") != registration["gross_amount_cents"]
        ):
            confirmed_processor_mismatches.append(pi_id)
        if intent.get("status") == "succeeded" and registration["status"] != "CONFIRMED":
            captured_unconfirmed.append(pi_id)
    return {
        "http_status": simulator.get("status"),
        "matching_payment_intents": matched,
        "missing_payment_intents": missing,
        "orphan_simulator_intents": [
            pi_id for pi_id, intent in intents.items()
            if pi_id not in registration_intent_ids
        ],
        "amount_mismatches": amount_mismatches,
        "confirmed_processor_mismatches": confirmed_processor_mismatches,
        "captured_unconfirmed_recovery_candidates": captured_unconfirmed,
        "intent_statuses": dict(Counter(item.get("status", "UNKNOWN") for item in intents.values())),
        "request_counts": state.get("requests", {}),
    }


def validate_batch(profile: str, expected_total: int, database: dict[str, Any],
                   simulator: dict[str, Any], batch_raw: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    events = database.get("events", [])
    if database.get("collection_error"):
        errors.append("database collection failed")
    if not events:
        errors.append("database returned no test events")
    for event in events:
        for key, ok in event.get("integrity", {}).items():
            if not ok:
                errors.append(f"{event['event_id']}: integrity check failed: {key}")
    if any(not str(registration.get("email", "")).startswith("fly-load-") or
           not str(registration.get("email", "")).endswith("@example.invalid")
           for registration in database.get("registrations", [])):
        errors.append("a registration email escaped the fly-load @example.invalid namespace")
    if simulator.get("status") != 200:
        errors.append(f"simulator state returned HTTP {simulator.get('status')}")
    comparison = compare_simulator(database, simulator)
    for key in ("missing_payment_intents", "orphan_simulator_intents", "amount_mismatches", "confirmed_processor_mismatches"):
        if comparison.get(key):
            errors.append(f"simulator/database mismatch: {key}={len(comparison[key])}")
    unexpected = [row for row in batch_raw.get("results", []) if row.get("outcome") in {
        "ERROR", "NETWORK_ERROR", "CSRF_REJECTED", "VALIDATION_ERROR",
        "UNVERIFIED", "UNVERIFIED_REDIRECT", "HARNESS_ERROR", "STRIPE_ERROR",
    }]
    if profile != "rate-limit":
        unexpected.extend(row for row in batch_raw.get("results", [])
                          if row.get("outcome") == "RATE_LIMITED")
    if unexpected:
        errors.append(f"{len(unexpected)} unexpected request outcomes")
    if any(not row.get("ok") for row in batch_raw.get("worker_session_init", [])):
        errors.append("one or more worker sessions failed initial CSRF bootstrap")
    registrations = database.get("registrations", [])
    confirmed = sum(row.get("status") == "CONFIRMED" for row in registrations)
    pending_capture = sum(row.get("status") == "PENDING_CAPTURE" for row in registrations)
    if profile in {"baseline", "soak", "post-commit"} and confirmed != expected_total:
        errors.append(f"expected {expected_total} confirmed rows, found {confirmed}")
    elif profile == "sellout" and confirmed != 10:
        errors.append(f"sellout expected 10 confirmed rows, found {confirmed}")
    elif profile == "outage" and (pending_capture != expected_total or confirmed != 0):
        errors.append(f"outage expected {expected_total} pending-capture rows and zero confirmed, found {pending_capture}/{confirmed}")
    elif profile == "rate-limit":
        phase1 = batch_raw.get("summary", {}).get("phase1", {})
        if int(phase1.get("status_codes", {}).get("429", 0)) < 1:
            errors.append("rate-limit profile did not observe an HTTP 429")
        if int(phase1.get("http_2xx", 0)) < 1:
            errors.append("rate-limit profile produced no accepted registration request")
    return errors


async def run(args: argparse.Namespace) -> int:
    self_check_summary_helpers()
    env = validate_args(args)
    output = Path(args.output).expanduser().resolve()
    base_url = args.url.rstrip("/")
    output.mkdir(parents=True, exist_ok=True)
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    manifest_path = output / "manifest.json"
    plan = batch_plan(args)
    manifest: dict[str, Any] = {
        "run_id": run_id, "created_at": utc_now(), "target": args.url,
        "allow_app": args.allow_app, "profile": args.profile,
        "plan": plan, "events": [], "status": "preparing",
        "note": "No cleanup is automatic. Use event names beginning 'Fly load <run_id>' for review/cleanup.",
    }
    # A manifest exists before the first insert and is updated immediately for
    # every successfully created event, so interrupted runs remain auditable.
    write_json(manifest_path, manifest)
    conn = psycopg2.connect(env["dsn"])
    conn.autocommit = True
    summaries: list[dict[str, Any]] = []
    validation_errors: list[str] = []
    admin_probes: list[dict[str, Any]] = []
    db_report: dict[str, Any] = {"events": [], "registrations": []}
    sim_report: dict[str, Any] = {"status": 0, "body": {}}
    prior_sim_report: dict[str, Any] = {"status": 0, "body": {}}
    restore_report: dict[str, Any] | None = None
    admin_report: dict[str, Any] = {"ok": False, "error": "not attempted"}
    exception: str | None = None
    try:
        timeout = aiohttp.ClientTimeout(total=args.timeout)
        async with aiohttp.ClientSession(timeout=timeout) as api:
            admin_session = aiohttp.ClientSession(timeout=timeout, cookie_jar=aiohttp.CookieJar(unsafe=True))
            try:
                prior_sim_report = await collect_simulator(api, env["simulator_url"], env["simulator_key"])
                admin_report = await authenticate_admin(admin_session, base_url,
                                                        env["admin_email"], env["admin_password"], args.timeout)
                config_report = await configure_simulator(api, env["simulator_url"],
                                                          env["simulator_key"], profile_config(args.profile))
                if not admin_report.get("ok"):
                    raise RuntimeError(f"admin authentication failed: {admin_report}")
                if config_report["status"] != 200:
                    raise RuntimeError(f"simulator config rejected: {config_report}")
                manifest["status"] = "running"
                manifest["simulator_config"] = profile_config(args.profile)
                write_json(manifest_path, manifest)
                soak_event_ids: list[str] = []
                if args.profile == "soak":
                    manifest["soak_pool"] = {
                        "size": SOAK_POOL_SIZE,
                        "capacity_per_event": SOAK_EVENT_CAPACITY,
                        "batch_attempts": plan[0]["total"],
                        "concurrency": plan[0]["concurrency"],
                    }
                    # Provision the reusable event pool before starting the
                    # timed portion. One bulk transaction and one manifest
                    # checkpoint avoid multi-second provisioning gaps per run.
                    soak_event_ids = create_events(
                        conn, run_id, "soak-pool", SOAK_POOL_SIZE,
                        SOAK_EVENT_CAPACITY, manifest, manifest_path,
                    )
                soak_deadline = time.monotonic() + args.duration_s if args.profile == "soak" else None
                batch_index = 0
                cumulative_soak_expected = 0
                while batch_index < len(plan) or soak_deadline is not None:
                    if soak_deadline is not None and time.monotonic() >= soak_deadline:
                        break
                    batch = plan[0] if soak_deadline is not None else plan[batch_index]
                    name = f"soak-{batch_index + 1:03d}" if soak_deadline is not None else batch["name"]
                    total = batch["total"]
                    if total <= 0:
                        break
                    if args.profile == "soak":
                        event_ids = soak_event_ids
                    else:
                        capacity = 10 if args.profile == "sellout" else total + 10
                        event_count = shard_count(total, args.profile)
                        event_ids = create_events(conn, run_id, name, event_count, capacity,
                                                  manifest, manifest_path)
                    batch_result = await run_batch(
                        base_url, env["simulator_url"], env["simulator_key"],
                        event_ids, args.profile, run_id, batch["concurrency"], total,
                        args.timeout, output, name, admin_session, admin_probes,
                    )
                    # run_batch writes the complete raw result before any
                    # validation can stop a baseline matrix or soak loop.
                    raw_batch = json.loads((output / batch_result["results_file"]).read_text())
                    db_batch = collect_database(conn, event_ids)
                    sim_batch = await collect_simulator(api, env["simulator_url"], env["simulator_key"])
                    sim_batch.setdefault("body", {})["intents"] = [
                        intent for intent in sim_batch.get("body", {}).get("intents", [])
                        if intent.get("metadata", {}).get("eventId") in set(event_ids)
                    ]
                    if args.profile == "soak":
                        cumulative_soak_expected += total
                        expected_confirmed = cumulative_soak_expected
                    else:
                        expected_confirmed = total
                    batch_errors = validate_batch(args.profile, expected_confirmed, db_batch, sim_batch, raw_batch)
                    batch_result["validation"] = {
                        "ok": not batch_errors, "errors": batch_errors,
                        "expected_cumulative_confirmed": expected_confirmed,
                        "database": db_batch, "simulator": compare_simulator(db_batch, sim_batch),
                    }
                    summaries.append(batch_result)
                    if batch_errors:
                        validation_errors.extend(f"{name}: {error}" for error in batch_errors)
                        manifest["status"] = "validation_failed"
                        manifest["validation_errors"] = validation_errors
                        write_json(manifest_path, manifest)
                        break
                    batch_index += 1
                    if soak_deadline is None and batch_index >= len(plan):
                        break
                if not validation_errors:
                    manifest["status"] = "load_complete"
            finally:
                await admin_session.close()
    except Exception as exc:
        exception = f"{type(exc).__name__}: {exc}"
        manifest["status"] = "failed"
        manifest["error"] = exception
    finally:
        try:
            event_ids = [item["event_id"] for item in manifest["events"]]
            if event_ids:
                db_report = collect_database(conn, event_ids)
        except Exception as exc:
            db_report["collection_error"] = f"{type(exc).__name__}: {exc}"
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=args.timeout)) as api:
                sim_report = await collect_simulator(api, env["simulator_url"], env["simulator_key"])
                prior_config = prior_sim_report.get("body", {}).get("config", {})
                if prior_sim_report.get("status") == 200 and prior_config:
                    restore_report = await configure_simulator(api, env["simulator_url"],
                                                              env["simulator_key"], prior_config)
        except Exception as exc:
            sim_report = {"status": 0, "body": {}, "error": f"{type(exc).__name__}: {exc}"}
        conn.close()
    integrity = {
        "collection_succeeded": not db_report.get("collection_error") and bool(db_report.get("events")),
        "all_event_capacity_equations_hold": bool(db_report.get("events")) and all(event["integrity"]["capacity_equation"] for event in db_report.get("events", [])),
        "confirmed_count_matches_confirmed_plus_pending_capture": bool(db_report.get("events")) and all(event["integrity"]["confirmed_count_matches_confirmed_plus_pending_capture"] for event in db_report.get("events", [])),
        "no_event_oversold": bool(db_report.get("events")) and all(event["integrity"]["not_oversold"] for event in db_report.get("events", [])),
    }
    event_id_set = {item["event_id"] for item in manifest["events"]}
    sim_intents = sim_report.get("body", {}).get("intents", [])
    sim_report.setdefault("body", {})["intents"] = [
        intent for intent in sim_intents
        if intent.get("metadata", {}).get("eventId") in event_id_set
    ]
    sim_comparison = compare_simulator(db_report, sim_report)
    write_json(output / "database-integrity.json", db_report)
    write_json(output / "simulator-state.json", sim_report)
    write_json(output / "admin-probes.json", {"authentication": admin_report, "probes": admin_probes})
    unexpected = []
    for item in summaries:
        raw_path = output / item["results_file"]
        if raw_path.exists():
            raw = json.loads(raw_path.read_text())
            unexpected.extend(
                row for row in raw.get("results", [])
                if row.get("outcome") in {"ERROR", "NETWORK_ERROR", "CSRF_REJECTED",
                                           "VALIDATION_ERROR", "UNVERIFIED", "UNVERIFIED_REDIRECT",
                                           "HARNESS_ERROR"}
            )
    if not admin_probes or any(row.get("status") != 200 for row in admin_probes):
        validation_errors.append("admin catalog/detail/analytics probe failed or was missing")
    if sim_report.get("status") != 200:
        validation_errors.append(f"final simulator state collection failed: HTTP {sim_report.get('status')}")
    if any(not value for value in integrity.values()):
        validation_errors.append("final database integrity collection/check failed")
    if (sim_comparison["missing_payment_intents"] or sim_comparison["orphan_simulator_intents"]
            or sim_comparison["amount_mismatches"]
            or sim_comparison["confirmed_processor_mismatches"]):
        validation_errors.append("final simulator/database financial reconciliation failed")
    if restore_report is None or restore_report.get("status") != 200:
        validation_errors.append("simulator configuration restore did not return HTTP 200")
    report = {
        "run_id": run_id, "created_at": manifest["created_at"], "finished_at": utc_now(),
        "target": args.url, "profile": args.profile, "plan": plan,
        "status": manifest.get("status"), "error": exception,
        "simulator_config_before": prior_sim_report.get("body", {}).get("config", {}),
        "simulator_config_restore": restore_report,
        "admin_authentication": admin_report, "admin_probe_count": len(admin_probes),
        "admin_probe_statuses": dict(Counter(str(row.get("status")) for row in admin_probes)),
        "batches": summaries, "database_integrity": integrity,
        "validation_errors": validation_errors,
        "simulator_comparison": sim_comparison, "unexpected_outcome_count": len(unexpected),
        "unexpected_outcomes": unexpected[:100],
        "limitations": [
            "Fly client IP headers are never spoofed.",
            "Registration routes are sharded to no more than 40 attempts per event path except the explicit rate-limit profile.",
            "Fly host CPU/memory/network metrics are collected separately by the operator.",
        ],
    }
    write_json(output / "summary.json", report)
    manifest["status"] = "complete_with_errors" if exception or unexpected or validation_errors else "complete"
    manifest["finished_at"] = utc_now()
    write_json(manifest_path, manifest)
    print(json.dumps({"output": str(output), "run_id": run_id, "status": manifest["status"],
                      "batches": len(summaries), "database_events": len(db_report.get("events", [])),
                      "unexpected_outcomes": len(unexpected)}, indent=2))
    return 2 if exception or unexpected or validation_errors else 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True, help="Flyte app URL; must be https://flyte.fly.dev")
    parser.add_argument("--allow-app", required=True, choices=["flyte"],
                        help="Explicit authorization guard. Supply 'flyte' for the designated testbed.")
    parser.add_argument("--output", required=True, help="Directory for manifest, raw results, and summary")
    parser.add_argument("--profile", required=True,
                        choices=["baseline", "stochastic", "rate-limit", "sellout", "outage", "post-commit", "soak"])
    parser.add_argument("--concurrency", type=int, choices=sorted(SAFE_BATCHES),
                        help="Override concurrency (one of 5, 20, 50, 100, 250)")
    parser.add_argument("--total", type=int, help="Override attempt count (1..2000)")
    parser.add_argument("--matrix", action="store_true",
                        help="For baseline only, run the bounded c5/100, c20/300, c50/1000, c100/2000 matrix")
    parser.add_argument("--timeout", type=float, default=30.0, help="Per HTTP request timeout in seconds")
    parser.add_argument("--duration-s", type=int, default=300,
                        help="Soak duration (60..600 seconds; default 300)")
    return parser.parse_args()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run(parse_args())))
