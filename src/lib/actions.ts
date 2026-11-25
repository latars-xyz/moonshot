"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { cardSchema, fieldErrors, parseContact, type Contact } from "@/lib/validation";
import { clearCardCookie, getMe, hashToken, newToken, rateLimit, setCardCookie } from "@/lib/me";
import { REACTIONS, UserError, attachDetails, importPosts, momentDetailFields, noReactions, reactionCounts, type ReactionCounts } from "@/lib/data";
import { fetchOEmbed, fetchPostDetails } from "@/lib/social/providers";
import { parseXPostUrl, snowflakeToDate } from "@/lib/social/x-url";
import { parsePhoto } from "@/lib/photo";
import { clientIp, visitorHash } from "@/lib/track";
import { MAX_MOMENT_PHOTOS } from "@/lib/constants";
import { checkinCookie, eventPhase, getEvent } from "@/lib/events";
import { getAccount } from "@/lib/auth";

export type Result = { ok: true; message?: string; data?: unknown } | { ok: false; error: string; fields?: Record<string, string> };

async function guard(fn: () => Promise<Result | void>): Promise<Result> {
  try {
    return (await fn()) ?? { ok: true };
  } catch (err) {
    if (err instanceof UserError) return { ok: false, error: err.message };
    console.error(err);
    return { ok: false, error: "Something went wrong — please try again." };
  }
}

const refresh = () => revalidatePath("/", "layout");

/** The event a form belongs to (its hidden "event" field, the event's slug). */
async function formEvent(form: FormData) {
  const e = await getEvent(await getDb(), String(form.get("event") ?? ""));
  if (!e) throw new UserError("That event wasn't found.");
  return e;
}

export async function saveCardAction(_: Result | null, form: FormData): Promise<Result> {
  const parsed = cardSchema.safeParse({
    name: form.get("name") ?? "",
    headline: form.get("headline") ?? "",
    wants: form.getAll("wants").filter(Boolean),
    offers: form.getAll("offers").filter(Boolean),
    company: form.get("company") ?? "",
    contact: form.get("contact") ?? "",
  });
  if (!parsed.success) return { ok: false, error: "Almost there — check the highlighted field.", fields: fieldErrors(parsed.error) };

  let created = false;
  let slug = "";
  const result = await guard(async () => {
    const db = await getDb();
    const event = await formEvent(form);
    slug = event.slug;
    const me = await getMe(event.id);
    if (me) {
      await db.update(schema.people).set({ ...parsed.data, updatedAt: new Date() }).where(eq(schema.people.id, me.id));
      return { ok: true, message: "Saved." };
    }
    if (!(await rateLimit("card", Number(process.env.RATE_LIMIT_CARDS_PER_HOUR ?? 60), 60))) {
      return { ok: false, error: "Lots of cards are being made from this network — try again in a few minutes." };
    }
    const token = newToken();
    // Signed in: the card is yours, on any device.
    const account = await getAccount();
    await db.insert(schema.people).values({ ...parsed.data, eventId: event.id, accountId: account?.id ?? null, editTokenHash: hashToken(token) });
    await setCardCookie(event.id, token);
    created = true;
  });
  refresh();
  if (created) redirect(`/${slug}?added=card`);
  return result;
}

/** The card "Update" page: your card photo from today. */
export async function saveUpdateAction(_: Result | null, form: FormData): Promise<Result> {
  const rawPhoto = String(form.get("photo") ?? "");
  const photo = rawPhoto ? parsePhoto(rawPhoto) : null;
  if (photo && "error" in photo) return { ok: false, error: photo.error, fields: { photo: photo.error } };
  const removePhoto = form.get("removePhoto") === "on";
  if (!photo && !removePhoto) return { ok: false, error: "Pick a photo first." };

  let slug = "";
  const result = await guard(async () => {
    const event = await formEvent(form);
    slug = event.slug;
    const me = await getMe(event.id);
    if (!me) return { ok: false, error: "Add yourself first." };
    if (!(await rateLimit("update", 60, 60))) return { ok: false, error: "Too many updates — try again in a few minutes." };
    const db = await getDb();
    const now = new Date();
    if (photo) {
      await db
        .insert(schema.photos)
        .values({ personId: me.id, ...photo, updatedAt: now })
        .onConflictDoUpdate({ target: schema.photos.personId, set: { ...photo, updatedAt: now } });
    } else {
      await db.delete(schema.photos).where(eq(schema.photos.personId, me.id));
    }
    await db.update(schema.people).set({ photoUpdatedAt: photo ? now : null, updatedAt: now }).where(eq(schema.people.id, me.id));
  });
  refresh();
  if (result.ok) redirect(`/${slug}?added=update`);
  return result;
}

/** Copies an X post's text, images and author from X (it must be public). Null when it can't be loaded. */
async function xMomentFields(xPost: NonNullable<ReturnType<typeof parseXPostUrl>>) {
  const [embed, details] = await Promise.all([fetchOEmbed(xPost.url), fetchPostDetails(xPost.id)]);
  if (!embed?.text && !details?.media.length) return null;
  return {
    xPostUrl: xPost.url,
    xAuthorHandle: xPost.handle,
    xAuthorName: embed?.authorName ?? null,
    xText: embed?.text?.slice(0, 1000) ?? null,
    xMedia: details?.media ?? [],
    xAvatarUrl: details?.avatarUrl ?? null,
    xPostedAt: snowflakeToDate(xPost.id),
    ...(details ? momentDetailFields(details) : {}),
  };
}

/** Moments: anyone can post photos and/or a short update. A card is optional. */
export async function postMomentAction(_: Result | null, form: FormData): Promise<Result> {
  const body = String(form.get("body") ?? "").trim();
  const place = String(form.get("place") ?? "").trim();
  const rawName = String(form.get("name") ?? "").trim();
  if (body.length > 280) return { ok: false, error: "Keep it under 280 characters.", fields: { body: "Keep it under 280 characters." } };
  if (place.length > 100) return { ok: false, error: "Keep the place short.", fields: { place: "Keep it under 100 characters." } };
  const rawPhotos = form.getAll("photo").map(String).filter(Boolean);
  if (rawPhotos.length > MAX_MOMENT_PHOTOS) return { ok: false, error: `Up to ${MAX_MOMENT_PHOTOS} photos.`, fields: { photo: `Up to ${MAX_MOMENT_PHOTOS} photos.` } };
  const photos: { mime: string; data: string }[] = [];
  for (const raw of rawPhotos) {
    const photo = parsePhoto(raw);
    if ("error" in photo) return { ok: false, error: photo.error, fields: { photo: photo.error } };
    photos.push(photo);
  }
  const rawX = String(form.get("xUrl") ?? "").trim();
  const xPost = rawX ? parseXPostUrl(rawX) : null;
  if (rawX && !xPost) return { ok: false, error: "That isn't an X post link.", fields: { xUrl: "Paste a link like x.com/name/status/123…" } };
  if (!photos.length && !body && !xPost) return { ok: false, error: "Add a photo, an X post link, or write something." };
  // "@handle" credits an X account; anything else is shown as a plain name.
  const handle = rawName.match(/^@?([A-Za-z0-9_]{1,15})$/) && rawName.startsWith("@") ? rawName.slice(1) : null;
  const name = handle ? null : rawName.slice(0, 40) || null;

  let slug = "";
  let newId = "";
  const result = await guard(async () => {
    if (!(await rateLimit("moment", Number(process.env.RATE_LIMIT_MOMENTS_PER_HOUR ?? 40), 60))) {
      return { ok: false, error: "Lots of moments from this network right now — try again in a few minutes." };
    }
    const db = await getDb();
    const event = await formEvent(form);
    slug = event.slug;
    // Moments added from the admin page are credited to the name typed there, not an admin's own card.
    const me = await getMe(event.id);
    const h = await headers();
    // An X post moment copies the post's text, images and author from X (it must be public).
    let x = {};
    if (xPost) {
      const fields = await xMomentFields(xPost);
      if (!fields) return { ok: false, error: "We couldn't load that X post. Is it public?", fields: { xUrl: "We couldn't load that post." } };
      x = fields;
    }
    const [m] = await db
      .insert(schema.moments)
      .values({
        ...x,
        eventId: event.id,
        personId: me?.id ?? null,
        name: me ? null : name,
        xHandle: me ? null : handle,
        body,
        place: place || null,
        hasPhoto: photos.length > 0,
        photoCount: photos.length,
        visitor: visitorHash(clientIp(h), h.get("user-agent") ?? ""),
      })
      .returning({ id: schema.moments.id });
    if (photos.length) await db.insert(schema.momentPhotos).values(photos.map((p, position) => ({ momentId: m.id, position, ...p })));
    newId = m.id;
  });
  refresh();
  // Back to Moments with the new one's id, so the "Posted" note can offer to share it on X.
  if (result.ok) redirect(`/${slug}/moments?posted=${Date.now()}&m=${newId}`);
  return result;
}

// ─── Meet up ─────────────────────────────────────────────────────────────────



/** When a check-in ends: in 1, 2 or 4 hours, or at the end of the day in Lagos. */
export async function checkinExpiry(choice: string, now = new Date()): Promise<Date> {
  const hours = { "1": 1, "2": 2, "4": 4 }[choice];
  if (hours) return new Date(now.getTime() + hours * 3600_000);
  // End of today in Lagos (UTC+1, no daylight saving): 23:59 local = 22:59 UTC.
  const lagos = new Date(now.getTime() + 3600_000);
  const end = new Date(Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), lagos.getUTCDate(), 22, 59));
  return end.getTime() - now.getTime() < 30 * 60_000 ? new Date(now.getTime() + 2 * 3600_000) : end;
}

export async function checkInAction(_: Result | null, form: FormData): Promise<Result> {
  const ev = await getEvent(await getDb(), String(form.get("event") ?? ""));
  if (!ev) return { ok: false, error: "That event wasn't found." };
  if (eventPhase(ev) !== "live") return { ok: false, error: eventPhase(ev) === "after" ? `${ev.short} is over, so Meet up has closed.` : `Meet up opens when ${ev.short} starts.` };
  const CHECKIN_COOKIE = checkinCookie(ev.id);
  const fail = (error: string, fields: Record<string, string>): Result => ({ ok: false, error, fields });
  const place = String(form.get("place") ?? "").trim();
  const note = String(form.get("note") ?? "").trim();
  if (!place) return { ok: false, error: "Say where people can find you.", fields: { place: "Where are you? e.g. “Booth 14, Hall B”" } };
  if (place.length > 100) return { ok: false, error: "Keep the place short.", fields: { place: "Keep it under 100 characters." } };
  if (note.length > 140) return { ok: false, error: "Keep it under 140 characters.", fields: { note: "Keep it under 140 characters." } };

  const result = await guard(async () => {
    const me = await getMe(ev.id);
    let who: { name: string; headline: string | null } & Contact;
    if (me) {
      who = { name: me.name, headline: me.headline, xHandle: me.xHandle, whatsapp: me.whatsapp, email: me.email, linkedinUrl: me.linkedinUrl, websiteUrl: me.websiteUrl };
    } else {
      const contact = parseContact(String(form.get("contact") ?? ""));
      if (!contact) return fail("Add your X handle so people can reach you.", { contact: "Add your X handle (or a WhatsApp number)" });
      // An X handle doubles as a name; a phone number or email needs a name to go with it.
      const name = String(form.get("name") ?? "").trim().slice(0, 60) || (contact.xHandle ? `@${contact.xHandle}` : "");
      if (!name) return fail("Add your name under “More options” so people know who to look for.", { name: "Add your name" });
      who = { name, headline: String(form.get("headline") ?? "").trim().slice(0, 80) || null, ...contact };
    }
    if (!(await rateLimit("checkin", 30, 60))) return { ok: false, error: "Too many check-ins from this network — try again shortly." };
    const db = await getDb();
    const h = await headers();
    const expiresAt = await checkinExpiry(String(form.get("for") ?? "2"));
    // One live check-in per person: a new one replaces the last.
    const previous = me ? undefined : (await cookies()).get(CHECKIN_COOKIE)?.value;
    if (me) await db.update(schema.checkins).set({ endedAt: new Date() }).where(and(eq(schema.checkins.personId, me.id), sql`${schema.checkins.endedAt} is null`));
    else if (previous && /^[0-9a-f-]{36}$/i.test(previous)) await db.update(schema.checkins).set({ endedAt: new Date() }).where(eq(schema.checkins.id, previous));
    const [c] = await db
      .insert(schema.checkins)
      .values({ eventId: ev.id, personId: me?.id ?? null, ...who, place, note, expiresAt, visitor: visitorHash(clientIp(h), h.get("user-agent") ?? "") })
      .returning({ id: schema.checkins.id });
    // Card holders also show "Catch me at" on their card while checked in.
    if (me) await db.update(schema.people).set({ whereNote: place, whereUpdatedAt: new Date() }).where(eq(schema.people.id, me.id));
    else (await cookies()).set(CHECKIN_COOKIE, c.id, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 });
  });
  refresh();
  if (result.ok) redirect(`/${ev.slug}/meet?checked=1`);
  return result;
}

/** "I've left": ends your current check-in. */
export async function endCheckinAction(eventId: string): Promise<Result> {
  return guard(async () => {
    const db = await getDb();
    const me = await getMe(eventId);
    const jar = await cookies();
    const CHECKIN_COOKIE = checkinCookie(eventId);
    const id = jar.get(CHECKIN_COOKIE)?.value;
    if (me) {
      await db.update(schema.checkins).set({ endedAt: new Date() }).where(and(eq(schema.checkins.personId, me.id), sql`${schema.checkins.endedAt} is null`));
      await db.update(schema.people).set({ whereNote: null, whereUpdatedAt: null }).where(eq(schema.people.id, me.id));
    } else if (id && /^[0-9a-f-]{36}$/i.test(id)) {
      await db.update(schema.checkins).set({ endedAt: new Date() }).where(eq(schema.checkins.id, id));
      jar.delete(CHECKIN_COOKIE);
    } else return { ok: false, error: "No check-in on this device." };
    refresh();
  });
}

/** Anyone can add a public X post about the event; it must load via X's official embed. */
export async function addXPostAction(_: Result | null, form: FormData): Promise<Result> {
  const url = String(form.get("url") ?? "").trim();
  const parsed = parseXPostUrl(url);
  if (!parsed) return { ok: false, error: "Paste a link to a post, like x.com/name/status/123…" };
  let slug = "";
  const result = await guard(async () => {
    const event = await formEvent(form);
    slug = event.slug;
    if (!(await rateLimit("xpost", 30, 60))) return { ok: false, error: "Too many posts from this network — try again shortly." };
    const embed = await fetchOEmbed(parsed.url);
    if (!embed?.text) return { ok: false, error: "We couldn't load that post. Is it public?" };
    const db = await getDb();
    const [r] = await importPosts(db, event.id, [{ url: parsed.url, content: embed.text, authorName: embed.authorName }]);
    if (r.status === "duplicate") return { ok: false, error: "That post is already here." };
    if (r.id) await attachDetails(db, { id: r.id, externalId: parsed.id }, fetchPostDetails);
  });
  if (result.ok) {
    refresh();
    redirect(`/${slug}?added=x`);
  }
  return result;
}

export async function addCommentAction(_: Result | null, form: FormData): Promise<Result> {
  const postId = String(form.get("postId") ?? "");
  const body = String(form.get("body") ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(postId)) return { ok: false, error: "Post not found." };
  if (!body) return { ok: false, error: "Write something first." };
  if (body.length > 280) return { ok: false, error: "Keep it under 280 characters." };
  return guard(async () => {
    const db = await getDb();
    const post = await db.query.socialPosts.findFirst({ where: eq(schema.socialPosts.id, postId) });
    if (!post || post.hidden) return { ok: false, error: "Post not found." };
    const me = await getMe(post.eventId);
    const name = me?.name ?? String(form.get("name") ?? "").trim().slice(0, 40);
    if (!name) return { ok: false, error: "Add your name so they know who's commenting." };
    if (!(await rateLimit("comment", 60, 60))) return { ok: false, error: "Too many comments from this network — try again shortly." };
    await db.insert(schema.comments).values({ postId, personId: me?.id ?? null, name, body });
    refresh();
    return { ok: true, message: "Posted." };
  });
}

export async function deleteCardAction(eventSlug: string): Promise<Result> {
  const result = await guard(async () => {
    const event = await getEvent(await getDb(), eventSlug);
    if (!event) return { ok: false, error: "That event wasn't found." };
    const me = await getMe(event.id);
    if (!me) return { ok: false, error: "No card on this device." };
    await (await getDb()).delete(schema.people).where(eq(schema.people.id, me.id));
    await clearCardCookie(event.id);
  });
  if (result.ok) {
    refresh();
    redirect(`/${eventSlug}`);
  }
  return result;
}

const AUTO_HIDE_REPORTS = 3;

export async function reportAction(targetType: "person" | "post" | "comment" | "moment" | "checkin", targetId: string, reason: string): Promise<Result> {
  return guard(async () => {
    if (!(await rateLimit("report", 60, 60))) return { ok: false, error: "Too many reports — try again later." };
    const db = await getDb();
    await db.insert(schema.reports).values({ targetType, targetId, reason: reason.slice(0, 300) || "unspecified", reporterId: null });
    // Moments and check-ins are open to anyone, so enough reports hide one until an admin looks at it.
    if (targetType === "moment" || targetType === "checkin") {
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.reports)
        .where(and(eq(schema.reports.targetId, targetId), eq(schema.reports.resolved, false)));
      if (n >= AUTO_HIDE_REPORTS) {
        if (targetType === "moment") await db.update(schema.moments).set({ hidden: true }).where(eq(schema.moments.id, targetId));
        else await db.update(schema.checkins).set({ hidden: true }).where(eq(schema.checkins.id, targetId));
        refresh();
      }
    }
    return { ok: true, message: "Thanks — we'll take a look." };
  });
}

// ─── Admin (ADMIN_KEY) ───────────────────────────────────────────────────────

/**
 * 🔥 ❤️ 👏 on a moment. Tapping again takes it back. The browser's random id is only stored hashed,
 * so a reaction can't be traced to anyone.
 */
export async function reactAction(momentId: string, kind: string, reactorId: string): Promise<Result & { counts?: ReactionCounts; on?: boolean }> {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID.test(momentId) || !UUID.test(reactorId) || !(REACTIONS as readonly string[]).includes(kind)) return { ok: false, error: "That didn't work." };
  const result = await guard(async () => {
    if (!(await rateLimit("react", 300, 60))) return { ok: false, error: "Slow down a little 🙂" };
    const db = await getDb();
    const [m] = await db.select({ id: schema.moments.id }).from(schema.moments).where(and(eq(schema.moments.id, momentId), eq(schema.moments.hidden, false))).limit(1);
    if (!m) return { ok: false, error: "That moment isn't here any more." };
    const key = { momentId, kind, reactor: hashToken(`reaction:${reactorId}`) };
    const added = await db.insert(schema.reactions).values(key).onConflictDoNothing().returning({ kind: schema.reactions.kind });
    if (!added.length) await db.delete(schema.reactions).where(and(eq(schema.reactions.momentId, momentId), eq(schema.reactions.kind, kind), eq(schema.reactions.reactor, key.reactor)));
    const counts = (await reactionCounts(db, [momentId])).get(momentId) ?? noReactions();
    return { ok: true, counts, on: added.length > 0 } as Result;
  });
  return result as Result & { counts?: ReactionCounts; on?: boolean };
}
