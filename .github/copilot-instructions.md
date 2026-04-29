# Flyte — Copilot Agent Instructions

This project uses the SPECIFICATION.md as its single source of truth.
Read it fully before making changes.

## Key Commands

- `npm run dev` — start the dev server (requires Postgres on localhost:5432)
- `npm run migrate` — run database migrations
- `npm run seed` — seed the admin user (admin@flyte.local / changeme123)
- `npm run build` — compile TypeScript

## Database

Postgres is available at localhost:5432 (user: flyte, password: flyte, db: flyte).
All queries use parameterized SQL — never concatenate user input.

## Testing Conventions

Run the app and verify each route manually after changes.
The full page verification order is:
home → register → email check API → verify email → login →
forgot password → reset password → dashboard → profile → logout.

## Code Style

- Strict TypeScript (`"strict": true`).
- EJS templates for HTML rendering.
- HTMX for dynamic UI — no client-side framework.
- Every state-changing endpoint requires CSRF validation.
