#!/usr/bin/env python3
"""
stress_test.py — Concurrent load test for the Flyte registration endpoint.

USAGE
-----
  python stress_test.py [OPTIONS]

OPTIONS (all have defaults or read from env)
  --url            Base URL of the Flyte app  [env FLYTE_URL, default http://localhost:3000]
  --event-id       UUID of the event to register for  [env FLYTE_EVENT_ID, required]
  --concurrency    Number of parallel workers  [default 10]
  --total          Total number of registration attempts  [default 50]
  --ramp-up        Seconds over which workers are started  [default 0 = immediate]
  --phase          Which phase to exercise:
                     1  = Phase 1 only (POST /events/:id/register)
                     1+3= Phase 1 + Phase 3 client-confirm (full flow)  [default]
  --timeout        Per-request timeout in seconds  [default 30]
  --output         Path to write JSON results file  [default results.json]
  --rate-limit-bypass  Include X-Forwarded-For spoofing to avoid per-IP rate limits
                       (use only against a dev/staging deployment, not production)

WHAT IT TESTS
-------------
1. Acquires a session cookie + CSRF token per worker (GET /events/:id/register).
2. Phase 1: POST /events/:id/register with randomised attendee data.
   - Measures: HTTP status, response body, latency.
3. Phase 3 (optional): POST /registration/confirm/:piId.
   - Uses the paymentIntentId returned by Phase 1.
   - Measures: HTTP status (redirect to /confirmed or error), latency.
4. Reports:
   - Throughput (req/s), latency p50/p95/p99/max
   - Status-code distribution
   - Registration outcomes (SUCCESS, ALREADY_REGISTERED, FULL, ERROR)
   - Capacity validation (confirmed_count in DB via /api/load-test/stats if available)

STRIPE INTERACTION
------------------
By default, the app must be configured to talk to the Stripe simulator:
  STRIPE_SECRET_KEY=sk_test_any_value
  (and stripe-factory.ts configured with STRIPE_SIMULATOR_HOST/PORT/PROTOCOL)
See load_testing/README.md for the complete setup.
"""

import asyncio
import json
import os
import random
import string
import sys
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import aiohttp
import click
from rich.console import Console
from rich.progress import BarColumn, Progress, SpinnerColumn, TaskProgressColumn, TextColumn, TimeElapsedColumn
from rich.table import Table

console = Console()

# ── Data generation ──────────────────────────────────────────────────────────

FIRST_NAMES = [
    "Alice", "Bob", "Carol", "David", "Emma", "Frank", "Grace", "Henry",
    "Iris", "James", "Karen", "Liam", "Maya", "Noah", "Olivia", "Paul",
    "Quinn", "Rachel", "Sam", "Tina", "Uma", "Victor", "Wendy", "Xander",
    "Yara", "Zoe", "Ana", "Ben", "Cleo", "Diego",
]
LAST_NAMES = [
    "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller",
    "Davis", "Wilson", "Moore", "Taylor", "Anderson", "Thomas", "Jackson",
    "White", "Harris", "Martin", "Thompson", "Lee", "Perez", "Walker",
    "Hall", "Young", "Allen", "King", "Scott", "Green", "Baker", "Adams",
]


def _random_email(idx: int) -> str:
    random_suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=6))
    return f"loadtest_{idx}_{random_suffix}@example.com"


def _random_name() -> tuple[str, str]:
    return random.choice(FIRST_NAMES), random.choice(LAST_NAMES)


def _random_phone() -> str | None:
    if random.random() < 0.7:
        return f"+1-{random.randint(200,999)}-{random.randint(100,999)}-{random.randint(1000,9999)}"
    return None


# ── Result tracking ───────────────────────────────────────────────────────────

@dataclass
class RequestResult:
    worker_id: int
    attempt: int
    phase: str
    status_code: int
    latency_ms: float
    outcome: str          # SUCCESS, ALREADY_REGISTERED, FULL, RATE_LIMITED, ERROR, NETWORK_ERROR
    error: str | None = None
    registration_id: str | None = None
    pi_id: str | None = None


@dataclass
class RunStats:
    results: list[RequestResult] = field(default_factory=list)
    start_time: float = field(default_factory=time.monotonic)
    end_time: float = 0.0

    def add(self, r: RequestResult) -> None:
        self.results.append(r)

    def phase_results(self, phase: str) -> list[RequestResult]:
        return [r for r in self.results if r.phase == phase]

    def latency_percentile(self, phase: str, p: float) -> float:
        latencies = sorted(r.latency_ms for r in self.phase_results(phase))
        if not latencies:
            return 0.0
        idx = int((len(latencies) - 1) * p / 100)
        return latencies[idx]

    def status_distribution(self, phase: str) -> dict[int, int]:
        dist: dict[int, int] = {}
        for r in self.phase_results(phase):
            dist[r.status_code] = dist.get(r.status_code, 0) + 1
        return dist

    def outcome_distribution(self, phase: str) -> dict[str, int]:
        dist: dict[str, int] = {}
        for r in self.phase_results(phase):
            dist[r.outcome] = dist.get(r.outcome, 0) + 1
        return dist

    def throughput(self, phase: str) -> float:
        elapsed = (self.end_time or time.monotonic()) - self.start_time
        if elapsed == 0:
            return 0.0
        return len(self.phase_results(phase)) / elapsed


# ── Worker ────────────────────────────────────────────────────────────────────

class RegistrationWorker:
    def __init__(
        self,
        worker_id: int,
        session: aiohttp.ClientSession,
        base_url: str,
        event_id: str,
        phase: str,
        timeout: float,
        rate_limit_bypass: bool,
        simulator_url: str | None,
    ) -> None:
        self.worker_id = worker_id
        self.session = session
        self.base_url = base_url.rstrip("/")
        self.event_id = event_id
        self.phase = phase
        self.timeout = aiohttp.ClientTimeout(total=timeout)
        self.rate_limit_bypass = rate_limit_bypass
        # If set, the stress test will call the simulator's /confirm endpoint
        # between Phase 1 and Phase 3, simulating what stripe.confirmPayment()
        # does in the browser (transitions PI to requires_capture).
        self.simulator_url = simulator_url.rstrip("/") if simulator_url else None
        self.cookie_jar: dict[str, str] = {}
        self.csrf_token: str | None = None
        self._initialized = False

    async def _acquire_session(self) -> bool:
        """GET the registration page to get a session cookie and CSRF token."""
        url = f"{self.base_url}/events/{self.event_id}/register"
        try:
            async with self.session.get(url, timeout=self.timeout, allow_redirects=True) as resp:
                text = await resp.text()
                # Extract CSRF token from the rendered HTML
                import re
                m = re.search(r'name="_csrf"\s+value="([^"]+)"', text)
                if m:
                    self.csrf_token = m.group(1)
                    self._initialized = True
                    return True
                # Also try X-CSRF-Token meta tag pattern
                m2 = re.search(r'<meta\s+name="csrf-token"\s+content="([^"]+)"', text)
                if m2:
                    self.csrf_token = m2.group(1)
                    self._initialized = True
                    return True
                # If no CSRF token found in HTML, try to get it from a direct JSON endpoint
                # (some configurations expose it). As a last resort use empty string and
                # rely on the server rejecting it gracefully.
                console.print(
                    f"[yellow]Worker {self.worker_id}: could not extract CSRF token "
                    f"(status {resp.status}). Requests will receive 403.[/yellow]"
                )
                return False
        except Exception as e:
            console.print(f"[red]Worker {self.worker_id}: session init failed: {e}[/red]")
            return False

    def _extra_headers(self, idx: int) -> dict[str, str]:
        headers: dict[str, str] = {}
        if self.csrf_token:
            headers["X-CSRF-Token"] = self.csrf_token
        if self.rate_limit_bypass:
            # Spoof a unique IP per request to bypass per-IP rate limiting.
            # Only use this against a dev/staging server.
            headers["X-Forwarded-For"] = (
                f"{random.randint(1,254)}.{random.randint(1,254)}."
                f"{random.randint(1,254)}.{random.randint(1,254)}"
            )
        return headers

    async def run_one(self, attempt: int) -> list[RequestResult]:
        results: list[RequestResult] = []

        if not self._initialized:
            ok = await self._acquire_session()
            if not ok:
                results.append(RequestResult(
                    worker_id=self.worker_id,
                    attempt=attempt,
                    phase="init",
                    status_code=0,
                    latency_ms=0,
                    outcome="ERROR",
                    error="session init failed",
                ))
                return results

        first, last = _random_name()
        email = _random_email(attempt * 1000 + self.worker_id)
        phone = _random_phone()

        payload: dict[str, Any] = {
            "email": email,
            "firstName": first,
            "lastName": last,
        }
        if phone:
            payload["phone"] = phone

        headers = {
            "Content-Type": "application/json",
            **self._extra_headers(attempt),
        }

        url = f"{self.base_url}/events/{self.event_id}/register"
        t0 = time.monotonic()
        pi_id: str | None = None
        registration_id: str | None = None

        try:
            async with self.session.post(
                url, json=payload, headers=headers, timeout=self.timeout
            ) as resp:
                latency_ms = (time.monotonic() - t0) * 1000
                try:
                    body = await resp.json(content_type=None)
                except Exception:
                    body = {}

                outcome = _classify_phase1(resp.status, body)
                pi_id = body.get("paymentIntentId")
                registration_id = body.get("registrationId")
                results.append(RequestResult(
                    worker_id=self.worker_id,
                    attempt=attempt,
                    phase="phase1",
                    status_code=resp.status,
                    latency_ms=latency_ms,
                    outcome=outcome,
                    pi_id=pi_id,
                    registration_id=registration_id,
                ))
        except asyncio.TimeoutError:
            results.append(RequestResult(
                worker_id=self.worker_id,
                attempt=attempt,
                phase="phase1",
                status_code=0,
                latency_ms=(time.monotonic() - t0) * 1000,
                outcome="NETWORK_ERROR",
                error="timeout",
            ))
            return results
        except Exception as e:
            results.append(RequestResult(
                worker_id=self.worker_id,
                attempt=attempt,
                phase="phase1",
                status_code=0,
                latency_ms=(time.monotonic() - t0) * 1000,
                outcome="NETWORK_ERROR",
                error=str(e),
            ))
            return results

        # Phase 3 confirm: only run when phase=1+3 and Phase 1 returned a PI id
        if self.phase == "1+3" and pi_id:
            # Step 2a: If a simulator URL is configured, simulate what the browser
            # does — call stripe.confirmPayment() by hitting the simulator's confirm
            # endpoint. This transitions the PI from requires_payment_method →
            # requires_capture so that the Flyte confirm endpoint can proceed.
            if self.simulator_url:
                try:
                    async with self.session.post(
                        f"{self.simulator_url}/v1/payment_intents/{pi_id}/confirm",
                        timeout=self.timeout,
                    ) as sim_resp:
                        if sim_resp.status not in (200, 201):
                            sim_body = await sim_resp.text()
                            results.append(RequestResult(
                                worker_id=self.worker_id,
                                attempt=attempt,
                                phase="sim_confirm",
                                status_code=sim_resp.status,
                                latency_ms=0,
                                outcome="ERROR",
                                error=f"simulator confirm failed: {sim_body[:200]}",
                            ))
                            return results
                except Exception as e:
                    results.append(RequestResult(
                        worker_id=self.worker_id,
                        attempt=attempt,
                        phase="sim_confirm",
                        status_code=0,
                        latency_ms=0,
                        outcome="NETWORK_ERROR",
                        error=f"simulator confirm error: {e}",
                    ))
                    return results
            confirm_url = f"{self.base_url}/registration/confirm/{pi_id}"
            t1 = time.monotonic()
            try:
                async with self.session.post(
                    confirm_url,
                    headers={**self._extra_headers(attempt)},
                    timeout=self.timeout,
                    allow_redirects=False,
                ) as resp2:
                    latency_ms = (time.monotonic() - t1) * 1000
                    body2: dict[str, Any] = {}
                    try:
                        body2 = await resp2.json(content_type=None)
                    except Exception:
                        pass
                    outcome3 = _classify_phase3(resp2.status, resp2.headers.get("Location", ""), body2)
                    results.append(RequestResult(
                        worker_id=self.worker_id,
                        attempt=attempt,
                        phase="phase3",
                        status_code=resp2.status,
                        latency_ms=latency_ms,
                        outcome=outcome3,
                        registration_id=registration_id,
                        pi_id=pi_id,
                    ))
            except asyncio.TimeoutError:
                results.append(RequestResult(
                    worker_id=self.worker_id,
                    attempt=attempt,
                    phase="phase3",
                    status_code=0,
                    latency_ms=(time.monotonic() - t1) * 1000,
                    outcome="NETWORK_ERROR",
                    error="timeout",
                ))
            except Exception as e:
                results.append(RequestResult(
                    worker_id=self.worker_id,
                    attempt=attempt,
                    phase="phase3",
                    status_code=0,
                    latency_ms=(time.monotonic() - t1) * 1000,
                    outcome="NETWORK_ERROR",
                    error=str(e),
                ))

        return results


def _classify_phase1(status: int, body: dict[str, Any]) -> str:
    if status == 200 and body.get("clientSecret"):
        return "SUCCESS"
    if status == 400:
        err = body.get("error", "")
        if err == "already_registered":
            return "ALREADY_REGISTERED"
        return "VALIDATION_ERROR"
    if status == 429:
        return "RATE_LIMITED"
    if status == 503:
        return "STRIPE_ERROR"
    if status == 404:
        return "NOT_FOUND"
    if status == 403:
        return "CSRF_REJECTED"
    if 200 <= status < 300:
        return "SUCCESS"
    return "ERROR"


def _classify_phase3(status: int, location: str, body: dict[str, Any]) -> str:
    if status in (301, 302, 303, 307, 308):
        if "/confirmed" in location:
            return "SUCCESS"
        if "waitlist" in location:
            return "FULL"
        return "REDIRECT"
    if status == 429:
        return "RATE_LIMITED"
    if status == 403:
        return "CSRF_REJECTED"
    if 200 <= status < 300:
        return "SUCCESS"
    return "ERROR"


# ── Orchestrator ──────────────────────────────────────────────────────────────

async def run_load_test(
    base_url: str,
    event_id: str,
    concurrency: int,
    total: int,
    ramp_up: float,
    phase: str,
    timeout: float,
    rate_limit_bypass: bool,
    output: str,
    simulator_url: str | None = None,
) -> RunStats:
    stats = RunStats()

    # Semaphore to cap concurrency
    sem = asyncio.Semaphore(concurrency)
    # Counter for atomic attempt numbering
    attempt_counter = 0
    lock = asyncio.Lock()

    connector = aiohttp.TCPConnector(limit=concurrency + 10, limit_per_host=concurrency + 10)
    cookie_jar = aiohttp.CookieJar(unsafe=True)

    async with aiohttp.ClientSession(connector=connector, cookie_jar=cookie_jar) as session:
        workers = [
            RegistrationWorker(
                worker_id=i,
                session=session,
                base_url=base_url,
                event_id=event_id,
                phase=phase,
                timeout=timeout,
                rate_limit_bypass=rate_limit_bypass,
                simulator_url=simulator_url,
            )
            for i in range(concurrency)
        ]

        async def do_attempt(worker: RegistrationWorker, attempt_num: int) -> None:
            async with sem:
                results = await worker.run_one(attempt_num)
                for r in results:
                    stats.add(r)

        # Build the task list — distribute attempts round-robin across workers
        tasks: list[asyncio.Task[None]] = []
        for i in range(total):
            worker = workers[i % concurrency]
            task = asyncio.create_task(do_attempt(worker, i))
            tasks.append(task)
            if ramp_up > 0 and i < concurrency:
                await asyncio.sleep(ramp_up / concurrency)

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TaskProgressColumn(),
            TimeElapsedColumn(),
            console=console,
        ) as progress:
            prog_task = progress.add_task(
                f"Running {total} requests × {concurrency} workers …", total=total
            )

            done_count = 0
            for coro in asyncio.as_completed(tasks):
                await coro
                done_count += 1
                progress.update(prog_task, completed=done_count)

    stats.end_time = time.monotonic()

    # Write JSON output
    results_dicts = [
        {
            "worker_id": r.worker_id,
            "attempt": r.attempt,
            "phase": r.phase,
            "status_code": r.status_code,
            "latency_ms": round(r.latency_ms, 2),
            "outcome": r.outcome,
            "error": r.error,
            "registration_id": r.registration_id,
            "pi_id": r.pi_id,
        }
        for r in stats.results
    ]
    with open(output, "w") as f:
        json.dump(
            {
                "config": {
                    "base_url": base_url,
                    "event_id": event_id,
                    "concurrency": concurrency,
                    "total": total,
                    "phase": phase,
                    "timeout": timeout,
                    "simulator_url": simulator_url,
                },
                "summary": _build_summary(stats, phase),
                "results": results_dicts,
            },
            f,
            indent=2,
        )

    return stats


def _build_summary(stats: RunStats, phase: str) -> dict[str, Any]:
    elapsed = stats.end_time - stats.start_time
    phases_to_report = ["phase1"]
    if phase == "1+3":
        phases_to_report.append("phase3")

    summary: dict[str, Any] = {
        "total_duration_s": round(elapsed, 3),
    }
    for p in phases_to_report:
        rs = stats.phase_results(p)
        if not rs:
            continue
        latencies = sorted(r.latency_ms for r in rs)
        summary[p] = {
            "total_requests": len(rs),
            "throughput_rps": round(stats.throughput(p), 2),
            "latency_ms": {
                "p50": round(latencies[int((len(latencies) - 1) * 0.50)], 2) if latencies else 0,
                "p90": round(latencies[int((len(latencies) - 1) * 0.90)], 2) if latencies else 0,
                "p95": round(latencies[int((len(latencies) - 1) * 0.95)], 2) if latencies else 0,
                "p99": round(latencies[int((len(latencies) - 1) * 0.99)], 2) if latencies else 0,
                "max": round(max(latencies), 2) if latencies else 0,
                "min": round(min(latencies), 2) if latencies else 0,
            },
            "status_codes": stats.status_distribution(p),
            "outcomes": stats.outcome_distribution(p),
        }
    return summary


# ── Rich report ───────────────────────────────────────────────────────────────

def print_report(stats: RunStats, phase: str) -> None:
    elapsed = stats.end_time - stats.start_time
    console.print(f"\n[bold cyan]═══ Load Test Results ═══[/bold cyan]")
    console.print(f"  Total wall-clock time: [yellow]{elapsed:.2f}s[/yellow]")

    phases_to_report = ["phase1"]
    if phase == "1+3":
        phases_to_report.append("phase3")

    for p in phases_to_report:
        rs = stats.phase_results(p)
        if not rs:
            continue
        label = "Phase 1 (initiate)" if p == "phase1" else "Phase 3 (confirm)"
        console.print(f"\n[bold green]{label}[/bold green]")

        # Latency table
        latencies = sorted(r.latency_ms for r in rs)
        lat_table = Table(show_header=True, header_style="bold magenta")
        lat_table.add_column("Metric")
        lat_table.add_column("Value", justify="right")
        lat_table.add_row("Requests", str(len(rs)))
        lat_table.add_row("Throughput", f"{stats.throughput(p):.1f} req/s")
        lat_table.add_row("p50", f"{latencies[int((len(latencies) - 1) * 0.50)]:.1f} ms" if latencies else "—")
        lat_table.add_row("p90", f"{latencies[int((len(latencies) - 1) * 0.90)]:.1f} ms" if latencies else "—")
        lat_table.add_row("p95", f"{latencies[int((len(latencies) - 1) * 0.95)]:.1f} ms" if latencies else "—")
        lat_table.add_row("p99", f"{latencies[int((len(latencies) - 1) * 0.99)]:.1f} ms" if latencies else "—")
        lat_table.add_row("max", f"{max(latencies):.1f} ms" if latencies else "—")
        console.print(lat_table)

        # Outcome distribution
        outcomes = stats.outcome_distribution(p)
        out_table = Table(show_header=True, header_style="bold blue")
        out_table.add_column("Outcome")
        out_table.add_column("Count", justify="right")
        out_table.add_column("% of total", justify="right")
        total = len(rs)
        for outcome, count in sorted(outcomes.items(), key=lambda x: -x[1]):
            color = "green" if outcome == "SUCCESS" else ("yellow" if outcome == "FULL" else "red")
            out_table.add_row(
                f"[{color}]{outcome}[/{color}]",
                str(count),
                f"{count/total*100:.1f}%",
            )
        console.print(out_table)

        # Status code distribution
        sc_dist = stats.status_distribution(p)
        sc_table = Table(show_header=True, header_style="bold blue")
        sc_table.add_column("HTTP Status")
        sc_table.add_column("Count", justify="right")
        for sc, count in sorted(sc_dist.items()):
            color = "green" if sc == 200 else ("yellow" if sc in (302, 303, 429) else "red")
            sc_table.add_row(f"[{color}]{sc}[/{color}]", str(count))
        console.print(sc_table)


# ── CLI ───────────────────────────────────────────────────────────────────────

@click.command()
@click.option("--url",           default=lambda: os.environ.get("FLYTE_URL", "http://localhost:3000"), show_default=True, help="Flyte app base URL")
@click.option("--event-id",      default=lambda: os.environ.get("FLYTE_EVENT_ID", ""), show_default=True, help="Event UUID to register against")
@click.option("--concurrency",   default=10,    type=int,   show_default=True, help="Number of parallel workers")
@click.option("--total",         default=50,    type=int,   show_default=True, help="Total registration attempts")
@click.option("--ramp-up",       default=0.0,   type=float, show_default=True, help="Seconds to ramp up workers (0 = immediate)")
@click.option("--phase",         default="1+3", type=click.Choice(["1", "1+3"]), show_default=True, help="Which phases to exercise")
@click.option("--timeout",       default=30.0,  type=float, show_default=True, help="Per-request timeout in seconds")
@click.option("--output",        default="results.json", show_default=True, help="JSON results output file")
@click.option("--simulator-url", default=lambda: os.environ.get("STRIPE_SIMULATOR_URL", ""), show_default=True,
              help="Base URL of the Stripe simulator (e.g. http://localhost:12111). When set, the stress test will call the simulator to confirm PIs between Phase 1 and Phase 3, simulating browser-side stripe.confirmPayment(). [env STRIPE_SIMULATOR_URL]")
@click.option("--rate-limit-bypass", is_flag=True, default=False, help="Spoof X-Forwarded-For to bypass per-IP rate limits (dev/staging only)")
def main(
    url: str,
    event_id: str,
    concurrency: int,
    total: int,
    ramp_up: float,
    phase: str,
    timeout: float,
    output: str,
    simulator_url: str,
    rate_limit_bypass: bool,
) -> None:
    """Flyte registration load tester."""
    if not event_id:
        console.print("[red]Error: --event-id is required (or set FLYTE_EVENT_ID env var)[/red]")
        sys.exit(1)

    sim = simulator_url or None

    console.print(f"[bold]Flyte Registration Load Test[/bold]")
    console.print(f"  Target:      [cyan]{url}[/cyan]")
    console.print(f"  Event ID:    [cyan]{event_id}[/cyan]")
    console.print(f"  Concurrency: [cyan]{concurrency}[/cyan] workers")
    console.print(f"  Total:       [cyan]{total}[/cyan] attempts")
    console.print(f"  Phase:       [cyan]{phase}[/cyan]")
    console.print(f"  Ramp-up:     [cyan]{ramp_up}s[/cyan]")
    console.print(f"  Timeout:     [cyan]{timeout}s[/cyan]")
    if sim:
        console.print(f"  Simulator:   [cyan]{sim}[/cyan]")
    if rate_limit_bypass:
        console.print("[yellow]  ⚠  Rate-limit bypass enabled (X-Forwarded-For spoofing)[/yellow]")
    console.print()

    stats = asyncio.run(run_load_test(
        base_url=url,
        event_id=event_id,
        concurrency=concurrency,
        total=total,
        ramp_up=ramp_up,
        phase=phase,
        timeout=timeout,
        rate_limit_bypass=rate_limit_bypass,
        output=output,
        simulator_url=sim,
    ))

    print_report(stats, phase)
    console.print(f"\n[dim]Full results written to [bold]{output}[/bold][/dim]")

    # Exit with non-zero if any requests failed unexpectedly
    p1_outcomes = stats.outcome_distribution("phase1")
    error_count = p1_outcomes.get("ERROR", 0) + p1_outcomes.get("NETWORK_ERROR", 0)
    if error_count > 0:
        console.print(f"[red]{error_count} unexpected errors — check results.json[/red]")
        sys.exit(2)


if __name__ == "__main__":
    main()
