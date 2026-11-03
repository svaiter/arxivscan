#!/usr/bin/env python3
"""Regenerate site/categories.json from https://arxiv.org/category_taxonomy.

Standard library only. Usage:

    python3 scripts/build_taxonomy.py                 # fetch and write site/categories.json
    python3 scripts/build_taxonomy.py --html page.html  # parse a saved copy instead

The output is a flat list so that the front-end can group it any way it likes:

    {"source": "...", "generated_at": "...", "categories": [
        {"id": "cs.AI", "name": "Artificial Intelligence", "group": "Computer Science", "archive": "cs"},
        ...
    ]}
"""
import argparse
import datetime
import html
import json
import os
import re
import sys
import urllib.request

TAXONOMY_URL = "https://arxiv.org/category_taxonomy"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(ROOT, "site", "categories.json")
USER_AGENT = "arxivscan (https://github.com/svaiter/arxivscan)"

HEADING_RE = re.compile(r"<(h2|h3|h4)[^>]*>(.*?)</\1>", re.S)
CAT_RE = re.compile(r"^([A-Za-z\-]+(?:\.[A-Za-z\-]+)?)\s*\((.+)\)$")
ARCHIVE_RE = re.compile(r"^(.*?)\s*\(([A-Za-z\-]+)\)$")


def clean(fragment: str) -> str:
    text = re.sub(r"<[^>]+>", " ", fragment)
    return " ".join(html.unescape(text).split())


def parse(page: str) -> list:
    categories = []
    group = None
    archive_id = None
    for tag, body in HEADING_RE.findall(page):
        text = clean(body)
        if tag == "h2":
            if text in ("Classification guide", "Group Name"):
                continue
            group, archive_id = text, None
        elif tag == "h3":
            m = ARCHIVE_RE.match(text)
            archive_id = m.group(2) if m else None
        elif tag == "h4" and group:
            m = CAT_RE.match(text)
            if not m:
                continue
            cat_id, name = m.group(1), m.group(2).strip()
            categories.append({
                "id": cat_id,
                "name": name,
                "group": group,
                "archive": archive_id or cat_id.split(".")[0],
            })
    return categories


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--html", help="parse this saved HTML file instead of downloading")
    ap.add_argument("--out", default=DEFAULT_OUT)
    args = ap.parse_args()

    if args.html:
        with open(args.html, encoding="utf-8") as fh:
            page = fh.read()
    else:
        req = urllib.request.Request(TAXONOMY_URL, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=60) as resp:
            page = resp.read().decode("utf-8", "replace")

    categories = parse(page)
    if len(categories) < 100:
        print(f"error: only {len(categories)} categories parsed, refusing to overwrite", file=sys.stderr)
        return 1
    seen = set()
    for c in categories:
        if c["id"] in seen:
            print(f"error: duplicate category {c['id']}", file=sys.stderr)
            return 1
        seen.add(c["id"])

    payload = {
        "source": TAXONOMY_URL,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "categories": categories,
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    print(f"wrote {len(categories)} categories to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
