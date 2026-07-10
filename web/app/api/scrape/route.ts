import { NextRequest, NextResponse } from "next/server";
import {
  CACHE_HEADERS,
  getScrapeMeta,
  scrapeCategoryPage,
  scrapeSearchPage,
} from "@/lib/scrape";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const store = sp.get("store");
  const brand = sp.get("brand");
  const mode = sp.get("mode") || "search";

  if (!store || !brand) {
    return NextResponse.json({ error: "store and brand required" }, { status: 400 });
  }

  try {
    if (mode === "meta") {
      const meta = await getScrapeMeta(store, brand);
      return NextResponse.json(meta, { headers: CACHE_HEADERS });
    }

    const page = Math.max(1, parseInt(sp.get("page") || "1", 10) || 1);

    if (mode === "search") {
      const query = sp.get("query") || brand;
      const items = await scrapeSearchPage(store, brand, query, page);
      return NextResponse.json(
        { items, hasMore: items.length > 0, page, mode: "search", query },
        { headers: CACHE_HEADERS }
      );
    }

    if (mode === "category") {
      const path = sp.get("path");
      if (!path || !path.startsWith("/categories/")) {
        return NextResponse.json({ error: "path required" }, { status: 400 });
      }
      const items = await scrapeCategoryPage(store, brand, path, page);
      return NextResponse.json(
        { items, hasMore: items.length > 0, page, mode: "category", path },
        { headers: CACHE_HEADERS }
      );
    }

    return NextResponse.json({ error: "mode must be meta|search|category" }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "scrape failed";
    return NextResponse.json({ error: msg, items: [] }, { status: 502 });
  }
}
