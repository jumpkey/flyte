# Flyte — Web Kit Standards

**Suite:** UI Elaboration v1 · Document 3 of 5
**Companions:** [`SITE-MAP-AND-STORYBOARD.md`](SITE-MAP-AND-STORYBOARD.md) · [`WIREFRAMES.md`](WIREFRAMES.md) · [`UI-IMPLEMENTATION-PLAN.md`](UI-IMPLEMENTATION-PLAN.md) · [`VIEWS-AND-ANALYTICS-ADDENDUM.md`](VIEWS-AND-ANALYTICS-ADDENDUM.md)

---

## 1. Purpose & how to use this document

This is a **requirements seed**, not a CSS framework. Flyte will adopt a
mature framework (recommendation in §11); this document defines what that
framework must be configured to produce. Every rule carries an ID
(`WK-<area>-<n>`) and MUST/SHOULD language:

- **MUST** — implementation is non-compliant without it; verified in the
  per-increment review and the I9 compliance audit (§12).
- **SHOULD** — default behavior; deviation requires a one-line justification
  in the PR.

"Compliance" means: the rendered page can be checked against this document by
someone who didn't build it. Wireframes are schematic — where a wireframe and
a WK rule disagree (e.g. exact accent shades), **this document wins**.

**Visual direction (owner decision D3): trust base + vivid accent.** A cool,
desaturated foundation that reads as payment-grade and calm, with one warm
vivid accent whose scarcity is the entire point: when only one thing on the
page is orange, the eye knows what to do.

---

## 2. Color system

### 2.1 Tokens

All colors ship as CSS custom properties on `:root`. Components reference
tokens, never raw hex — this is the dark-mode escape hatch (§2.5).

| Token | Hex | Role |
|---|---|---|
| `--fl-navy` | `#1F3A5F` | Brand primary: nav bars, admin sidebar, hero, headings on light |
| `--fl-navy-2` | `#2C5282` | Gradient partner for navy (hero, fallback cards) |
| `--fl-ink` | `#0F172A` | Display text, table emphasis |
| `--fl-text` | `#334155` | Body text |
| `--fl-muted` | `#64748B` | Secondary text, captions, labels |
| `--fl-line` | `#94A3B8` | Decorative strokes, disabled glyphs — **never information-bearing text** |
| `--fl-border` | `#CBD5E1` | Input borders |
| `--fl-border-l` | `#E2E8F0` | Card borders, dividers, table rules |
| `--fl-surface` | `#F1F5F9` | Inset panels, table headers, read-only fields |
| `--fl-canvas` | `#F8FAFC` | Page background |
| `--fl-white` | `#FFFFFF` | Cards, inputs, content panels |
| `--fl-flare` | `#E8590C` | **The accent.** Large CTAs, hero buttons, active-nav markers, focus ring |
| `--fl-flare-deep` | `#C2410C` | Accent for *small text* and standard-size button fills (AA-safe, §2.4) |
| `--fl-flare-hover` | `#D9480F` | Hover for **large CTAs only** — at 4.30:1 it fails AA behind small white text |
| `--fl-flare-deep-hover` | `#9A3412` | Hover for standard flare-deep buttons (7.31:1 with white — hovers go *darker*, never lighter) |
| `--fl-flare-tint` | `#FFF4EC` | Accent surfaces: callouts, annotation blocks |
| `--fl-success` / `-tint` / `-text` | `#2F9E44` / `#EBF7ED` / `#237032` | Positive: CONFIRMED, OPEN, success alerts |
| `--fl-warning` / `-tint` / `-text` | `#F08C00` / `#FFF4E0` / `#9C5A00` | Caution: pending states, low availability |
| `--fl-danger` / `-tint` / `-text` | `#E03131` / `#FDECEC` / `#C92A2A` | Destructive & failed: errors, refund/cancel actions |
| `--fl-info` / `-tint` / `-text` | `#1971C2` / `#E7F1FA` / `#1864AB` | Neutral-informational: REFUNDED, FULL, in-flight |

Each semantic family has three jobs: the **base** for fills and icons, the
**tint** for surfaces, the **text** variant for words (the base hues are too
light to read small — measured in §2.4).

### 2.2 Distribution — the 60/30/10 rule

- **WK-COL-1 (MUST):** Per screen, roughly 60% neutral field (canvas, white,
  surface), 30% structural brand (navy bars, ink/body text, borders), ≤10%
  accent + semantics. If a screen feels wrong, count the orange first.
- **WK-COL-2 (MUST):** **One Flare-filled element per viewport** — the
  primary action. Everything else that's interactive is navy, link-blue, or
  outline. Accent scarcity is what makes the CTA pop (selective attention:
  a unique hue in a field of neutrals is found pre-attentively; two unique
  hues compete and both lose).
- **WK-COL-3 (MUST):** Flare is FORBIDDEN for: body/long text, large area
  fills (> a button), destructive actions (danger red owns delete/refund/
  cancel — orange "delete" buttons train users to ignore the accent), and
  validation states.
- **WK-COL-4 (SHOULD):** Warm-vs-cool is deliberate: the orange accent is the
  complement-adjacent temperature of the navy base, which is why it reads as
  energetic against it. Don't add a second warm hue (no yellows/reds as
  decoration) — warmth must stay scarce or the trust base goes noisy.

### 2.3 Status mapping (single source of truth)

The status-pill partial (site map §4.4) MUST implement exactly this table —
pill text uses the `-text` variant on the `-tint` surface (**WK-COL-5, MUST**):

| Status | Family | | Status | Family |
|---|---|---|---|---|
| CONFIRMED, OPEN, `active` | success | | PENDING_CAPTURE, REFUNDED*, FULL, APPROVED | info |
| PENDING_PAYMENT, CLOSED, `shadow`, REQUESTED | warning | | PAYMENT_FAILED, CANCELLED, DENIED, LOCKED | danger |
| EXPIRED, DRAFT | neutral (muted/surface) | | | |

\* REFUNDED is a derived display status — site map §7.

Deliberate divergence: the admin **FULL pill is info** (a full event is a
neutral fact in a back office) while storefront **sold-out copy is
danger-text** (WK-CMP-10 — urgency is the message there). Pills describe
state; storefront copy persuades. Don't "fix" one to match the other.

### 2.4 Contrast — measured, not asserted

WCAG 2.1 AA: ≥ 4.5:1 normal text, ≥ 3:1 large text (≥ 24px regular /
≥ 18.66px bold) and non-text UI parts. Computed via relative luminance:

| Pair | Ratio | AA normal | Rule |
|---|---|---|---|
| ink on white | 17.85:1 | ✅ | unrestricted |
| body on white / canvas / surface | 10.35 / 9.90 / 9.45 | ✅ | unrestricted |
| white on navy | 11.48:1 | ✅ | unrestricted |
| navy on white / surface | 11.48 / 10.48 | ✅ | unrestricted |
| muted on white / canvas | 4.76 / 4.55 | ✅ | OK at any size |
| muted on **surface** | 4.34:1 | ❌ (large only) | **WK-COL-6 (MUST):** muted text on surface panels ≥ 16px, or use `--fl-text` |
| line `#94A3B8` on white | 2.56:1 | ❌ | decorative/disabled only (token table note) |
| white on flare `#E8590C` | 3.58:1 | ❌ (large only) | see WK-COL-7 |
| white on flare-deep `#C2410C` | 5.18:1 | ✅ | standard buttons |
| white on flare-deep-hover `#9A3412` | 7.31:1 | ✅ | standard-button hover |
| flare-deep on white / tint | 5.18 / 4.78 | ✅ | accent text/links |
| flare on white | 3.58:1 | ❌ (large only) | accent text must use flare-deep |
| success/warning/danger/info **base** on their tints | 3.13 / 2.28 / 3.95 / 4.39 | ❌ | bases are fills/icons only |
| success/warning/danger/info **text** on their tints | 5.55 / 4.97 / 4.78 / 5.32 | ✅ | pills, inline alerts |
| white on danger `#E03131` | 4.51:1 | ✅ | danger buttons OK |
| nav links `#C3D0E0` on navy | 7.34:1 | ✅ | inactive nav OK |

- **WK-COL-7 (MUST):** Pure Flare fills with white labels are reserved for
  **large CTAs** (label ≥ 18.66px bold — hero buttons, the event-detail
  register button). Standard-size buttons (14–16px labels) use
  `--fl-flare-deep` fill (5.18:1 ✅), hover `--fl-flare-deep-hover` (7.31:1 —
  hover must go darker, never lighter, so contrast never dips below AA). This
  is the honest resolution of a real conflict between the vivid accent and AA:
  we keep the vivid hue where text is big, and shift one step deeper where it
  isn't.
- **WK-COL-8 (MUST):** No new color pairs without a computed ratio. The token
  set above is the approved palette; additions go through this table.

### 2.5 Dark mode

Out of scope for v1 (**WK-COL-9, SHOULD**: don't build it speculatively). The
token indirection is the reservation: components never hardcode hex, so dark
mode later is a `:root[data-theme=dark]` token swap plus an image/elevation
audit — not a component rewrite.

---

## 3. Typography

- **WK-TYP-1 (MUST):** One family: **Inter**, self-hosted (woff2, weights
  400/600/700/800), `font-display: swap`, preloaded — no render-blocking, no
  third-party font CDN (keeps CSP tight, §10). Fallback stack:
  `Inter, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`.
  No second display family — weight and size carry the hierarchy; a second
  family buys variety and costs coherence + bytes.
- **WK-TYP-2 (MUST):** Major-third scale (×1.25) from 16px, as rem:

| Name | Size | Weight | Line-height | Use |
|---|---|---|---|---|
| `display` | 39px / 2.44rem | 800 | 1.15 | Hero headline only |
| `h1` | 31.25px / 1.95rem | 800 | 1.2 | Page title (one per page) |
| `h2` | 25px / 1.56rem | 700 | 1.25 | Section headings |
| `h3` | 20px / 1.25rem | 700 | 1.3 | Card titles, panel headings |
| `body` | 16px / 1rem | 400 | 1.6 | Default; forms, prose |
| `small` | 13.5px* | 400/600 | 1.5 | Table cells, meta, help text |
| `caption` | 12.8px / 0.8rem | 600 | 1.4 | Labels, pills, column headers |

\* `small` is the scale's 12.8 step nudged up for table legibility — the one
sanctioned off-scale size.

- **WK-TYP-3 (MUST):** Prose line length ≤ 72ch (event descriptions, emails).
  Reading rhythm collapses past ~75 characters; this is why form columns and
  description blocks cap at 560–720px, not the grid width.
- **WK-TYP-4 (MUST):** All money in `font-variant-numeric: tabular-nums`,
  right-aligned in tables, always two decimals, via the shared money helper —
  proportional digits make columns of figures unscannable.
- **WK-TYP-5 (SHOULD):** ALL-CAPS only at `caption` size with
  `letter-spacing: 0.06em` (column headers, KPI labels). Never caps body text.
- **WK-TYP-6 (MUST):** Headings use `ink` or `navy`; never muted, never accent.

---

## 4. Spacing & layout

- **WK-SPC-1 (MUST):** 8px base grid, 4px half-step. Scale tokens:
  `--sp-1..12` = 4, 8, 12, 16, 24, 32, 40, 48, 64, 80, 96, 128. All margins,
  paddings, gaps come from the scale — arbitrary values are what makes a UI
  feel subtly broken.
- **WK-SPC-2 (MUST):** Container max-width 1200px, centered, 12-column grid,
  24px gutters. Breakpoints: 480 / 768 / 1024 / 1280.
- **WK-SPC-3 (MUST):** Page archetype behavior:
  - *Storefront grid:* event cards 1-up < 480, 2-up < 768, 3-up < 1280, 3-up
    at desktop (4-up only if cards shrink past 280px — they shouldn't).
  - *Admin:* fixed 240px sidebar ≥ 1024px; below that it collapses to a top
    bar with a menu. Admin is desktop-first; it must be *usable* on mobile,
    not optimized.
  - *Forms:* single column, max 560px (WK-TYP-3 logic + one eye-path down the
    page; two-column forms double the error rate of "which field is this label
    for"). Paired short fields (first/last name, date/capacity) may share a row.
  - *Checkout/auth:* centered single panel, max 720px.
- **WK-SPC-4 (SHOULD):** Whitespace philosophy: trust = air. Section spacing
  ≥ `--sp-9` (64px) on storefront, ≥ `--sp-6` (32px) in admin. Crowding reads
  as discount-store; this brand charges money for things.
- **WK-SPC-5 (MUST):** Vertical rhythm inside components: heading→content gap
  is one scale step *smaller* than component→component gap (Gestalt proximity:
  related things sit closer than unrelated things, and the ratio must be
  visible, not subtle).

---

## 5. Component standards

States required for every interactive component (**WK-CMP-0, MUST**):
default · hover · focus-visible (§8 ring) · active · disabled · and where
async: loading. Error state additionally for inputs.

### 5.1 Buttons

- **WK-CMP-1 (MUST):** Four variants, used by meaning not by taste:
  - **Primary** — flare-deep fill (flare itself for large CTAs, WK-COL-7),
    white label, radius 8px. One per viewport (WK-COL-2).
  - **Secondary** — white fill, 1.5px navy border, navy label.
  - **Tertiary/link** — no border, navy label, underline on hover.
  - **Destructive** — danger fill (white label) for the confirming action
    inside a modal; danger-outline for the triggering button on the page.
- **WK-CMP-2 (MUST):** Sizes: 40px default, 48px checkout/hero, 32px
  table-inline. Labels verb-first ("Register", "Save event", "Confirm
  refund" — never "OK"/"Submit").
- **WK-CMP-3 (MUST):** Async buttons disable on submit and show an inline
  spinner replacing the label icon, label stays ("Pay $25.00" keeps showing
  what's happening). Double-submit is a payments bug, not a style bug.

### 5.2 Forms

- **WK-CMP-4 (MUST):** Label above every field, always visible, 600 weight.
  Placeholder is example content only, never the label (it vanishes exactly
  when the user starts answering).
- **WK-CMP-5 (MUST):** Inputs: 40px, white fill, `--fl-border` border, radius
  8px; focus per §8; read-only fields use surface fill (the locked email in
  logged-in checkout, WF-04). Required marked with `*`; optional fields
  labelled "(optional)" when the form is mostly-required.
- **WK-CMP-6 (MUST):** Validation: inline, per-field, on blur + on submit;
  danger-text message with icon below the field; border flips to danger.
  Message says how to fix, not what's wrong ("Email addresses don't match",
  not "Invalid input"). Server-side errors re-render with values preserved.
- **WK-CMP-7 (MUST):** The email double-entry (D1): second field labelled
  **Confirm email**, paste NOT blocked (blocking paste punishes password-manager
  users and stops nobody), compared trimmed/case-insensitive live on blur.
- **WK-CMP-8 (MUST):** Stripe Payment Element sits in a borderless container
  on the white panel with the order summary above it; we style around it, not
  inside it. The Pay button states the amount.

### 5.3 Event card (the signature component)

- **WK-CMP-9 (MUST):** Anatomy fixed (WF-01): 3:2 image (or §6 fallback) with
  date badge overlay → h3 title → muted meta line → price (h3-weight,
  tabular) + availability meter / state CTA. Whole card is one link; radius
  12px; border `--fl-border-l`; hover lifts one elevation step.
- **WK-CMP-10 (MUST):** Availability meter: 8px bar, success fill; switches
  to warning fill + warning-text label under 25% remaining ("12 of 50 left").
  Numbers AND color change (color is never the sole carrier, §8). Sold out:
  meter hidden, "Sold out" danger-text + waitlist link. Closed: card at ~55%
  opacity, no CTA.

### 5.4 Tables (admin)

- **WK-CMP-11 (MUST):** Surface-fill header row with caption-style column
  labels; 42–48px rows; row hover tint; row click navigates where a detail
  page exists (entire row is the target — Fitts), with the first cell also a
  real `<a>` for middle-click/keyboard.
- **WK-CMP-12 (MUST):** Money right-aligned tabular; status as pills (§2.3);
  timestamps muted, relative under 24h ("2h ago"), absolute after.
- **WK-CMP-13 (MUST):** Empty states are designed, not blank: one muted
  sentence + the action that fills the table ("No events yet — [New event]").
- **WK-CMP-14 (SHOULD):** Pagination + filters via HTMX swapping the table
  region; filter state lives in the query string (shareable, back-button-safe).
  Plain-GET fallback must work with JS off.

### 5.5 Pills, alerts, modals

- **WK-CMP-15 (MUST):** Pills: tint surface, `-text` color, 700 weight
  caption size, radius 999px. Pills are status, never actions.
- **WK-CMP-16 (MUST):** Alerts/banners: tint surface, 4px base-color left
  bar, ink text (WF-07). Toasts (flash messages) top-right, auto-dismiss 6s,
  also rendered inline for no-JS.
- **WK-CMP-17 (MUST):** Modals confirm every irreversible/money action
  (refund, cancel event, lock user) and MUST state the blast radius in
  numbers ("Refund all 38 registrations — $950") with the destructive verb on
  the danger button. Focus-trapped, Esc closes, initial focus on the
  *non*-destructive button.

### 5.6 Navigation

- **WK-CMP-18 (MUST):** Public top bar: navy, logo + Events left; Login /
  Sign up (or avatar menu) right; active link gets a 3px flare underline.
  Admin: §4 sidebar, active item highlighted with surface tint + 4px flare
  edge; "← Back to site" pinned at bottom.
- **WK-CMP-19 (SHOULD):** Breadcrumb (single "← parent" link style, WF-03/09)
  on every detail/form page; admin pages keep `<title>` = "Page · Flyte Admin".

---

## 6. Imagery

- **WK-IMG-1 (MUST):** Event images render 3:2, `object-fit: cover`, never
  stretched or letterboxed. One aspect ratio everywhere kills the
  ransom-note grid effect.
- **WK-IMG-2 (MUST):** Fallback card (D2) when `image_url` is null *or fails
  to load* (JS `onerror` swap + server-side null check): navy→navy-2 gradient,
  event initials (≤2 chars) at 800 weight, date beneath (WF-01 card 2). The
  fallback must look intentional — it's the default state, not an error.
- **WK-IMG-3 (MUST):** `alt` = event name; `loading="lazy"` below the fold;
  explicit `width`/`height` or `aspect-ratio` to prevent layout shift.
- **WK-IMG-4 (SHOULD):** No stock-photo hero imagery v1; the navy gradient +
  type hero (WF-01) is the brand. Cheap stock reads as cheap trust.

---

## 7. Motion

- **WK-MOT-1 (MUST):** Micro-transitions only: 150ms ease-out for
  hover/focus, 200–250ms for panel/modal enter. Nothing animates that the
  user didn't cause.
- **WK-MOT-2 (MUST):** `prefers-reduced-motion: reduce` → transitions ≤ 1ms
  globally. No parallax, no scroll-jacking, no marquee/auto-carousel, ever.
- **WK-MOT-3 (SHOULD):** Skeleton shimmer only for HTMX swaps > 300ms;
  under that, instant replacement (a skeleton you can barely see is jank).

---

## 8. Accessibility baseline (WCAG 2.1 AA)

- **WK-A11Y-1 (MUST):** Focus visible always: 2px flare ring, 2px offset, on
  every interactive element — including row-links and the Stripe container.
  Never `outline: none` without a replacement.
- **WK-A11Y-2 (MUST):** Full keyboard path through J1 (browse → pay) and J5
  (create event) — tested as part of I9. Modals per WK-CMP-17.
- **WK-A11Y-3 (MUST):** Color never the sole carrier: status pills carry
  words, the meter carries numbers, errors carry icons + text, charts (if
  ever) carry labels.
- **WK-A11Y-4 (MUST):** Touch targets ≥ 44×44px on mobile (sticky purchase
  bar, WF-16); form controls reachable and labelled (`<label for>`, error
  text linked via `aria-describedby`, errors announced with
  `role="alert"` on submit).
- **WK-A11Y-5 (MUST):** Semantic structure: one `h1` per page, landmarks
  (`nav`/`main`/`footer`), tables with `<th scope>`, buttons are `<button>`,
  links navigate and buttons act — no div-onclick anywhere.

---

## 9. Transactional email standards

- **WK-EML-1 (MUST):** Table-based layout, fully inline styles, 600px max
  width, system font stack (email clients don't load Inter — design for the
  fallback). Navy header band with the wordmark, white body, muted footer.
- **WK-EML-2 (MUST):** Exactly one CTA button per email, flare-deep fill
  (AA, §2.4), bulletproof-button markup (VML-safe is out of scope; padded
  `<a>` with bgcolor is the floor). Everything else is links.
- **WK-EML-3 (MUST):** Every user-originated string passes the existing
  `escapeHtml` (this is already enforced in `NotificationService` — keep it
  that way, security S4); every email has a plain-text part carrying the
  same content and links.
- **WK-EML-4 (MUST):** Receipts: amounts tabular, registration ID, event
  details, the capability link, and (per D1) the activation paragraph for
  shadow recipients. Subject lines state the event, not just "Confirmation".

---

## 10. Constraints from the codebase

- **WK-CODE-1 (MUST):** CSP forbids inline `<script>`: all JS stays in
  `public/js/` external files; HTMX attributes are fine (they're attributes,
  not scripts).
- **WK-CODE-2 (SHOULD):** `style-src` currently allows `'unsafe-inline'`;
  new work uses classes/external CSS so that allowance can eventually be
  retired. No `style=` attributes in new templates except the §9 emails
  (email ≠ web; CSP doesn't apply there).
- **WK-CODE-3 (MUST):** Adopting any CDN-hosted asset means updating the CSP
  allowlist in `src/web/app.ts` deliberately — prefer self-hosting (npm →
  build → `public/`) over widening CSP. The CSP **already** allows
  `unpkg.com` (HTMX) and `cdn.jsdelivr.net` (Pico CSS): increment I1
  self-hosts HTMX and the framework CSS and removes both hosts from the
  allowlist — the CSP gets *tighter* with this work, not looser. The planned
  `img-src https:` change for D2 event images is the one documented widening
  (security S5).
- **WK-CODE-4 (MUST):** HTMX is the interactivity layer: server-rendered
  partials swapped into regions (`hx-get` + `hx-target` for filters/
  pagination, `hx-boost` optional for nav). Every HTMX interaction has a
  working plain-HTTP fallback (WK-CMP-14). No SPA framework enters through
  the side door.
- **WK-CODE-5 (MUST):** All *data* interpolation in EJS uses escaped
  `<%= %>`. Raw `<%- %>` output is reserved for layout plumbing —
  `<%- include(…) %>` and `<%- body %>`, the only two uses in the existing
  codebase (`layouts/main.ejs`), and the only two the new admin layout may
  add. Raw output never touches request data, DB values, or anything
  user-originated.

---

## 11. Framework mapping

**Recommendation (WK-MAP-1, SHOULD): Bootstrap 5, themed via SCSS variable
overrides, compiled in our build, self-hosted.**

Rationale: the admin back office is table-, form-, and modal-heavy — exactly
the components Bootstrap ships hardened (focus management, modal traps,
collapse) — and a server-rendered EJS+HTMX app wants a class-based kit, not a
utility compiler. SCSS theming (`$primary: #C2410C; $body-color: #334155;
$font-family-base: Inter…; $border-radius: .5rem; $enable-negative-margins:
false…`) plus a thin `flyte.css` layer for the token custom properties,
event card, pills, meter, and admin sidebar (Bootstrap has no sidebar — ours
is ~60 lines). Map: buttons→`.btn` variants restyled per §5.1; forms→
`.form-label`/`.form-control` + our validation classes; tables→`.table` with
our header treatment; alerts/badges/modals→themed Bootstrap. Disable
Bootstrap's color-mode JS (we're light-only v1) and don't ship components we
don't use (custom SCSS build, import-by-part).

Alternatives, assessed: **Tailwind** maps tokens beautifully
(`@theme`/config) but pushes toward utility-soup in EJS templates and brings
a second build mindset; better for component-framework codebases than
server-rendered partials. **Stay on Pico + custom CSS** is viable (smallest
footprint) but means hand-building modal focus traps, table styles and form
validation states that Bootstrap gives for free — the admin build cost lands
on us. Either remains acceptable if the owner prefers; this document is
framework-agnostic by construction (Gate 0 confirms the choice).

- **WK-MAP-2 (MUST):** Whatever framework: tokens land as CSS custom
  properties with the §2.1 names; components must pass the §12 checklist
  identically. The framework is an implementation detail; this document is
  the contract.

---

## 12. Compliance checklist

Executed page-by-page in increment I9 (and spot-checked every increment).
Evidence column gets a link or a waiver note.

| ID | One-line check | ☐ |
|---|---|---|
| WK-COL-1 | 60/30/10 distribution holds per screen | ☐ |
| WK-COL-2 | One Flare-filled element per viewport | ☐ |
| WK-COL-3 | No accent on long text / large fills / destructive | ☐ |
| WK-COL-4 | No second warm hue introduced | ☐ |
| WK-COL-5 | Status pills use exactly the §2.3 mapping, `-text` on `-tint` | ☐ |
| WK-COL-6 | No sub-16px muted text on surface | ☐ |
| WK-COL-7 | White-on-flare only at ≥18.66px bold; standard buttons flare-deep | ☐ |
| WK-COL-8 | Every color pair in use appears in §2.4 with a ratio | ☐ |
| WK-COL-9 | No speculative dark-mode code | ☐ |
| WK-TYP-1 | Inter self-hosted, swap, preloaded; no font CDN | ☐ |
| WK-TYP-2 | Only scale sizes in use | ☐ |
| WK-TYP-3 | Prose ≤ 72ch | ☐ |
| WK-TYP-4 | Money tabular, 2 decimals, shared helper | ☐ |
| WK-TYP-5 | Caps only at caption + letterspacing | ☐ |
| WK-TYP-6 | Headings ink/navy only | ☐ |
| WK-SPC-1 | All spacing from the scale | ☐ |
| WK-SPC-2 | Container/grid/breakpoints as specified | ☐ |
| WK-SPC-3 | Archetype layouts behave at every breakpoint | ☐ |
| WK-SPC-4 | Section air ≥ sp-9 storefront / sp-6 admin | ☐ |
| WK-SPC-5 | Proximity ratio visible in components | ☐ |
| WK-CMP-0 | All interactive states present | ☐ |
| WK-CMP-1..3 | Buttons: variants, sizes, async behavior | ☐ |
| WK-CMP-4..8 | Forms: labels, validation, double-entry, Stripe container | ☐ |
| WK-CMP-9..10 | Event card anatomy + meter states | ☐ |
| WK-CMP-11..14 | Tables: structure, money, empty states, HTMX fallback | ☐ |
| WK-CMP-15..17 | Pills/alerts/modals incl. blast-radius copy | ☐ |
| WK-CMP-18..19 | Navigation patterns + titles | ☐ |
| WK-IMG-1..4 | 3:2 cover, fallback card, alt/lazy/no-CLS, no stock hero | ☐ |
| WK-MOT-1..3 | Timings, reduced-motion, skeleton threshold | ☐ |
| WK-A11Y-1..5 | Focus ring, keyboard journeys, non-color carriers, targets, semantics | ☐ |
| WK-EML-1..4 | Email structure, single CTA, escaping + text part, receipt content | ☐ |
| WK-CODE-1..5 | No inline JS, class-based CSS, CSP discipline (unpkg/jsdelivr retired), HTMX fallbacks, raw EJS only in layout plumbing | ☐ |
| WK-MAP-1..2 | Framework decision recorded; tokens as custom properties | ☐ |
