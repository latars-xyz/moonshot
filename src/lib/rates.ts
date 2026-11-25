import "server-only";
import crypto from "crypto";
import { sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { cleanName, hashPassword, normaliseEmail, rowsOf, validPassword, verifyPassword } from "@/lib/ads";

// Backend for Rates by Latars (rates.latars.xyz): its own accounts, creators, rates and uploaded rate cards in the
// `rates` Postgres schema. Anyone with an account can add a creator from a link and add rates; there is no email
// verification. The admin (/adminx/rates) can hide or delete anything.

export { cleanName, normaliseEmail, validPassword };

const hash = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
const DUMMY_HASH = `scrypt$${Buffer.alloc(16).toString("base64url")}$${Buffer.alloc(64).toString("base64url")}`;

export const PLATFORMS = ["instagram", "tiktok", "youtube", "x", "website", "podcast"] as const;
export const NICHES = ["general", "pop-culture", "wellness", "comedy", "entertainment", "lifestyle", "beauty", "fashion", "tech", "fitness", "food", "travel", "finance", "gaming", "news", "publisher", "other"] as const;
export const CURRENCIES = ["NGN", "USD", "ZAR"] as const;
export type Platform = (typeof PLATFORMS)[number];
export type Currency = (typeof CURRENCIES)[number];

export const MAX_FILE_BYTES = 3_000_000;
export const MAX_ITEMS = 40;

// ─── Accounts ────────────────────────────────────────────────────────────────

export interface RatesUser {
  id: string;
  email: string;
  name: string | null;
}

async function startSession(db: DB, user: RatesUser) {
  const token = crypto.randomBytes(32).toString("base64url");
  await db.execute(sql`INSERT INTO "rates"."sessions" ("token_hash","user_id") VALUES (${hash(token)}, ${user.id})`);
  return { token, user };
}

export async function signUp(db: DB, email: string, password: string, name: string | null) {
  const passwordHash = await hashPassword(password);
  const rows = rowsOf<RatesUser>(await db.execute(sql`
    INSERT INTO "rates"."users" ("email","name","password_hash") VALUES (${email}, ${name}, ${passwordHash})
    ON CONFLICT ("email") DO NOTHING RETURNING "id","email","name"`));
  if (!rows[0]) return { error: "exists" as const };
  return startSession(db, rows[0]);
}

export async function signIn(db: DB, email: string, password: string) {
  const row = rowsOf<RatesUser & { password_hash: string }>(await db.execute(sql`SELECT "id","email","name","password_hash" FROM "rates"."users" WHERE "email" = ${email}`))[0];
  // Always run a hash, so a missing account takes as long as a wrong password.
  const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !ok) return { error: "bad_login" as const };
  await db.execute(sql`UPDATE "rates"."users" SET "last_seen_at" = now() WHERE "id" = ${row.id}`);
  return startSession(db, { id: row.id, email: row.email, name: row.name });
}

export async function userForToken(db: DB, token: string | null): Promise<RatesUser | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  return (
    rowsOf<RatesUser>(await db.execute(sql`
      SELECT u."id", u."email", u."name" FROM "rates"."sessions" s JOIN "rates"."users" u ON u."id" = s."user_id"
      WHERE s."token_hash" = ${hash(token)}`))[0] ?? null
  );
}

export async function signOut(db: DB, token: string) {
  await db.execute(sql`DELETE FROM "rates"."sessions" WHERE "token_hash" = ${hash(token)}`);
}

// ─── Links ───────────────────────────────────────────────────────────────────

export interface ParsedLink {
  platform: Platform;
  handle: string | null;
  website: string | null;
  name: string;
  /** Identifies the same creator however the link is written. */
  key: string;
}

const titleCase = (s: string) => s.replace(/[-_.]+/g, " ").replace(/\b\p{L}/gu, (c) => c.toUpperCase()).trim();
const SOCIAL = /^[A-Za-z0-9._-]{1,60}$/;

/**
 * Reads a creator's link (Instagram, TikTok, X, YouTube or a website) into a platform, handle and a first guess at
 * the name. Nothing is fetched, so any link is safe to pass.
 */
export function parseLink(raw: unknown): ParsedLink | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > 300) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!host.includes(".") || host.length > 120) return null;
  const seg = url.pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  const social = (platform: Platform, handle: string | undefined) => {
    const h = handle?.replace(/^@/, "");
    return h && SOCIAL.test(h) ? ({ platform, handle: h, website: null, name: titleCase(h), key: `${platform}:${h.toLowerCase()}` } satisfies ParsedLink) : null;
  };
  const is = (...hosts: string[]) => hosts.some((h) => host === h || host.endsWith(`.${h}`));
  if (is("instagram.com")) return seg[0] && !["p", "reel", "reels", "explore", "stories"].includes(seg[0]) ? social("instagram", seg[0]) : null;
  if (is("tiktok.com")) return seg[0]?.startsWith("@") ? social("tiktok", seg[0]) : null;
  if (is("x.com", "twitter.com")) return seg[0] && !["i", "home", "search", "intent", "share"].includes(seg[0]) ? social("x", seg[0]) : null;
  if (is("youtube.com")) {
    if (seg[0]?.startsWith("@")) return social("youtube", seg[0]);
    if (["c", "user", "channel"].includes(seg[0] ?? "")) return social("youtube", seg[1]);
    return null;
  }
  const label = host.split(".").slice(0, -1).filter((p) => !["com", "co", "org", "net", "ng"].includes(p)).pop() ?? host;
  return { platform: "website", handle: null, website: `${url.protocol}//${host}`, name: titleCase(label), key: `web:${host}` };
}

export const slugify = (s: string) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "creator";

// ─── Creators and rates ──────────────────────────────────────────────────────

export interface RateItemInput {
  deliverable: string;
  platform: Platform;
  priceMin: number;
  priceMax: number;
  currency: Currency;
}

export interface FileInput {
  name: string;
  mime: string;
  data: Buffer;
}

export interface CreatorInput {
  link: ParsedLink | null;
  name: string;
  slug: string | null;
  type: "creator" | "media";
  platform: Platform;
  niche: string;
  country: string;
  followers: number | null;
  bio: string | null;
  items: RateItemInput[];
  file: FileInput | null;
}

const MAGIC: Record<string, (b: Buffer) => boolean> = {
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/webp": (b) => b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP",
  "application/pdf": (b) => b.subarray(0, 5).toString("ascii") === "%PDF-",
};

/** Checks an uploaded rate card: a photo or PDF, under 3 MB, that really is what it says. */
export function cleanFile(v: unknown): FileInput | { error: string } | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object") return { error: "That file couldn't be read." };
  const f = v as { name?: unknown; type?: unknown; data?: unknown };
  const mime = typeof f.type === "string" ? f.type : "";
  if (!MAGIC[mime] || typeof f.data !== "string" || !/^[A-Za-z0-9+/=]+$/.test(f.data)) return { error: "Upload a PDF, JPEG, PNG or WebP rate card." };
  const data = Buffer.from(f.data, "base64");
  if (data.length === 0 || data.length > MAX_FILE_BYTES) return { error: "That file is too large. Keep rate cards under 3 MB." };
  if (!MAGIC[mime](data)) return { error: "That file isn't what it says it is." };
  const name = (typeof f.name === "string" ? f.name : "rate-card").replace(/[^\w. -]/g, "").slice(0, 80) || "rate-card";
  return { name, mime, data };
}

const price = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.replace(/[,\s]/g, "")) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1_000_000_000 ? Math.round(n) : null;
};

/** Validates a creator submission from a browser. Returns the clean input or a message to show. */
export function cleanCreator(body: unknown): CreatorInput | { error: string } {
  if (!body || typeof body !== "object") return { error: "Something went wrong. Try again." };
  const b = body as Record<string, unknown>;
  const link = b.link ? parseLink(b.link) : null;
  if (b.link && !link) return { error: "That link doesn't look right. Paste their Instagram, TikTok, X, YouTube or website link." };
  const name = (typeof b.name === "string" ? b.name.trim().slice(0, 80) : "") || link?.name || "";
  if (!name) return { error: "Add a link or a name." };
  const slug = typeof b.slug === "string" && /^[a-z0-9-]{1,80}$/.test(b.slug) ? b.slug : null;
  const asked = (PLATFORMS as readonly string[]).includes(String(b.platform)) ? (b.platform as Platform) : "website";
  const platform: Platform = link?.platform ?? asked;
  const niche = (NICHES as readonly string[]).includes(String(b.niche)) ? String(b.niche) : "general";
  const country = typeof b.country === "string" && /^[A-Za-z]{2}$/.test(b.country.trim()) ? b.country.trim().toUpperCase() : "NG";
  const followers = price(b.followers);
  const bio = typeof b.bio === "string" ? b.bio.trim().slice(0, 400) || null : null;
  const rawItems = Array.isArray(b.items) ? b.items.slice(0, MAX_ITEMS) : [];
  const items: RateItemInput[] = [];
  for (const r of rawItems) {
    const it = r as Record<string, unknown>;
    const deliverable = typeof it?.deliverable === "string" ? it.deliverable.trim().slice(0, 120) : "";
    const min = price(it?.priceMin);
    const max = it?.priceMax === undefined || it.priceMax === "" || it.priceMax === null ? min : price(it.priceMax);
    if (!deliverable && min === null) continue; // a blank row
    if (!deliverable || min === null || max === null || max < min) return { error: "Each rate needs a name and a price (a range's top can't be below its bottom)." };
    items.push({
      deliverable,
      platform: (PLATFORMS as readonly string[]).includes(String(it.platform)) ? (it.platform as Platform) : platform,
      priceMin: min,
      priceMax: max,
      currency: (CURRENCIES as readonly string[]).includes(String(it.currency)) ? (it.currency as Currency) : "NGN",
    });
  }
  const file = cleanFile(b.file);
  if (file && "error" in file) return file;
  return { link, name, slug, type: b.type === "media" ? "media" : "creator", platform, niche, country, followers, bio, items, file };
}

/** "Instagram reel: 150000" or "Banner, 80000-120000" per line. Lines that don't read as a rate are reported, not dropped. */
export function parseRateLines(text: string, currency: string): { items: Record<string, string>[]; bad: string[] } {
  const items: Record<string, string>[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/\r?\n/).slice(0, 80)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(.*?)[\s:,=|-]+₦?\$?([\d][\d,\s.]*)(?:\s*(?:-|–|to)\s*₦?\$?([\d][\d,\s.]*))?\s*$/i);
    if (!m || !m[1].trim()) {
      bad.push(line);
      continue;
    }
    items.push({ deliverable: m[1].trim(), priceMin: m[2].replace(/[,\s]/g, ""), priceMax: (m[3] ?? m[2]).replace(/[,\s]/g, ""), currency });
  }
  return { items, bad };
}

export interface CreatorDTO {
  slug: string;
  name: string;
  type: "creator" | "media";
  platform: Platform;
  niche: string;
  country: string;
  website: string | null;
  handle: string | null;
  followers: number | null;
  bio: string | null;
  createdAt: string;
  items: { deliverable: string; platform: Platform; priceMin: number; priceMax: number; currency: Currency }[];
  files: { id: string; name: string; mime: string }[];
}

interface CreatorRow {
  id: string;
  slug: string;
  name: string;
  type: "creator" | "media";
  platform: Platform;
  niche: string;
  country: string;
  website: string | null;
  handle: string | null;
  followers: number | null;
  bio: string | null;
  hidden: boolean;
  created_at: Date | string;
  added_by_email?: string | null;
  added_by_admin?: boolean;
}

async function attach(db: DB, rows: CreatorRow[]): Promise<(CreatorDTO & { id: string; hidden: boolean; addedBy: string | null })[]> {
  if (!rows.length) return [];
  const ids = sql.join(rows.map((r) => sql`${r.id}::uuid`), sql`, `);
  const items = rowsOf<{ creator_id: string; deliverable: string; platform: Platform; price_min: number; price_max: number; currency: Currency }>(
    await db.execute(sql`SELECT "creator_id","deliverable","platform","price_min","price_max","currency" FROM "rates"."rate_items" WHERE "creator_id" IN (${ids}) ORDER BY "id"`),
  );
  const files = rowsOf<{ id: string; creator_id: string; name: string; mime: string }>(
    await db.execute(sql`SELECT "id","creator_id","name","mime" FROM "rates"."files" WHERE "creator_id" IN (${ids}) ORDER BY "created_at"`),
  );
  return rows.map((r) => ({
    id: r.id,
    hidden: r.hidden,
    addedBy: r.added_by_admin ? "Admin" : r.added_by_email ?? "Visitor",
    slug: r.slug,
    name: r.name,
    type: r.type,
    platform: r.platform,
    niche: r.niche,
    country: r.country,
    website: r.website,
    handle: r.handle,
    followers: r.followers,
    bio: r.bio,
    createdAt: new Date(r.created_at).toISOString(),
    items: items.filter((i) => i.creator_id === r.id).map((i) => ({ deliverable: i.deliverable, platform: i.platform, priceMin: Number(i.price_min), priceMax: Number(i.price_max), currency: i.currency })),
    files: files.filter((f) => f.creator_id === r.id).map((f) => ({ id: f.id, name: f.name, mime: f.mime })),
  }));
}

type Attached = Awaited<ReturnType<typeof attach>>[number];
/** What the public site sees: no ids, no moderation state, no who-added-it. */
const publicView = (c: Attached): CreatorDTO => ({ slug: c.slug, name: c.name, type: c.type, platform: c.platform, niche: c.niche, country: c.country, website: c.website, handle: c.handle, followers: c.followers, bio: c.bio, createdAt: c.createdAt, items: c.items, files: c.files });

const COLUMNS = sql`c."id", c."slug", c."name", c."type", c."platform", c."niche", c."country", c."website", c."handle", c."followers", c."bio", c."hidden", c."created_at", c."added_by_admin", u."email" AS "added_by_email"`;
const FROM = sql`FROM "rates"."creators" c LEFT JOIN "rates"."users" u ON u."id" = c."added_by"`;

/** Public: every visible creator, newest first. */
export async function listCreators(db: DB): Promise<CreatorDTO[]> {
  const rows = rowsOf<CreatorRow>(await db.execute(sql`SELECT ${COLUMNS} ${FROM} WHERE NOT c."hidden" ORDER BY c."created_at" DESC LIMIT 3000`));
  return (await attach(db, rows)).map(publicView);
}

export async function getCreator(db: DB, slug: string): Promise<CreatorDTO | null> {
  const rows = rowsOf<CreatorRow>(await db.execute(sql`SELECT ${COLUMNS} ${FROM} WHERE c."slug" = ${slug} AND NOT c."hidden"`));
  const [one] = await attach(db, rows);
  return one ? publicView(one) : null;
}

export async function getFile(db: DB, id: string): Promise<{ name: string; mime: string; data: Buffer } | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const row = rowsOf<{ name: string; mime: string; data: Uint8Array }>(
    await db.execute(sql`SELECT f."name", f."mime", f."data" FROM "rates"."files" f JOIN "rates"."creators" c ON c."id" = f."creator_id" WHERE f."id" = ${id}::uuid AND NOT c."hidden"`),
  )[0];
  return row ? { name: row.name, mime: row.mime, data: Buffer.from(row.data) } : null;
}

export interface Adder {
  userId: string | null;
  admin: boolean;
}

async function freeSlug(db: DB, base: string) {
  for (let n = 1; n < 50; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const taken = rowsOf(await db.execute(sql`SELECT 1 FROM "rates"."creators" WHERE "slug" = ${slug}`));
    if (!taken.length) return slug;
  }
  return `${base}-${crypto.randomBytes(3).toString("hex")}`;
}

/**
 * Adds a creator, or adds rates to one that's already there (found by its slug or by the same link). Rates and the
 * uploaded rate card are always added to; a creator's existing details are only filled in where they were empty.
 */
export async function addCreator(db: DB, input: CreatorInput, by: Adder): Promise<{ creator: CreatorDTO; created: boolean }> {
  const key = input.link?.key ?? null;
  let row = input.slug ? rowsOf<{ id: string; slug: string }>(await db.execute(sql`SELECT "id","slug" FROM "rates"."creators" WHERE "slug" = ${input.slug}`))[0] : undefined;
  if (!row && key) row = rowsOf<{ id: string; slug: string }>(await db.execute(sql`SELECT "id","slug" FROM "rates"."creators" WHERE "link_key" = ${key}`))[0];
  let created = false;
  if (!row) {
    const slug = await freeSlug(db, input.slug ?? slugify(input.name));
    row = rowsOf<{ id: string; slug: string }>(
      await db.execute(sql`
        INSERT INTO "rates"."creators" ("slug","link_key","name","type","platform","niche","country","website","handle","followers","bio","added_by","added_by_admin")
        VALUES (${slug}, ${key}, ${input.name}, ${input.type}, ${input.platform}, ${input.niche}, ${input.country}, ${input.link?.website ?? null}, ${input.link?.handle ?? null}, ${input.followers}, ${input.bio}, ${by.userId}, ${by.admin})
        ON CONFLICT DO NOTHING RETURNING "id","slug"`),
    )[0];
    // Lost a race with someone adding the same link: use theirs.
    if (!row && key) row = rowsOf<{ id: string; slug: string }>(await db.execute(sql`SELECT "id","slug" FROM "rates"."creators" WHERE "link_key" = ${key}`))[0];
    if (!row) throw new Error("Could not save the creator");
    created = true;
  } else {
    await db.execute(sql`
      UPDATE "rates"."creators" SET "updated_at" = now(), "followers" = COALESCE("followers", ${input.followers}), "bio" = COALESCE("bio", ${input.bio}),
        "website" = COALESCE("website", ${input.link?.website ?? null}), "handle" = COALESCE("handle", ${input.link?.handle ?? null})
      WHERE "id" = ${row.id}::uuid`);
    if (key) {
      await db.execute(sql`
        UPDATE "rates"."creators" SET "link_key" = ${key}
        WHERE "id" = ${row.id}::uuid AND "link_key" IS NULL AND NOT EXISTS (SELECT 1 FROM "rates"."creators" o WHERE o."link_key" = ${key})`);
    }
  }
  for (const it of input.items) {
    await db.execute(sql`
      INSERT INTO "rates"."rate_items" ("creator_id","deliverable","platform","price_min","price_max","currency","added_by","added_by_admin")
      VALUES (${row.id}::uuid, ${it.deliverable}, ${it.platform}, ${it.priceMin}, ${it.priceMax}, ${it.currency}, ${by.userId}, ${by.admin})`);
  }
  if (input.file) {
    await db.execute(sql`
      INSERT INTO "rates"."files" ("creator_id","name","mime","size","data","added_by","added_by_admin")
      VALUES (${row.id}::uuid, ${input.file.name}, ${input.file.mime}, ${input.file.data.length}, ${input.file.data}, ${by.userId}, ${by.admin})`);
  }
  const creator = await getCreator(db, row.slug);
  if (!creator) throw new Error("Could not read the creator back");
  return { creator, created };
}

// ─── Admin ───────────────────────────────────────────────────────────────────

export interface RatesAdminStats {
  users: number;
  newUsers7: number;
  creators: number;
  hidden: number;
  withRates: number;
  rateItems: number;
  files: number;
  recent: (CreatorDTO & { id: string; hidden: boolean; addedBy: string | null })[];
}

export async function ratesAdminStats(db: DB): Promise<RatesAdminStats> {
  const one = async (q: ReturnType<typeof sql>) => Number(rowsOf<{ n: number | string }>(await db.execute(q))[0]?.n ?? 0);
  const [users, newUsers7, creators, hidden, withRates, rateItems, files] = await Promise.all([
    one(sql`SELECT count(*)::int AS n FROM "rates"."users"`),
    one(sql`SELECT count(*)::int AS n FROM "rates"."users" WHERE "created_at" > now() - interval '7 days'`),
    one(sql`SELECT count(*)::int AS n FROM "rates"."creators"`),
    one(sql`SELECT count(*)::int AS n FROM "rates"."creators" WHERE "hidden"`),
    one(sql`SELECT count(DISTINCT x."creator_id")::int AS n FROM (SELECT "creator_id" FROM "rates"."rate_items" UNION SELECT "creator_id" FROM "rates"."files") x`),
    one(sql`SELECT count(*)::int AS n FROM "rates"."rate_items"`),
    one(sql`SELECT count(*)::int AS n FROM "rates"."files"`),
  ]);
  const rows = rowsOf<CreatorRow>(await db.execute(sql`SELECT ${COLUMNS} ${FROM} ORDER BY c."created_at" DESC LIMIT 200`));
  return { users, newUsers7, creators, hidden, withRates, rateItems, files, recent: await attach(db, rows) };
}

export async function setCreatorHidden(db: DB, id: string, hidden: boolean) {
  await db.execute(sql`UPDATE "rates"."creators" SET "hidden" = ${hidden}, "updated_at" = now() WHERE "id" = ${id}::uuid`);
}

export async function deleteCreator(db: DB, id: string) {
  await db.execute(sql`DELETE FROM "rates"."creators" WHERE "id" = ${id}::uuid`);
}

export async function ratesUsersCsv(db: DB): Promise<string> {
  const rows = rowsOf<{ email: string; name: string | null; created_at: Date | string; last_seen_at: Date | string; creators: number | string }>(
    await db.execute(sql`
      SELECT u."email", u."name", u."created_at", u."last_seen_at", (SELECT count(*) FROM "rates"."creators" c WHERE c."added_by" = u."id")::int AS creators
      FROM "rates"."users" u ORDER BY u."created_at"`),
  );
  const cell = (v: string | null) => `"${(v ?? "").replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"`;
  const iso = (d: Date | string) => new Date(d).toISOString();
  return [["email", "name", "creators_added", "signed_up_at", "last_seen_at"].join(","), ...rows.map((r) => [cell(r.email), cell(r.name), Number(r.creators), iso(r.created_at), iso(r.last_seen_at)].join(","))].join("\r\n") + "\r\n";
}

// ─── Browser access ──────────────────────────────────────────────────────────

/** Which web pages may call the API from a browser. */
export function allowedOrigins(): string[] {
  const configured = (process.env.RATES_ORIGINS ?? "https://rates.latars.xyz").split(",").map((s) => s.trim()).filter(Boolean);
  return process.env.NODE_ENV === "production" ? configured : [...configured, "http://localhost:3000", "http://127.0.0.1:3000"];
}

export function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = { Vary: "Origin" };
  if (origin && allowedOrigins().includes(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}
