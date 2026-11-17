"""
Registry of supported schools.

To add a school: create scraper/schools/<school>.py with a
`scrape(day: str) -> DayMenu` function, then add it below.
"""
from . import berkeley, ucd, uci, ucla, ucsb, ucsc, ucsd

SCHOOLS = {
    "berkeley": berkeley.scrape,
    "ucla": ucla.scrape,
    "ucsd": ucsd.scrape,
    "uci": uci.scrape,
    "ucsb": ucsb.scrape,
    "ucd": ucd.scrape,
    "ucsc": ucsc.scrape,
}

TIMEZONES = {
    "berkeley": berkeley.TIMEZONE,
    "ucla": ucla.TIMEZONE,
    "ucsd": ucsd.TIMEZONE,
    "uci": uci.TIMEZONE,
    "ucsb": ucsb.TIMEZONE,
    "ucd": ucd.TIMEZONE,
    "ucsc": ucsc.TIMEZONE,
}
