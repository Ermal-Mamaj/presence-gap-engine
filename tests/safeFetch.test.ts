import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertUrlAllowed,
  classifyError,
  isBlockedAddress,
  MAX_CONCURRENT_FETCHES,
  parseWebsiteUrl,
  safeFetchPage,
  SafeFetchError,
  type Resolved,
  type SafeFetchOptions,
} from "@/lib/safeFetch";

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "192.168.255.255",
    "169.254.169.254", // cloud metadata
    "169.254.0.1",
    "100.64.0.1", // carrier-grade NAT
    "0.0.0.0",
    "0.1.2.3",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
    "192.0.2.1",
    "198.18.0.1",
    "::",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:10.0.0.5",
    "::ffff:169.254.169.254",
    "::127.0.0.1", // IPv4-compatible
    "64:ff9b::7f00:1", // NAT64 to 127.0.0.1
    "2002:7f00:1::", // 6to4 of 127.0.0.1
    "2001:db8::1",
    "not-an-ip",
    "",
    "999.1.1.1",
  ])("blocks %j", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "11.0.0.1",
    "169.253.1.1",
    "192.169.0.1",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
  ])("allows the public address %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe("assertUrlAllowed", () => {
  const blocked = (raw: string) => {
    try {
      assertUrlAllowed(new URL(raw));
    } catch (err) {
      return (err as SafeFetchError).kind;
    }
    return null;
  };

  it("accepts ordinary public web URLs", () => {
    for (const raw of ["http://example.com/", "https://example.com/a?b=c", "https://example.com:8443/", "http://8.8.8.8/"]) {
      expect(blocked(raw), raw).toBeNull();
    }
  });

  it.each(["ftp://example.com/", "file:///etc/passwd", "gopher://example.com/", "ws://example.com/"])(
    "rejects the scheme in %s",
    (raw) => {
      expect(blocked(raw)).toBe("invalid_url");
    }
  );

  it("rejects embedded credentials", () => {
    expect(blocked("https://user:pass@example.com/")).toBe("invalid_url");
    expect(blocked("https://user@example.com/")).toBe("invalid_url");
  });

  it.each(["http://example.com:22/", "http://example.com:3306/", "http://example.com:6379/", "https://example.com:9200/"])(
    "rejects the non-web port in %s",
    (raw) => {
      expect(blocked(raw)).toBe("blocked");
    }
  );

  it.each([
    "http://127.0.0.1/",
    "http://localhost.invalid:80/", // not an IP: checked at DNS time instead
    "http://[::1]/",
    "http://[::ffff:7f00:1]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/",
    "http://192.168.1.1/",
    "http://2130706433/", // decimal form of 127.0.0.1
    "http://0x7f.0.0.1/", // hex form
    "http://0177.0.0.1/", // octal form
    "http://127.1/", // short form
    "http://0/",
  ])("handles the address form in %s", (raw) => {
    // Hostnames are checked when they resolve; IP literals are checked here.
    const expected = raw.includes("localhost.invalid") ? null : "blocked";
    expect(blocked(raw), raw).toBe(expected);
  });
});

describe("parseWebsiteUrl", () => {
  it("offers https first then http for a bare domain", () => {
    expect(parseWebsiteUrl("example.com").map((u) => u.protocol)).toEqual(["https:", "http:"]);
    expect(parseWebsiteUrl("www.example.com/menu?x=1")[0].href).toBe("https://www.example.com/menu?x=1");
  });

  it("uses an explicit scheme as given", () => {
    expect(parseWebsiteUrl("http://example.com").map((u) => u.href)).toEqual(["http://example.com/"]);
  });

  it("accepts a bare host with a port", () => {
    expect(parseWebsiteUrl("example.com:8080")[0].href).toBe("https://example.com:8080/");
  });

  it.each([
    "",
    "   ",
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html,hi",
    "mailto:a@b.c",
    "tel:+3831234",
    "file:///etc/passwd",
    "ftp://example.com",
    "has space.com",
    "http://",
  ])("rejects %j", (raw) => {
    expect(() => parseWebsiteUrl(raw)).toThrowError(SafeFetchError);
    try {
      parseWebsiteUrl(raw);
    } catch (err) {
      expect((err as SafeFetchError).kind).toBe("invalid_url");
    }
  });
});

describe("classifyError", () => {
  const withCode = (code: string) => Object.assign(new Error("x"), { code });

  it.each([
    ["ENOTFOUND", "dns"],
    ["EAI_AGAIN", "dns"],
    ["ETIMEDOUT", "timeout"],
    ["ECONNREFUSED", "connection"],
    ["ECONNRESET", "connection"],
    ["CERT_HAS_EXPIRED", "tls"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls"],
    ["ERR_SSL_WRONG_VERSION_NUMBER", "tls"],
  ])("maps %s to %s", (code, kind) => {
    expect(classifyError(withCode(code)).kind).toBe(kind);
  });

  it("keeps an existing SafeFetchError and handles non-errors", () => {
    const original = new SafeFetchError("blocked", "no");
    expect(classifyError(original)).toBe(original);
    expect(classifyError("weird").kind).toBe("connection");
  });
});

// ---- live behaviour, against real sockets on loopback -----------------------

const servers: http.Server[] = [];

async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

afterAll(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});

// Name -> address table standing in for DNS. "evil" resolves to a private
// address, "mixed" to a public and a private one.
const DNS: Record<string, Resolved[]> = {
  "site.test": [{ address: "127.0.0.1", family: 4 }],
  "other.test": [{ address: "127.0.0.1", family: 4 }],
  "evil.test": [{ address: "10.0.0.5", family: 4 }],
  "metadata.test": [{ address: "169.254.169.254", family: 4 }],
  "mixed.test": [
    { address: "8.8.8.8", family: 4 },
    { address: "10.0.0.5", family: 4 },
  ],
  "empty.test": [],
};

function options(extra: SafeFetchOptions = {}): SafeFetchOptions {
  return {
    timeoutMs: 2000,
    allowAnyPort: true,
    // The tests' own servers live on loopback; everything else keeps the real policy.
    isAddressAllowed: (address) => address === "127.0.0.1" || !isBlockedAddress(address),
    resolve: async (hostname) => {
      const found = DNS[hostname];
      if (!found) {
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
      }
      return found;
    },
    ...extra,
  };
}

const fetchFrom = (host: string, port: number, path = "/", extra?: SafeFetchOptions) =>
  safeFetchPage(new URL(`http://${host}:${port}${path}`), options(extra));

async function failure(promise: Promise<unknown>): Promise<SafeFetchError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SafeFetchError);
    return err as SafeFetchError;
  }
  throw new Error("expected the fetch to fail");
}

describe("safeFetchPage: ordinary responses", () => {
  it("returns the page", async () => {
    const { port } = await listen((_req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end("<html><head></head><body>Mirëdita</body></html>");
    });
    const page = await fetchFrom("site.test", port);
    expect(page).toMatchObject({ status: 200, isHtml: true, truncated: false, redirects: 0 });
    expect(page.body).toContain("Mirëdita");
    expect(page.finalUrl).toBe(`http://site.test:${port}/`);
  });

  it("returns an error status as a page, not an exception", async () => {
    const { port } = await listen((_req, res) => {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/html");
      res.end("<h1>Nothing here</h1>");
    });
    const page = await fetchFrom("site.test", port);
    expect(page.status).toBe(404);
  });

  it("sends an honest user agent and asks for no compression", async () => {
    let seen: http.IncomingHttpHeaders = {};
    const { port } = await listen((req, res) => {
      seen = req.headers;
      res.end("<html></html>");
    });
    await fetchFrom("site.test", port);
    expect(seen["user-agent"]).toMatch(/presence-gap-engine/);
    expect(seen["accept-encoding"]).toBe("identity");
    expect(seen.cookie).toBeUndefined();
  });

  it("does not treat a non-HTML response as a page, and does not download it", async () => {
    const { port } = await listen((_req, res) => {
      res.setHeader("Content-Type", "application/pdf");
      res.end("%PDF-1.4 ...");
    });
    const page = await fetchFrom("site.test", port);
    expect(page).toMatchObject({ isHtml: false, body: "", contentType: "application/pdf" });
  });

  it("treats a response with no content type as possibly HTML", async () => {
    const { port } = await listen((_req, res) => {
      res.writeHead(200, {});
      res.end("<html><head><meta name=viewport content=x></head></html>");
    });
    expect((await fetchFrom("site.test", port)).isHtml).toBe(true);
  });

  it("decodes the declared charset", async () => {
    const { port } = await listen((_req, res) => {
      res.setHeader("Content-Type", "text/html; charset=iso-8859-1");
      res.end(Buffer.from([0x3c, 0x70, 0x3e, 0xeb, 0x3c, 0x2f, 0x70, 0x3e])); // <p>ë</p>
    });
    expect((await fetchFrom("site.test", port)).body).toBe("<p>ë</p>");
  });
});

describe("safeFetchPage: redirects", () => {
  it("follows a short chain and counts the hops", async () => {
    const { port } = await listen((req, res) => {
      if (req.url === "/a") return void res.writeHead(301, { Location: "/b" }).end();
      if (req.url === "/b") return void res.writeHead(302, { Location: `http://other.test:${port}/c` }).end();
      res.setHeader("Content-Type", "text/html");
      res.end("<html>end</html>");
    });
    const page = await fetchFrom("site.test", port, "/a");
    expect(page.redirects).toBe(2);
    expect(page.finalUrl).toBe(`http://other.test:${port}/c`);
    expect(page.body).toContain("end");
  });

  it("stops a redirect loop at the redirect limit", async () => {
    const { port } = await listen((_req, res) => void res.writeHead(302, { Location: "/" }).end());
    const err = await failure(fetchFrom("site.test", port, "/", { maxRedirects: 3 }));
    expect(err.kind).toBe("too_many_redirects");
  });

  it("refuses a redirect to a hostname that resolves to a private address", async () => {
    const { port } = await listen((_req, res) => void res.writeHead(302, { Location: `http://evil.test:${port}/` }).end());
    const err = await failure(fetchFrom("site.test", port));
    expect(err.kind).toBe("blocked");
  });

  it.each([
    "http://10.0.0.5/admin",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::ffff:a00:5]/", // IPv4-mapped form of 10.0.0.5
    "http://167772165/", // decimal form of 10.0.0.5
    "http://metadata.test/latest/meta-data/",
  ])("refuses a redirect to %s", async (target) => {
    const { port } = await listen((_req, res) => void res.writeHead(302, { Location: target }).end());
    const err = await failure(fetchFrom("site.test", port));
    expect(err.kind).toBe("blocked");
  });

  it.each(["file:///etc/passwd", "ftp://example.com/", "gopher://example.com/"])(
    "refuses a redirect to %s",
    async (target) => {
      const { port } = await listen((_req, res) => void res.writeHead(302, { Location: target }).end());
      const err = await failure(fetchFrom("site.test", port));
      expect(err.kind).toBe("invalid_url");
    }
  );

  it("refuses a redirect to a credentialed URL", async () => {
    const { port } = await listen((_req, res) => void res.writeHead(302, { Location: "http://user:pw@other.test/" }).end());
    const err = await failure(fetchFrom("site.test", port));
    expect(err.kind).toBe("invalid_url");
  });

  it("never contacts the redirect target when it is not allowed", async () => {
    let targetHits = 0;
    const target = await listen((_req, res) => {
      targetHits++;
      res.end("secret");
    });
    // The target listens on loopback, which these options allow for site.test; a
    // private-resolving name pointing at the same port must still be refused.
    const { port } = await listen((_req, res) => void res.writeHead(302, { Location: `http://evil.test:${target.port}/` }).end());
    await failure(fetchFrom("site.test", port));
    expect(targetHits).toBe(0);
  });
});

describe("safeFetchPage: DNS handling", () => {
  it("refuses a name that resolves to a private address", async () => {
    const { port } = await listen((_req, res) => res.end("secret"));
    const err = await failure(fetchFrom("evil.test", port));
    expect(err.kind).toBe("blocked");
    expect(err.message).toMatch(/non-public/);
  });

  it("refuses a name when any of its addresses is private", async () => {
    const { port } = await listen((_req, res) => res.end("secret"));
    const err = await failure(fetchFrom("mixed.test", port));
    expect(err.kind).toBe("blocked");
  });

  it("reports a name with no addresses as a DNS failure", async () => {
    const { port } = await listen((_req, res) => res.end("x"));
    const err = await failure(fetchFrom("empty.test", port));
    expect(err.kind).toBe("dns");
  });

  it("reports an unknown name as a DNS failure", async () => {
    const { port } = await listen((_req, res) => res.end("x"));
    const err = await failure(fetchFrom("no-such-host.test", port));
    expect(err.kind).toBe("dns");
  });

  it("resolves once per request and connects to exactly what it checked", async () => {
    const { port } = await listen((_req, res) => res.end("<html>ok</html>"));
    const lookups: string[] = [];
    // First answer is allowed; a second lookup (the rebinding window) would
    // return a private address. Only one lookup may happen.
    let calls = 0;
    const resolve = async (hostname: string) => {
      lookups.push(hostname);
      calls++;
      return calls === 1 ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "10.0.0.5", family: 4 }];
    };
    const page = await fetchFrom("rebind.test", port, "/", { resolve });
    expect(page.status).toBe(200);
    expect(lookups).toEqual(["rebind.test"]);
  });

  it("checks every hop's DNS answer, so a later rebind to a private address is caught", async () => {
    const { port } = await listen((req, res) => {
      if (req.url === "/start") return void res.writeHead(302, { Location: `http://rebind.test:${port}/next` }).end();
      res.end("<html>ok</html>");
    });
    let calls = 0;
    const resolve = async () => {
      calls++;
      return calls === 1 ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "10.0.0.5", family: 4 }];
    };
    const err = await failure(fetchFrom("rebind.test", port, "/start", { resolve }));
    expect(err.kind).toBe("blocked");
  });
});

describe("safeFetchPage: ports and schemes", () => {
  it("refuses a non-web port by default", async () => {
    const { port } = await listen((_req, res) => res.end("x"));
    const err = await failure(fetchFrom("site.test", port, "/", { allowAnyPort: false }));
    expect(err.kind).toBe("blocked");
    expect(err.message).toMatch(/port/i);
  });

  it("refuses an IP literal that is private under the default policy", async () => {
    const err = await failure(safeFetchPage(new URL("http://127.0.0.1:80/")));
    expect(err.kind).toBe("blocked");
  });

  it("refuses unsupported schemes before connecting", async () => {
    const err = await failure(safeFetchPage(new URL("ftp://example.com/")));
    expect(err.kind).toBe("invalid_url");
  });
});

describe("safeFetchPage: timeouts", () => {
  it("gives up on a server that accepts the connection and never answers", async () => {
    const { port } = await listen(() => {
      /* never respond */
    });
    const started = Date.now();
    const err = await failure(fetchFrom("site.test", port, "/", { timeoutMs: 300 }));
    expect(err.kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("applies the deadline to the body too, so a slow drip can't hold a worker", async () => {
    const { port } = await listen((_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.write("<html>");
      const interval = setInterval(() => res.write("x"), 50);
      res.on("close", () => clearInterval(interval));
    });
    const started = Date.now();
    const err = await failure(fetchFrom("site.test", port, "/", { timeoutMs: 400 }));
    expect(err.kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("shares one deadline across redirects", async () => {
    const { port } = await listen((req, res) => {
      if (req.url === "/slow") return; // never answers
      setTimeout(() => res.writeHead(302, { Location: "/slow" }).end(), 150);
    });
    const started = Date.now();
    const err = await failure(fetchFrom("site.test", port, "/", { timeoutMs: 500 }));
    expect(err.kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("reports a refused connection as a connection failure", async () => {
    const closed = await listen((_req, res) => res.end());
    const port = closed.port;
    await new Promise<void>((resolve) => closed.server.close(() => resolve()));
    const err = await failure(fetchFrom("site.test", port));
    expect(err.kind).toBe("connection");
  });
});

describe("safeFetchPage: response size", () => {
  it("stops reading at the size limit and drops the connection", async () => {
    let closedEarly = false;
    const { port } = await listen((_req, res) => {
      res.setHeader("Content-Type", "text/html");
      const chunk = "a".repeat(10_000);
      const interval = setInterval(() => res.write(chunk), 1);
      res.on("close", () => {
        closedEarly = true;
        clearInterval(interval);
      });
    });
    const page = await fetchFrom("site.test", port, "/", { maxBytes: 50_000 });
    expect(page.truncated).toBe(true);
    expect(page.body.length).toBe(50_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(closedEarly).toBe(true);
  });

  it("does not mark a page that fits as truncated", async () => {
    const { port } = await listen((_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end("a".repeat(1000));
    });
    const page = await fetchFrom("site.test", port, "/", { maxBytes: 1000 });
    expect(page.truncated).toBe(false);
    expect(page.body.length).toBe(1000);
  });

  it("decompresses a gzip response that was not asked for", async () => {
    const { port } = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" });
      res.end(zlib.gzipSync("<html>compressed hello</html>"));
    });
    expect((await fetchFrom("site.test", port)).body).toBe("<html>compressed hello</html>");
  });

  it("caps the decompressed size, so a gzip bomb can't exhaust memory", async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(30 * 1024 * 1024, "a")); // ~30 KB on the wire
    expect(bomb.length).toBeLessThan(100_000);
    const { port } = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" });
      res.end(bomb);
    });
    const page = await fetchFrom("site.test", port, "/", { maxBytes: 100_000 });
    expect(page.truncated).toBe(true);
    expect(page.body.length).toBe(100_000);
  });

  it("does not trust an unknown content encoding", async () => {
    const { port } = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "zstd" });
      res.end("garbage");
    });
    const page = await fetchFrom("site.test", port);
    expect(page.isHtml).toBe(false);
    expect(page.body).toBe("");
  });
});

describe("safeFetchPage: concurrency", () => {
  it("never has more than the global limit of requests in flight", async () => {
    let active = 0;
    let max = 0;
    const { port } = await listen((_req, res) => {
      active++;
      max = Math.max(max, active);
      setTimeout(() => {
        active--;
        res.setHeader("Content-Type", "text/html");
        res.end("<html></html>");
      }, 60);
    });
    const pages = await Promise.all(Array.from({ length: 40 }, () => fetchFrom("site.test", port, "/", { timeoutMs: 10_000 })));
    expect(pages).toHaveLength(40);
    expect(max).toBeGreaterThan(1);
    expect(max).toBeLessThanOrEqual(MAX_CONCURRENT_FETCHES);
  });
});
