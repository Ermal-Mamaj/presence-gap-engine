import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Readable } from "node:stream";
import zlib from "node:zlib";

/**
 * Fetches a page for gap detection without letting a third-party URL reach
 * anything it shouldn't. Business websites come from data anyone can edit, so
 * every URL is treated as hostile:
 *
 * - only http(s), no credentials, only common web ports
 * - every IP the hostname resolves to is checked at connect time, inside the
 *   socket's own DNS lookup, so a name that resolves differently on a second
 *   lookup (DNS rebinding) can't slip past a separate pre-check
 * - redirects are followed manually and each hop is re-validated
 * - one deadline covers connect, headers and body; the body is size-capped
 * - nothing is executed: the body is read as text and never parsed as a page
 */

export type FetchFailureKind =
  | "invalid_url"
  | "blocked"
  | "dns"
  | "timeout"
  | "connection"
  | "tls"
  | "too_many_redirects";

export class SafeFetchError extends Error {
  constructor(
    readonly kind: FetchFailureKind,
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

export interface FetchedPage {
  status: number;
  finalUrl: string;
  contentType: string;
  /** False when the response isn't HTML-like text; body is empty then. */
  isHtml: boolean;
  body: string;
  /** True when the body was cut at the size limit. */
  truncated: boolean;
  redirects: number;
}

export interface Resolved {
  address: string;
  family: number;
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Replaceable DNS resolution, for tests. */
  resolve?: (hostname: string) => Promise<Resolved[]>;
  /** Replaceable address policy, for tests that need a loopback server. */
  isAddressAllowed?: (address: string) => boolean;
  /** Lifts the port allow-list, for tests whose servers use random ports. */
  allowAnyPort?: boolean;
}

interface UrlPolicy {
  isAddressAllowed?: (address: string) => boolean;
  allowAnyPort?: boolean;
}

export const DEFAULT_TIMEOUT_MS = 8000;
export const DEFAULT_MAX_BYTES = 1024 * 1024;
export const DEFAULT_MAX_REDIRECTS = 5;
export const MAX_CONCURRENT_FETCHES = 8;

const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);
const USER_AGENT = "presence-gap-engine/0.1 (website check)";

const blockList = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, includes cloud metadata 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, includes broadcast
] as const) {
  blockList.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 96], // unspecified, loopback and IPv4-compatible addresses
  ["64:ff9b::", 96], // NAT64: can reach IPv4 hosts
  ["64:ff9b:1::", 48],
  ["100::", 64], // discard-only
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4: embeds an IPv4 address
  ["3fff::", 20], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  blockList.addSubnet(network, prefix, "ipv6");
}

/** True for loopback, private, link-local, reserved and unparseable addresses. */
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return true;
  // BlockList also checks the embedded IPv4 address of IPv4-mapped IPv6 (::ffff:a.b.c.d).
  return blockList.check(address, family === 4 ? "ipv4" : "ipv6");
}

const defaultResolve = async (hostname: string): Promise<Resolved[]> =>
  dns.promises.lookup(hostname, { all: true, verbatim: true });

/**
 * Validates a URL before any connection is attempted. IP literals can't go
 * through the DNS hook (Node skips lookup for them), so they are checked here.
 */
export function assertUrlAllowed(url: URL, policy: UrlPolicy = {}): void {
  const isAddressAllowed = policy.isAddressAllowed ?? ((a: string) => !isBlockedAddress(a));
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError("invalid_url", `Unsupported scheme "${url.protocol}"`);
  }
  if (url.username || url.password) {
    throw new SafeFetchError("invalid_url", "URL contains credentials");
  }
  if (!policy.allowAnyPort && !ALLOWED_PORTS.has(url.port)) {
    throw new SafeFetchError("blocked", `Port ${url.port} is not allowed`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new SafeFetchError("invalid_url", "URL has no host");
  if (net.isIP(host) !== 0 && !isAddressAllowed(host)) {
    throw new SafeFetchError("blocked", `Address ${host} is not a public address`);
  }
}

/**
 * Parses user/third-party input into a URL. A scheme-less value like
 * "example.com" yields an https candidate first and an http fallback.
 */
export function parseWebsiteUrl(raw: string): URL[] {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    throw new SafeFetchError("invalid_url", "Website value is not a URL");
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  if (!hasScheme && /^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[^/]+:\d+(\/|$)/.test(trimmed)) {
    // "javascript:...", "mailto:...", "data:..." and similar
    throw new SafeFetchError("invalid_url", "Unsupported URL scheme");
  }
  try {
    const candidates = hasScheme
      ? [new URL(trimmed)]
      : [new URL(`https://${trimmed}`), new URL(`http://${trimmed}`)];
    if (candidates.some((u) => u.protocol !== "http:" && u.protocol !== "https:")) {
      throw new SafeFetchError("invalid_url", "Unsupported URL scheme");
    }
    return candidates;
  } catch (err) {
    if (err instanceof SafeFetchError) throw err;
    throw new SafeFetchError("invalid_url", "Website value is not a valid URL");
  }
}

const TLS_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "EPROTO",
]);

export function classifyError(err: unknown): SafeFetchError {
  if (err instanceof SafeFetchError) return err;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const message = err instanceof Error ? err.message : "request failed";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NODATA") {
    return new SafeFetchError("dns", message, code);
  }
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") {
    return new SafeFetchError("timeout", message, code);
  }
  if (code && (TLS_CODES.has(code) || code.startsWith("ERR_SSL") || code.startsWith("ERR_TLS"))) {
    return new SafeFetchError("tls", message, code);
  }
  return new SafeFetchError("connection", message, code);
}

function createLimiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

// Shared by every caller in the process, so concurrent scans can't multiply the
// outbound request count.
const limitConcurrency = createLimiter(MAX_CONCURRENT_FETCHES);

type HopResult =
  | { kind: "redirect"; status: number; location: string }
  | { kind: "page"; status: number; contentType: string; isHtml: boolean; body: string; truncated: boolean };

function decoderFor(contentType: string): TextDecoder {
  const charset = contentType.match(/charset=["']?([\w-]+)/i)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset);
  } catch {
    return new TextDecoder("utf-8");
  }
}

function looksLikeHtml(contentType: string): boolean {
  // Some servers omit the header entirely; treat that as possibly HTML.
  return contentType === "" || /html|xml|text\/plain/.test(contentType);
}

function requestHop(url: URL, remainingMs: number, options: SafeFetchOptions): Promise<HopResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const resolve = options.resolve ?? defaultResolve;
  const isAddressAllowed = options.isAddressAllowed ?? ((a: string) => !isBlockedAddress(a));

  return new Promise<HopResult>((resolvePromise, rejectPromise) => {
    let settled = false;
    let req: http.ClientRequest | undefined;

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const fail = (err: unknown) =>
      done(() => {
        req?.destroy();
        rejectPromise(classifyError(err));
      });

    const timer = setTimeout(
      () => fail(new SafeFetchError("timeout", `No complete response within ${remainingMs}ms`)),
      Math.max(remainingMs, 1)
    );

    // Runs for the connection that will actually be used, so the checked
    // addresses are the connected addresses.
    const guardedLookup = (
      hostname: string,
      lookupOptions: dns.LookupOptions,
      callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void
    ) => {
      resolve(hostname).then(
        (addresses) => {
          if (addresses.length === 0) {
            const err: NodeJS.ErrnoException = new Error(`No addresses for ${hostname}`);
            err.code = "ENOTFOUND";
            return callback(err, "", 0);
          }
          const bad = addresses.find((a) => !isAddressAllowed(a.address));
          if (bad) {
            return callback(
              new SafeFetchError("blocked", `${hostname} resolves to a non-public address (${bad.address})`),
              "",
              0
            );
          }
          if (lookupOptions.all) return callback(null, addresses);
          callback(null, addresses[0].address, addresses[0].family);
        },
        (err) => callback(err, "", 0)
      );
    };

    const transport = url.protocol === "https:" ? https : http;
    try {
      req = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname.replace(/^\[|\]$/g, ""),
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          method: "GET",
          agent: false, // fresh socket per request, so every request does its own lookup
          lookup: guardedLookup as net.LookupFunction,
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
            "Accept-Encoding": "identity",
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const location = res.headers.location;
          if (status >= 300 && status < 400 && location) {
            res.destroy();
            return done(() => resolvePromise({ kind: "redirect", status, location }));
          }

          const contentType = String(res.headers["content-type"] ?? "").toLowerCase();
          if (!looksLikeHtml(contentType)) {
            res.destroy();
            return done(() =>
              resolvePromise({ kind: "page", status, contentType, isHtml: false, body: "", truncated: false })
            );
          }

          let stream: Readable = res;
          const encoding = String(res.headers["content-encoding"] ?? "identity").toLowerCase();
          if (encoding === "gzip" || encoding === "deflate") stream = res.pipe(zlib.createUnzip());
          else if (encoding === "br") stream = res.pipe(zlib.createBrotliDecompress());
          else if (encoding !== "identity") {
            res.destroy();
            return done(() =>
              resolvePromise({ kind: "page", status, contentType, isHtml: false, body: "", truncated: false })
            );
          }

          const chunks: Buffer[] = [];
          let size = 0;
          let truncated = false;
          const finish = () =>
            done(() =>
              resolvePromise({
                kind: "page",
                status,
                contentType,
                isHtml: true,
                body: decoderFor(contentType).decode(Buffer.concat(chunks)),
                truncated,
              })
            );

          stream.on("data", (chunk: Buffer) => {
            if (truncated) return;
            size += chunk.length;
            if (size > maxBytes) {
              truncated = true;
              chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
              res.destroy();
              stream.destroy();
              return finish();
            }
            chunks.push(chunk);
          });
          stream.on("end", finish);
          stream.on("error", (err) => (truncated ? finish() : fail(err)));
          res.on("error", (err) => (truncated ? finish() : fail(err)));
        }
      );
    } catch (err) {
      return fail(err);
    }
    req.on("error", fail);
    req.end();
  });
}

async function fetchChain(start: URL, options: SafeFetchOptions): Promise<FetchedPage> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const deadline = Date.now() + timeoutMs;
  let current = start;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    assertUrlAllowed(current, options);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SafeFetchError("timeout", `Exceeded ${timeoutMs}ms across redirects`);

    const result = await requestHop(current, remaining, options);
    if (result.kind === "page") {
      return {
        status: result.status,
        finalUrl: current.toString(),
        contentType: result.contentType,
        isHtml: result.isHtml,
        body: result.body,
        truncated: result.truncated,
        redirects: hop,
      };
    }
    try {
      current = new URL(result.location, current);
    } catch {
      throw new SafeFetchError("invalid_url", "Redirect target is not a valid URL");
    }
  }
  throw new SafeFetchError("too_many_redirects", `More than ${maxRedirects} redirects`);
}

/** Fetches one already-parsed URL. Throws SafeFetchError for every failure. */
export function safeFetchPage(url: URL, options: SafeFetchOptions = {}): Promise<FetchedPage> {
  return limitConcurrency(() => fetchChain(url, options));
}
