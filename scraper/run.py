"""
Command-line entry point.

    python -m scraper.run                       # Berkeley, today
    python -m scraper.run --school ucla         # UCLA
    python -m scraper.run --school all --days 2 # every registered school
    python -m scraper.run --date 2026-11-16     # a specific day
    python -m scraper.run --days 3              # today + next 2 days

Writes docs/data/<school>/<date>.json, plus today.json for today.
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

from .schools import SCHOOLS, TIMEZONES


def scrape_one(school: str, start: date, days: int, out_root: Path, today: date) -> int:
    out_dir = out_root / school
    out_dir.mkdir(parents=True, exist_ok=True)
    total = 0
    for offset in range(days):
        day = (start + timedelta(days=offset)).isoformat()
        menu = SCHOOLS[school](day)
        count = menu.item_count()
        total += count

        # Never replace a saved menu with an empty one. An empty result
        # usually means the network or the source failed, not "no food".
        if count == 0:
            print(f"{school} {day}: nothing found, keeping any existing file")
            continue

        payload = json.dumps(menu.to_dict(), indent=2, ensure_ascii=False)
        (out_dir / f"{day}.json").write_text(payload, encoding="utf-8")
        if day == today.isoformat():
            (out_dir / "today.json").write_text(payload, encoding="utf-8")

        halls = ", ".join(l.name for l in menu.locations) or "none"
        print(f"{school} {day}: {count} items across {len(menu.locations)} locations ({halls})")
    return total


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Scrape campus dining menus.")
    p.add_argument(
        "--school", default="berkeley",
        help="school id, or 'all' for every registered school",
    )
    p.add_argument("--date", help="YYYY-MM-DD (default: today, school's local time)")
    p.add_argument("--days", type=int, default=1, help="number of days to scrape")
    p.add_argument("--out", default="docs/data", help="output folder (docs/ is what GitHub Pages serves)")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(levelname)s %(message)s")

    if args.school == "all":
        schools = sorted(SCHOOLS)
    elif args.school in SCHOOLS:
        schools = [args.school]
    else:
        print(f"Unknown school {args.school!r}. Choose from: {', '.join(sorted(SCHOOLS))} or all",
              file=sys.stderr)
        return 2

    out_root = Path(args.out)
    grand = 0
    for school in schools:
        today = datetime.now(ZoneInfo(TIMEZONES[school])).date()
        start = date.fromisoformat(args.date) if args.date else today
        grand += scrape_one(school, start, args.days, out_root, today)

    if grand == 0:
        print("ERROR: no menu items found. The source may have changed, "
              "or dining is closed (breaks, holidays).", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
