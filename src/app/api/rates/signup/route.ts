import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { cleanName, normaliseEmail, signUp, validPassword } from "@/lib/rates";
import { preflight, readJson, reply } from "@/lib/rates-route";
import { rateLimit } from "@/lib/me";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

// Creates a Rates account with an email and password. No verification.
export async function POST(req: NextRequest) {
  if (!(await rateLimit("rates-signup", Number(process.env.RATE_LIMIT_RATES_SIGNUP_PER_HOUR ?? 10), 60))) return reply(req, { error: "Too many attempts. Try again later." }, 429);
  const body = (await readJson(req, 4_000)) as { email?: unknown; password?: unknown; name?: unknown } | undefined;
  const email = normaliseEmail(body?.email);
  if (!body || !email) return reply(req, { error: "Enter a valid email address." }, 400);
  if (!validPassword(body.password)) return reply(req, { error: "Use a password of at least 8 characters." }, 400);
  const result = await signUp(await getDb(), email, body.password, cleanName(body.name));
  if ("error" in result) return reply(req, { error: "An account with this email already exists. Sign in instead." }, 409);
  return reply(req, { token: result.token, user: result.user });
}
