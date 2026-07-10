import { NextResponse } from "next/server";
import { getBrands } from "@/lib/wiki";

export const dynamic = "force-dynamic";

export async function GET() {
  const brands = getBrands();
  const totalStores = brands.reduce((n, b) => n + b.storeCount, 0);
  return NextResponse.json({
    brands,
    totalStores,
    mode: "live-scrape",
  });
}
