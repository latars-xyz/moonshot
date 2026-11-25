import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { MAX_FILE_BYTES, addCreator, cleanCreator, listCreators, userForToken } from "@/lib/rates";
import { bearer, preflight, readJson, reply } from "@/lib/rates-route";
import { rateLimit } from "@/lib/me";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

// Everyone's creators with their rates, newest first. Public.
export async function GET(req: NextRequest) {
  return reply(req, { creators: await listCreators(await getDb()) });
}

// Adds a creator from a link (and a name, niche and rates if known), or adds rates and a rate card to one already
// there. Needs an account, nothing more.
export async function POST(req: NextRequest) {
  const db = await getDb();
  const user = await userForToken(db, bearer(req));
  if (!user) return reply(req, { error: "Sign in to add a creator." }, 401);
  if (!(await rateLimit("rates-add", Number(process.env.RATE_LIMIT_RATES_ADD_PER_HOUR ?? 40), 60))) return reply(req, { error: "You've added a lot just now. Try again in a while." }, 429);
  const body = await readJson(req, Math.ceil(MAX_FILE_BYTES * 1.4) + 60_000);
  if (body === undefined) return reply(req, { error: "That couldn't be read, or it was too large. Rate cards must be under 3 MB." }, 413);
  const input = cleanCreator(body);
  if ("error" in input) return reply(req, { error: input.error }, 400);
  const { creator, created } = await addCreator(db, input, { userId: user.id, admin: false });
  return reply(req, { creator, created }, created ? 201 : 200);
}
