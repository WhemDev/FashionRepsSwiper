# FashionRepsSwiper

A **Tinder-style swiper** for browsing items from the [r/FashionReps trusted-sellers wiki](https://www.reddit.com/r/FashionReps/wiki/trusted/). Swipe right to save an item with its Yupoo link, left to skip.

**Live app:** https://web-xi-blond-rgpvkw0mok.vercel.app — items load **on demand** when you pick brands (no local scrape).

![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-blue)
![Next.js 15](https://img.shields.io/badge/Next.js-15-black)
![License MIT](https://img.shields.io/badge/license-MIT-green)

## Use online (recommended)

1. Open your Vercel deployment (see [Deploy](#deploy-on-vercel-free))
2. Pick one or more **brands** in the left sidebar
3. Items load live from trusted Yupoo stores (progress bar)
4. Swipe right to **save** — stored in your browser (`localStorage`)
5. Export saved items as JSON from the Saved view

No install, no scrape, free on Vercel hobby tier.

## Deploy on Vercel (free)

1. Fork or clone: https://github.com/WhemDev/FashionRepsSwiper
2. [Import to Vercel](https://vercel.com/new) → set **Root Directory** to `web`
3. Deploy — no environment variables required

```bash
cd web && npx vercel --prod
```

### How live mode works

- Pick brand(s) → browser calls `/api/scrape` per trusted store
- Cards appear as results arrive (CDN-cached 24h)
- Images via `/api/img` proxy (Yupoo requires Referer)
- Saves in **localStorage** (not cookies — fits hundreds of items)

“All brands at once” is disabled — it would be thousands of API calls. Pick the brands you want.

## Features

- Live on-demand scraping from wiki trusted sellers
- Swipe deck (drag, keyboard, buttons)
- Multi-brand filter + search
- Saved items + JSON export
- Optional local bulk scraper + Flask app for power users

## Local mode (optional)

```bash
pip install -r requirements.txt
python scraper/scrape.py --limit 20   # test scrape
python app/server.py --demo           # or python app/server.py
```

### Next.js dev

```bash
cd web && npm install && npm run dev
```

## Project layout

```text
web/           Next.js app for Vercel (live scrape)
app/           Flask UI (local hosting)
scraper/       Bulk offline scraper
wiki_structure.json
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
