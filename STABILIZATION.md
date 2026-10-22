# Stabilization testbed runbook

This branch is prepared for an explicit deployment to the existing `flyte`
testbed. It has not been deployed by this runbook. GitHub's legacy push-based
Fly Deploy workflow is disabled; the repository workflow is `workflow_dispatch`
only. Use an explicit CLI deployment for this branch. Re-enable the GitHub workflow only after its manual-only definition has reached the default branch. The Fly release command runs the serialized, transactional migration
runner before starting web and worker processes.

Before deploying, confirm that Fly's Stripe secret is still a test key
(`sk_test_…`). A pre-migration volume snapshot exists: `vs_bR19nA3O3Y7Ukql3NLD735m`
for volume `vol_r68pkzz10xdewyd4` (created 2026-10-22). The smoke script also
requires a database whose current name is `flyte`; it refuses live Stripe keys,
simulator redirects, and calls without an explicit testbed acknowledgement.

After a manual deploy, check `fly status --app flyte`, `fly checks list --app
flyte`, and `fly logs --app flyte`. `/health` performs a database readiness
query and returns the deployed `APP_REVISION`; Fly routes traffic only after
the configured readiness check succeeds. The web process has one minimum
running machine. Confirm both `web` and `worker` processes are present; the
worker runs the reconciliation schedule in `/app/crontab`.

Migration `011_security.sql` conservatively classifies accounts that were
already locked as administrative suspensions, since the previous schema did
not record why they were locked. Review these legacy accounts and explicitly
unlock legitimate users through the admin interface; subsequent failed-login
locks remain recoverable through ordinary password reset.

Run the test-mode payment smoke only against the testbed database after
verifying its backup and Stripe mode:

```sh
FLYTE_TESTBED_SMOKE=YES npm run smoke:stabilization
```

It creates uniquely named, temporary events and registrations using
`example.invalid` addresses; it checks lifecycle rejection, card authorization
and capture, duplicate confirmation, partial and full refunds, and event
cancellation. It deletes those database fixtures only after every check passes.
Stripe test-mode PaymentIntents and refunds remain in the Stripe dashboard for
inspection. On failure, fixtures are deliberately retained for diagnosis.
Notifications are no-op in this script.

Set `SMOKE_TEST_WEBHOOK=1` to additionally POST a locally signed test event to
the app's webhook handler. That checks signature validation and handler routing
inside this process; it does **not** verify delivery from Stripe to Fly's
configured public webhook endpoint. Do not use a live Stripe key for any smoke
test.
