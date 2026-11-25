import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { getFile } from "@/lib/rates";

export const dynamic = "force-dynamic";

// An uploaded rate card. Only the allowed photo and PDF types are ever stored, and the response can't run anything.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const file = await getFile(await getDb(), (await params).id);
  if (!file) return new NextResponse(null, { status: 404 });
  return new NextResponse(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.mime,
      "Content-Disposition": `inline; filename="${file.name.replace(/"/g, "")}"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
