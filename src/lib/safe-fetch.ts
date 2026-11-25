import "server-only";
import dns from "dns";
import http from "http";
import https from "https";
import net from "net";

// Fetching a link someone typed in is a way to make this server talk to places it shouldn't (its own network, cloud
// metadata, other services). So every address is checked at connect time, redirects are followed by hand and checked
// again, and the size and time are capped. Only http and https on their usual ports.

/** True for loopback, private, link-local, shared, multicast and otherwise non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb") || v.startsWith("ff");
  }
  return true;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** DNS lookup that refuses anything non-public, used at connect time so a hostname can't change its answer afterwards. */
function guardedLookup(hostname: string, options: dns.LookupOptions, cb: LookupCb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err, "");
    const list = addresses as dns.LookupAddress[];
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) return cb(Object.assign(new Error("Blocked address"), { code: "EBLOCKED" }) as NodeJS.ErrnoException, "");
    if (options.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

export interface Fetched {
  status: number;
  url: string;
  contentType: string;
  body: Buffer;
}

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  accept?: string;
}

const UA = "RatesBot/1.0 (+https://rates.latars.xyz)";

function once(url: URL, o: Required<FetchOptions>): Promise<{ res: http.IncomingMessage; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      { method: "GET", lookup: guardedLookup as never, timeout: o.timeoutMs, headers: { "User-Agent": UA, Accept: o.accept, "Accept-Language": "en", "Accept-Encoding": "identity" } },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > o.maxBytes) {
            // Enough: what we want (meta tags, a small image) is at the start, or it's too big to be it.
            res.destroy();
            resolve({ res, body: Buffer.concat(chunks).subarray(0, o.maxBytes) });
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ res, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("Timed out")));
    req.on("error", reject);
    req.end();
  });
}

/** GET a public web address. Throws if it's blocked, slow or broken. */
export async function safeFetch(input: string, opts: FetchOptions = {}): Promise<Fetched> {
  const o = { timeoutMs: 5000, maxBytes: 600_000, maxRedirects: 3, accept: "*/*", ...opts };
  let url = new URL(input);
  for (let hop = 0; hop <= o.maxRedirects; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Not a web address");
    if (url.username || url.password) throw new Error("Not allowed");
    if (url.port && url.port !== (url.protocol === "https:" ? "443" : "80")) throw new Error("Port not allowed");
    if (net.isIP(url.hostname.replace(/^\[|\]$/g, "")) && isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ""))) throw new Error("Blocked address");
    const { res, body } = await once(url, o);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      url = new URL(res.headers.location, url);
      continue;
    }
    return { status, url: url.toString(), contentType: String(res.headers["content-type"] ?? ""), body };
  }
  throw new Error("Too many redirects");
}
