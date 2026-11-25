import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { userForToken } from "@/lib/rates";
import { bearer, preflight, reply } from "@/lib/rates-route";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

// Who this device's token belongs to, or 401 when it has expired or was signed out.
export async function GET(req: NextRequest) {
  const user = await userForToken(await getDb(), bearer(req));
  return user ? reply(req, { user }) : reply(req, { error: "Signed out." }, 401);
}
