"""Yupoo album scraper for the r/FashionReps trusted stores wiki.

Reads wiki_structure.json, extracts (yupoo store, brand) pairs, searches each
store's album search for the brand (plus aliases), and writes per-brand JSON
files under data/brands/. Resumable via data/state.json.
"""

import argparse
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from urllib.parse import quote, urlparse

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WIKI_JSON = os.path.join(ROOT, "wiki_structure.json")
DATA_DIR = os.path.join(ROOT, "data")
BRANDS_DIR = os.path.join(DATA_DIR, "brands")
STATE_PATH = os.path.join(DATA_DIR, "state.json")

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)

MAX_PAGES = 50
PAGE_SLEEP = 0.3
TIMEOUT = 20
RETRY_DELAYS = [1, 3, 9]

ALIASES = {
    "louis vuitton": ["LV"],
    "saint laurent": ["YSL"],
    "the north face": ["TNF"],
    "chrome hearts": ["chrome", "CH"],
    "alexander mcqueen": ["mcqueen"],
    "christian louboutin": ["louboutin", "CL"],
    "canada goose": ["goose"],
    "anti social social club": ["ASSC"],
    "cdg / cdg play": ["CDG"],
    "comme des garcons": ["CDG"],
    "fear of god": ["FOG", "essentials"],
    "bvlgari": ["bulgari"],
    "yeezy": ["yzy"],
    "acne studios": ["acne"],
    "essentials": ["FOG", "fear of god"],
    "rhude": ["RHUDE"],
    "supreme": ["SUPREME"],
}

CATEGORY_LINK_RE = re.compile(
    r'href="(/categories/(\d+))"[^>]*>\s*<li[^>]*>([^<]+)</li>',
    re.IGNORECASE,
)

JUNK_RE = re.compile(
    r"whatsapp|wechat|telegram|payment|shipping|feedback|QC|how to|contact|"
    r"discount|coupon|aftersale|album|catalogue|price list",
    re.IGNORECASE,
)

ALBUM_ANCHOR_RE = re.compile(r'<a[^>]+href="/albums/(\d+)[^"]*"')
TITLE_RE = re.compile(
    r'class="[^"]*album__title[^"]*"[^>]*>(.*?)</', re.DOTALL
)
IMG_RE = re.compile(
    r'(?:data-src|src)="((?:https?:)?//photo\.yupoo\.com/[^"]+)"'
)
TAG_RE = re.compile(r"<[^>]+>")

_tls = threading.local()
state_lock = threading.Lock()
brand_lock = threading.Lock()
index_lock = threading.Lock()
print_lock = threading.Lock()


def get_session():
    sess = getattr(_tls, "session", None)
    if sess is None:
        sess = requests.Session()
        sess.headers["User-Agent"] = USER_AGENT
        _tls.session = sess
    return sess


def fetch(url):
    """GET with retries. Returns response text or raises the last error."""
    last_exc = None
    for attempt in range(len(RETRY_DELAYS) + 1):
        try:
            resp = get_session().get(url, timeout=TIMEOUT)
            resp.raise_for_status()
            return resp.text
        except Exception as exc:  # noqa: BLE001 - network errors of any kind
            last_exc = exc
            if attempt < len(RETRY_DELAYS):
                time.sleep(RETRY_DELAYS[attempt])
    raise last_exc


def slugify(name):
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower())
    return slug.strip("-")


def clean_heading(heading):
    return heading.lstrip("#").strip()


def load_pairs():
    """Returns (pairs, skipped) where pairs is a list of (store, brand)."""
    with open(WIKI_JSON, encoding="utf-8") as fh:
        sections = json.load(fh)

    pairs = []
    seen = set()
    skipped = []
    for section in sections:
        heading = clean_heading(section["heading"])
        if heading.lower() == "trusted store list":
            continue
        for link in section["links"]:
            href = link.get("href") or ""
            host = urlparse(href).netloc.lower()
            if host.endswith(".yupoo.com"):
                key = (host, heading)
                if key not in seen:
                    seen.add(key)
                    pairs.append(key)
            elif "reddit.com" not in host:
                skipped.append(
                    {"brand": heading, "text": link.get("text"), "href": href}
                )
    return pairs, skipped


def queries_for(brand):
    extra = ALIASES.get(brand.lower(), [])
    return [brand] + extra


def category_matches(name, queries):
    """True if a Yupoo category label looks like it belongs to this brand."""
    name_lower = TAG_RE.sub("", name).strip().lower()
    if len(name_lower) < 2:
        return False
    for query in queries:
        ql = query.lower().strip()
        if len(ql) < 2:
            continue
        if ql == name_lower or ql in name_lower or name_lower in ql:
            return True
        if len(ql) >= 4 and re.search(r"\b" + re.escape(ql) + r"\b", name_lower):
            return True
    return False


def find_matching_categories(store, brand):
    """Return category paths (/categories/123) whose names match the brand."""
    html = fetch(f"https://{store}/categories")
    queries = queries_for(brand)
    paths = []
    seen = set()
    for _path, _cid, raw_name in CATEGORY_LINK_RE.findall(html):
        if not category_matches(raw_name, queries):
            continue
        if _path not in seen:
            seen.add(_path)
            paths.append(_path)
    return paths


def scrape_category(store, brand, cat_path, items):
    """Paginate a category page and merge albums into items dict."""
    for page in range(1, MAX_PAGES + 1):
        suffix = f"?page={page}" if page > 1 else ""
        url = f"https://{store}{cat_path}{suffix}"
        html = fetch(url)
        albums = parse_albums(html, store)
        if not albums:
            break
        for album in albums:
            items[(store, album["id"])] = {
                "id": album["id"],
                "title": album["title"],
                "brand": brand,
                "store": store,
                "url": album["url"],
                "img": album["img"],
            }
        time.sleep(PAGE_SLEEP)


def parse_albums(html, store):
    """Parse album cards from a search results page."""
    albums = []
    anchors = list(ALBUM_ANCHOR_RE.finditer(html))
    for i, match in enumerate(anchors):
        album_id = match.group(1)
        window_end = anchors[i + 1].start() if i + 1 < len(anchors) else len(html)
        window = html[match.start():window_end]

        title_m = TITLE_RE.search(window)
        img_m = IMG_RE.search(window)
        if not title_m or not img_m:
            continue

        title = TAG_RE.sub("", title_m.group(1)).strip()
        if len(title) < 3 or JUNK_RE.search(title):
            continue

        img = img_m.group(1)
        img = re.sub(r"/[^/]+$", "/medium.jpg", img)
        if img.startswith("//"):
            img = "https:" + img
        albums.append(
            {
                "id": album_id,
                "title": title,
                "url": f"https://{store}/albums/{album_id}?uid=1&isSubCate=false&referrercate=",
                "img": img,
            }
        )
    return albums


def scrape_pair(store, brand):
    """Collect albums via search + matching category folders."""
    items = {}
    for query in queries_for(brand):
        for page in range(1, MAX_PAGES + 1):
            url = f"https://{store}/search/album?q={quote(query)}&page={page}"
            html = fetch(url)
            albums = parse_albums(html, store)
            if not albums:
                break
            for album in albums:
                items[(store, album["id"])] = {
                    "id": album["id"],
                    "title": album["title"],
                    "brand": brand,
                    "store": store,
                    "url": album["url"],
                    "img": album["img"],
                }
            time.sleep(PAGE_SLEEP)

    try:
        for cat_path in find_matching_categories(store, brand):
            scrape_category(store, brand, cat_path, items)
    except Exception:  # noqa: BLE001 - category scrape is best-effort
        pass

    return list(items.values())


def atomic_write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1)
    for attempt in range(5):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(0.2 * (attempt + 1))


def load_json(path, default):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    return default


class BrandStore:
    """Accumulates items per brand and rewrites brand files atomically."""

    def __init__(self):
        self.by_brand = {}

    def add(self, brand, items):
        with brand_lock:
            slug = slugify(brand)
            path = os.path.join(BRANDS_DIR, f"{slug}.json")
            if slug not in self.by_brand:
                existing = load_json(path, [])
                self.by_brand[slug] = {
                    (it["store"], it["id"]): it for it in existing
                }
            bucket = self.by_brand[slug]
            for item in items:
                bucket[(item["store"], item["id"])] = item
            atomic_write_json(path, list(bucket.values()))

    def total_items(self):
        with brand_lock:
            return sum(len(b) for b in self.by_brand.values())


def write_index():
    """Rebuild data/index.json from the brand files on disk."""
    with index_lock:
        brands = []
        total = 0
        if os.path.isdir(BRANDS_DIR):
            for fname in sorted(os.listdir(BRANDS_DIR)):
                if not fname.endswith(".json"):
                    continue
                items = load_json(os.path.join(BRANDS_DIR, fname), [])
                if not items:
                    continue
                # Brand display name from the items themselves
                name = items[0]["brand"]
                brands.append(
                    {"name": name, "slug": fname[:-5], "count": len(items)}
                )
                total += len(items)
        brands.sort(key=lambda b: b["name"])
        atomic_write_json(
            os.path.join(DATA_DIR, "index.json"),
            {
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "total_items": total,
                "brands": brands,
            },
        )


def main():
    parser = argparse.ArgumentParser(description="Yupoo brand album scraper")
    parser.add_argument("--limit", type=int, default=None,
                        help="only process first N pairs")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument(
        "--rescan-brands",
        default=None,
        help="comma-separated brand names to force re-scrape (e.g. Rhude,Supreme)",
    )
    args = parser.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    os.makedirs(BRANDS_DIR, exist_ok=True)

    pairs, skipped = load_pairs()
    atomic_write_json(os.path.join(DATA_DIR, "skipped_links.json"), skipped)

    if args.limit is not None:
        pairs = pairs[: args.limit]

    rescan = set()
    if args.rescan_brands:
        rescan = {b.strip() for b in args.rescan_brands.split(",") if b.strip()}

    state = load_json(STATE_PATH, {})
    todo = []
    for s, b in pairs:
        key = f"{s}|{b}"
        if b in rescan:
            todo.append((s, b))
        elif key not in state or state[key].get("status") not in ("done", "error"):
            todo.append((s, b))
    skipped_done = len(pairs) - len(todo)
    if skipped_done:
        label = "Re-scanning" if rescan else "Resuming"
        print(f"{label}: {skipped_done} pairs skipped, "
              f"{len(todo)} to process.", flush=True)

    store = BrandStore()
    completed = [skipped_done]

    def save_state(key, value):
        with state_lock:
            state[key] = value
            atomic_write_json(STATE_PATH, state)

    def work(pair):
        host, brand = pair
        key = f"{host}|{brand}"
        try:
            items = scrape_pair(host, brand)
        except Exception as exc:  # noqa: BLE001
            save_state(key, {"status": "error", "error": str(exc)})
            with print_lock:
                completed[0] += 1
                print(f"[{completed[0]}/{len(pairs)}] {brand} @ {host}: "
                      f"ERROR {exc}", flush=True)
            return
        store.add(brand, items)
        save_state(key, {"status": "done", "items": len(items)})
        write_index()
        with print_lock:
            completed[0] += 1
            print(f"[{completed[0]}/{len(pairs)}] {brand} @ {host}: "
                  f"{len(items)} items (total {store.total_items()})",
                  flush=True)

    if todo:
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = [pool.submit(work, pair) for pair in todo]
            for fut in as_completed(futures):
                fut.result()

    write_index()
    print("Done. Index written.", flush=True)


if __name__ == "__main__":
    main()
