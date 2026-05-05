#!/usr/bin/env python3
"""
create_test_event.py — Insert a test event into the database and print its UUID.

Usage:
  python create_test_event.py [OPTIONS]

Options:
  --db-url       Postgres connection URL  [env DATABASE_URL]
  --name         Event name               [default "Load Test Tournament"]
  --capacity     Total slots              [default 1000]
  --fee-cents    Registration fee in cents [default 5000 ($50)]

Prints the event UUID to stdout so you can set FLYTE_EVENT_ID.
"""

import os
import sys
import argparse

try:
    import psycopg2
except ImportError:
    print("psycopg2 is required: pip install psycopg2-binary", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--db-url",      default=os.environ.get("DATABASE_URL", "postgres://flyte:flyte@localhost:5432/flyte"))
    p.add_argument("--name",        default="Load Test Tournament")
    p.add_argument("--capacity",    type=int, default=1000)
    p.add_argument("--fee-cents",   type=int, default=5000)
    args = p.parse_args()

    conn = psycopg2.connect(args.db_url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO events (name, event_date, total_capacity, available_slots,
                                    registration_fee_cents, status)
                VALUES (%s, now() + interval '30 days', %s, %s, %s, 'OPEN')
                RETURNING event_id
                """,
                (args.name, args.capacity, args.capacity, args.fee_cents),
            )
            row = cur.fetchone()
            event_id = str(row[0])
        conn.commit()
    finally:
        conn.close()

    print(event_id)
    print(f"export FLYTE_EVENT_ID={event_id}", file=sys.stderr)


if __name__ == "__main__":
    main()
