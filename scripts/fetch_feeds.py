#!/usr/bin/env python3
"""Fetch the daily arXiv listing of every category and write one JSON file per category.

Standard library only (no pip install needed). Designed to run inside GitHub Actions,
but works locally too:

    python3 scripts/fetch_feeds.py --out build/data                  # all categories
    python3 scripts/fetch_feeds.py --out build/data --only cs.LG,math.OC

Source: the official RSS feeds https://rss.arxiv.org/rss/<category>, which carry the
same content as the daily "new submissions" mailing (announce types: new, cross,
replace, replace-cross). Only "new" (primary category) and "cross" (cross-listed)
entries are kept; replacements are dropped.

Robustness:
  * every feed is retried with backoff;
  * if a feed fails or comes back empty (weekend, holiday, outage), the previously
    published JSON for that category (``--previous``) is kept and flagged ``stale``;
  * the script exits non-zero only when *nothing* could be fetched (so a single
    broken category never blocks the deployment of the others).

Output layout (``--out`` directory):
    <category>.json  one per category, see ``category_payload``;
    index.json       manifest with per-category status, used by the front-end.
"""
import argparse
import datetime as dt
import email.utils
import json
import os
import re
import sys
import time
import urllib.error
import unicodedata
import urllib.request
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_TAXONOMY = os.path.join(ROOT, "site", "categories.json")
FEED_URL = "https://rss.arxiv.org/rss/{cat}"
USER_AGENT = "arxivscan/3.0 (GitHub Actions; +https://github.com/svaiter/arxivscan)"
KEEP_TYPES = ("new", "cross")
FORMAT_VERSION = 1

NS = {
    "arxiv": "http://arxiv.org/schemas/atom",
    "dc": "http://purl.org/dc/elements/1.1/",
}
DESC_RE = re.compile(r"^\s*arXiv:(?P<id>\S+?)\s+Announce Type:\s*(?P<type>[\w-]+)\s*(?:\n|$)\s*(?:Abstract:\s*)?(?P<abstract>.*)$", re.S)
VERSION_RE = re.compile(r"v(\d+)$")


def utcnow() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg: str) -> None:
    print(msg, flush=True)


# --------------------------------------------------------------------------- fetching

def http_get(url: str, timeout: float = 60.0, attempts: int = 4) -> bytes:
    """GET with retries and exponential backoff (2s, 4s, 8s)."""
    last_err = None
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
            })
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code in (400, 404):  # unknown category: retrying will not help
                raise
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            last_err = e
        if attempt + 1 < attempts:
            time.sleep(2 ** (attempt + 1))
    raise RuntimeError(f"{url}: {last_err}")


# --------------------------------------------------------------------------- parsing

def parse_rfc822_date(text: str) -> str:
    """'Tue, 03 Nov 2026 00:00:00 -0500' -> '2026-11-03' (date in the feed's own zone)."""
    try:
        d = email.utils.parsedate_to_datetime(text.strip())
        return d.strftime("%Y-%m-%d")
    except Exception:
        return ""


# TeX accents are common in RSS titles and author names ("M\\"uller", "Jos\\'e").
ACCENTS = {'"': "\u0308", "'": "\u0301", "`": "\u0300", "^": "\u0302", "~": "\u0303", "=": "\u0304",
           ".": "\u0307", "u": "\u0306", "v": "\u030c", "H": "\u030b", "c": "\u0327", "k": "\u0328", "r": "\u030a"}
SYMBOLS = {"ss": "ß", "o": "ø", "O": "Ø", "ae": "æ", "AE": "Æ", "aa": "å", "AA": "Å", "l": "ł", "L": "Ł",
           "i": "ı", "j": "ȷ", "deg": "°", "oe": "œ", "OE": "Œ", "dh": "ð", "DH": "Ð", "th": "þ", "TH": "Þ"}
ACCENT_RE = re.compile(r"\\([\"'`^~=.uvHckr])\s*(?:\{(\w)\}|(\w))")
SYMBOL_RE = re.compile(r"\{\\(" + "|".join(sorted(SYMBOLS, key=len, reverse=True)) + r")\}|\\(" +
                       "|".join(sorted(SYMBOLS, key=len, reverse=True)) + r")(?![A-Za-z])\s?")
TEXTCMD_RE = re.compile(r"\\(?:textsc|textit|textbf|texttt|emph|textrm|mbox)\{([^{}]*)\}")


def detex(text: str) -> str:
    """Turn common TeX accents/symbols into Unicode outside of math; leave $...$ untouched."""
    if "\\" not in text and "{" not in text:
        return text
    out = []
    for i, chunk in enumerate(re.split(r"(\$[^$]*\$)", text)):
        if i % 2 == 1:  # math segment
            out.append(chunk)
            continue
        chunk = TEXTCMD_RE.sub(r"\1", chunk)
        chunk = ACCENT_RE.sub(lambda m: unicodedata.normalize("NFC", (m.group(2) or m.group(3)) + ACCENTS[m.group(1)]), chunk)
        chunk = SYMBOL_RE.sub(lambda m: SYMBOLS[m.group(1) or m.group(2)], chunk)
        chunk = re.sub(r"\{(\w)\}", r"\1", chunk)  # leftover single-letter groups such as {e}
        out.append(chunk)
    return "".join(out)


def split_authors(text: str) -> list:
    # dc:creator is "A. One, B. Two, C. Three"; a few entries use ' and '.
    parts = re.split(r",\s*|\s+and\s+", text or "")
    return [p.strip() for p in parts if p.strip()]


def parse_feed(raw: bytes) -> dict:
    root = ET.fromstring(raw)
    channel = root.find("channel")
    if channel is None:
        raise ValueError("no <channel> element")

    announced = parse_rfc822_date(channel.findtext("pubDate", ""))
    built = channel.findtext("lastBuildDate", "")

    papers = []
    counts = {}
    for item in channel.findall("item"):
        desc = item.findtext("description", "") or ""
        m = DESC_RE.match(desc)
        atype = (item.findtext("arxiv:announce_type", "", NS) or (m.group("type") if m else "")).strip()
        counts[atype] = counts.get(atype, 0) + 1
        if atype not in KEEP_TYPES:
            continue

        full_id = m.group("id") if m else ""
        if not full_id:
            guid = item.findtext("guid", "") or ""
            full_id = guid.rsplit(":", 1)[-1]
        ver_m = VERSION_RE.search(full_id)
        version = int(ver_m.group(1)) if ver_m else 1
        short_id = VERSION_RE.sub("", full_id)

        abstract = m.group("abstract") if m else desc
        papers.append({
            "id": short_id,
            "v": version,
            "title": detex(" ".join((item.findtext("title", "") or "").split())),
            "authors": [detex(a) for a in split_authors(item.findtext("dc:creator", "", NS))],
            "abstract": " ".join(abstract.split()),
            "cats": [c.text.strip() for c in item.findall("category") if c.text and c.text.strip()],
            "type": atype,
        })

    if not announced and papers:
        announced = parse_rfc822_date(channel.find("item").findtext("pubDate", ""))

    return {
        "announced": announced,
        "feed_built": built,
        "papers": papers,
        "counts": counts,
    }


def category_payload(cat: dict, parsed: dict) -> dict:
    papers = parsed["papers"]
    return {
        "format": FORMAT_VERSION,
        "category": cat["id"],
        "name": cat.get("name", cat["id"]),
        "announced": parsed["announced"],
        "fetched_at": utcnow(),
        "feed_built": parsed.get("feed_built", ""),
        "stale": False,
        "count_new": sum(1 for p in papers if p["type"] == "new"),
        "count_cross": sum(1 for p in papers if p["type"] == "cross"),
        "feed_counts": parsed.get("counts", {}),
        "papers": papers,
    }


# --------------------------------------------------------------------------- main loop

def load_json(path: str):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def write_json(path: str, payload: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--taxonomy", default=DEFAULT_TAXONOMY, help="categories.json listing every category")
    ap.add_argument("--out", required=True, help="output directory for <cat>.json and index.json")
    ap.add_argument("--previous", default=None, help="directory holding the previously published JSON (fallback)")
    ap.add_argument("--only", default=None, help="comma-separated subset of categories (for testing)")
    ap.add_argument("--delay", type=float, default=0.5, help="seconds to wait between feed requests")
    args = ap.parse_args()

    taxonomy = load_json(args.taxonomy)
    if not taxonomy or not taxonomy.get("categories"):
        log(f"error: cannot read taxonomy {args.taxonomy}")
        return 2
    categories = taxonomy["categories"]
    if args.only:
        wanted = {c.strip() for c in args.only.replace("+", ",").split(",") if c.strip()}
        categories = [c for c in categories if c["id"] in wanted]
        missing = wanted - {c["id"] for c in categories}
        if missing:
            log(f"warning: unknown categories ignored: {', '.join(sorted(missing))}")

    os.makedirs(args.out, exist_ok=True)
    started = time.time()
    index = {
        "format": FORMAT_VERSION,
        "generated_at": utcnow(),
        "run_url": None,
        "repo_url": None,
        "categories": {},
    }
    server = os.environ.get("GITHUB_SERVER_URL")
    repo = os.environ.get("GITHUB_REPOSITORY")
    run_id = os.environ.get("GITHUB_RUN_ID")
    if server and repo:
        index["repo_url"] = f"{server}/{repo}"
        if run_id:
            index["run_url"] = f"{server}/{repo}/actions/runs/{run_id}"

    ok = fresh = stale = failed = 0
    for i, cat in enumerate(categories):
        cid = cat["id"]
        out_path = os.path.join(args.out, f"{cid}.json")
        prev = load_json(os.path.join(args.previous, f"{cid}.json")) if args.previous else None
        if prev is not None and prev.get("format") != FORMAT_VERSION:
            prev = None  # incompatible layout: do not carry it over

        error = None
        parsed = None
        try:
            parsed = parse_feed(http_get(FEED_URL.format(cat=cid)))
        except Exception as e:  # noqa: BLE001 - we want to keep going whatever happens
            error = f"{type(e).__name__}: {e}"

        if parsed is not None and not parsed["papers"] and prev is not None:
            # Weekend / holiday / transient empty feed: keep what we had.
            error = "feed returned no new or cross-listed entries; previous listing kept"
            parsed = None

        if parsed is not None:
            payload = category_payload(cat, parsed)
            fresh += 1
            status = "fresh"
        elif prev is not None:
            payload = dict(prev)
            payload["stale"] = True
            payload["stale_reason"] = error
            payload["stale_since"] = utcnow()
            stale += 1
            status = "stale"
        else:
            payload = {
                "format": FORMAT_VERSION,
                "category": cid,
                "name": cat.get("name", cid),
                "announced": "",
                "fetched_at": utcnow(),
                "stale": True,
                "stale_reason": error,
                "count_new": 0,
                "count_cross": 0,
                "papers": [],
            }
            failed += 1
            status = "failed"
        ok += status != "failed"

        write_json(out_path, payload)
        index["categories"][cid] = {
            "name": payload["name"],
            "announced": payload.get("announced", ""),
            "fetched_at": payload.get("fetched_at", ""),
            "stale": payload.get("stale", False),
            "count_new": payload.get("count_new", 0),
            "count_cross": payload.get("count_cross", 0),
            "error": error,
        }
        log(f"[{i + 1:3d}/{len(categories)}] {cid:<22} {status:<6} new={payload.get('count_new', 0):<4} "
            f"cross={payload.get('count_cross', 0):<4} announced={payload.get('announced') or '-'}"
            + (f"  ({error})" if error else ""))

        if i + 1 < len(categories) and args.delay > 0:
            time.sleep(args.delay)

    index["summary"] = {
        "total": len(categories),
        "fresh": fresh,
        "stale": stale,
        "failed": failed,
        "seconds": round(time.time() - started, 1),
    }
    # Most common announcement date among fresh categories, for the UI header.
    dates = {}
    for cid, meta in index["categories"].items():
        if meta["announced"] and not meta["stale"]:
            dates[meta["announced"]] = dates.get(meta["announced"], 0) + 1
    index["announced"] = max(dates, key=dates.get) if dates else ""
    write_json(os.path.join(args.out, "index.json"), index)

    log(f"done in {index['summary']['seconds']}s: {fresh} fresh, {stale} stale, {failed} failed "
        f"out of {len(categories)} categories")
    write_step_summary(index)
    if fresh == 0:
        log("::error::no category could be fetched")
        return 1
    if failed:
        log(f"::error::{failed} categories have no data at all (fetch failed and nothing to fall back on)")
        return 1
    if stale:
        log(f"::warning::{stale} categories are stale (previous listing kept)")
    return 0


def write_step_summary(index: dict) -> None:
    """Append a short Markdown report to the GitHub Actions job summary, if running there."""
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    s = index["summary"]
    lines = [
        "## arXiv fetch report",
        "",
        f"Batch announced **{index.get('announced') or '?'}**, generated {index['generated_at']} "
        f"in {s['seconds']}s.",
        "",
        "| fresh | stale (previous kept) | failed (no data) |",
        "|---:|---:|---:|",
        f"| {s['fresh']} | {s['stale']} | {s['failed']} |",
    ]
    problems = [(cid, m) for cid, m in index["categories"].items() if m.get("error")]
    if problems:
        lines += ["", "| category | status | problem |", "|---|---|---|"]
        for cid, m in problems:
            status = "failed" if not m.get("announced") else "stale"
            lines.append(f"| `{cid}` | {status} | {m['error']} |")
    with open(path, "a", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    sys.exit(main())
