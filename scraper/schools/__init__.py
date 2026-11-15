"""
Registry of supported schools.

To add a school: create scraper/schools/<school>.py with a
`scrape(day: str) -> DayMenu` function, then add it below.
"""
from . import berkeley

SCHOOLS = {
    "berkeley": berkeley.scrape,
}
