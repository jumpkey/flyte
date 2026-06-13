# Flyte — Views & Analytics Addendum

**Suite:** UI Elaboration v1 · Document 5 of 5
**Companions:** [`SITE-MAP-AND-STORYBOARD.md`](SITE-MAP-AND-STORYBOARD.md) · [`WIREFRAMES.md`](WIREFRAMES.md) · [`WEBKIT-STANDARDS.md`](WEBKIT-STANDARDS.md) · [`UI-IMPLEMENTATION-PLAN.md`](UI-IMPLEMENTATION-PLAN.md)
**Status:** DRAFT — functional gap review of the suite, done while structural changes are still cheap.

---

## 1. Method: driving questions drive views

The base suite was derived from *operations* (what must exist for the site to
function). This pass is derived from *curiosity and anticipation*: at every
moment of every journey, what does the person **want to know**, and is there a
view that answers it? Where the answer needs data we aren't capturing yet,
that's a structural change — flagged in §5 and folded into migration 007 now,
because a booking curve we start recording at launch is a booking curve we
*have* in month two.

Views are tagged `A-n` (admin) and `V-n` (visitor/user) and mapped to
increments in §7.

---

## 2. The journeys, re-walked for questions

### Admin: the life of an event

| Moment | Driving questions | Answered by |
|---|---|---|
| **Plan** | What sold well before? What price/capacity worked? | A1 sales dash, A2 history of past events |
| **Publish** | Did I forget anything? Is it live? Does the card look right? | existing WF-09 preview; A5 "DRAFT with approaching date" nudge |
| **Sell** | Is it selling? Fast enough? **Will it sell out — and when?** Should I push promotion? Should I add capacity? | **A2 booking curve + projection**, A3 pace column, A5 at-risk alerts |
| **Run (day-of)** | Who's coming? Who's here? Who paid but didn't show? | **A6 check-in view**, A7 roster export |
| **Settle** | Did the money all land? Any refunds pending? Anything stuck? | existing WF-11/15; A5 stuck-payment panel |
| **Learn** | How did it compare? When did people book? Where did buyers come from (new/repeat)? | A1, A2 retrospective mode, A4 customers |

### Admin: running the business (not one event)

| Driving questions | Answered by |
|---|---|
| How's revenue trending? Best month ever? | A1 |
| What % of started checkouts become paid? Where do they drop? | A1 payment funnel |
| How much revenue have failed/abandoned payments cost? | A1 funnel losses |
| Who are my regulars? Are guest buyers becoming account holders (is D1 working)? | A4 |
| Is the *system* healthy — emails sending, captures completing, reconciliation clean? | A5 |

### Visitor: discover → assess → commit → anticipate → attend

| Moment | Driving questions | Answered by |
|---|---|---|
| Discover | What is this? Anything for me? | existing WF-01/02; **V3 social cards** (discovery happens in chat apps — a pasted link must unfurl well) |
| Assess | Where exactly is it? Can I make it? What if I can't come? | **V4 map link**; refund-policy line on detail/checkout (content slot, V6) |
| Commit | (covered: checkout) | — |
| Anticipate | When is it again? → calendar. *Where's my confirmation email?!* | **V2 add-to-calendar (ICS)**; **V1 find-my-registration** — guests hold only a bearer URL in one email; losing it currently means emailing the admin |
| Attend | (v1: show up) | A6 sees them |
| Follow up | What else does this org run? What did I go to? | **V5 past-events view**; existing My Registrations |
| Waitlist limbo | Am I moving up? Still on it? | **V7 live waitlist-position page** (ack shows join-time position only) |

The strongest gaps by impact: **A2** (the selling moment is where an admin
lives, and we currently show only a static count), **V1** (the only recovery
path for the majority customer type — guests — is human support), and **V3**
(free distribution).

---

## 3. Admin views

### A1 — Sales & business dashboard · `GET /admin/analytics` *(new, WF-17)*

The business-wide money view; `/admin` stays the *operational* morning page,
this is the *analytical* one. Default range 90 days, toggle 30/90/365/all
(HTMX swap, range in query string).

- **KPI row:** gross revenue, net (minus refunds), AOV, refund rate %, each
  with prior-period delta arrows.
- **Revenue chart:** daily net revenue bars + 30-day trend line.
- **Payment funnel:** initiated → authorized → captured → confirmed as
  horizontal bars with absolute counts, % conversion between stages, and the
  money value lost at each drop (PENDING_PAYMENT→EXPIRED = abandonment;
  PAYMENT_FAILED = declines). Data: registration status history (all states
  already persisted).
- **Per-event table:** event, status, fill %, gross, net, refund %, days
  on sale → row links to A2.
- **Customers strip (A4):** new vs returning buyers this period, repeat-buyer
  rate, **shadow→active activation rate** (the D1 success metric), top 5
  customers by lifetime net.

### A2 — Event performance · `GET /admin/events/:id/performance` *(new, WF-18)* + summary panel on WF-10

The view for the **sell** moment, also useful retrospectively after the event.

- **Projection callout** (the headline): one sentence in plain words —
  "Projected to sell out **Jun 17** — 3 days before the event", or "At the
  current pace this event reaches **62% of capacity** — consider promotion",
  or "Demand is outrunning capacity by ~14 seats — consider expanding" —
  with a confidence qualifier (§3.1).
- **Booking curve:** cumulative confirmed registrations over time from
  `opened_at` to `event_date`; capacity as a dashed ceiling; today marker;
  dotted projection line continuing at current velocity. Capacity changes
  (from `user_action_events.metadata`) render as step annotations.
- **Velocity panel:** daily bookings bars + **7-day moving average** line;
  current velocity (regs/day); pace index vs linear baseline.
- **Funnel for this event:** views→checkouts→paid if Q7 lands, else
  checkout→paid only.
- **Companions:** waitlist depth over time, revenue to date, refunds count,
  CSV export buttons (A7).
- WF-10 (event detail) gains a compact strip: sparkline + projection sentence
  + link here. WF-08 (events list) gains a **pace** column (A3): pill-style
  badge `AHEAD / ON PACE / AT RISK / SOLD OUT` from the same math.

### 3.1 Projection math (v1 — honest and simple)

All times in days; `t` = now. Implementable as one SQL query + 20 lines.

```
days_on_sale   = max(1, t − opened_at)
window         = min(7, days_on_sale)
velocity v     = confirmed_count_in(t − window … t) / window        [regs/day]
remaining      = available_slots
days_to_event  = event_date − t

projected_sellout_date = t + remaining / v                  (when v > 0)
projected_fill         = min(capacity, confirmed + v × days_to_event)
demand_overflow        = max(0, v × days_to_event − remaining)
expected_fraction      = (t − opened_at) / (event_date − opened_at)   [linear baseline]
pace_index             = (confirmed / capacity) / expected_fraction
```

**Bands:** `SOLD OUT` (remaining = 0) · `AHEAD` (pace_index > 1.15) ·
`ON PACE` (0.85–1.15) · `AT RISK` (pace_index < 0.85 **or**
projected_fill < 80% capacity).

**Honesty rules (MUST):** when `days_on_sale < 3` or `confirmed < 5`, the
callout is prefixed "Early days — low confidence" and no sellout date is
shown. Projections are labelled "at current pace", never presented as fact.
The linear baseline is deliberately naive for v1: real booking curves are
bimodal (early spike + last-minute surge), and the right fix is fitting
against **our own accumulated curves** once a few events have completed —
that's a v2 item that depends on `opened_at` existing from day one (§5),
which is the structural point of this addendum.

### A5 — Needs-attention panel · extends `/admin` (WF-07)

The dashboard currently surfaces only pending refund requests. Generalize to
a prioritized attention list (each row: icon, sentence, deep link; section
hidden when empty — the calm-page rule from WF-07 holds):

| Trigger | Sentence pattern |
|---|---|
| Pending refund requests (existing) | "3 refund requests waiting · oldest 2 days" |
| `PENDING_CAPTURE` older than 2h | "2 payments stuck in capture — view transactions" |
| `CONFIRMED` with `confirmation_email_sent_at IS NULL` > 1h | "1 receipt email unsent" |
| Reconciliation runner hasn't completed in > its interval | "Reconciliation overdue — last ran 9h ago" |
| `DRAFT` event with `event_date` < 14 days away | "Autumn Retreat is still a draft and starts in 12 days" |
| A2 `AT RISK` events | "Summer 5K pacing to 62% — view performance" |
| Events in the next 7 days | "Intro to Sailing runs Saturday · 42 confirmed — check-in / roster" |

### A6 — Day-of check-in · `GET /admin/events/:id/checkin` *(optional increment I11)*

Mobile-first (the admin is standing at a door with a phone): search-as-you-type
roster, one **tap = check in** per row (HTMX POST, sets
`registrations.checked_in_at`), undo, progress bar "38 / 42 checked in",
walk-up hint pointing at the normal register flow. Requires only the §5
column; everything else is a thin view. Also turns A2 retrospective into
attendance data (no-show rate) for free.

### A7 — CSV exports *(part of I5)*

`GET /admin/events/:id/roster.csv`, `GET /admin/registrations.csv` (honors
the WF-11 filters), `GET /admin/events/:id/waitlist.csv`. adminGuard, same
queries as the HTML views, `Content-Disposition: attachment`. The door list,
the accountant hand-off, and the "slice it in a spreadsheet" escape hatch in
~40 lines total.

---

## 4. Visitor & user views

### V1 — Find my registration · `GET/POST /find-registration` *(new)*

The guest recovery path. Form: email → always renders "If that address has
registrations, we've emailed the links" (no enumeration); the email lists the
person's active registrations with their confirmation (capability) URLs.
Rate-limited RL(5), CSRF, reuses the forgot-password timing-pad pattern.
Linked from the storefront footer and the login page ("Bought tickets as a
guest?"). *Without this, a guest who deletes one email has no self-service
path at all.*

### V2 — Add to calendar (ICS) · `GET /registration/:registrationId/calendar.ics` *(reinstated from v2 parking)*

Was cut in the deep review for being unassigned; it's now assigned (I7) and
specified: standards-minimal VEVENT (UID = registration UUID, DTSTART from
`event_date` in the Q5 venue timezone, SUMMARY, LOCATION, DESCRIPTION with
the confirmation URL). Button returns to WF-05 and My Registrations rows.
~30 lines, no dependency.

### V3 — Social cards (Open Graph) · meta on `/events/:id` *(I2)*

`og:title` (event name), `og:description` (first line of description),
`og:image` (`image_url`, else a static brand card — generating fallback-card
images is v2), `og:type=event`, canonical URL, Twitter summary-card tags.
Zero UI; turns every shared link into a poster. Discovery for a small events
site *is* links pasted into chats.

### V4 — Map link · on `/events/:id` *(I2)*

`location` text renders with a "Map ↗" link:
`https://www.google.com/maps/search/?api=1&query={urlencoded location}` —
plain link, no API key, no CSP change, opens the native maps app on mobile.

### V5 — Past events · `/events?when=past` *(I2)*

Catalog toggle "Upcoming / Past". Past events render in the WF-02 closed
style with "Held on {date}". Answers the visitor's "what does this org
actually run?" trust question and gives CLOSED/CANCELLED links somewhere
dignified to live forever (extends the Q1 decision).

### V6 — Static pages · `/about` `/contact` `/terms` `/privacy` *(I2)*

WF-01's footer already links Terms · Privacy · Contact — but the pages were
never specced. Plain EJS content pages, single prose column (WK-TYP-3), admin
contact email on /contact. The refund-policy paragraph lives on /terms and is
excerpted as one line on event detail + checkout ("Refundable until the event
— see policy"). A payments site without reachable terms reads as a scam.

### V7 — Live waitlist position · `GET /waitlist/:waitlistEntryId` *(I3, with the waitlist work)*

The ack page shows position at join time and goes stale immediately. A
capability URL (same bearer pattern as confirmations, UUID PK already exists)
showing current position and event status, linked from the waitlist email.
One query.

### Recorded but deferred (v2 parking, site map §9)

Email change on profile (currently read-only — it's auth-sensitive and needs
re-verification flow) · event-update notification emails ("time changed") ·
QR codes on confirmations feeding A6 scanning · generated OG fallback images.

---

## 5. Structural deltas (fold into migration 007 — the reason this review happened now)

```sql
-- Curve math needs to know when selling started. Set once, on the first
-- DRAFT→OPEN transition; backfill pre-007 events from created_at.
ALTER TABLE events ADD COLUMN opened_at TIMESTAMPTZ;
UPDATE events SET opened_at = created_at WHERE status <> 'DRAFT';

-- Check-in (A6). Cheap now, impossible to backfill later.
ALTER TABLE registrations ADD COLUMN checked_in_at TIMESTAMPTZ;

-- Q7 (if accepted): first-party, privacy-clean page-view counters so A1/A2
-- can show view→checkout→paid conversion. Aggregate counts only — no IP,
-- no UA, no cookies, no per-visitor rows.
CREATE TABLE page_views (
  day      DATE NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('event_detail','checkout','catalog','home')),
  event_id UUID REFERENCES events(event_id),
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, event_id)
);
```

No other tables needed: booking curves derive from `registrations.created_at`
/ `confirmed_at` (already persisted), funnel stages from existing statuses
and timestamps, capacity-change annotations from `user_action_events.metadata`
(JSONB — already in the schema; I4's event-edit action just records
`{field, old, new}`). Daily rollup tables are explicitly **not** added —
at this scale `date_trunc` over `registrations` is instant; rollups are a
scale problem we should be lucky enough to have.

## 6. Chart rendering decision

Charts are **server-rendered inline SVG** from a small TS helper (line, bar,
sparkline, h-funnel — ~150 lines, no axes library): fits the EJS+HTMX
architecture, zero dependencies, zero CSP impact (inline SVG is markup, not
script), prints cleanly, and range toggles are just HTMX swaps of the chart
partial. A charting library (Chart.js etc.) is rejected for v1: it would be
the largest JS dependency on the site to draw six charts. Colors use the WK
tokens (navy series, flare for projection/today markers, muted gridlines);
every chart carries its numbers in text too (WK-A11Y-3 — the chart is the
garnish, the sentence is the data).

## 7. Increment impact

| Increment | Change |
|---|---|
| I1 | Migration 007 gains §5 columns (and `page_views` if Q7 accepted) |
| I2 | + V3 social cards, V4 map link, V5 past toggle, V6 static pages |
| I3 | + V7 live waitlist position |
| I4 | Event edits log `{field, old, new}` into `user_action_events.metadata`; DRAFT→OPEN sets `opened_at` |
| I5 | + A5 attention panel (supersedes the single refund banner), A7 CSV exports |
| I7 | + V2 ICS endpoints + buttons |
| **I10** *(new)* | A1 analytics dashboard, A2 event performance + WF-08/WF-10 pace surfaces, A4 customers strip, chart helper (§6). After I5; sized M |
| **I11** *(new, optional)* | A6 check-in. After I4; sized S. Ship before the first real event |

Sequencing note: I10 is deliberately late — it *reads* what I1–I5 *record*.
The structural columns land in I1 precisely so that by the time I10 ships,
real curves exist to draw.

### Acceptance criteria

**Absorbed items.** ① `opened_at` set exactly once on first DRAFT→OPEN and
backfilled for pre-007 events; event edits write `{field, old, new}` to
`user_action_events.metadata` (I4). ② Social-card meta validates in a card
debugger; map link URL-encodes hostile location strings; static pages reachable
from the footer; past toggle never leaks DRAFT (I2). ③ Waitlist position page
404s on unknown UUIDs and reflects promotions/removals (I3). ④ Attention
panel: each §3-A5 trigger fires on a fixture and the panel is absent when all
are clear; CSV exports match their HTML views row-for-row under the same
filters, adminGuard-protected (I5). ⑤ Find-my-registration responds
identically for known/unknown emails (timing-padded), emails only active
registration links, RL(5); ICS imports cleanly into Google/Apple Calendar with
the Q5 timezone (I7).

**AC-I10.** ① Projection math reproduces §3.1 on a fixture curve (unit-tested
against hand-computed values, including the low-confidence guards and each
band boundary). ② Booking curve, funnel, and revenue charts render from
seeded data with their plain-text sentences present (WK-A11Y-3); charts are
inline SVG with zero new JS dependencies. ③ Range toggles are HTMX swaps with
query-string state and plain-GET fallback. ④ Pace badges on WF-08 match A2's
band for the same fixtures. ⑤ Funnel counts reconcile exactly with the
transaction log's status counts for the same period.

**AC-I11.** ① Check-in sets `checked_in_at` once (idempotent; undo clears
it), HTMX row swap, adminGuard + CSRF. ② Search filters the roster
client-round-trip in < 1s on 300 rows. ③ Progress count is live. ④ Usable
one-handed at 375px (44px targets — WK-A11Y-4).

## 8. Explicit non-goals (v1)

Third-party analytics (GA etc. — Q7 is the privacy-respecting answer) ·
cohort/retention analysis · A/B testing · ML demand forecasting (the §3.1
linear model with honesty labels beats a black box at this scale) ·
revenue recognition/accounting exports beyond CSV · cross-event customer
segmentation UI.

## 9. New open questions (Gate 0)

| # | Question | Default |
|---|---|---|
| Q7 | First-party page-view counters (aggregate, anonymous) so conversion funnels include the view stage? | Yes — counts only, no visitor data; revisit if privacy posture says otherwise |
| Q8 | Is check-in (A6/I11) in v1 scope? | Yes if a real event happens within a month of launch; otherwise first v2 item |
