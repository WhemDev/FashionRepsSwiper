# Contributing to FashionRepsSwiper

Thanks for helping improve the app for r/FashionReps!

## How to contribute

1. **Fork** the repo on GitHub
2. **Clone** your fork locally
3. Create a branch: `git checkout -b fix/my-improvement`
4. Make your changes
5. Test locally:
   ```bash
   pip install -r requirements.txt
   python app/server.py --demo
   node --check app/static/app.js   # if Node is installed
   ```
6. **Open a pull request** against `main`

Do not commit scraped data (`data/brands/`, `data/img_cache/`) — those are generated locally.

## Good first contributions

- UX polish (mobile layout, loading states, accessibility)
- Better category/brand matching in the scraper
- Faster pagination or caching
- Docs and setup scripts for Linux/macOS

## Repo permissions

- The repo is **public** so anyone can fork and run the app
- Only the **owner** can change repository settings, delete the repo, or merge to protected `main`
- Everyone else contributes via **pull requests**

## Code style

- Keep frontend vanilla JS/CSS — no build step
- Match existing patterns in `app/static/` and `scraper/scrape.py`
- Use `textContent` for user-facing strings in the UI
- Small, focused PRs are easier to review

## Questions

Open a GitHub issue or discuss in your PR.
