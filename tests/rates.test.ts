import path from "path";
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import { rowsOf } from "@/lib/ads";
import * as schema from "@/lib/db/schema";
import { cleanName, enrichFromLink, imageType, readMeta, type Fetcher } from "@/lib/rates-enrich";
import { isPrivateAddress, safeFetch } from "@/lib/safe-fetch";
import type { DB } from "@/lib/db";
import { addCreator, cleanCreator, cleanFile, corsHeaders, getAvatar, getCreator, getFile, listCreators, parseLink, signIn, signOut, signUp, slugify, userForToken, type CreatorInput } from "@/lib/rates";

let db: DB;
beforeAll(async () => {
  const d = drizzle(new PGlite(), { schema });
  await migrate(d, { migrationsFolder: path.join(__dirname, "..", "drizzle"), migrationsSchema: schema.DB_SCHEMA });
  db = d as unknown as DB;
});

const ok = <T>(v: T): Exclude<T, { error: unknown }> => {
  if (v && typeof v === "object" && "error" in v) throw new Error(String((v as { error: unknown }).error));
  return v as Exclude<T, { error: unknown }>;
};
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);

describe("links", () => {
  it("reads social and website links", () => {
    expect(parseLink("https://www.instagram.com/bimboademoye/?hl=en")).toMatchObject({ platform: "instagram", handle: "bimboademoye", name: "Bimboademoye", key: "instagram:bimboademoye" });
    expect(parseLink("instagram.com/@Some.Creator")).toMatchObject({ platform: "instagram", handle: "Some.Creator", key: "instagram:some.creator" });
    expect(parseLink("https://www.tiktok.com/@khaby.lame")).toMatchObject({ platform: "tiktok", handle: "khaby.lame" });
    expect(parseLink("https://x.com/premiumtimesng")).toMatchObject({ platform: "x", handle: "premiumtimesng" });
    expect(parseLink("https://twitter.com/premiumtimesng")?.key).toBe("x:premiumtimesng");
    expect(parseLink("https://www.youtube.com/@mrbeast")).toMatchObject({ platform: "youtube", handle: "mrbeast" });
    expect(parseLink("https://www.youtube.com/channel/UC123")).toMatchObject({ platform: "youtube", handle: "UC123" });
    expect(parseLink("https://www.bellanaija.com/some/page")).toMatchObject({ platform: "website", website: "https://bellanaija.com", name: "Bellanaija", key: "web:bellanaija.com" });
    expect(parseLink("9jafoodie.com")).toMatchObject({ platform: "website", name: "9jafoodie" });
  });
  it("refuses things that aren't a creator link", () => {
    for (const bad of ["", "nope", "javascript:alert(1)", "https://instagram.com/p/ABC123/", "https://instagram.com/", "https://tiktok.com/video/1", 42, null, "x".repeat(400)]) expect(parseLink(bad)).toBeNull();
  });
  it("slugifies names", () => {
    expect(slugify("Bimbo Ademoye!")).toBe("bimbo-ademoye");
    expect(slugify("Ṣọlá Àdé")).toBe("sola-ade");
    expect(slugify("???")).toBe("creator");
  });
});

describe("validation", () => {
  it("needs a link or a name, and fills the name from the link", () => {
    expect(cleanCreator({})).toEqual({ error: "Add a link or a name." });
    expect(cleanCreator({ link: "not a link" })).toMatchObject({ error: expect.stringContaining("link") });
    const c = ok(cleanCreator({ link: "https://instagram.com/ada_creates", niche: "beauty" }));
    expect(c).toMatchObject({ name: "Ada Creates", platform: "instagram", niche: "beauty", type: "creator", country: "NG", items: [], file: null });
  });
  it("falls back to safe defaults for unknown values", () => {
    expect(ok(cleanCreator({ name: "X", niche: "<script>", platform: "myspace", country: "Nigeria" }))).toMatchObject({ niche: "general", platform: "website", country: "NG" });
  });
  it("cleans rates: skips blank rows, defaults the top of a range, rejects half-filled and backwards ones", () => {
    const c = ok(cleanCreator({ name: "X", items: [{ deliverable: "Reel", priceMin: "150,000" }, { deliverable: "", priceMin: "" }, { deliverable: "Banner", priceMin: 80000, priceMax: 120000, currency: "USD" }] }));
    expect(c.items).toEqual([
      { deliverable: "Reel", platform: "website", priceMin: 150000, priceMax: 150000, currency: "NGN" },
      { deliverable: "Banner", platform: "website", priceMin: 80000, priceMax: 120000, currency: "USD" },
    ]);
    expect(cleanCreator({ name: "X", items: [{ deliverable: "Reel" }] })).toMatchObject({ error: expect.any(String) });
    expect(cleanCreator({ name: "X", items: [{ deliverable: "Reel", priceMin: 5, priceMax: 1 }] })).toMatchObject({ error: expect.any(String) });
    expect(cleanCreator({ name: "X", items: [{ deliverable: "Reel", priceMin: -5 }] })).toMatchObject({ error: expect.any(String) });
  });
  it("accepts only real photos and PDFs under the size limit", () => {
    expect(cleanFile(undefined)).toBeNull();
    expect(cleanFile({ name: "card.png", type: "image/png", data: PNG.toString("base64") })).toMatchObject({ name: "card.png", mime: "image/png" });
    expect(cleanFile({ name: "a.pdf", type: "application/pdf", data: Buffer.from("%PDF-1.7 hi").toString("base64") })).toMatchObject({ mime: "application/pdf" });
    expect(cleanFile({ name: "x.png", type: "image/png", data: Buffer.from("<script>alert(1)</script>").toString("base64") })).toMatchObject({ error: expect.any(String) });
    expect(cleanFile({ name: "x.svg", type: "image/svg+xml", data: Buffer.from("<svg/>").toString("base64") })).toMatchObject({ error: expect.any(String) });
    expect(cleanFile({ name: "big.png", type: "image/png", data: Buffer.concat([PNG, Buffer.alloc(3_100_000)]).toString("base64") })).toMatchObject({ error: expect.stringContaining("large") });
    expect(cleanFile({ name: "../../etc/passwd\"", type: "image/png", data: PNG.toString("base64") })).toMatchObject({ name: "....etcpasswd" });
  });
});

describe("accounts", () => {
  it("signs up, signs in, resolves tokens and signs out", async () => {
    const made = ok(await signUp(db, "Ada@x.io".toLowerCase(), "a long password", "Ada"));
    expect(await signUp(db, "ada@x.io", "other password", null)).toEqual({ error: "exists" });
    expect(await signIn(db, "ada@x.io", "wrong password")).toEqual({ error: "bad_login" });
    expect(await signIn(db, "nobody@x.io", "a long password")).toEqual({ error: "bad_login" });
    const again = ok(await signIn(db, "ada@x.io", "a long password"));
    expect(await userForToken(db, again.token)).toMatchObject({ email: "ada@x.io", name: "Ada" });
    expect(await userForToken(db, "short")).toBeNull();
    await signOut(db, made.token);
    expect(await userForToken(db, made.token)).toBeNull();
    expect(await userForToken(db, again.token)).not.toBeNull();
  });
});

describe("creators", () => {
  const input = (o: Record<string, unknown>): CreatorInput => ok(cleanCreator(o));
  let userId: string;
  beforeAll(async () => {
    userId = ok(await signUp(db, "adder@x.io", "a long password", null)).user.id;
  });

  it("adds a creator from a link alone", async () => {
    const { creator, created } = await addCreator(db, input({ link: "https://instagram.com/bimboademoye", niche: "lifestyle" }), { userId, admin: false });
    expect(created).toBe(true);
    expect(creator).toMatchObject({ slug: "bimboademoye", name: "Bimboademoye", platform: "instagram", handle: "bimboademoye", niche: "lifestyle", items: [], files: [] });
    expect(creator).not.toHaveProperty("id");
    expect(creator).not.toHaveProperty("hidden");
  });

  it("adding the same link again adds rates to the same creator instead of a duplicate", async () => {
    const { creator, created } = await addCreator(db, input({ link: "instagram.com/BimboAdemoye/", items: [{ deliverable: "Reel", priceMin: 150000 }] }), { userId, admin: false });
    expect(created).toBe(false);
    expect(creator.slug).toBe("bimboademoye");
    expect(creator.items).toHaveLength(1);
    const more = await addCreator(db, input({ link: "https://www.instagram.com/bimboademoye", items: [{ deliverable: "Story", priceMin: 40000 }] }), { userId: null, admin: true });
    expect(more.creator.items.map((i) => i.deliverable)).toEqual(["Reel", "Story"]);
  });

  it("lets anyone add a creator without an account, shown as a visitor to the admin", async () => {
    const { creator } = await addCreator(db, input({ link: "https://tiktok.com/@walkin" }), { userId: null, admin: false });
    expect(creator.slug).toBe("walkin");
    const row = rowsOf<{ added_by: string | null; added_by_admin: boolean }>(await db.execute(sql`SELECT "added_by","added_by_admin" FROM "rates"."creators" WHERE "slug" = 'walkin'`))[0];
    expect(row).toEqual({ added_by: null, added_by_admin: false });
  });

  it("keeps existing details, filling only the empty ones", async () => {
    await addCreator(db, input({ name: "Keep Me", slug: "keep-me", bio: "first bio", niche: "tech" }), { userId, admin: false });
    const { creator } = await addCreator(db, input({ name: "Different", slug: "keep-me", bio: "second bio", followers: 5000, niche: "food" }), { userId, admin: false });
    expect(creator).toMatchObject({ name: "Keep Me", bio: "first bio", followers: 5000, niche: "tech" });
  });

  it("gives creators with the same name different slugs", async () => {
    const a = await addCreator(db, input({ name: "Twin Name", link: "https://tiktok.com/@twin1" }), { userId, admin: false });
    const b = await addCreator(db, input({ name: "Twin Name", link: "https://tiktok.com/@twin2" }), { userId, admin: false });
    expect([a.creator.slug, b.creator.slug]).toEqual(["twin-name", "twin-name-2"]);
  });

  it("stores and serves an uploaded rate card, and not for hidden creators", async () => {
    const file = ok(cleanFile({ name: "card.png", type: "image/png", data: PNG.toString("base64") }));
    const { creator } = await addCreator(db, { ...input({ name: "With File" }), file }, { userId, admin: false });
    expect(creator.files).toHaveLength(1);
    const got = await getFile(db, creator.files[0].id);
    expect(got).toMatchObject({ name: "card.png", mime: "image/png" });
    expect(got!.data.equals(PNG)).toBe(true);
    expect(await getFile(db, "not-an-id")).toBeNull();
    await db.execute(sql`UPDATE "rates"."creators" SET "hidden" = true WHERE "slug" = 'with-file'`); // what the admin's Hide does
    expect(await getFile(db, creator.files[0].id)).toBeNull();
    expect(await getCreator(db, "with-file")).toBeNull();
    expect((await listCreators(db)).some((c) => c.slug === "with-file")).toBe(false);
  });
});

describe("browser access", () => {
  it("allows only the Rates site to call the API", () => {
    expect(corsHeaders("https://rates.latars.xyz")["Access-Control-Allow-Origin"]).toBe("https://rates.latars.xyz");
    expect(corsHeaders("https://evil.example")["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(corsHeaders(null)["Access-Control-Allow-Origin"]).toBeUndefined();
  });
});

describe("filling in a creator from their link", () => {
  const fetcherFor = (pages: Record<string, { body: string | Buffer; type?: string; status?: number }>): Fetcher => async (url) => {
    const hit = pages[url];
    if (!hit) throw new Error("blocked or missing");
    return { status: hit.status ?? 200, url, contentType: hit.type ?? "text/html", body: Buffer.isBuffer(hit.body) ? hit.body : Buffer.from(hit.body) };
  };
  const link = (u: string) => parseLink(u)!;

  it("reads names out of page titles", () => {
    expect(cleanName("Davido (@davido) on X", link("x.com/davido"))).toBe("Davido");
    expect(cleanName("MrBeast - YouTube", link("youtube.com/@mrbeast"))).toBe("MrBeast");
    expect(cleanName("Home | BellaNaija", link("bellanaija.com"))).toBe("BellaNaija");
    expect(cleanName("Instagram", link("instagram.com/x"))).toBeUndefined();
    expect(cleanName("Just a moment...", link("example.com"))).toBeUndefined();
    expect(readMeta('<meta property="og:title" content="Tom &amp; Jerry &#39;s"><meta name="description" content="hi">')).toMatchObject({ "og:title": "Tom & Jerry 's", description: "hi" });
  });

  it("gets name, bio and picture from a YouTube channel page", async () => {
    const got = await enrichFromLink(link("https://youtube.com/@mrbeast"), fetcherFor({
      "https://www.youtube.com/@mrbeast": { body: '<meta property="og:title" content="MrBeast"><meta property="og:description" content="New videos every Saturday"><meta property="og:image" content="https://cdn.example/pic.png">' },
      "https://cdn.example/pic.png": { body: PNG, type: "image/png" },
    }));
    expect(got).toMatchObject({ name: "MrBeast", bio: "New videos every Saturday" });
    expect(got.image?.mime).toBe("image/png");
  });

  it("finds YouTube's tags even when they sit far down a huge page", async () => {
    const page = "<html><head><script>" + "x".repeat(900_000) + '</script><title>MrBeast - YouTube</title><meta name="description" content="Videos weekly"><meta property="og:title" content="MrBeast"></head>';
    const got = await enrichFromLink(link("youtube.com/@mrbeast"), fetcherFor({ "https://www.youtube.com/@mrbeast": { body: page } }));
    expect(got).toMatchObject({ name: "MrBeast", bio: "Videos weekly" });
  });

  it("falls back to the avatar service for TikTok and skips login walls", async () => {
    const seen: string[] = [];
    const f: Fetcher = async (url) => { seen.push(url); if (url.startsWith("https://unavatar.io/tiktok/")) return { status: 200, url, contentType: "image/png", body: PNG }; throw new Error("no"); };
    const got = await enrichFromLink(link("tiktok.com/@khaby.lame"), f);
    expect(got.image?.mime).toBe("image/png");
    expect(seen).toEqual(["https://unavatar.io/tiktok/khaby.lame"]); // the TikTok page itself is not fetched
    expect(await enrichFromLink(link("instagram.com/bimboademoye"), async () => { throw new Error("down"); })).toEqual({});
  });

  it("never keeps a picture that isn't a photo, or is too large", async () => {
    const svg = fetcherFor({ "https://unavatar.io/youtube/x": { body: "<svg onload=alert(1)/>", type: "image/svg+xml" } });
    expect((await enrichFromLink(link("youtube.com/@x"), svg)).image).toBeUndefined();
    expect(imageType(Buffer.concat([PNG, Buffer.alloc(10)]))).toBe("image/png");
    expect(imageType(Buffer.from("GIF89a"))).toBeNull();
  });

  it("stores the picture and details for a new creator, and uses the typed name over the page's", async () => {
    const enrich = async () => ({ name: "Page Name", bio: "From the page", image: { mime: "image/png", data: PNG } });
    const first = await addCreator(db, ok(cleanCreator({ link: "https://x.com/pagey", nameHint: "Pagey Searched" })), { userId: null, admin: false }, enrich);
    expect(first.creator).toMatchObject({ name: "Page Name", bio: "From the page", hasAvatar: true });
    const avatar = await getAvatar(db, first.creator.slug);
    expect(avatar?.mime).toBe("image/png");
    expect(avatar!.data.equals(PNG)).toBe(true);
    const typed = await addCreator(db, ok(cleanCreator({ link: "https://x.com/typed1", name: "Typed Name" })), { userId: null, admin: false }, enrich);
    expect(typed.creator.name).toBe("Typed Name");
    // no page name: the search term beats the handle
    const hinted = await addCreator(db, ok(cleanCreator({ link: "https://instagram.com/bimbo_ademoye2", nameHint: "Bimbo Ademoye" })), { userId: null, admin: false }, async () => ({}));
    expect(hinted.creator).toMatchObject({ name: "Bimbo Ademoye", hasAvatar: false });
    expect(await getAvatar(db, hinted.creator.slug)).toBeNull();
    expect(await getAvatar(db, "../etc")).toBeNull();
  });

  it("does not look anything up for a creator that's already there", async () => {
    let calls = 0;
    await addCreator(db, ok(cleanCreator({ link: "https://x.com/pagey" })), { userId: null, admin: false }, async () => { calls++; return {}; });
    expect(calls).toBe(0);
  });

  it("is added anyway when the lookup fails", async () => {
    const { creator } = await addCreator(db, ok(cleanCreator({ link: "https://x.com/flaky1" })), { userId: null, admin: false }, async () => { throw new Error("boom"); });
    expect(creator).toMatchObject({ slug: "flaky1", hasAvatar: false });
  });
});

describe("the fetch guard", () => {
  it("recognises non-public addresses", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "224.0.0.1", "not an ip"]) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "142.250.80.46", "172.32.0.1", "2606:4700:4700::1111"]) expect(isPrivateAddress(ip)).toBe(false);
  });
  it("refuses to fetch internal addresses, odd ports and other schemes", async () => {
    for (const u of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://localhost/", "http://example.com:8080/", "file:///etc/passwd", "ftp://example.com/", "http://user:pw@example.com/"]) await expect(safeFetch(u, { timeoutMs: 1500 })).rejects.toBeTruthy();
  });
});
