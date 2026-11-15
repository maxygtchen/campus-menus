"""End-to-end run of the CLI with the network faked out."""
import base64
import json
from pathlib import Path

from scraper import run
from scraper.schools import berkeley

FIXTURE = (Path(__file__).parent / "fixtures" / "crossroads_sample.xml").read_text()


class FakeResponse:
    def __init__(self, text):
        self.text = text


def fake_get(session, url):
    if url == berkeley.MENUS_PAGE:
        p = "/code/wp-content/uploads/menus-exportimport/Crossroads_20261115.xml"
        return FakeResponse(f'<div data-location="{base64.b64encode(p.encode()).decode()}"></div>')
    if url.endswith("Crossroads_20261115.xml"):
        return FakeResponse(FIXTURE)
    return None  # every other location: 404 / closed


def test_cli_writes_json(tmp_path, monkeypatch):
    monkeypatch.setattr(berkeley, "_get", fake_get)
    monkeypatch.setattr(berkeley, "REQUEST_DELAY_S", 0)
    code = run.main(["--date", "2026-11-15", "--out", str(tmp_path)])
    assert code == 0
    data = json.loads((tmp_path / "berkeley" / "2026-11-15.json").read_text())
    assert data["school"] == "berkeley"
    assert [l["name"] for l in data["locations"]] == ["Crossroads"]
    assert data["locations"][0]["meals"][1]["items"][0]["name"] == "Harissa Roasted Chicken"


def test_cli_fails_loudly_when_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(berkeley, "_get", lambda s, u: None)
    monkeypatch.setattr(berkeley, "REQUEST_DELAY_S", 0)
    assert run.main(["--date", "2026-12-25", "--out", str(tmp_path)]) == 1
