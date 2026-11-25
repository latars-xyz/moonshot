import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { getCreator } from "@/lib/rates";
import { preflight, reply } from "@/lib/rates-route";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const creator = await getCreator(await getDb(), (await params).slug);
  return creator ? reply(req, { creator }) : reply(req, { error: "Not found." }, 404);
}
