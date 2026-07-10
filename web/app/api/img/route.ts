import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 15;
export const dynamic = "force-dynamic";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function allowedHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "photo.yupoo.com" || host.endsWith(".yupoo.com");
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("u");
  if (!raw || !allowedHost(raw)) {
    return new NextResponse("forbidden", { status: 403 });
  }

  const refParam = req.nextUrl.searchParams.get("ref");
  let referer = "https://x.yupoo.com/";
  if (refParam) {
    try {
      const refUrl = new URL(refParam);
      if (refUrl.hostname.toLowerCase().endsWith(".yupoo.com")) {
        referer = refUrl.origin + "/";
      }
    } catch {
      /* keep default */
    }
  }

  try {
    const upstream = await fetch(raw, {
      headers: { "User-Agent": UA, Referer: referer },
    });
    if (!upstream.ok) {
      return new NextResponse("upstream error", { status: 502 });
    }
    const body = await upstream.arrayBuffer();
    const contentType = upstream.headers.get("content-type") || "image/jpeg";
    return new NextResponse(body, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=604800, s-maxage=604800",
      },
    });
  } catch {
    return new NextResponse("upstream error", { status: 502 });
  }
}
