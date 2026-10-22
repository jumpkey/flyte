# Stabilization testbed runbook

This branch was deployed to the existing `flyte` testbed on 2026-10-22.
The live URL is https://flyte.fly.dev; `/health` identifies its deployed revision. GitHub's legacy push-based
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


## Verified deployment and remaining limits

The release applied migrations 011–014 successfully. The public database
readiness check passed. A web machine and a supercronic worker are running;
the scheduled five-minute recovery run completed with zero unresolved items.
The extra worker machine is a stopped standby. Existing demonstration records
were retained; six fabricated `pi_demo_` pending registrations with
`@demo.flyte.test` addresses were expired through the normal SQL transition.
Two clearly labeled future test events were added for manual testing.

Real Stripe **test-mode** authorization/capture, duplicate confirmation,
partial-then-full refunds and event cancellation passed. The existing Stripe
webhook endpoint was missing both PaymentIntent subscriptions; these were
added while retaining its existing charge subscriptions. A public signed
request passed, and a real authorization delivered by Stripe confirmed its
registration without a client-confirm call. Temporary financial smoke rows
were removed after their successful refunds. Stripe test objects remain.
Free registration also completed through the deployed browser interface.

The local suite passed all 16 registration files, all 16 web files, and the
migration runner checks. Node 24 CI exposed an old SMTP test that depended on
platform-specific connection-error text; it now delivers all three notification
messages to an isolated local SMTP sink. Production build and typechecking
pass. Sass still reports upstream Bootstrap deprecations.

Known limits and intentional deferrals:

- A refreshed/new browser page does not resume a paid checkout. Back/Continue
  within the current page preserves its intent. Changed participant details
  require abandoning that attempt and waiting for expiration; the server does
  not reveal another person's payment secret based on an email address.
- Signup still distinguishes existing email addresses in some responses.
  Neutral email-availability hints reduce explicit enumeration, but full
  account-enumeration resistance is not claimed. Unguessable registration
  links retain their existing bearer-capability access policy.
- Waitlist handling is manual; both page and email copy now say so.
- Mail composition/local SMTP delivery is tested; delivery to a real inbox,
  bounce handling, 3-D Secure, wallets and all browser/assistive-technology
  combinations have not been exercised. No real-money rollout was performed.
- Refund operations without a known processor refund ID stop automatic retry
  after 23 hours, before Stripe's idempotency retention boundary. An operator
  must investigate Stripe before deciding whether to retry. Refund notification
  delivery remains best effort and is not a durable mail queue.
- Event times default to explicitly labeled UTC. Set EVENT_TIME_ZONE to an IANA
  zone only as a deliberate operator choice; changing it changes the editor's
  interpretation/display, not stored instants.
- Automated browser layout checks were not added to CI. Manual responsive
  checks covered 320, 375, 768 and 1440 pixels. Full keyboard/screen-reader
  auditing, optional card-density polish and broad code cleanup remain deferred.
- No merge into main was performed. Keep the legacy Fly Deploy workflow disabled
  until its manual-only definition reaches the default branch.

Rollback is a deliberate operation: the migrations are additive but old code
must not process new CANCELLING/refund-operation states. Prefer a forward fix.
If a full rollback is necessary, stop financial processing and restore the
pre-migration database snapshot together with the previous application image;
restoring the snapshot loses writes made after it. Do not run historical
`migrate:down` sections blindly. The pre-migration snapshot has limited retention.
