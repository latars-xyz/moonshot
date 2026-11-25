import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { getAvatar } from "@/lib/rates";

export const dynamic = "force-dynamic";

// A creator's picture, kept when they were added. Only photo types are ever stored, and the response can't run anything.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const a = await getAvatar(await getDb(), (await params).slug);
  if (!a) return new NextResponse(null, { status: 404 });
  return new NextResponse(new Uint8Array(a.data), {
    headers: { "Content-Type": a.mime, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Cache-Control": "public, max-age=86400", "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin" },
  });
}
