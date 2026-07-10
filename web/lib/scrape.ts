import type { Item, ScrapeMeta } from "./types";

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const ALIASES: Record<string, string[]> = {
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
  bvlgari: ["bulgari"],
  yeezy: ["yzy"],
  "acne studios": ["acne"],
  essentials: ["FOG", "fear of god"],
  rhude: ["RHUDE"],
  supreme: ["SUPREME"],
};

const JUNK_RE =
  /whatsapp|wechat|telegram|payment|shipping|feedback|QC|how to|contact|discount|coupon|aftersale|album|catalogue|price list/i;

const ALBUM_ANCHOR_RE = /<a[^>]+href="\/albums\/(\d+)[^"]*"/g;
const TITLE_RE = /class="[^"]*album__title[^"]*"[^>]*>([\s\S]*?)<\//;
const IMG_RE = /(?:data-src|src)="((?:https?:)?\/\/photo\.yupoo\.com\/[^"]+)"/;
const TAG_RE = /<[^>]+>/g;
const CATEGORY_LINK_RE =
  /href="(\/categories\/(\d+))"[^>]*>\s*<li[^>]*>([^<]+)<\/li>/gi;

export function queriesFor(brand: string): string[] {
  const extra = ALIASES[brand.toLowerCase()] ?? [];
  return [brand, ...extra];
}

export async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    next: { revalidate: 86400 },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

export function parseAlbums(html: string, store: string, brand: string): Item[] {
  const albums: Item[] = [];
  const anchors = [...html.matchAll(ALBUM_ANCHOR_RE)];
  for (let i = 0; i < anchors.length; i++) {
    const match = anchors[i];
    const albumId = match[1];
    const start = match.index ?? 0;
    const end = i + 1 < anchors.length ? (anchors[i + 1].index ?? html.length) : html.length;
    const window = html.slice(start, end);

    const titleM = window.match(TITLE_RE);
    const imgM = window.match(IMG_RE);
    if (!titleM || !imgM) continue;

    const title = titleM[1].replace(TAG_RE, "").trim();
    if (title.length < 3 || JUNK_RE.test(title)) continue;

    let img = imgM[1].replace(/\/[^/]+$/, "/medium.jpg");
    if (img.startsWith("//")) img = "https:" + img;

    albums.push({
      id: albumId,
      title,
      brand,
      store,
      url: `https://${store}/albums/${albumId}?uid=1&isSubCate=false&referrercate=`,
      img,
    });
  }
  return albums;
}

function categoryMatches(name: string, queries: string[]): boolean {
  const nameLower = name.replace(TAG_RE, "").trim().toLowerCase();
  if (nameLower.length < 2) return false;
  for (const query of queries) {
    const ql = query.toLowerCase().trim();
    if (ql.length < 2) continue;
    if (ql === nameLower || nameLower.includes(ql) || ql.includes(nameLower)) return true;
    if (ql.length >= 4 && new RegExp(`\\b${escapeReg(ql)}\\b`, "i").test(nameLower)) return true;
  }
  return false;
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function getScrapeMeta(store: string, brand: string): Promise<ScrapeMeta> {
  const queries = queriesFor(brand);
  let categories: string[] = [];
  try {
    const html = await fetchHtml(`https://${store}/categories`);
    const seen = new Set<string>();
    for (const m of html.matchAll(CATEGORY_LINK_RE)) {
      const path = m[1];
      const rawName = m[3];
      if (categoryMatches(rawName, queries) && !seen.has(path)) {
        seen.add(path);
        categories.push(path);
      }
    }
  } catch {
    categories = [];
  }
  return { queries, categories };
}

export async function scrapeSearchPage(
  store: string,
  brand: string,
  query: string,
  page: number
): Promise<Item[]> {
  const q = encodeURIComponent(query);
  const p = page > 1 ? `&page=${page}` : "";
  const url = `https://${store}/search/album?q=${q}${p}`;
  const html = await fetchHtml(url);
  return parseAlbums(html, store, brand);
}

export async function scrapeCategoryPage(
  store: string,
  brand: string,
  catPath: string,
  page: number
): Promise<Item[]> {
  const suffix = page > 1 ? `?page=${page}` : "";
  const url = `https://${store}${catPath}${suffix}`;
  const html = await fetchHtml(url);
  return parseAlbums(html, store, brand);
}

export function dedupeItems(items: Item[]): Item[] {
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const it of items) {
    const k = `${it.store}|${it.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

export const CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=3600",
};
