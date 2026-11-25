import path from "path";
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { addCreator, cleanCreator, cleanFile, corsHeaders, deleteCreator, getCreator, getFile, listCreators, parseLink, parseRateLines, ratesAdminStats, ratesUsersCsv, setCreatorHidden, signIn, signOut, signUp, slugify, userForToken, type CreatorInput } from "@/lib/rates";

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
  it("reads typed rate lines", () => {
    const { items, bad } = parseRateLines("Instagram reel: 150,000\nBanner, 80000-120000\nStory - ₦25000\n\nnonsense", "NGN");
    expect(items).toEqual([
      { deliverable: "Instagram reel", priceMin: "150000", priceMax: "150000", currency: "NGN" },
      { deliverable: "Banner", priceMin: "80000", priceMax: "120000", currency: "NGN" },
      { deliverable: "Story", priceMin: "25000", priceMax: "25000", currency: "NGN" },
    ]);
    expect(bad).toEqual(["nonsense"]);
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
    const admin = await ratesAdminStats(db);
    await setCreatorHidden(db, admin.recent.find((c) => c.slug === "with-file")!.id, true);
    expect(await getFile(db, creator.files[0].id)).toBeNull();
    expect(await getCreator(db, "with-file")).toBeNull();
    expect((await listCreators(db)).some((c) => c.slug === "with-file")).toBe(false);
  });

  it("lists, counts and deletes for the admin", async () => {
    const s = await ratesAdminStats(db);
    expect(s.creators).toBeGreaterThanOrEqual(5);
    expect(s.hidden).toBe(1);
    expect(s.users).toBeGreaterThanOrEqual(2);
    expect(s.withRates).toBeGreaterThanOrEqual(2);
    const row = s.recent.find((c) => c.slug === "bimboademoye")!;
    expect(row.addedBy).toBe("adder@x.io");
    await deleteCreator(db, row.id);
    expect(await getCreator(db, "bimboademoye")).toBeNull();
    expect((await ratesAdminStats(db)).rateItems).toBeLessThan(s.rateItems);
    const csv = await ratesUsersCsv(db);
    expect(csv.split("\r\n")[0]).toBe("email,name,creators_added,signed_up_at,last_seen_at");
    expect(csv).toContain('"adder@x.io"');
  });
});

describe("browser access", () => {
  it("allows only the Rates site to call the API", () => {
    expect(corsHeaders("https://rates.latars.xyz")["Access-Control-Allow-Origin"]).toBe("https://rates.latars.xyz");
    expect(corsHeaders("https://evil.example")["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(corsHeaders(null)["Access-Control-Allow-Origin"]).toBeUndefined();
  });
});
