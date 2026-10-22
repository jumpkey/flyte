# Preserved load-test evidence

- `2026-10-22-local.zip`: isolated local request timings, scenario results, query comparison and resource samples.
- `2026-10-22-fly.zip`: existing-testbed manifests, request timings, page probes, resource samples, reconciliation, cleanup, restoration and CI evidence. Includes the failed generator/proxy run as well as its completed rerun.

These archives contain synthetic identifiers, not environment/credential backups or original customer database exports. Early/intermediate states are historical; use the final reconciliation and [consolidated interpretation](../../REVIEW-AND-RESILIENCE-SUMMARY.md) for outcomes. The Fly archive excludes captured session identifiers. The testbed is no longer routed to the simulator.
