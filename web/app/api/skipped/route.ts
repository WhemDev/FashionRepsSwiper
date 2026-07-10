import { NextResponse } from "next/server";
import { getSkippedLinks } from "@/lib/wiki";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getSkippedLinks());
}
