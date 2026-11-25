import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isAdmin } from "@/lib/me";
import { ratesUsersCsv } from "@/lib/rates";

export const dynamic = "force-dynamic";

// Admin-only download of everyone who signed up to Rates.
export async function GET() {
  if (!(await isAdmin())) return new NextResponse(null, { status: 404 });
  return new NextResponse(await ratesUsersCsv(await getDb()), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="rates-users.csv"', "Cache-Control": "private, no-store" },
  });
}
