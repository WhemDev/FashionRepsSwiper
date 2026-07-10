"""Fetch r/FashionReps trusted-sellers wiki and write wiki_structure.json."""

import json
import re
import sys
from urllib.parse import urlparse

import requests

WIKI_URL = "https://old.reddit.com/r/FashionReps/wiki/trusted/"
OUT = "wiki_structure.json"
UA = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
    )
}


def main():
    root = __file__.replace("\\", "/").rsplit("/", 2)[0]
    if root.endswith("scripts"):
        root = root.rsplit("/", 1)[0]
    out_path = f"{root}/{OUT}" if "/" in root else OUT

    r = requests.get(WIKI_URL, headers=UA, timeout=30)
    r.raise_for_status()
    html = r.text
    wiki = re.search(
        r'<div class="wiki">(.*?)</div>\s*<div class="wiki-page-actions">', html, re.S
    )
    if not wiki:
        print("Could not find wiki content on page", file=sys.stderr)
        sys.exit(1)

    body = wiki.group(1)
    sections = []
    current = None
    for tag in re.finditer(r"<(h[1-4])[^>]*>(.*?)</\1>|<(ul|ol|p|table)(?:\s[^>]*)?>(.*?)</\3>", body, re.S | re.I):
        if tag.group(1):
            heading = re.sub(r"<[^>]+>", "", tag.group(2)).strip()
            current = {"heading": heading, "level": tag.group(1).upper(), "links": []}
            sections.append(current)
        elif current and tag.group(4):
            chunk = tag.group(4)
            for href, text in re.findall(r'href="([^"]+)"[^>]*>(.*?)</a>', chunk, re.S):
                text = re.sub(r"<[^>]+>", "", text).strip()
                current["links"].append({"text": text or href, "href": href})

    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(sections, fh, ensure_ascii=False, indent=1)

    yupoo = sum(
        1
        for s in sections
        for l in s["links"]
        if "yupoo.com" in urlparse(l["href"]).netloc
    )
    print(f"Wrote {len(sections)} sections, {yupoo} Yupoo links -> {out_path}")


if __name__ == "__main__":
    main()
