"""
Command-line entry point.

    python -m scraper.run                       # Berkeley, today
    python -m scraper.run --date 2026-11-16     # a specific day
    python -m scraper.run --days 3              # today + next 2 days

Writes data/<school>/<date>.json, plus data/<school>/today.json for today.
Exits with an error if no menu items were found, so a scheduled job
can alert you when the source breaks.
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from .schools import SCHOOLS
from .schools import berkeley

TIMEZONES = {"berkeley": berkeley.TIMEZONE}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Scrape campus dining menus.")
    p.add_argument("--school", default="berkeley", choices=sorted(SCHOOLS))
    p.add_argument("--date", help="YYYY-MM-DD (default: today, school's local time)")
    p.add_argument("--days", type=int, default=1, help="number of days to scrape")
    p.add_argument("--out", default="data", help="output folder")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(levelname)s %(message)s")

    today = datetime.now(ZoneInfo(TIMEZONES[args.school])).date()
    start = date.fromisoformat(args.date) if args.date else today
    out_dir = Path(args.out) / args.school
    out_dir.mkdir(parents=True, exist_ok=True)

    total = 0
    for offset in range(args.days):
        day = (start + timedelta(days=offset)).isoformat()
        menu = SCHOOLS[args.school](day)
        count = menu.item_count()
        total += count

        payload = json.dumps(menu.to_dict(), indent=2, ensure_ascii=False)
        (out_dir / f"{day}.json").write_text(payload, encoding="utf-8")
        if day == today.isoformat():
            (out_dir / "today.json").write_text(payload, encoding="utf-8")

        halls = ", ".join(l.name for l in menu.locations) or "none"
        print(f"{args.school} {day}: {count} items across {len(menu.locations)} locations ({halls})")

    if total == 0:
        print("ERROR: no menu items found. The source may have changed, "
              "or dining is closed (breaks, holidays).", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
