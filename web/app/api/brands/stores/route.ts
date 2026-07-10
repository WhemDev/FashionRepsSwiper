import { NextRequest, NextResponse } from "next/server";
import { getBrandNameBySlug, getStoresForBrand } from "@/lib/wiki";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("slug");
  if (!slug) {
    return NextResponse.json({ error: "slug required" }, { status: 400 });
  }
  const name = getBrandNameBySlug(slug);
  if (!name) {
    return NextResponse.json({ error: "unknown brand" }, { status: 404 });
  }
  const stores = getStoresForBrand(name);
  return NextResponse.json({ name, slug, stores, storeCount: stores.length });
}
