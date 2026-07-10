"""Flask server for the Yupoo swipe UI.

Serves brand/item data produced by the scraper (data/ folder) plus an
image proxy that adds the Referer header Yupoo requires.
"""

import argparse
import hashlib
import json
import os
import random
import threading

import requests
from flask import Flask, Response, jsonify, request, send_from_directory

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DATA_DIR = os.path.join(os.path.dirname(APP_DIR), "data")
STATIC_DIR = os.path.join(APP_DIR, "static")

YUPOO_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
    ),
    "Referer": "https://x.yupoo.com/",
}

app = Flask(__name__)

DATA_DIR = DEFAULT_DATA_DIR

# mtime-keyed caches, guarded by a lock since we run threaded
_cache_lock = threading.Lock()
_index_cache = {"mtime": None, "data": None}
_brand_cache = {}  # slug -> {"mtime": float, "items": list}


def _load_json_if_changed(path, cache_entry):
    """Return cached data, reloading from disk if mtime changed. None if missing."""
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return None
    if cache_entry.get("mtime") != mtime:
        try:
            with open(path, "r", encoding="utf-8") as f:
                cache_entry["data"] = json.load(f)
            cache_entry["mtime"] = mtime
        except (OSError, json.JSONDecodeError):
            return cache_entry.get("data")
    return cache_entry["data"]


def get_index():
    with _cache_lock:
        return _load_json_if_changed(os.path.join(DATA_DIR, "index.json"), _index_cache)


def get_brand_items(slug):
    path = os.path.join(DATA_DIR, "brands", f"{slug}.json")
    with _cache_lock:
        entry = _brand_cache.setdefault(slug, {})
        items = _load_json_if_changed(path, entry)
    return items if isinstance(items, list) else None


def get_brands_from_disk():
    """Discover brands by scanning data/brands/*.json (live during scraping)."""
    brands_dir = os.path.join(DATA_DIR, "brands")
    brands = []
    total = 0
    if not os.path.isdir(brands_dir):
        return brands, total
    for fname in sorted(os.listdir(brands_dir)):
        if not fname.endswith(".json"):
            continue
        slug = fname[:-5]
        items = get_brand_items(slug) or []
        if not items:
            continue
        name = items[0].get("brand") or slug.replace("-", " ").title()
        brands.append({"name": name, "slug": slug, "count": len(items)})
        total += len(items)
    brands.sort(key=lambda b: b["name"].lower())
    return brands, total


def get_all_items():
    combined = []
    seen = set()
    brands, _ = get_brands_from_disk()
    for brand in brands:
        items = get_brand_items(brand.get("slug", "")) or []
        for item in items:
            key = (item.get("store"), item.get("id"))
            if key in seen:
                continue
            seen.add(key)
            combined.append(item)
    return combined


@app.route("/api/brands")
def api_brands():
    brands, total = get_brands_from_disk()
    index = get_index() or {}
    return jsonify(
        {
            "brands": brands,
            "total_items": total,
            "generated_at": index.get("generated_at"),
        }
    )


@app.route("/api/items")
def api_items():
    brand = request.args.get("brand", "all")
    seed = request.args.get("seed", 0, type=int)
    offset = max(request.args.get("offset", 0, type=int), 0)
    limit = min(max(request.args.get("limit", 30, type=int), 1), 100)

    if brand == "all":
        pool = get_all_items()
    else:
        pool = get_brand_items(brand)
        if pool is None:
            return jsonify({"error": f"unknown brand: {brand}"}), 404
        pool = list(pool)

    random.Random(seed).shuffle(pool)
    return jsonify(
        {
            "items": pool[offset : offset + limit],
            "total": len(pool),
            "offset": offset,
        }
    )


@app.route("/api/skipped")
def api_skipped():
    path = os.path.join(DATA_DIR, "skipped_links.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            return jsonify(json.load(f))
    except (OSError, json.JSONDecodeError):
        return jsonify([])


@app.route("/api/health")
def api_health():
    brands, total = get_brands_from_disk()
    return jsonify({"ok": True, "items_loaded": len(get_all_items()), "brand_count": len(brands), "total_items": total})


@app.route("/api/info")
def api_info():
    brands, total = get_brands_from_disk()
    repo_root = os.path.dirname(APP_DIR)
    return jsonify(
        {
            "demo": "mock_data" in DATA_DIR.replace("\\", "/"),
            "brand_count": len(brands),
            "total_items": total,
            "wiki_present": os.path.isfile(os.path.join(repo_root, "wiki_structure.json")),
            "scrape_needed": len(brands) == 0,
        }
    )


def _allowed_image_host(url):
    from urllib.parse import urlparse

    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return False
    return host == "photo.yupoo.com" or host.endswith(".yupoo.com")


@app.route("/img")
def img_proxy():
    url = request.args.get("u", "")
    if not url.startswith(("http://", "https://")) or not _allowed_image_host(url):
        return Response("forbidden", status=403)

    cache_dir = os.path.join(DATA_DIR, "img_cache")
    cache_path = os.path.join(cache_dir, hashlib.sha1(url.encode("utf-8")).hexdigest() + ".jpg")

    if os.path.isfile(cache_path):
        with open(cache_path, "rb") as f:
            body = f.read()
        return Response(
            body,
            mimetype="image/jpeg",
            headers={"Cache-Control": "public, max-age=604800"},
        )

    try:
        resp = requests.get(url, headers=YUPOO_HEADERS, timeout=15)
        resp.raise_for_status()
    except requests.RequestException:
        return Response("upstream error", status=502)

    os.makedirs(cache_dir, exist_ok=True)
    tmp_path = cache_path + ".tmp"
    with open(tmp_path, "wb") as f:
        f.write(resp.content)
    os.replace(tmp_path, cache_path)

    content_type = resp.headers.get("Content-Type", "image/jpeg")
    return Response(
        resp.content,
        mimetype=content_type,
        headers={"Cache-Control": "public, max-age=604800"},
    )


@app.route("/")
def index_page():
    index_html = os.path.join(STATIC_DIR, "index.html")
    if os.path.isfile(index_html):
        return send_from_directory(STATIC_DIR, "index.html")
    return Response(
        "<html><body><h1>Frontend not built yet</h1>"
        "<p>The static UI is still being generated. API endpoints are live at /api/*.</p>"
        "</body></html>",
        mimetype="text/html",
    )


@app.route("/<path:filename>")
def static_files(filename):
    if os.path.isdir(STATIC_DIR):
        return send_from_directory(STATIC_DIR, filename)
    return Response("not found", status=404)


def main():
    global DATA_DIR
    parser = argparse.ArgumentParser(description="Yupoo swipe UI server")
    parser.add_argument("--port", type=int, default=5000)
    parser.add_argument("--data-dir", default=DEFAULT_DATA_DIR)
    parser.add_argument(
        "--demo",
        action="store_true",
        help="serve bundled sample data (try the app without scraping)",
    )
    args = parser.parse_args()
    if args.demo:
        DATA_DIR = os.path.abspath(os.path.join(APP_DIR, "mock_data"))
    else:
        DATA_DIR = os.path.abspath(args.data_dir)
    print(f"Serving data from: {DATA_DIR}")
    app.run(host="127.0.0.1", port=args.port, threaded=True)


if __name__ == "__main__":
    main()
