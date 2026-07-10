"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BrandInfo, Item, SkippedLink } from "@/lib/types";
import { preloadItemImage, preloadItemImages, proxied } from "@/lib/images";
import { scrapeBrandsLive, type ScrapeProgress } from "@/lib/scrapeClient";
import SwipeCard from "@/components/SwipeCard";

const LS_SAVED = "fr_saved";
const LS_SWIPED = "fr_swiped";
const LS_BRANDS = "fr_brands";
const LS_COLLAPSED = "fr_brands_collapsed";
const LS_WELCOME = "fr_welcome_seen";
const SS_SEED = "fr_seed";
const PREFETCH_AHEAD = 8;
const PRELOAD_CONCURRENCY = 4;

function itemKey(item: Item) {
  return `${item.store}|${item.id}`;
}

function brandColor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 65%, 42%)`;
}

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export default function SwipeApp() {
  const [view, setView] = useState<"deck" | "saved" | "skipped">("deck");
  const [brands, setBrands] = useState<BrandInfo[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [brandQuery, setBrandQuery] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [welcome, setWelcome] = useState(false);

  const [deck, setDeck] = useState<Item[]>([]);
  const [saved, setSaved] = useState<Item[]>([]);
  const [swiped, setSwiped] = useState<Set<string>>(new Set());
  const [seed, setSeed] = useState(0);

  const [scraping, setScraping] = useState(false);
  const [progress, setProgress] = useState<ScrapeProgress | null>(null);
  const [scrapeError, setScrapeError] = useState(false);
  const [scrapeDone, setScrapeDone] = useState(false);
  const [bufferingCard, setBufferingCard] = useState(false);
  const [imagesReady, setImagesReady] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const queueRef = useRef<Item[]>([]);
  const preloadIdxRef = useRef(0);
  const preloadRunningRef = useRef(false);
  const failedKeysRef = useRef(new Set<string>());
  const readyKeysRef = useRef(new Set<string>());
  const swipedRef = useRef(new Set<string>());

  const [skipped, setSkipped] = useState<SkippedLink[]>([]);
  const [drag, setDrag] = useState({ x: 0, active: false });
  const dragStartX = useRef(0);

  const buildDeck = useCallback(() => {
    return queueRef.current.filter(
      (it) =>
        readyKeysRef.current.has(itemKey(it)) && !swipedRef.current.has(itemKey(it))
    );
  }, []);

  const hasMoreToPreload = useCallback(() => {
    return queueRef.current.some((it) => {
      const k = itemKey(it);
      return (
        !readyKeysRef.current.has(k) &&
        !failedKeysRef.current.has(k) &&
        !swipedRef.current.has(k)
      );
    });
  }, []);

  const commitSwipe = useCallback(
    (action: "save" | "skip") => {
      const current = buildDeck();
      const item = current[0];
      if (!item) return;

      const k = itemKey(item);
      swipedRef.current.add(k);
      setSwiped(new Set(swipedRef.current));
      localStorage.setItem(LS_SWIPED, JSON.stringify([...swipedRef.current]));

      if (action === "save") {
        const entry = { ...item, savedAt: Date.now() };
        setSaved((prev) => {
          if (prev.some((s) => itemKey(s) === k)) return prev;
          const next = [entry as Item & { savedAt: number }, ...prev];
          localStorage.setItem(LS_SAVED, JSON.stringify(next));
          return next;
        });
      }

      setDrag({ x: 0, active: false });
      setDeck(buildDeck());
    },
    [buildDeck]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (view !== "deck" || !deck[0]) return;
      if (e.key === "ArrowLeft") commitSwipe("skip");
      if (e.key === "ArrowRight") commitSwipe("save");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, deck, commitSwipe]);

  useEffect(() => {
    const s = parseInt(sessionStorage.getItem(SS_SEED) || "", 10);
    setSeed(Number.isInteger(s) ? s : Math.floor(Math.random() * 1e9));
    setSaved(readJSON(LS_SAVED, []));
    const storedSwiped = readJSON<string[]>(LS_SWIPED, []);
    swipedRef.current = new Set(storedSwiped);
    setSwiped(swipedRef.current);
    const stored = readJSON<string[]>(LS_BRANDS, []);
    if (stored.length) setSelected(stored.filter((x) => x !== "all"));
    setCollapsed(localStorage.getItem(LS_COLLAPSED) === "true");
    setWelcome(localStorage.getItem(LS_WELCOME) !== "1");
  }, []);

  useEffect(() => {
    fetch("/api/brands")
      .then((r) => r.json())
      .then((d) => setBrands(d.brands || []))
      .catch(() => setBrands([]));
  }, []);

  const persistSelected = useCallback((slugs: string[]) => {
    localStorage.setItem(LS_BRANDS, JSON.stringify(slugs));
  }, []);

  const runPreload = useCallback(
    async (signal: AbortSignal) => {
      if (preloadRunningRef.current) return;
      preloadRunningRef.current = true;

      const sync = () => {
        const next = buildDeck();
        setDeck(next);
        setImagesReady(readyKeysRef.current.size);
        setBufferingCard(next.length === 0 && hasMoreToPreload());
      };

      try {
        while (preloadIdxRef.current < queueRef.current.length) {
          if (signal.aborted) break;

          const buffered = buildDeck().length;
          if (buffered >= PREFETCH_AHEAD) break;

          const batch: Item[] = [];
          while (
            batch.length < PRELOAD_CONCURRENCY &&
            preloadIdxRef.current < queueRef.current.length
          ) {
            const item = queueRef.current[preloadIdxRef.current++];
            const k = itemKey(item);
            if (
              readyKeysRef.current.has(k) ||
              failedKeysRef.current.has(k) ||
              swipedRef.current.has(k)
            ) {
              continue;
            }
            batch.push(item);
          }

          if (batch.length === 0) break;

          if (buildDeck().length === 0) setBufferingCard(true);

          const loaded = await preloadItemImages(batch);
          if (signal.aborted) break;

          for (const item of batch) {
            const k = itemKey(item);
            if (loaded.some((it) => itemKey(it) === k)) {
              readyKeysRef.current.add(k);
            } else {
              failedKeysRef.current.add(k);
            }
          }
          sync();
        }
      } finally {
        preloadRunningRef.current = false;
        sync();
      }
    },
    [buildDeck, hasMoreToPreload]
  );

  const kickPreload = useCallback(() => {
    const ac = abortRef.current;
    if (ac && !ac.signal.aborted) void runPreload(ac.signal);
  }, [runPreload]);

  const resetQueue = useCallback(() => {
    queueRef.current = [];
    preloadIdxRef.current = 0;
    failedKeysRef.current = new Set();
    readyKeysRef.current = new Set();
    setImagesReady(0);
    setDeck([]);
  }, []);

  const enqueueItems = useCallback(
    (items: Item[], signal: AbortSignal) => {
      const seen = new Set(queueRef.current.map(itemKey));
      for (const item of items) {
        const k = itemKey(item);
        if (seen.has(k) || swipedRef.current.has(k) || failedKeysRef.current.has(k)) continue;
        seen.add(k);
        queueRef.current.push(item);
      }
      void runPreload(signal);
    },
    [runPreload]
  );

  const startScrape = useCallback(
    (slugs: string[]) => {
      abortRef.current?.abort();
      resetQueue();

      if (slugs.length === 0) {
        setScraping(false);
        setProgress(null);
        setScrapeDone(false);
        setBufferingCard(false);
        return;
      }

      const ac = new AbortController();
      abortRef.current = ac;
      setScraping(true);
      setScrapeError(false);
      setScrapeDone(false);
      setProgress({ done: 0, total: 0, currentStore: "", itemsFound: 0 });

      scrapeBrandsLive(
        slugs,
        setProgress,
        (batch) => {
          const fresh = batch.filter((it) => !swipedRef.current.has(itemKey(it)));
          enqueueItems(fresh, ac.signal);
        },
        ac.signal
      )
        .then((all) => {
          const fresh = all.filter((it) => !swipedRef.current.has(itemKey(it)));
          enqueueItems(fresh, ac.signal);
        })
        .then(() => {
          if (!ac.signal.aborted) {
            setScraping(false);
            setScrapeDone(true);
            setBufferingCard(buildDeck().length === 0 && hasMoreToPreload());
          }
        })
        .catch(() => {
          if (!ac.signal.aborted) setScrapeError(true);
          setScraping(false);
          setScrapeDone(true);
          setBufferingCard(false);
        });
    },
    [resetQueue, runPreload, enqueueItems, buildDeck, hasMoreToPreload]
  );

  useEffect(() => {
    if (seed === 0 && selected.length === 0) return;
    startScrape(selected);
    return () => abortRef.current?.abort();
  }, [selected, seed, startScrape]);

  useEffect(() => {
    kickPreload();
  }, [deck.length, kickPreload]);

  const toggleBrand = (slug: string) => {
    setSelected((prev) => {
      const next = prev.includes(slug)
        ? prev.filter((s) => s !== slug)
        : [...prev, slug];
      persistSelected(next);
      return next;
    });
  };

  const filteredBrands = brandQuery
    ? brands.filter((b) => b.name.toLowerCase().includes(brandQuery.toLowerCase()))
    : brands;

  const top = deck[0];
  const waitingForFirstImage =
    selected.length > 0 && !top && (scraping || bufferingCard);

  return (
    <>
      <header className="app-header">
        <div className="logo">
          <span className="logo-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
            </svg>
          </span>
          FashionRepsSwiper
          <span className="live-badge">LIVE</span>
        </div>
        <nav className="app-nav">
          <button type="button" className={`nav-btn ${view === "deck" ? "active" : ""}`} onClick={() => setView("deck")}>
            Deck
          </button>
          <button type="button" className={`nav-btn ${view !== "deck" ? "active" : ""}`} onClick={() => setView(view === "saved" ? "deck" : "saved")}>
            Saved
            {saved.length > 0 && <span className="badge">{saved.length > 99 ? "99+" : saved.length}</span>}
          </button>
        </nav>
      </header>

      <main className="app-main">
        {view === "deck" && (
          <section id="view-deck" className="view">
            <div className="deck-layout">
              <div className={`brand-section ${collapsed ? "collapsed" : ""}`}>
                <div className="brand-bar-head">
                  <button
                    type="button"
                    className="brand-collapse-toggle"
                    aria-expanded={!collapsed}
                    onClick={() => {
                      const next = !collapsed;
                      setCollapsed(next);
                      localStorage.setItem(LS_COLLAPSED, String(next));
                    }}
                  >
                    <svg className="chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                    <span className="brand-toggle-label">Brands</span>
                  </button>
                </div>
                <div className="brand-chips" role="tablist">
                  {filteredBrands.map((b) => (
                    <button
                      key={b.slug}
                      type="button"
                      role="tab"
                      className={`chip ${selected.includes(b.slug) ? "active" : ""}`}
                      onClick={() => toggleBrand(b.slug)}
                    >
                      <span>{b.name}</span>
                      <span className="chip-count">{b.storeCount}</span>
                    </button>
                  ))}
                </div>
                <input
                  className="brand-search"
                  type="search"
                  placeholder="Search brands..."
                  value={brandQuery}
                  onChange={(e) => setBrandQuery(e.target.value)}
                />
              </div>

              <div className="deck-column">
                {selected.length === 0 && (
                  <div className="scrape-progress">
                    <strong>Pick one or more brands</strong> on the left to load items live from Yupoo stores.
                  </div>
                )}

                {scraping && progress && (
                  <div className="scrape-progress">
                    Loading from trusted stores… {progress.done}/{progress.total || "?"}
                    {progress.currentStore && ` · ${progress.currentStore}`}
                    <div className="scrape-progress-bar">
                      <div
                        className="scrape-progress-fill"
                        style={{
                          width: progress.total
                            ? `${(100 * progress.done) / progress.total}%`
                            : "30%",
                        }}
                      />
                    </div>
                    <div style={{ marginTop: 6 }}>{progress.itemsFound} items found</div>
                  </div>
                )}

                {waitingForFirstImage && (
                  <div className="scrape-progress image-loading">
                    <strong>{scraping ? "Loading items…" : "Loading next image…"}</strong>
                    <div className="image-loading-spinner" aria-hidden="true" />
                    <div style={{ marginTop: 6 }}>
                      {imagesReady} ready
                      {(progress?.itemsFound ?? 0) > 0 && ` · ${progress?.itemsFound} found`}
                    </div>
                  </div>
                )}

                <div className="deck">
                  <div className="stack">
                    {top && (
                      <SwipeCard
                        item={top}
                        drag={drag}
                        dragStartX={dragStartX}
                        onDrag={setDrag}
                        onSwipe={commitSwipe}
                      />
                    )}
                    {!top && !waitingForFirstImage && scrapeDone && selected.length > 0 && (
                      <div className="deck-status">
                        <h3>{scrapeError ? "Some stores failed" : "No more items"}</h3>
                        <p className="muted">
                          {scrapeError
                            ? "Try another brand or retry."
                            : "Change brand selection to load more."}
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="actions">
                  <button type="button" className="action-btn action-skip" onClick={() => commitSwipe("skip")} aria-label="Skip" disabled={!top}>
                    ✕
                  </button>
                  <button type="button" className="action-btn action-save" onClick={() => commitSwipe("save")} aria-label="Save" disabled={!top}>
                    ♥
                  </button>
                </div>
                <p className="shortcuts-hint">
                  <kbd>←</kbd> skip · <kbd>→</kbd> save
                </p>
              </div>
            </div>
          </section>
        )}

        {view === "saved" && (
          <section className="view">
            <div className="view-head">
              <h2>Saved items</h2>
              <button
                type="button"
                className="tool-btn"
                onClick={() => {
                  const blob = new Blob([JSON.stringify(saved, null, 2)], { type: "application/json" });
                  const a = document.createElement("a");
                  a.href = URL.createObjectURL(blob);
                  a.download = "fr_saved.json";
                  a.click();
                }}
              >
                Export JSON
              </button>
            </div>
            <div className="saved-grid">
              {saved.map((item) => (
                <a key={itemKey(item)} className="saved-card" href={item.url} target="_blank" rel="noopener noreferrer">
                  <div className="saved-thumb">
                    <img src={proxied(item.img, item.store)} alt="" loading="lazy" />
                  </div>
                  <div className="saved-meta">
                    <span className="brand-chip" style={{ background: brandColor(item.brand) }}>
                      {item.brand}
                    </span>
                    <h3 className="saved-title">{item.title}</h3>
                  </div>
                </a>
              ))}
            </div>
            {saved.length === 0 && (
              <div className="empty-note">
                <p>Nothing saved yet — swipe right on items you like.</p>
              </div>
            )}
            <button
              type="button"
              className="tool-btn"
              style={{ marginTop: 16 }}
              onClick={() => {
                fetch("/api/skipped")
                  .then((r) => r.json())
                  .then(setSkipped)
                  .then(() => setView("skipped"));
              }}
            >
              Skipped shops
            </button>
          </section>
        )}

        {view === "skipped" && (
          <section className="view">
            <div className="view-head">
              <button type="button" className="tool-btn" onClick={() => setView("saved")}>
                Back
              </button>
              <h2>Skipped shops</h2>
            </div>
            <div className="skipped-list">
              {[...new Set(skipped.map((s) => s.brand))].sort().map((brand) => (
                <div key={brand} className="skipped-group">
                  <h3>{brand}</h3>
                  <div className="skipped-links">
                    {skipped
                      .filter((s) => s.brand === brand)
                      .map((s, i) => (
                        <a key={i} className="skipped-link" href={s.href} target="_blank" rel="noopener noreferrer">
                          {s.text}
                        </a>
                      ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>

      {welcome && (
        <div className="modal">
          <div className="modal-backdrop" onClick={() => { setWelcome(false); localStorage.setItem(LS_WELCOME, "1"); }} />
          <div className="modal-card">
            <h2>Welcome to FashionRepsSwiper</h2>
            <p className="modal-lead">
              Items load <strong>live from Yupoo</strong> when you pick brands — no install needed.
            </p>
            <ul className="modal-steps">
              <li>Select brand(s) on the left</li>
              <li>Swipe right to save with link · left to skip</li>
              <li>Saved list stays in your browser (localStorage)</li>
            </ul>
            <button
              type="button"
              className="primary-btn"
              onClick={() => {
                setWelcome(false);
                localStorage.setItem(LS_WELCOME, "1");
              }}
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  );
}
