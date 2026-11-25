import "server-only";
import type { ParsedLink } from "@/lib/rates";
import { safeFetch, type Fetched, type FetchOptions } from "@/lib/safe-fetch";

// Fills in what's public about a creator from the link they were added with: a name, a one-line bio and a picture.
// Best effort and honest about it. Some platforms show automated readers only a login wall (Instagram, TikTok pages),
// and none of them publishes follower counts this way, so anything missing is simply left empty.

export interface Enriched {
  name?: string;
  bio?: string;
  image?: { mime: string; data: Buffer };
}

export type Fetcher = (url: string, opts?: FetchOptions) => Promise<Fetched>;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s: string) =>
  s
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();

/** The page's og: and twitter: meta tags, by property name. */
export function readMeta(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const head = html; // YouTube puts its tags about 900 KB into the page, so the whole (size-capped) body is scanned
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = tag.match(/\b(?:property|name)\s*=\s*"([^"]+)"/i)?.[1]?.toLowerCase();
    const value = tag.match(/\bcontent\s*=\s*"([^"]*)"/i)?.[1];
    if (key && value !== undefined && !(key in out)) out[key] = decode(value);
  }
  const title = head.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
  if (title && !out.title) out.title = decode(title);
  return out;
}

const GENERIC = /^(instagram|tiktok|x|twitter|youtube|log in|login|sign in|home|just a moment\.{0,3}|access denied|attention required.*)$/i;

/** "Davido (@davido) on X" -> "Davido", "MrBeast - YouTube" -> "MrBeast", "Home | BellaNaija" -> "BellaNaija". */
export function cleanName(raw: string | undefined, link: ParsedLink): string | undefined {
  if (!raw) return undefined;
  let t = raw.trim();
  t = t.replace(/\s*\(@[^)]*\).*$/, ""); // (@handle) and anything after it
  t = t.replace(/\s*[|•—-]\s*(YouTube|TikTok|Instagram|X|Twitter)\b.*$/i, "").replace(/\s+on\s+(X|Twitter|TikTok|Instagram)\s*$/i, "");
  if (link.platform === "website") {
    const parts = t.split(/\s+[|–—-]\s+/).map((p) => p.trim()).filter(Boolean);
    const site = link.name.toLowerCase().replace(/\s+/g, "");
    t = parts.find((p) => p.toLowerCase().replace(/[^a-z0-9]/g, "").includes(site.replace(/[^a-z0-9]/g, ""))) ?? parts[parts.length - 1] ?? t;
  }
  t = t.trim().slice(0, 80);
  return t && !GENERIC.test(t) ? t : undefined;
}

const MAGIC: [string, (b: Buffer) => boolean][] = [
  ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/png", (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ["image/webp", (b) => b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP"],
];
export const MAX_AVATAR_BYTES = 300_000;

/** The type of a picture we're willing to keep (photos and logos only, never SVG), judged by its bytes. */
export const imageType = (b: Buffer): string | null => MAGIC.find(([, ok]) => ok(b))?.[0] ?? null;

async function fetchImage(url: string, fetcher: Fetcher): Promise<Enriched["image"] | undefined> {
  try {
    const r = await fetcher(url, { maxBytes: MAX_AVATAR_BYTES + 1, accept: "image/*", timeoutMs: 5000 });
    if (r.status !== 200 || r.body.length === 0 || r.body.length > MAX_AVATAR_BYTES) return undefined;
    const mime = imageType(r.body);
    return mime ? { mime, data: r.body } : undefined;
  } catch {
    return undefined;
  }
}

const unavatar = (l: ParsedLink) => (l.platform === "website" ? (l.website ? `https://unavatar.io/${new URL(l.website).hostname}` : null) : l.handle && l.platform !== "instagram" ? `https://unavatar.io/${l.platform}/${encodeURIComponent(l.handle)}` : null);

/**
 * Name, bio and picture for a link. Never throws: on any failure the creator is simply added with what the link says.
 * Instagram and TikTok pages show automated readers only a login wall, so those aren't fetched.
 */
export async function enrichFromLink(link: ParsedLink, fetcher: Fetcher = safeFetch): Promise<Enriched> {
  const out: Enriched = {};
  const pageUrl = link.platform === "website" ? link.website : link.platform === "youtube" ? `https://www.youtube.com/@${link.handle}` : link.platform === "x" ? `https://x.com/${link.handle}` : null;
  let ogImage: string | undefined;
  if (pageUrl) {
    try {
      const r = await fetcher(pageUrl, { accept: "text/html", maxBytes: link.platform === "youtube" ? 1_200_000 : 400_000, timeoutMs: 8000 });
      if (r.status === 200 && /html/i.test(r.contentType)) {
        const meta = readMeta(r.body.toString("utf8"));
        out.name = cleanName(meta["og:title"] ?? meta["twitter:title"] ?? meta.title, link);
        const bio = meta["og:description"] ?? meta.description;
        if (bio && !/^(create an account|log in|sign in|join )/i.test(bio)) out.bio = bio.slice(0, 280);
        const img = meta["og:image"] ?? meta["twitter:image"];
        if (img) ogImage = new URL(img, r.url).toString();
      }
    } catch {
      /* leave it empty */
    }
  }
  // A brand's own picture first, then the avatar service, which covers TikTok, YouTube, X and website logos.
  for (const candidate of [ogImage, unavatar(link) ?? undefined]) {
    if (!candidate || out.image) continue;
    out.image = await fetchImage(candidate, fetcher);
  }
  return out;
}
