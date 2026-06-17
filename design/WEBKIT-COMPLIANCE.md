# WebKit §12 Compliance Audit (I9)

**Status:** executed 2026-06-17 against `ui-elaboration`. Each WebKit requirement
is marked **✓ met** (and where it lives / how it's checked), **⏳ owner-verify**
(needs a headed browser — Lighthouse / keyboard walkthrough, which the headless
CI environment can't run), or **— waived** with a reason. This satisfies AC-I9 ①;
AC-I9 ② (keyboard-only J1/J5, 375px) and ③ (Lighthouse ≥95) are the owner-verify
items below.

## Color (WK-COL)
| ID | Requirement | Status |
|----|-------------|--------|
| WK-COL-1 | 60/30/10 neutral/secondary/accent per screen | ✓ trust-base layout; accent reserved for CTAs |
| WK-COL-2 | One Flare-filled element per viewport | ✓ `.btn-cta` is the single accent fill per page |
| WK-COL-3 | No accent on long text / large fills / destructive | ✓ destructive uses `.btn-danger`/`-outline-danger` |
| WK-COL-5 | Status pills exactly the §2.3 mapping, text-on-tint | ✓ `view-helpers.statusPill` + `status-pill.test.ts` (exhaustive snapshot) |
| WK-COL-7 | White-on-flare ≥18.66px bold; standard buttons flare-deep | ✓ `$fl-flare-deep` for `.btn-primary`, pure flare reserved for `.btn-cta` |

## Type (WK-TYP)
| ID | Requirement | Status |
|----|-------------|--------|
| WK-TYP-3 | Prose ≤72ch (descriptions, emails, static pages) | ✓ static pages + auth panels width-capped |
| WK-TYP-4 | Money tabular-nums | ✓ `.money` class; `money()` helper everywhere |

## Components (WK-CMP)
| ID | Requirement | Status |
|----|-------------|--------|
| WK-CMP-0 | Every interactive component has its states | ✓ Bootstrap states + custom hover/focus |
| WK-CMP-3 | Async buttons disable on submit, inline status | ✓ checkout (`registration-form.js`) disables + relabels |
| WK-CMP-4/5/6 | Labels above fields; 40px inputs; inline validation | ✓ `form-field` partial + per-form labels; server + client validation |
| WK-CMP-7 | Email double-entry, paste not blocked | ✓ I3 confirm-email field; no paste handler |
| WK-CMP-9/10 | Event card + availability meter | ✓ `event-card` partial; `.meter` with low-state amber |
| WK-CMP-14 | Every HTMX interaction has a plain-HTTP fallback | ✓ catalog filters/pagination + transaction log degrade to GETs |
| WK-CMP-15 | Status pills, radius 999px, caption size | ✓ `.pill` in `flyte.scss` |

## Accessibility (WK-A11Y / §8)
| ID | Requirement | Status |
|----|-------------|--------|
| WK-A11Y-1 | Visible focus everywhere | ✓ `:focus-visible` outline in `flyte.scss` |
| WK-A11Y-3 | Color never the sole status carrier | ✓ pills carry text labels (verified in `status-pill.test.ts`) |
| §8 | Skip-link, landmark, lang, labelled controls | ✓ skip-link + `#main` landmark + `lang="en"` (`polish.test.ts`) |
| AC-I9 ② | Keyboard-only J1 & J5, 375px width | ⏳ **owner-verify** (headed browser) — focus order and the mobile sticky CTA are in place to support it |
| AC-I9 ③ | Lighthouse a11y ≥95 on /, event detail, checkout, admin dashboard | ⏳ **owner-verify** (Lighthouse needs Chromium; not available headless in CI) |

## Responsive (WF-16)
| Item | Status |
|------|--------|
| Mobile sticky purchase bar | ✓ `.sticky-cta` on event detail, shown ≤575px |
| 44px touch targets | ✓ `.btn` min-height 44px (48px for primary/CTA) at phone widths |
| Admin desktop-first, degrades <1024px | ✓ admin sidebar collapses to a top bar |

## Transactional email (WK-EML / §9)
| ID | Requirement | Status |
|----|-------------|--------|
| WK-EML-1 | Table layout, inline styles, 600px, system font, navy header | ✓ `email-template.wrapEmail` (`polish.test.ts`) |
| WK-EML-2 | Exactly one CTA button, flare-deep | ✓ single `background-color:#C2410C` button asserted in test |
| WK-EML-3 | User strings escaped; plain-text part on every email | ✓ `escapeHtml` at call sites (S4, tested I6); `text:` on every `sendMail` |
| WK-EML-4 | Receipts: tabular amount, registration ID, capability link | ✓ `sendRegistrationConfirmation` receipt table + CTA |

## Code constraints (WK-CODE)
| ID | Requirement | Status |
|----|-------------|--------|
| WK-CODE-1 | No inline `<script>`; JS in `public/js/` | ✓ all JS external; only HTMX attributes inline |
| WK-CODE-3 | CDN hosts removed from CSP; self-hosted assets | ✓ I1 dropped unpkg + jsdelivr; only Stripe domains remain |
| WK-CODE-5 | No raw `<%- %>` data interpolation | ✓ raw is layout plumbing only; data uses `<%= %>` |

## Waivers
- None outstanding. The two ⏳ items are not waived — they require a headed
  browser the CI environment lacks; run them locally per
  `STRIPE-LIVE-SANDBOX-TEST-GUIDE.md` Appendix D (Playwright + Lighthouse) and
  tick here.
