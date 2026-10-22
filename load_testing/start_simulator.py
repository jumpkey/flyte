"""Run the simulator with one explicit dual-stack HTTP listener."""

import asyncio
import os

import uvicorn

import stripe_simulator as sim


async def main() -> None:
    port = int(os.environ.get("STRIPE_SIM_PORT", "12111"))
    http_listener = sim._dual_stack_listener(port)
    config = uvicorn.Config("simulator_instrumented:app", log_level="info")
    server = uvicorn.Server(config)
    try:
        await server.serve(sockets=[http_listener])
    finally:
        http_listener.close()


if __name__ == "__main__":
    asyncio.run(main())
