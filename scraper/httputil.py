"""Small shared HTTP helpers for school scrapers."""
from __future__ import annotations

import logging
import time
from typing import Optional

import requests

log = logging.getLogger(__name__)

DEFAULT_HEADERS = {
    "User-Agent": "campus-menus/0.1 (student project; contact: YOUR_EMAIL)",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}


def get(
    session: requests.Session,
    url: str,
    *,
    headers: Optional[dict] = None,
    timeout: int = 30,
    verify: bool = True,
    retries: int = 2,
) -> Optional[requests.Response]:
    hdrs = {**DEFAULT_HEADERS, **(headers or {})}
    for attempt in range(retries):
        try:
            r = session.get(url, headers=hdrs, timeout=timeout, verify=verify)
            if r.status_code == 404:
                return None
            r.raise_for_status()
            return r
        except requests.RequestException as e:
            log.warning("GET %s failed (attempt %d): %s", url, attempt + 1, e)
            time.sleep(1.5)
    return None
