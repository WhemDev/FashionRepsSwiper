import type { Item, ScrapeMeta } from "./types";

const CONCURRENCY = 6;

async function api<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

type PageResult = { items: Item[]; hasMore: boolean };

async function fetchSearchPage(
  store: string,
  brand: string,
  query: string,
  page: number
): Promise<PageResult> {
  const u = `/api/scrape?mode=search&store=${encodeURIComponent(store)}&brand=${encodeURIComponent(brand)}&query=${encodeURIComponent(query)}&page=${page}`;
  return api(u);
}

async function fetchCategoryPage(
  store: string,
  brand: string,
  path: string,
  page: number
): Promise<PageResult> {
  const u = `/api/scrape?mode=category&store=${encodeURIComponent(store)}&brand=${encodeURIComponent(brand)}&path=${encodeURIComponent(path)}&page=${page}`;
  return api(u);
}

async function fetchMeta(store: string, brand: string): Promise<ScrapeMeta> {
  const u = `/api/scrape?mode=meta&store=${encodeURIComponent(store)}&brand=${encodeURIComponent(brand)}`;
  return api(u);
}

async function paginate(
  fetchPage: (page: number) => Promise<PageResult>,
  maxPages = 15
): Promise<Item[]> {
  const all: Item[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const { items, hasMore } = await fetchPage(page);
    all.push(...items);
    if (!hasMore || items.length === 0) break;
  }
  return all;
}

async function scrapeOneStore(store: string, brand: string): Promise<Item[]> {
  const meta = await fetchMeta(store, brand);
  const buckets: Item[][] = [];

  for (const query of meta.queries) {
    buckets.push(
      await paginate((page) => fetchSearchPage(store, brand, query, page), 10)
    );
  }
  for (const path of meta.categories) {
    buckets.push(
      await paginate((page) => fetchCategoryPage(store, brand, path, page), 10)
    );
  }

  const seen = new Set<string>();
  const out: Item[] = [];
  for (const list of buckets) {
    for (const it of list) {
      const k = `${it.store}|${it.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(it);
    }
  }
  return out;
}

export type ScrapeProgress = {
  done: number;
  total: number;
  currentStore: string;
  itemsFound: number;
};

export async function scrapeBrandsLive(
  brandSlugs: string[],
  onProgress: (p: ScrapeProgress) => void,
  onItems: (batch: Item[]) => void,
  signal?: AbortSignal
): Promise<Item[]> {
  const storeJobs: { store: string; brand: string }[] = [];

  for (const slug of brandSlugs) {
    const data = await api<{ stores: string[]; name: string }>(
      `/api/brands/stores?slug=${encodeURIComponent(slug)}`
    );
    for (const store of data.stores) {
      storeJobs.push({ store, brand: data.name });
    }
  }

  const total = storeJobs.length;
  let done = 0;
  let itemsFound = 0;
  const all: Item[] = [];
  const seen = new Set<string>();

  const runJob = async (job: { store: string; brand: string }) => {
    if (signal?.aborted) return;
    onProgress({ done, total, currentStore: job.store, itemsFound });
    try {
      const items = await scrapeOneStore(job.store, job.brand);
      const fresh: Item[] = [];
      for (const it of items) {
        const k = `${it.store}|${it.id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        all.push(it);
        fresh.push(it);
      }
      itemsFound = all.length;
      if (fresh.length) onItems(fresh);
    } catch {
      /* store failed — continue */
    }
    done++;
    onProgress({ done, total, currentStore: job.store, itemsFound });
  };

  let idx = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, async () => {
    while (idx < total) {
      if (signal?.aborted) break;
      const job = storeJobs[idx++];
      await runJob(job);
    }
  });
  await Promise.all(workers);
  return all;
}

export function itemSortKey(item: Item, seed: number): number {
  const k = `${item.store}|${item.id}`;
  const s = `${seed}|${k}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

export function shuffleItems(items: Item[], seed: number): Item[] {
  return items
    .slice()
    .sort((a, b) => itemSortKey(a, seed) - itemSortKey(b, seed));
}
