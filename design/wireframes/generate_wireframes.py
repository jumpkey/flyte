#!/usr/bin/env python3
"""Flyte UI Elaboration v1 — wireframe generator.

Emits every SVG referenced by design/WIREFRAMES.md into this directory.
Deterministic output: re-running produces identical files, so wireframe
changes are reviewable as diffs to this script.

    python3 design/wireframes/generate_wireframes.py
"""
import html
import os

OUT = os.path.dirname(os.path.abspath(__file__))

# WebKit anchor tokens (see design/WEBKIT-STANDARDS.md §2)
NAVY = "#1F3A5F"
NAVY2 = "#2C5282"
INK = "#0F172A"
TEXT = "#334155"
MUTED = "#64748B"
LINE = "#94A3B8"
BORDER = "#CBD5E1"
BORDER_L = "#E2E8F0"
SURFACE = "#F1F5F9"
CANVAS = "#F8FAFC"
WHITE = "#FFFFFF"
FLARE = "#E8590C"
FLARE_T = "#FFF4EC"
GREEN = "#2F9E44"
GREEN_T = "#EBF7ED"
AMBER = "#F08C00"
AMBER_T = "#FFF4E0"
RED = "#E03131"
RED_T = "#FDECEC"
BLUE = "#1971C2"
BLUE_T = "#E7F1FA"
FONT = "Inter, -apple-system, Segoe UI, sans-serif"

PILL = {
    "CONFIRMED": (GREEN, GREEN_T), "OPEN": (GREEN, GREEN_T), "active": (GREEN, GREEN_T),
    "PENDING_PAYMENT": (AMBER, AMBER_T), "CLOSED": (AMBER, AMBER_T), "shadow": (AMBER, AMBER_T),
    "PENDING_CAPTURE": (BLUE, BLUE_T), "REFUNDED": (BLUE, BLUE_T), "APPROVED": (BLUE, BLUE_T),
    "FULL": (BLUE, BLUE_T),
    "PAYMENT_FAILED": (RED, RED_T), "CANCELLED": (RED, RED_T), "DENIED": (RED, RED_T),
    "LOCKED": (RED, RED_T), "REQUESTED": (AMBER, AMBER_T),
    "EXPIRED": (MUTED, SURFACE), "DRAFT": (MUTED, SURFACE),
}


def esc(t):
    return html.escape(str(t), quote=True)


class S:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.e = [
            '<defs><linearGradient id="ng" x1="0" y1="0" x2="1" y2="1">'
            f'<stop offset="0" stop-color="{NAVY}"/><stop offset="1" stop-color="{NAVY2}"/>'
            "</linearGradient></defs>",
            f'<rect x="0" y="0" width="{w}" height="{h}" fill="{CANVAS}"/>',
        ]

    def rect(self, x, y, w, h, fill, stroke=None, rx=0, sw=1, dash=None, op=None):
        a = f'<rect x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}" fill="{fill}"'
        if rx:
            a += f' rx="{rx}"'
        if stroke:
            a += f' stroke="{stroke}" stroke-width="{sw}"'
        if dash:
            a += f' stroke-dasharray="{dash}"'
        if op is not None:
            a += f' opacity="{op}"'
        self.e.append(a + "/>")

    def text(self, x, y, t, size=13, fill=TEXT, w=400, anchor="start", spacing=None):
        a = (f'<text x="{x:g}" y="{y:g}" font-family="{FONT}" font-size="{size}" '
             f'font-weight="{w}" fill="{fill}"')
        if anchor != "start":
            a += f' text-anchor="{anchor}"'
        if spacing:
            a += f' letter-spacing="{spacing}"'
        self.e.append(a + f">{esc(t)}</text>")

    def line(self, x1, y1, x2, y2, stroke=LINE, sw=1, dash=None):
        a = f'<line x1="{x1:g}" y1="{y1:g}" x2="{x2:g}" y2="{y2:g}" stroke="{stroke}" stroke-width="{sw}"'
        if dash:
            a += f' stroke-dasharray="{dash}"'
        self.e.append(a + "/>")

    def circle(self, cx, cy, r, fill, stroke=None, sw=1):
        a = f'<circle cx="{cx:g}" cy="{cy:g}" r="{r:g}" fill="{fill}"'
        if stroke:
            a += f' stroke="{stroke}" stroke-width="{sw}"'
        self.e.append(a + "/>")

    def save(self, name):
        body = "\n".join(self.e)
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w}" height="{self.h}" '
               f'viewBox="0 0 {self.w} {self.h}">\n{body}\n</svg>\n')
        with open(os.path.join(OUT, name), "w") as f:
            f.write(svg)
        print(f"  {name}")


# ---------------------------------------------------------------- components

def browser(s, url):
    s.rect(0, 0, s.w, 36, BORDER_L)
    for i, c in enumerate(("#FC8181", "#F6E05E", "#68D391")):
        s.circle(22 + i * 18, 18, 5, c)
    s.rect(90, 8, s.w - 180, 20, WHITE, stroke=BORDER, rx=10)
    s.text(104, 22, url, 11, MUTED)


def topnav(s, active=None, user=None):
    y = 36
    s.rect(0, y, s.w, 56, NAVY)
    s.text(40, y + 36, "Flyte", 20, WHITE, 800)
    s.circle(96, y + 22, 4, FLARE)
    x = 140
    for l in ("Events",):
        on = l == active
        s.text(x, y + 35, l, 14, WHITE if on else "#C3D0E0", 600 if on else 400)
        if on:
            s.rect(x, y + 46, 46, 3, FLARE, rx=1.5)
        x += 100
    if user:
        s.circle(s.w - 170, y + 28, 13, "#2C4A73", stroke="#5B7396")
        s.text(s.w - 170, y + 33, user[0], 12, WHITE, 700, anchor="middle")
        s.text(s.w - 148, y + 33, user + "  ▾", 13, "#C3D0E0")
    else:
        s.text(s.w - 190, y + 35, "Log in", 14, "#C3D0E0", 600)
        s.rect(s.w - 130, y + 12, 90, 32, "transparent", stroke="#5B7396", rx=8)
        s.text(s.w - 85, y + 33, "Sign up", 13, WHITE, 600, anchor="middle")


def admin_nav(s, active):
    s.rect(0, 36, 240, s.h - 36, NAVY)
    s.text(32, 80, "Flyte", 20, WHITE, 800)
    s.circle(88, 66, 4, FLARE)
    s.text(32, 100, "ADMIN", 10, "#9FB3CC", 600, spacing="2px")
    y = 146
    for it in ("Dashboard", "Events", "Transactions", "Refund requests", "Users", "Activity"):
        if it == active:
            s.rect(14, y - 22, 212, 34, "#2C4A73", rx=8)
            s.rect(14, y - 22, 4, 34, FLARE, rx=2)
        s.text(38, y, it, 13, WHITE if it == active else "#C3D0E0", 600 if it == active else 400)
        y += 44
    s.line(14, s.h - 64, 226, s.h - 64, "#3A567C")
    s.text(38, s.h - 38, "← Back to site", 12, "#9FB3CC")


def btn(s, x, y, w, label, kind="primary", h=40):
    fills = {"primary": (FLARE, None, WHITE), "secondary": (WHITE, NAVY, NAVY),
             "danger": (RED, None, WHITE), "danger-o": (WHITE, RED, RED),
             "green": (GREEN, None, WHITE), "ghost": (CANVAS, BORDER, TEXT)}
    fill, stroke, color = fills[kind]
    s.rect(x, y, w, h, fill, stroke=stroke, rx=8, sw=1.5)
    s.text(x + w / 2, y + h / 2 + 5, label, 14 if h >= 40 else 12, color, 600, anchor="middle")


def pill(s, x, y, label):
    fg, bg = PILL.get(label, (MUTED, SURFACE))
    w = 18 + len(label) * 6.4
    s.rect(x, y, w, 20, bg, rx=10)
    s.text(x + w / 2, y + 14, label, 10, fg, 700, anchor="middle")
    return w


def field(s, x, y, w, label, value="", req=False, error=None, readonly=False, h=40):
    s.text(x, y + 12, label + (" *" if req else ""), 12, INK, 600)
    s.rect(x, y + 20, w, h, SURFACE if readonly else WHITE,
           stroke=RED if error else BORDER, rx=8, sw=1.5 if error else 1)
    if value:
        s.text(x + 12, y + 45, value, 13, MUTED if readonly else TEXT)
    if error:
        s.text(x, y + h + 36, "⚠ " + error, 11, RED, 600)
    return y + 20 + h + (34 if error else 16)


def bars(s, x, y, w, n, gap=14, h=8):
    widths = [1.0, 0.97, 0.92, 0.62, 1.0, 0.88, 0.95, 0.5]
    for i in range(n):
        s.rect(x, y + i * (h + gap), w * widths[i % len(widths)], h, BORDER_L, rx=4)
    return y + n * (h + gap)


def img_ph(s, x, y, w, h, label="event image · 3:2 · object-fit: cover"):
    s.rect(x, y, w, h, "#E9EEF3", stroke=BORDER, rx=8)
    s.line(x + 8, y + 8, x + w - 8, y + h - 8, BORDER)
    s.line(x + w - 8, y + 8, x + 8, y + h - 8, BORDER)
    s.rect(x + w / 2 - 105, y + h / 2 - 11, 210, 22, WHITE, rx=11, op=0.9)
    s.text(x + w / 2, y + h / 2 + 4, label, 10, MUTED, anchor="middle")


def img_fallback(s, x, y, w, h, initials, date):
    s.rect(x, y, w, h, "url(#ng)", rx=8)
    s.text(x + w / 2, y + h / 2 + 2, initials, int(h * 0.3), WHITE, 800, anchor="middle")
    s.text(x + w / 2, y + h / 2 + 26, date, 12, "#C3D0E0", 600, anchor="middle")


def meter(s, x, y, w, frac, label, warn=False):
    s.rect(x, y, w, 8, BORDER_L, rx=4)
    if frac > 0:
        s.rect(x, y, max(8, w * frac), 8, AMBER if warn else GREEN, rx=4)
    s.text(x, y + 26, label, 11, AMBER if warn else MUTED, 600 if warn else 400)


def event_card(s, x, y, w, title, date, loc, price, avail, frac=0.6, fallback=None,
               soldout=False, closed=False):
    h = 356
    s.rect(x, y, w, h, WHITE, stroke=BORDER_L, rx=12)
    if closed:
        s.rect(x, y, w, h, WHITE, rx=12, op=0.55)
    if fallback:
        img_fallback(s, x + 1, y + 1, w - 2, 196, *fallback)
    else:
        img_ph(s, x + 1, y + 1, w - 2, 196)
    s.rect(x + 12, y + 12, 86, 24, WHITE, rx=6)
    s.text(x + 55, y + 28, date, 11, NAVY, 700, anchor="middle")
    s.text(x + 16, y + 226, title, 16, INK, 700)
    s.text(x + 16, y + 248, loc, 12, MUTED)
    s.text(x + 16, y + 296, price, 18, INK, 800)
    if soldout:
        pill(s, x + w - 96, y + 282, "CLOSED") if closed else None
        s.text(x + w - 16, y + 290, "Sold out", 12, RED, 700, anchor="end")
        s.text(x + w - 16, y + 308, "Join waitlist →", 12, NAVY, 600, anchor="end")
    elif closed:
        s.text(x + w - 16, y + 296, "Registration closed", 12, MUTED, 600, anchor="end")
    else:
        meter(s, x + 16, y + 316, w - 120, frac, avail, warn=frac < 0.25)
        s.text(x + w - 16, y + 300, "Register →", 13, FLARE, 700, anchor="end")
    return h


def table(s, x, y, w, cols, rows, rh=42):
    cw = [c[1] for c in cols]
    s.rect(x, y, w, 36, SURFACE, stroke=BORDER_L, rx=8)
    cx = x + 16
    for (title, _w) in cols:
        s.text(cx, y + 23, title.upper(), 10, MUTED, 700, spacing="1px")
        cx += _w
    ry = y + 36
    for r, row in enumerate(rows):
        if r % 2:
            s.rect(x, ry, w, rh, CANVAS)
        s.line(x, ry, x + w, ry, BORDER_L)
        cx = x + 16
        for ci, cell in enumerate(row):
            if isinstance(cell, tuple):
                kind, val = cell
                if kind == "pill":
                    pill(s, cx, ry + 11, val)
                elif kind == "link":
                    s.text(cx, ry + 26, val, 12, BLUE, 600)
                    s.line(cx, ry + 30, cx + len(val) * 6, ry + 30, BLUE, 0.75)
                elif kind == "b":
                    s.text(cx, ry + 26, val, 12.5, INK, 700)
                elif kind == "danger":
                    s.text(cx, ry + 26, val, 12, RED, 600)
            else:
                s.text(cx, ry + 26, cell, 12.5, TEXT)
            cx += cw[ci]
        ry += rh
    s.line(x, ry, x + w, ry, BORDER_L)
    return ry


def note(s, x, y, n):
    s.circle(x, y, 11, FLARE)
    s.text(x, y + 4, str(n), 11, WHITE, 800, anchor="middle")


def legend(s, y, notes, x=40):
    w = s.w - x - 40
    maxc = int((w - 70) / 6.4)
    lines = []
    for i, t in enumerate(notes, 1):
        cur, first = "", True
        for word in t.split():
            if cur and len(cur) + len(word) + 1 > maxc:
                lines.append((i if first else None, cur))
                first, cur = False, word
            else:
                cur = cur + " " + word if cur else word
        lines.append((i if first else None, cur))
    h = len(lines) * 22 + 26
    s.rect(x, y, w, h, FLARE_T, stroke="#F3CDB3", rx=10)
    ny = y + 26
    for num, t in lines:
        if num:
            note(s, x + 24, ny - 4, num)
        s.text(x + 44, ny, t, 12, TEXT)
        ny += 22
    if y + h > s.h - 8:
        print(f"  WARNING: legend overflows canvas ({y + h} > {s.h})")


def kpi(s, x, y, w, label, value, accent=None, sub=None):
    s.rect(x, y, w, 96, WHITE, stroke=BORDER_L, rx=12)
    s.text(x + 18, y + 28, label.upper(), 10, MUTED, 700, spacing="1px")
    s.text(x + 18, y + 62, value, 26, accent or INK, 800)
    if sub:
        s.text(x + 18, y + 82, sub, 11, MUTED)


def stepper(s, x, y, step):
    for i, lbl in enumerate(("Details", "Payment"), 1):
        cx = x + (i - 1) * 170
        on, done = i == step, i < step
        s.circle(cx, y, 14, FLARE if on else (GREEN if done else WHITE),
                 stroke=None if (on or done) else BORDER, sw=1.5)
        s.text(cx, y + 4.5, "✓" if done else str(i), 12, WHITE if (on or done) else MUTED, 700,
               anchor="middle")
        s.text(cx + 24, y + 4.5, lbl, 13, INK if on else MUTED, 700 if on else 400)
        if i == 1:
            s.line(cx + 92, y, cx + 150, y, BORDER, 1.5)


def page_h1(s, x, y, title, sub=None):
    s.text(x, y, title, 26, INK, 800)
    if sub:
        s.text(x, y + 24, sub, 13, MUTED)


def alert(s, x, y, w, txt, link=None, tone=AMBER):
    tones = {AMBER: AMBER_T, RED: RED_T, GREEN: GREEN_T, BLUE: BLUE_T}
    s.rect(x, y, w, 48, tones[tone], rx=10)
    s.rect(x, y, 4, 48, tone, rx=2)
    s.text(x + 20, y + 29, txt, 13, INK, 600)
    if link:
        s.text(x + w - 20, y + 29, link, 13, tone, 700, anchor="end")


def summary_box(s, x, y, w, rows, title="Order summary"):
    h = 46 + len(rows) * 26 + 12
    s.rect(x, y, w, h, SURFACE, rx=10)
    s.text(x + 16, y + 26, title, 13, INK, 700)
    ry = y + 52
    for k, v, strong in rows:
        s.text(x + 16, ry, k, 12, MUTED)
        s.text(x + w - 16, ry, v, 13 if strong else 12, INK if strong else TEXT,
               800 if strong else 400, anchor="end")
        ry += 26
    return y + h


# ---------------------------------------------------------------- screens

def wf01_home():
    s = S(1280, 1010)
    browser(s, "flyte.fly.dev/")
    topnav(s)
    s.rect(0, 92, s.w, 240, "url(#ng)")
    s.text(s.w / 2, 188, "Find your next event", 38, WHITE, 800, anchor="middle")
    s.text(s.w / 2, 220, "Workshops, meetups and community events — secure checkout in under a minute.",
           14, "#C3D0E0", anchor="middle")
    btn(s, s.w / 2 - 90, 252, 180, "Browse events", "primary", 44)
    note(s, s.w / 2 + 110, 274, 1)
    s.text(64, 392, "Upcoming events", 22, INK, 800)
    s.text(s.w - 64, 392, "View all →", 14, NAVY, 700, anchor="end")
    cards = [
        ("Intro to Sailing", "JUN 20", "Marina Bay Dock C", "$25.00", "12 of 50 left", 0.24, None, False, False),
        ("Founders Dinner", "JUL 02", "The Press Room", "$80.00", "Sold out", 0.0, ("FD", "JUL 02"), True, False),
        ("Summer 5K Run", "JUL 18", "Riverside Park", "$15.00", "210 of 300 left", 0.7, None, False, False),
    ]
    x = 64
    for c in cards:
        event_card(s, x, 412, 368, *c)
        x += 392
    note(s, 424, 444, 2)
    note(s, 816, 444, 3)
    note(s, 300, 716, 4)
    s.rect(0, 800, s.w, 2, BORDER_L)
    s.text(64, 832, "Flyte", 14, MUTED, 800)
    s.text(s.w - 64, 832, "Terms · Privacy · Contact", 12, MUTED, anchor="end")
    legend(s, 856, [
        "Single accent CTA (Flare token) — links to /events. Hero uses the navy gradient brand block.",
        "Up to 6 OPEN upcoming events, soonest first; whole card is the click target → /events/:id.",
        "No image_url set → styled CSS fallback card: navy gradient, event initials, date (WK §6).",
        "Availability meter from available_slots; amber under 25%. Sold-out cards swap CTA for waitlist link.",
    ])
    s.save("wf-01-home.svg")


def wf02_events_list():
    s = S(1280, 1230)
    browser(s, "flyte.fly.dev/events")
    topnav(s, active="Events")
    page_h1(s, 64, 140, "Upcoming events", "All events open for registration or recently closed")
    s.rect(64, 180, 360, 40, WHITE, stroke=BORDER, rx=8)
    s.text(80, 205, "🔍  Search events…", 13, MUTED)
    s.rect(440, 180, 180, 40, WHITE, stroke=BORDER, rx=8)
    s.text(456, 205, "Any month  ▾", 13, TEXT)
    s.text(640, 205, "Clear filters", 12, MUTED)
    note(s, 700, 200, 1)
    rows = [
        [("Intro to Sailing", "JUN 20", "Marina Bay Dock C", "$25.00", "12 of 50 left", 0.24, None, False, False),
         ("Founders Dinner", "JUL 02", "The Press Room", "$80.00", "", 0.0, ("FD", "JUL 02"), True, False),
         ("Summer 5K Run", "JUL 18", "Riverside Park", "$15.00", "210 of 300 left", 0.7, None, False, False)],
        [("Pottery Workshop", "JUL 25", "Clay Studio North", "$45.00", "8 of 12 left", 0.66, ("PW", "JUL 25"), False, False),
         ("Wine & Paint Night", "AUG 01", "Gallery 22", "$35.00", "30 of 40 left", 0.75, None, False, False),
         ("Spring Gala (closed)", "MAY 30", "Grand Hall", "$120.00", "", 0.0, ("SG", "MAY 30"), False, True)],
    ]
    y = 248
    for row in rows:
        x = 64
        for c in row:
            event_card(s, x, y, 368, *c)
            x += 392
        y += 380
    note(s, 488, y - 660, 2)
    note(s, 880, y - 280, 3)
    btn(s, s.w / 2 - 80, y + 8, 160, "Load more", "ghost")
    note(s, s.w / 2 + 100, y + 28, 4)
    legend(s, y + 70, [
        "Text search + month filter submit via HTMX (hx-get) and replace the grid only — no full reload.",
        "Sold-out events stay listed (social proof) with the waitlist CTA replacing Register.",
        "CLOSED events render at 55% opacity, 'Registration closed', no CTA (site-map Q1 default).",
        "HTMX pagination, 12 cards per page. Empty state: 'No upcoming events yet' + nothing else.",
    ])
    s.save("wf-02-events-list.svg")


def wf03_event_detail():
    s = S(1280, 1010)
    browser(s, "flyte.fly.dev/events/4f2a…")
    topnav(s, active="Events")
    s.text(64, 134, "← All events", 13, NAVY, 600)
    img_ph(s, 64, 156, 720, 480)
    note(s, 96, 188, 1)
    s.text(64, 678, "About this event", 18, INK, 800)
    bars(s, 64, 700, 700, 7)
    panel_x, panel_y = 824, 156
    s.rect(panel_x, panel_y, 392, 446, WHITE, stroke=BORDER_L, rx=12)
    s.text(panel_x + 24, panel_y + 42, "Intro to Sailing", 22, INK, 800)
    pill(s, panel_x + 24, panel_y + 58, "OPEN")
    s.text(panel_x + 24, panel_y + 110, "📅  Saturday, June 20 · 9:00 AM", 13, TEXT)
    s.text(panel_x + 24, panel_y + 136, "📍  Marina Bay, Dock C", 13, TEXT)
    s.line(panel_x + 24, panel_y + 160, panel_x + 368, panel_y + 160, BORDER_L)
    s.text(panel_x + 24, panel_y + 200, "$25.00", 30, INK, 800)
    s.text(panel_x + 120, panel_y + 200, "per person", 12, MUTED)
    meter(s, panel_x + 24, panel_y + 224, 344, 0.24, "12 of 50 spots left", warn=True)
    note(s, panel_x + 392, panel_y + 228, 2)
    btn(s, panel_x + 24, panel_y + 286, 344, "Register — $25.00", "primary", 48)
    note(s, panel_x + 392, panel_y + 310, 3)
    s.text(panel_x + 196, panel_y + 370, "🔒 Secure checkout · Stripe", 12, MUTED, anchor="middle")
    s.text(panel_x + 196, panel_y + 400, "No account needed", 12, MUTED, anchor="middle")
    note(s, panel_x + 392, panel_y + 396, 4)
    s.rect(panel_x, 634, 392, 132, SURFACE, rx=12)
    s.text(panel_x + 24, 664, "State variants", 12, MUTED, 700, spacing="1px")
    btn(s, panel_x + 24, 682, 344, "Join the waitlist", "secondary", 40)
    s.text(panel_x + 196, 752, "Sold out → CTA swaps to waitlist (J7)", 11, MUTED, anchor="middle")
    legend(s, 800, [
        "image_url rendered 3:2, object-fit cover; missing/broken URL → navy fallback card with initials.",
        "Live availability from available_slots (the engine's atomic counter) — amber when < 25%.",
        "Primary CTA → /events/:id/register. CLOSED: disabled bar 'Registration closed'. CANCELLED: info alert.",
        "Guest checkout is first-class (decision D1) — copy says so to remove signup anxiety.",
    ])
    s.save("wf-03-event-detail.svg")


def wf04_checkout():
    s = S(1560, 1030)
    browser(s, "flyte.fly.dev/events/4f2a…/register")
    s.rect(0, 36, s.w, 56, NAVY)
    s.text(40, 72, "Flyte", 20, WHITE, 800)
    s.text(s.w - 40, 70, "🔒 Secure checkout", 13, "#C3D0E0", anchor="end")
    # -- Step 1 panel
    px, py, pw = 40, 124, 710
    s.rect(px, py, pw, 700, WHITE, stroke=BORDER_L, rx=12)
    stepper(s, px + 56, py + 44, 1)
    sy = summary_box(s, px + 32, py + 84, pw - 64,
                     [("Intro to Sailing — Jun 20", "", False), ("Total due today", "$25.00", True)])
    y = sy + 20
    half = (pw - 64 - 20) / 2
    field(s, px + 32, y, half, "First name", "Dana", req=True)
    field(s, px + 32 + half + 20, y, half, "Last name", "Reyes", req=True)
    y += 86
    y = field(s, px + 32, y, pw - 64, "Email", "dana@example.com", req=True)
    note(s, px + pw - 18, y - 46, 1)
    y = field(s, px + 32, y, pw - 64, "Confirm email", "dana@exmaple.com", req=True,
              error="Email addresses don't match")
    note(s, px + pw - 18, y - 64, 2)
    y = field(s, px + 32, y, pw - 64, "Phone (optional)")
    btn(s, px + 32, y + 8, pw - 64, "Continue to payment", "primary", 48)
    note(s, px + pw - 18, y + 32, 3)
    # -- Step 2 panel
    qx, qw = 790, 730
    s.rect(qx, py, qw, 700, WHITE, stroke=BORDER_L, rx=12)
    stepper(s, qx + 56, py + 44, 2)
    sy = summary_box(s, qx + 32, py + 84, qw - 64,
                     [("Intro to Sailing — Jun 20", "", False), ("Dana Reyes · dana@example.com", "", False),
                      ("Total due today", "$25.00", True)])
    y = sy + 24
    s.rect(qx + 32, y, qw - 64, 230, CANVAS, stroke=LINE, rx=10, dash="6 5")
    s.text(qx + qw / 2, y + 105, "Stripe Payment Element", 15, MUTED, 700, anchor="middle")
    s.text(qx + qw / 2, y + 130, "(card / wallet fields rendered by Stripe.js — never touches our server)",
           11, MUTED, anchor="middle")
    note(s, qx + qw - 18, y + 24, 4)
    y += 254
    btn(s, qx + 32, y, qw - 64, "Pay $25.00", "primary", 48)
    note(s, qx + qw - 18, y + 24, 5)
    s.text(qx + qw / 2, y + 84, "Your spot is held while you pay. 3-D Secure may open a bank prompt.",
           11, MUTED, anchor="middle")
    legend(s, 850, [
        "Logged-in users: email prefilled from session, read-only; Confirm email field is hidden entirely.",
        "Guest (D1): email entered twice, compared case-insensitively client-side AND server-side (400 EMAIL_MISMATCH). On success a shadow user row is found-or-created and stamped on the registration.",
        "POST /events/:id/register → slot reserved atomically (engine) → PaymentIntent created → step 2.",
        "Element container per WK §5; manual capture flow unchanged from the payment engine.",
        "stripe.confirmPayment → POST /registration/confirm/:piId → capture → redirect to confirmation.",
    ])
    s.save("wf-04-checkout.svg")


def wf05_confirmation():
    s = S(1280, 980)
    browser(s, "flyte.fly.dev/registration/9c1b…/confirmed")
    topnav(s)
    cx, cw = 320, 640
    s.rect(cx, 132, cw, 560, WHITE, stroke=BORDER_L, rx=12)
    s.circle(cx + cw / 2, 200, 34, GREEN_T)
    s.text(cx + cw / 2, 212, "✓", 34, GREEN, 800, anchor="middle")
    s.text(cx + cw / 2, 276, "You're registered!", 26, INK, 800, anchor="middle")
    s.text(cx + cw / 2, 302, "A receipt is on its way to dana@example.com", 13, MUTED, anchor="middle")
    rows = [("Event", "Intro to Sailing"), ("When", "Sat, Jun 20 · 9:00 AM"),
            ("Where", "Marina Bay, Dock C"), ("Amount paid", "$25.00"),
            ("Registration ID", "9c1b2e84-…"), ("Status", "__PILL__")]
    ry = 340
    for k, v in rows:
        s.line(cx + 48, ry - 18, cx + cw - 48, ry - 18, BORDER_L)
        s.text(cx + 48, ry + 4, k, 12, MUTED)
        if v == "__PILL__":
            pill(s, cx + cw - 48 - 92, ry - 10, "CONFIRMED")
        else:
            s.text(cx + cw - 48, ry + 4, v, 13, INK, 600, anchor="end")
        ry += 38
    note(s, cx + cw - 24, 352, 1)
    btn(s, cx + 48, ry + 6, (cw - 116) / 2, "Add to calendar", "secondary")
    btn(s, cx + 48 + (cw - 116) / 2 + 20, ry + 6, (cw - 116) / 2, "Request a refund", "danger-o")
    note(s, cx + cw - 24, ry + 26, 2)
    # activation callout
    ay = 716
    s.rect(cx, ay, cw, 110, FLARE_T, stroke="#F3CDB3", rx=12)
    s.text(cx + 24, ay + 32, "Want an account?", 15, INK, 800)
    s.text(cx + 24, ay + 56, "You don't need one — but set a password and your purchases,", 12, TEXT)
    s.text(cx + 24, ay + 74, "refunds and future tickets all live in one place.", 12, TEXT)
    btn(s, cx + cw - 196, ay + 32, 172, "Activate account", "secondary", 38)
    note(s, cx + cw - 24, ay + 18, 3)
    legend(s, 856, [
        "Page is reachable by capability URL (unguessable registration UUID) — guests need no login (audit-documented pattern).",
        "→ /registration/:id/refund-request (WF-05 flow, J4): optional reason, idempotent, acknowledged by email.",
        "Shadow-account activation (D1/J3): links to /forgot-password with email prefilled. Password reset flips shadow → active and the purchase is already attached. Hidden when viewer's account is already active.",
    ])
    s.save("wf-05-confirmation.svg")


def wf06_account_regs():
    s = S(1280, 800)
    browser(s, "flyte.fly.dev/account/registrations")
    topnav(s, user="Dana")
    page_h1(s, 64, 150, "My registrations", "Every ticket on this account — including ones bought before you set a password")
    note(s, 560, 168, 1)
    cols = [("Event", 280), ("Date", 150), ("Amount", 110), ("Status", 170), ("Receipt", 110), ("", 160)]
    rows = [
        [("b", "Intro to Sailing"), "Jun 20, 2026", "$25.00", ("pill", "CONFIRMED"), ("link", "View"), ("danger", "Request refund")],
        [("b", "Summer 5K Run"), "Jul 18, 2026", "$15.00", ("pill", "PENDING_CAPTURE"), "—", ""],
        [("b", "Spring Gala"), "May 30, 2026", "$120.00", ("pill", "REFUNDED"), ("link", "View"), ""],
        [("b", "Pottery Workshop"), "Apr 02, 2026", "$45.00", ("pill", "CONFIRMED"), ("link", "View"), ("danger", "Request refund")],
    ]
    ty = table(s, 64, 210, 1152, cols, rows)
    note(s, 1000, 270, 2)
    note(s, 700, 354, 3)
    s.rect(64, ty + 30, 1152, 70, SURFACE, rx=10)
    s.text(80, ty + 60, "Empty state:", 12, MUTED, 700)
    s.text(170, ty + 60, "“No registrations yet.”  +  [Browse events] secondary button", 12, TEXT)
    legend(s, ty + 130, [
        "Rows are all registrations with user_id = session user — guest purchases made pre-activation appear automatically (the shadow-account payoff, J3).",
        "Request refund shown only for CONFIRMED rows with no open/approved refund request; row click → /account/registrations/:id (ownership-checked).",
        "REFUNDED rows keep their receipt; refund details shown on the detail page.",
    ])
    s.save("wf-06-account-registrations.svg")


def wf07_admin_dashboard():
    s = S(1280, 930)
    browser(s, "flyte.fly.dev/admin")
    admin_nav(s, "Dashboard")
    x = 280
    page_h1(s, x, 150, "Dashboard")
    alert(s, x, 176, 936, "3 refund requests are waiting for review", "Review now →")
    note(s, x + 960, 200, 1)
    labels = [("Gross revenue · 30d", "$4,820", None, "all-time $18,240"),
              ("Registrations · 30d", "142", None, "12 pending"),
              ("Upcoming events", "5", None, "2 nearly sold out"),
              ("Pending refunds", "3", FLARE, "oldest 2 days")]
    kx = x
    for label, val, accent, sub in labels:
        kpi(s, kx, 248, 222, label, val, accent, sub)
        kx += 238
    note(s, x + 940, 268, 2)
    s.text(x, 396, "Recent transactions", 16, INK, 800)
    cols = [("When", 110), ("Event", 210), ("Customer", 220), ("Status", 150), ("Net", 80)]
    rows = [
        ["2m ago", "Intro to Sailing", "dana@example.com", ("pill", "CONFIRMED"), "$25.00"],
        ["1h ago", "Summer 5K Run", "ben@example.com", ("pill", "PENDING_CAPTURE"), "$15.00"],
        ["3h ago", "Pottery Workshop", "kim@example.com", ("pill", "PAYMENT_FAILED"), "$0.00"],
        ["5h ago", "Intro to Sailing", "joe@example.com", ("pill", "REFUNDED"), "$0.00"],
    ]
    ty = table(s, x, 412, 800, cols, rows)
    s.text(x, ty + 16, "View all transactions →", 12, NAVY, 700)
    s.rect(x + 824, 412, 112 + 0, 0, WHITE)  # no-op keeps layout code symmetric
    s.text(x, ty + 70, "Recent sign-ins", 16, INK, 800)
    for i, (who, when, ok) in enumerate([("admin@flyte.dev", "9:02 AM · 203.0.113.9", True),
                                         ("dana@example.com", "8:44 AM · 198.51.100.3", True),
                                         ("unknown@mail.ru", "6:10 AM · failed ×5 → rate-limited", False)]):
        yy = ty + 92 + i * 30
        s.circle(x + 8, yy - 4, 4, GREEN if ok else RED)
        s.text(x + 24, yy, f"{who} — {when}", 12, TEXT if ok else RED)
    note(s, x + 420, ty + 148, 3)
    legend(s, 812, [
        "Pending-request banner appears only when count > 0 — the admin's daily to-do surfaces itself (J4 step 2).",
        "KPI window: 30 days with all-time secondary (site-map Q3 default). Money always tabular-nums (WK §3).",
        "Feed from login_events — failed-attempt clusters visible at a glance; full log under Activity.",
    ], x=280)
    s.save("wf-07-admin-dashboard.svg")


def wf08_admin_events():
    s = S(1280, 760)
    browser(s, "flyte.fly.dev/admin/events")
    admin_nav(s, "Events")
    x = 280
    page_h1(s, x, 150, "Events")
    btn(s, x + 796, 122, 140, "+ New event", "primary")
    note(s, x + 956, 142, 1)
    cols = [("Event", 250), ("Date", 130), ("Status", 130), ("Confirmed", 110), ("Available", 100), ("Revenue", 100)]
    rows = [
        [("b", "Intro to Sailing"), "Jun 20, 2026", ("pill", "OPEN"), "38 / 50", "12", "$950"],
        [("b", "Founders Dinner"), "Jul 02, 2026", ("pill", "FULL"), "24 / 24", "0", "$1,920"],
        [("b", "Summer 5K Run"), "Jul 18, 2026", ("pill", "OPEN"), "90 / 300", "210", "$1,350"],
        [("b", "Autumn Retreat"), "Sep 12, 2026", ("pill", "DRAFT"), "0 / 40", "—", "—"],
        [("b", "Spring Gala"), "May 30, 2026", ("pill", "CLOSED"), "180 / 180", "0", "$21,600"],
        [("b", "Winter Mixer"), "Jan 15, 2026", ("pill", "CANCELLED"), "0 / 60", "—", "$0 (refunded)"],
    ]
    ty = table(s, x, 184, 936, cols, rows)
    note(s, x + 320, 254, 2)
    note(s, x + 392, 380, 3)
    legend(s, ty + 40, [
        "→ /admin/events/new (WF-09). Events default to DRAFT: fully editable, invisible on the storefront.",
        "Entire row → /admin/events/:id (WF-10). Confirmed counts come straight from the registrations table.",
        "DRAFT never appears publicly; CANCELLED rows keep their refund history for the audit trail.",
    ], x=280)
    s.save("wf-08-admin-events.svg")


def wf09_admin_event_form():
    s = S(1280, 1040)
    browser(s, "flyte.fly.dev/admin/events/new")
    admin_nav(s, "Events")
    x = 280
    s.text(x, 134, "← Events", 12, NAVY, 600)
    page_h1(s, x, 168, "New event")
    fx, fw = x, 560
    y = 196
    y = field(s, fx, y, fw, "Name", "Intro to Sailing", req=True)
    y = field(s, fx, y, fw, "Summary (card blurb, 140 chars)", "Learn the ropes — literally.")
    s.text(fx, y + 12, "Description", 12, INK, 600)
    s.rect(fx, y + 20, fw, 110, WHITE, stroke=BORDER, rx=8)
    bars(s, fx + 12, y + 38, fw - 60, 3, gap=12, h=7)
    y += 150
    half = (fw - 20) / 2
    field(s, fx, y, half, "Date & time", "2026-06-20 09:00", req=True)
    field(s, fx + half + 20, y, half, "Location", "Marina Bay, Dock C")
    y += 86
    field(s, fx, y, half, "Capacity", "50", req=True)
    note(s, fx + half - 18, y + 40, 1)
    field(s, fx + half + 20, y, half, "Fee (USD)", "$ 25.00", req=True)
    note(s, fx + fw - 18, y + 40, 2)
    y += 86
    y = field(s, fx, y, fw, "Image URL (https)", "https://images.example.com/sailing.jpg")
    note(s, fx + fw - 18, y - 46, 3)
    s.text(fx, y + 12, "Status", 12, INK, 600)
    s.rect(fx, y + 20, 220, 40, WHITE, stroke=BORDER, rx=8)
    s.text(fx + 12, y + 45, "DRAFT  ▾", 13, TEXT)
    y += 86
    btn(s, fx, y, 160, "Save event", "primary")
    btn(s, fx + 176, y, 120, "Cancel", "ghost")
    # preview card
    pvx = x + 620
    s.text(pvx, 208, "CARD PREVIEW", 10, MUTED, 700, spacing="1px")
    event_card(s, pvx, 220, 316, "Intro to Sailing", "JUN 20", "Marina Bay, Dock C",
               "$25.00", "50 of 50 left", 1.0)
    s.text(pvx, 630, "NO-IMAGE FALLBACK", 10, MUTED, 700, spacing="1px")
    img_fallback(s, pvx, 642, 316, 160, "IS", "JUN 20")
    note(s, pvx + 316, 232, 4)
    legend(s, y + 60, [
        "On edit, capacity may not drop below the current confirmed count — server-enforced, inline error.",
        "Entered in dollars, stored in cents (fee_cents) via the shared money helper; > $0 required.",
        "https:// only, ≤ 2048 chars (security S5). Broken URL degrades to the fallback card at render time.",
        "Live preview (HTMX) shows the storefront card and the no-image fallback as the admin types.",
    ], x=280)
    s.save("wf-09-admin-event-form.svg")


def wf10_admin_event_detail():
    s = S(1280, 1080)
    browser(s, "flyte.fly.dev/admin/events/4f2a…")
    admin_nav(s, "Events")
    x = 280
    s.text(x, 134, "← Events", 12, NAVY, 600)
    s.text(x, 172, "Intro to Sailing", 26, INK, 800)
    pill(s, x + 200, 156, "OPEN")
    btn(s, x + 580, 142, 90, "Edit", "secondary", 36)
    btn(s, x + 682, 142, 100, "Close", "ghost", 36)
    btn(s, x + 794, 142, 142, "Cancel event", "danger-o", 36)
    note(s, x + 956, 160, 1)
    stats = [("Capacity", "50"), ("Confirmed", "38"), ("Available", "12"),
             ("Waitlist", "5"), ("Gross revenue", "$950")]
    kx = x
    for label, val in stats:
        s.rect(kx, 204, 176, 72, WHITE, stroke=BORDER_L, rx=10)
        s.text(kx + 16, 230, label.upper(), 9, MUTED, 700, spacing="1px")
        s.text(kx + 16, 258, val, 20, INK, 800)
        kx += 190
    s.text(x, 322, "Roster", 16, INK, 800)
    cols = [("Participant", 200), ("Email", 250), ("Status", 160), ("Amount", 100), ("Registered", 150)]
    rows = [
        [("b", "Dana Reyes"), ("link", "dana@example.com"), ("pill", "CONFIRMED"), "$25.00", "Jun 02, 9:14 AM"],
        [("b", "Ben Ortiz"), ("link", "ben@example.com"), ("pill", "CONFIRMED"), "$25.00", "Jun 02, 8:01 AM"],
        [("b", "Kim Lau"), ("link", "kim@example.com"), ("pill", "PENDING_PAYMENT"), "—", "Jun 02, 8:00 AM"],
        [("b", "Joe Fox"), ("link", "joe@example.com"), ("pill", "REFUNDED"), "$0.00", "May 28, 4:40 PM"],
    ]
    ty = table(s, x, 338, 936, cols, rows)
    note(s, x + 480, 408, 2)
    s.text(x, ty + 40, "Waitlist (5)", 16, INK, 800)
    wcols = [("Position", 90), ("Name", 220), ("Email", 280), ("Joined", 180)]
    wrows = [["1", "Ana Silva", "ana@example.com", "Jun 03, 11:02 AM"],
             ["2", "Raj Patel", "raj@example.com", "Jun 03, 2:48 PM"]]
    wy = table(s, x, ty + 56, 936, wcols, wrows)
    note(s, x + 480, ty + 96, 3)
    legend(s, wy + 36, [
        "Cancel opens a confirm modal: “Refund all 38 confirmed registrations ($950)?” → existing bulk-refund path; event flips to CANCELLED only if every Stripe refund succeeds (engine A6 semantics).",
        "Email links jump to /admin/users/:id; row click → /admin/registrations/:id for the payment record.",
        "v1 waitlist is visibility only — promotion is a manual contact (J7); automation is parked for v2.",
    ], x=280)
    s.save("wf-10-admin-event-detail.svg")


def wf11_admin_transactions():
    s = S(1280, 940)
    browser(s, "flyte.fly.dev/admin/registrations")
    admin_nav(s, "Transactions")
    x = 280
    page_h1(s, x, 150, "Transactions", "Every registration and its payment state")
    fy = 186
    for i, (lbl, w) in enumerate([("All events  ▾", 200), ("All statuses  ▾", 160),
                                  ("Search email…", 240), ("Last 30 days  ▾", 160)]):
        fx = x + sum(_w + 16 for _, _w in
                     [("", 200), ("", 160), ("", 240)][:i])
        s.rect(fx, fy, w, 38, WHITE, stroke=BORDER, rx=8)
        s.text(fx + 12, fy + 24, lbl, 12, MUTED if "Search" in lbl else TEXT)
    btn(s, x + 800, fy, 100, "Apply", "secondary", 38)
    note(s, x + 930, fy + 19, 1)
    cols = [("Created", 130), ("Event", 190), ("Customer", 230), ("Status", 160), ("Gross", 80), ("Net", 80)]
    rows = [
        ["Jun 12, 9:02", "Intro to Sailing", "dana@example.com", ("pill", "CONFIRMED"), "$25.00", "$25.00"],
        ["Jun 12, 8:44", "Summer 5K Run", "ben@example.com", ("pill", "PENDING_CAPTURE"), "$15.00", "—"],
        ["Jun 12, 8:00", "Summer 5K Run", "kim@example.com", ("pill", "PENDING_PAYMENT"), "—", "—"],
        ["Jun 11, 6:31", "Pottery Workshop", "joe@example.com", ("pill", "PAYMENT_FAILED"), "—", "$0.00"],
        ["Jun 11, 2:12", "Intro to Sailing", "ana@example.com", ("pill", "REFUNDED"), "$25.00", "$0.00"],
        ["Jun 10, 7:55", "Spring Gala", "raj@example.com", ("pill", "CONFIRMED"), "$120.00", "$100.00"],
        ["Jun 09, 1:20", "Summer 5K Run", "lee@example.com", ("pill", "EXPIRED"), "—", "—"],
        ["Jun 08, 5:46", "Winter Mixer", "amy@example.com", ("pill", "CANCELLED"), "$35.00", "$0.00"],
    ]
    ty = table(s, x, 244, 936, cols, rows)
    note(s, x + 500, 300, 2)
    note(s, x + 880, 552, 3)
    s.text(x, ty + 28, "Showing 1–25 of 412", 12, MUTED)
    btn(s, x + 760, ty + 12, 80, "‹ Prev", "ghost", 32)
    btn(s, x + 856, ty + 12, 80, "Next ›", "ghost", 32)
    legend(s, ty + 70, [
        "Filters + pagination via HTMX (hx-get swaps the table body); state lives in the query string so views are shareable.",
        "Row click → /admin/registrations/:id (WF-12). Every engine state is visible — PAYMENT_FAILED and EXPIRED rows finally have a home (they were DB-only before).",
        "Partial refunds show as reduced Net (Spring Gala row: $120 gross, $20 refunded).",
    ], x=280)
    s.save("wf-11-admin-transactions.svg")


def wf12_admin_reg_detail():
    s = S(1280, 1030)
    browser(s, "flyte.fly.dev/admin/registrations/9c1b…")
    admin_nav(s, "Transactions")
    x = 280
    s.text(x, 134, "← Transactions", 12, NAVY, 600)
    s.text(x, 172, "Registration 9c1b2e84", 24, INK, 800)
    pill(s, x + 300, 156, "CONFIRMED")
    # left column — participant + timeline
    s.rect(x, 200, 450, 150, WHITE, stroke=BORDER_L, rx=12)
    s.text(x + 20, 228, "PARTICIPANT", 10, MUTED, 700, spacing="1px")
    s.text(x + 20, 256, "Dana Reyes", 16, INK, 700)
    s.text(x + 20, 280, "dana@example.com", 13, BLUE, 600)
    s.line(x + 20, 284, x + 150, 284, BLUE, 0.75)
    note(s, x + 170, 276, 1)
    s.text(x + 20, 304, "shadow account · guest checkout", 11, MUTED)
    s.text(x + 20, 330, "Intro to Sailing · Jun 20, 2026", 13, TEXT)
    s.text(x + 20, 392, "PAYMENT TIMELINE", 10, MUTED, 700, spacing="1px")
    tl = [("Registration initiated", "Jun 02, 9:14:02 AM", GREEN),
          ("Payment authorized (Stripe)", "Jun 02, 9:14:41 AM", GREEN),
          ("Capture succeeded", "Jun 02, 9:14:43 AM", GREEN),
          ("Status → CONFIRMED · receipt emailed", "Jun 02, 9:14:44 AM", GREEN),
          ("Partial refund $5.00 by admin@flyte.dev", "Jun 09, 2:10:18 PM", BLUE)]
    ty = 414
    s.line(x + 27, ty + 6, x + 27, ty + (len(tl) - 1) * 44 + 6, BORDER)
    for label, when, c in tl:
        s.circle(x + 27, ty + 2, 6, c)
        s.text(x + 46, ty + 6, label, 13, INK, 600)
        s.text(x + 46, ty + 24, when, 11, MUTED)
        ty += 44
    note(s, x + 420, 432, 2)
    # right column — payment card + refund modal sketch
    rx = x + 486
    s.rect(rx, 200, 450, 240, WHITE, stroke=BORDER_L, rx=12)
    s.text(rx + 20, 228, "PAYMENT", 10, MUTED, 700, spacing="1px")
    for i, (k, v, strong) in enumerate([("Gross", "$25.00", False), ("Refunded", "−$5.00", False),
                                        ("Net", "$20.00", True)]):
        yy = 258 + i * 28
        s.text(rx + 20, yy, k, 12, MUTED)
        s.text(rx + 430 - 16, yy, v, 14 if strong else 12, INK if strong else TEXT,
               800 if strong else 400, anchor="end")
    s.line(rx + 20, 350, rx + 430, 350, BORDER_L)
    s.text(rx + 20, 374, "Stripe PI:  pi_3NXk…9fQ2", 12, TEXT)
    s.text(rx + 430 - 16, 374, "View in Stripe ↗", 12, BLUE, 600, anchor="end")
    btn(s, rx + 20, 392, 150, "Refund…", "danger-o", 34)
    note(s, rx + 190, 408, 3)
    # modal sketch
    my = 480
    s.rect(rx, my, 450, 290, WHITE, stroke=LINE, rx=12, sw=1.5)
    s.rect(rx, my, 450, 290, INK, rx=12, op=0.03)
    s.text(rx + 24, my + 34, "Refund registration", 16, INK, 800)
    s.text(rx + 24, my + 58, "Up to $20.00 remaining is refundable.", 12, MUTED)
    field(s, rx + 24, my + 74, 200, "Amount (USD)", "$ 20.00")
    s.rect(rx + 248, my + 96, 16, 16, WHITE, stroke=BORDER, rx=4)
    s.text(rx + 272, my + 108, "Full remaining amount", 12, TEXT)
    s.text(rx + 24, my + 176, "The card is refunded via Stripe and the customer", 11, MUTED)
    s.text(rx + 24, my + 192, "is emailed automatically. This cannot be undone.", 11, MUTED)
    btn(s, rx + 24, my + 216, 180, "Confirm refund", "danger", 40)
    btn(s, rx + 220, my + 216, 100, "Cancel", "ghost", 40)
    note(s, rx + 420, my + 236, 4)
    s.text(rx + 10, my - 12, "MODAL", 9, MUTED, 700, spacing="2px")
    legend(s, 820, [
        "Linked user → /admin/users/:id; shadow accounts are labelled so support knows the customer can't log in yet.",
        "Timeline reconstructed from registration timestamps + refund_log — answers “what happened?” without psql.",
        "First HTTP exposure of RefundService: adminGuard + CSRF + server-validated amount ≤ remaining net (S3).",
        "Success → refund_log row + customer email (existing template) + timeline entry. Stripe failure → error flash, nothing recorded as refunded.",
    ], x=280)
    s.save("wf-12-admin-registration-detail.svg")


def wf13_admin_users():
    s = S(1280, 800)
    browser(s, "flyte.fly.dev/admin/users")
    admin_nav(s, "Users")
    x = 280
    page_h1(s, x, 150, "Users")
    s.rect(x, 176, 320, 38, WHITE, stroke=BORDER, rx=8)
    s.text(x + 12, 200, "🔍  Search email or name…", 12, MUTED)
    s.rect(x + 336, 176, 170, 38, WHITE, stroke=BORDER, rx=8)
    s.text(x + 348, 200, "Any status  ▾", 12, TEXT)
    s.rect(x + 522, 176, 150, 38, WHITE, stroke=BORDER, rx=8)
    s.text(x + 534, 200, "Locked: any  ▾", 12, TEXT)
    cols = [("Email", 250), ("Name", 170), ("Status", 120), ("Locked", 90), ("Regs", 80), ("Created", 130)]
    rows = [
        [("link", "admin@flyte.dev"), "Site Admin", ("pill", "active"), "—", "0", "Jan 02, 2026"],
        [("link", "dana@example.com"), "Dana Reyes", ("pill", "shadow"), "—", "2", "Jun 02, 2026"],
        [("link", "ben@example.com"), "Ben Ortiz", ("pill", "active"), "—", "5", "Feb 14, 2026"],
        [("link", "kim@example.com"), "Kim Lau", ("pill", "active"), ("pill", "LOCKED"), "1", "Mar 30, 2026"],
        [("link", "joe@example.com"), "Joe Fox", ("pill", "shadow"), "—", "1", "May 28, 2026"],
    ]
    ty = table(s, x, 240, 936, cols, rows)
    note(s, x + 410, 322, 1)
    note(s, x + 530, 408, 2)
    legend(s, ty + 40, [
        "shadow = created by guest checkout (D1): no password, can't log in, owns purchases. Activates itself via password reset — admins never flip it manually.",
        "Locked is orthogonal to status (admin action, failed-login defense). Row → /admin/users/:id (WF-14).",
    ], x=280)
    s.save("wf-13-admin-users.svg")


def wf14_admin_user_detail():
    s = S(1280, 1090)
    browser(s, "flyte.fly.dev/admin/users/7d3e…")
    admin_nav(s, "Users")
    x = 280
    s.text(x, 134, "← Users", 12, NAVY, 600)
    s.rect(x, 156, 936, 120, WHITE, stroke=BORDER_L, rx=12)
    s.circle(x + 56, 216, 28, SURFACE, stroke=BORDER)
    s.text(x + 56, 224, "DR", 18, NAVY, 800, anchor="middle")
    s.text(x + 104, 200, "Dana Reyes", 20, INK, 800)
    s.text(x + 104, 224, "dana@example.com · created Jun 02, 2026", 13, MUTED)
    pill(s, x + 104, 238, "shadow")
    s.text(x + 200, 252, "unverified · not admin", 11, MUTED)
    btn(s, x + 760, 196, 152, "Lock account", "danger-o", 38)
    note(s, x + 930, 215, 1)
    s.text(x, 320, "Purchases", 15, INK, 800)
    pcols = [("Event", 230), ("Date", 130), ("Amount", 100), ("Status", 150)]
    prow = [
        [("b", "Intro to Sailing"), "Jun 20, 2026", "$25.00", ("pill", "CONFIRMED")],
        [("b", "Summer 5K Run"), "Jul 18, 2026", "$15.00", ("pill", "PENDING_CAPTURE")],
    ]
    ty = table(s, x, 336, 660, pcols, prow)
    note(s, x + 690, 360, 2)
    s.text(x, ty + 40, "Login history", 15, INK, 800)
    lcols = [("When", 160), ("IP", 140), ("Result", 120), ("User agent", 220)]
    lrows = [
        ["Jun 12, 8:44 AM", "198.51.100.3", ("pill", "DENIED"), "Mobile Safari · iOS 19"],
        ["Jun 11, 9:02 PM", "198.51.100.3", ("pill", "DENIED"), "Mobile Safari · iOS 19"],
    ]
    ly = table(s, x, ty + 56, 660, lcols, lrows)
    note(s, x + 690, ty + 96, 3)
    s.text(x, ly + 40, "Action history", 15, INK, 800)
    for i, t in enumerate(["Jun 02 — registration_created (Intro to Sailing)",
                           "Jun 02 — shadow_account_created (guest checkout)",
                           "Jun 12 — refund_requested (Intro to Sailing)"]):
        s.circle(x + 8, ly + 64 + i * 28, 4, LINE)
        s.text(x + 24, ly + 68 + i * 28, t, 12, TEXT)
    legend(s, ly + 160, [
        "Modal-confirmed. Lock revokes all sessions (destroyUserSessions) and blocks login; admins cannot lock themselves (S7). Both lock and unlock are written to user_action_events.",
        "Same data as the customer's My Registrations — support sees exactly what the customer sees.",
        "Shadow user login attempts show as denied — expected until they activate (R2); a wall of these plus a refund request is a support signal, not an attack.",
    ], x=280)
    s.save("wf-14-admin-user-detail.svg")


def wf15_refund_queue():
    s = S(1280, 880)
    browser(s, "flyte.fly.dev/admin/refund-requests")
    admin_nav(s, "Refund requests")
    x = 280
    page_h1(s, x, 150, "Refund requests")
    s.text(x, 196, "Requested (3)", 14, INK, 800)
    s.rect(x, 206, 104, 3, FLARE, rx=1.5)
    s.text(x + 150, 196, "Resolved", 14, MUTED)
    cards = [
        ("dana@example.com", "Intro to Sailing · Jun 20", "$25.00", "2 days ago",
         "“Schedule conflict, sorry! Hope to catch the next one.”"),
        ("raj@example.com", "Spring Gala · May 30", "$120.00", "1 day ago",
         "(no reason given)"),
        ("amy@example.com", "Summer 5K Run · Jul 18", "$15.00", "3 hours ago",
         "“Injured during training.”"),
    ]
    y = 232
    for who, ev, amt, when, reason in cards:
        s.rect(x, y, 936, 108, WHITE, stroke=BORDER_L, rx=12)
        s.text(x + 24, y + 32, who, 14, INK, 700)
        s.text(x + 24, y + 56, ev, 12, MUTED)
        s.text(x + 24, y + 84, reason, 12, TEXT)
        s.text(x + 560, y + 32, amt, 16, INK, 800)
        s.text(x + 560, y + 54, "requested " + when, 11, MUTED)
        btn(s, x + 680, y + 24, 150, "Approve & refund", "green", 36)
        btn(s, x + 844, y + 24, 72, "Deny", "ghost", 36)
        s.text(x + 690, y + 84, "View transaction →", 11, BLUE, 600)
        y += 124
    note(s, x + 820, 264, 1)
    note(s, x + 900, 264, 2)
    note(s, x + 740, 510, 3)
    legend(s, y + 24, [
        "Approve modal: “Refund $25.00 to dana@example.com via Stripe?” → RefundService full refund; request → APPROVED with resolved_by stamp; customer emailed. Stripe failure keeps it REQUESTED with an error flash — never silently resolved.",
        "Deny modal requires a note; request → DENIED and the note is emailed to the customer (HTML-escaped, S4).",
        "Deep link to /admin/registrations/:id to inspect the payment before deciding.",
    ], x=280)
    s.save("wf-15-admin-refund-queue.svg")


def wf16_mobile():
    s = S(1180, 880)
    s.text(40, 48, "Mobile (≤ 480px) — key storefront screens", 18, INK, 800)
    s.text(40, 72, "Breakpoint behavior per WEBKIT-STANDARDS §4: single column, full-width CTAs, sticky purchase bar", 12, MUTED)

    def phone(px, title):
        s.rect(px, 100, 330, 650, WHITE, stroke=INK, rx=28, sw=2)
        s.rect(px + 130, 112, 70, 8, BORDER_L, rx=4)
        s.text(px + 165, 90, title, 12, MUTED, 700, anchor="middle")
        return px + 15, 130, 300  # content x, y, w

    # home
    cx, cy, cw = phone(60, "/  (home)")
    s.rect(cx, cy, cw, 44, NAVY, rx=6)
    s.text(cx + 14, cy + 28, "Flyte", 15, WHITE, 800)
    s.text(cx + cw - 14, cy + 28, "☰", 15, WHITE, anchor="end")
    s.text(cx + 10, cy + 78, "Find your next event", 17, INK, 800)
    for i in range(2):
        yy = cy + 96 + i * 230
        s.rect(cx, yy, cw, 214, WHITE, stroke=BORDER_L, rx=10)
        if i == 0:
            img_ph(s, cx + 1, yy + 1, cw - 2, 120, "image · 3:2")
        else:
            img_fallback(s, cx + 1, yy + 1, cw - 2, 120, "FD", "JUL 02")
        s.text(cx + 12, yy + 144, ["Intro to Sailing", "Founders Dinner"][i], 13, INK, 700)
        s.text(cx + 12, yy + 162, ["Jun 20 · $25.00", "Jul 02 · $80.00"][i], 11, MUTED)
        s.text(cx + 12, yy + 190, ["12 left · Register →", "Sold out · Waitlist →"][i], 11,
               FLARE if i == 0 else NAVY, 700)
    # event detail
    cx, cy, cw = phone(430, "/events/:id")
    img_ph(s, cx, cy, cw, 160, "image · 3:2")
    s.text(cx + 10, cy + 188, "Intro to Sailing", 16, INK, 800)
    s.text(cx + 10, cy + 210, "Sat Jun 20 · Marina Bay", 11, MUTED)
    meter(s, cx + 10, cy + 228, cw - 20, 0.24, "12 of 50 left", warn=True)
    bars(s, cx + 10, cy + 278, cw - 20, 6, gap=12, h=7)
    s.rect(cx - 15, cy + 540, 330, 80, WHITE, stroke=BORDER_L)
    s.text(cx + 10, cy + 572, "$25.00", 16, INK, 800)
    btn(s, cx + 100, cy + 556, 190, "Register", "primary", 44)
    note(s, cx + 300, cy + 578, 1)
    # checkout
    cx, cy, cw = phone(800, "/events/:id/register")
    stepper(s, cx + 40, cy + 16, 1)
    y = cy + 40
    y = field(s, cx + 10, y, cw - 20, "First name", "Dana", req=True)
    y = field(s, cx + 10, y, cw - 20, "Email", "dana@example.com", req=True)
    y = field(s, cx + 10, y, cw - 20, "Confirm email", "dana@example.com", req=True)
    note(s, cx + cw - 10, y - 46, 2)
    btn(s, cx + 10, y + 12, cw - 20, "Continue to payment", "primary", 46)
    legend(s, 770, [
        "Purchase bar is sticky at the viewport bottom on mobile — price always paired with the action (Fitts's law).",
        "Same double-entry email rule as desktop; fields stack full-width, 44px minimum touch targets (WK §8).",
    ])
    s.save("wf-16-mobile.svg")


if __name__ == "__main__":
    print("Generating wireframes →", OUT)
    wf01_home(); wf02_events_list(); wf03_event_detail(); wf04_checkout()
    wf05_confirmation(); wf06_account_regs(); wf07_admin_dashboard()
    wf08_admin_events(); wf09_admin_event_form(); wf10_admin_event_detail()
    wf11_admin_transactions(); wf12_admin_reg_detail(); wf13_admin_users()
    wf14_admin_user_detail(); wf15_refund_queue(); wf16_mobile()
    print("Done.")
