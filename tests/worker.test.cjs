const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const ts = require("typescript");

const sourcePath = path.resolve(__dirname, "../src/index.ts");
const code = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true },
}).outputText;

function fixture(overrides = {}) {
  const calls = { get: [], head: [], list: [], limits: [], events: [] };
  const stored = new Map();
  const pending = [];
  const cache = {
    async match(request) { return stored.get(request.url)?.clone(); },
    async put(request, response) { stored.set(request.url, response); },
  };
  const object = (key, text = "hello") => ({
    key, size: Buffer.byteLength(text), uploaded: new Date("2026-01-01T00:00:00Z"),
    httpEtag: '"test-etag"', httpMetadata: { contentType: "text/plain" },
    body: new Response(text).body,
  });
  // The Node TransformStream constructor does not accept a fixed byte count.
  class FixedLengthStream extends TransformStream { constructor() { super(); } }
  const runtime = { exports: {}, require: createRequire(sourcePath), Request, Response, Headers,
    URL, console, setTimeout, FixedLengthStream, caches: { default: cache } };
  vm.runInNewContext(code, runtime, { filename: sourcePath });
  const env = {
    ALLOWED_ORIGINS: "*", CACHE_CONTROL: "max-age=86400", DIRECTORY_LISTING: true,
    DIRECTORY_LISTING_DEFAULT: "hide", PUBLIC_DIRECTORIES: ",", JSON_DIRECTORY_API: true,
    RATE_LIMITING: true, DOWNLOAD_ANALYTICS_ENABLED: true,
    CDN_RATE_LIMITER: { async limit({ key }) { calls.limits.push(["global", key]); return { success: true }; } },
    DIRECTORY_RATE_LIMITER: { async limit({ key }) { calls.limits.push(["directory", key]); return { success: true }; } },
    DOWNLOAD_ANALYTICS: { writeDataPoint(event) { calls.events.push(JSON.parse(JSON.stringify(event))); } },
    R2_BUCKET: {
      async get(key) { calls.get.push(key); return key.endsWith(".txt") ? object(key) : null; },
      async head(key) { calls.head.push(key); return null; },
      async list(options) {
        calls.list.push(options);
        return { objects: [object(options.prefix + "hello.txt")], delimitedPrefixes: [], truncated: false };
      },
    },
    ...overrides,
  };
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  async function fetch(url = "/", init = {}) {
    return runtime.exports.default.fetch(new Request("https://cdn.example" + url, {
      ...init, headers: { "cf-connecting-ip": "192.0.2.1", ...init.headers },
    }), env, ctx);
  }
  return { fetch, env, calls, cache, object, stored, async flush() { await Promise.all(pending); } };
}

test("global rate limit rejects before cache/R2 and returns retry/CORS headers", async () => {
  const f = fixture({ CDN_RATE_LIMITER: { async limit() { return { success: false }; } } });
  const response = await f.fetch("/hello.txt");
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(f.calls.get.length + f.calls.head.length + f.calls.list.length, 0);
  assert.equal(f.calls.events[0].doubles[3], 0);
});

test("directory limit covers HTML and JSON, including encoded trailing slash", async () => {
  const f = fixture({ DIRECTORY_RATE_LIMITER: { async limit() { return { success: false }; } } });
  for (const url of ["/", "/?format=json", "/public%2F?format=json"]) {
    const response = await f.fetch(url);
    assert.equal(response.status, 429);
  }
  assert.equal(f.calls.get.length + f.calls.head.length + f.calls.list.length, 0);
});

test("rate keys ignore spoofed forwarding headers, paths, and query parameters", async () => {
  const f = fixture();
  await f.fetch("/missing?one=1", { headers: { "x-forwarded-for": "attacker" } });
  await f.fetch("/different?two=2");
  assert.equal(f.calls.limits[0][1], f.calls.limits[1][1]);
  assert.match(f.calls.limits[0][1], /192\.0\.2\.1$/);
});

test("missing/failing limiter fails closed; explicit disabling supports package consumers", async () => {
  for (const binding of [undefined, { async limit() { throw Error("secret error"); } }]) {
    const f = fixture({ CDN_RATE_LIMITER: binding });
    const response = await f.fetch("/hello.txt");
    assert.equal(response.status, 503);
    assert.equal(await response.text(), "Service Unavailable");
    assert.equal(f.calls.get.length, 0);
  }
  const f = fixture({ RATE_LIMITING: false, CDN_RATE_LIMITER: undefined });
  const response = await f.fetch("/hello.txt");
  assert.equal(await response.text(), "hello");
  await f.flush();
});

test("JSON lists root, paginates, and bypasses index files", async () => {
  const f = fixture({ INDEX_FILE: "index.html" });
  f.env.R2_BUCKET.list = async options => {
    f.calls.list.push(options);
    return { objects: [f.object("a b.txt")], delimitedPrefixes: ["sub folder/"], truncated: true, cursor: "next+/=" };
  };
  const response = await f.fetch("/?format=json&limit=2&cursor=current%2B%2F%3D");
  const payload = await response.json();
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(payload.path, "/");
  assert.equal(payload.files[0].url, "/a%20b.txt");
  assert.equal(payload.directories[0].url, "/sub%20folder/");
  assert.equal(payload.cursor, "next+/=");
  assert.equal(f.calls.list[0].limit, 2);
  assert.equal(f.calls.list[0].cursor, "current+/=");
  assert.equal(f.calls.get.length, 0);
  assert.equal(f.calls.events[0].blobs[2], "directory");
  assert.equal(f.calls.events[0].doubles[3], 0);
});

test("JSON respects visibility, configuration, and directory boundaries", async () => {
  for (const config of [
    { PUBLIC_DIRECTORIES: "public" },
    { JSON_DIRECTORY_API: false },
    { DIRECTORY_LISTING: false },
  ]) {
    const f = fixture(config);
    const response = await f.fetch("/publicity/?format=json");
    assert.ok([403, 404].includes(response.status));
    assert.equal(typeof (await response.json()).error, "string");
    assert.equal(f.calls.list.length, 0);
  }
  const f = fixture({ PUBLIC_DIRECTORIES: "public" });
  assert.equal((await f.fetch("/public/sub/?format=json")).status, 200);
});

test("marker grants JSON access using HEAD and host-scoped cache", async () => {
  const f = fixture({ ENABLE_PUBLIC_MARKER: true, PUBLIC_DIRECTORIES: "" });
  f.env.R2_BUCKET.head = async key => { f.calls.head.push(key); return f.object(key); };
  assert.equal((await f.fetch("/docs/?format=json")).status, 200);
  await f.flush();
  assert.equal((await f.fetch("/docs/?format=json")).status, 200);
  assert.deepEqual(f.calls.head, ["docs/.public"]);
  assert.ok([...f.stored.keys()].some(key => key.startsWith("https://cdn.example/.cdn-marker-cache/")));
});

test("JSON applies hidden-file filtering and does not expose backend prefixes", async () => {
  const f = fixture({ PATH_PREFIX: "/tenant/", PUBLIC_DIRECTORIES: "tenant/public/", HIDE_HIDDEN_FILES: true });
  f.env.R2_BUCKET.list = async options => {
    assert.equal(options.prefix, "tenant/public/");
    return { objects: [f.object(options.prefix + ".secret"), f.object(options.prefix + "ok.txt")],
      delimitedPrefixes: [options.prefix + ".hidden/", options.prefix + "sub/"], truncated: false };
  };
  const response = await f.fetch("/public/?format=json");
  const payload = await response.json();
  assert.deepEqual(payload.files.map(file => file.name), ["ok.txt"]);
  assert.deepEqual(payload.directories.map(dir => dir.name), ["sub"]);
  assert.equal(payload.files[0].url, "/public/ok.txt");
  assert.equal(JSON.stringify(payload).includes("tenant"), false);
});

test("empty JSON directories return an empty successful page", async () => {
  const f = fixture();
  f.env.R2_BUCKET.list = async () => ({ objects: [], delimitedPrefixes: [], truncated: false });
  const response = await f.fetch("/?format=json");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { path: "/", files: [], directories: [], truncated: false, cursor: null });
});

test("invalid paths, file JSON requests and page sizes reject before listing", async () => {
  const f = fixture();
  for (const url of ["/%ZZ", "/%00", "/hello.txt?format=json", "/?format=json&limit=0",
    "/?format=json&limit=1001", "/?format=json&limit=1.5", "/?format=json&limit=", "/?format=json&cursor=" + "a".repeat(4097)]) {
    assert.equal((await f.fetch(url)).status, 400, url.slice(0, 100));
  }
  assert.equal(f.calls.list.length, 0);
});

test("JSON API is read-only and HEAD has no response body", async () => {
  const f = fixture();
  const post = await f.fetch("/?format=json", { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal((await post.json()).status, 405);
  const head = await f.fetch("/?format=json", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(f.calls.events[0].doubles[3], 0);
});

test("HTML escapes object names and paths; directory listings are never in Worker cache", async () => {
  const f = fixture({ DIRECTORY_LISTING_DEFAULT: "show", DIRECTORY_CACHE_CONTROL: "max-age=60" });
  f.env.R2_BUCKET.list = async () => ({ objects: [f.object("<script>/a<img>.txt")],
    delimitedPrefixes: ["<script>/d<svg>/"], truncated: true, cursor: 'x"&' });
  const response = await f.fetch("/%3Cscript%3E/");
  const html = await response.text();
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("<img>"), false);
  assert.equal(html.includes("<svg>"), false);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  await f.flush();
  assert.equal(f.stored.size, 0);
});

test("downloads are counted on cache misses AND hits without query strings/IPs", async () => {
  const f = fixture();
  for (const expected of ["MISS", "HIT"]) {
    const response = await f.fetch("/hello.txt?token=private");
    assert.equal(await response.text(), "hello");
    assert.equal(response.headers.get("x-cdn-cache"), expected);
    await f.flush();
  }
  assert.equal(f.calls.get.length, 1);
  assert.equal(f.calls.events.length, 2);
  for (const event of f.calls.events) {
    assert.equal(event.blobs[0], "/hello.txt");
    assert.equal(event.doubles[1], 5);
    assert.equal(event.doubles[3], 1);
    assert.equal(JSON.stringify(event).includes("private"), false);
    assert.equal(JSON.stringify(event).includes("192.0.2.1"), false);
  }
});

test("CORS is reapplied to cached files for each allowed origin", async () => {
  const f = fixture({ ALLOWED_ORIGINS: "https://one.example,https://two.example" });
  for (const origin of ["https://one.example", "https://two.example", "https://blocked.example"]) {
    const response = await f.fetch("/hello.txt", { headers: { origin } });
    assert.equal(response.headers.get("access-control-allow-origin"), origin.includes("blocked") ? null : origin);
    assert.equal(response.headers.get("vary"), "Origin");
    assert.equal(await response.text(), "hello");
    await f.flush();
  }
  assert.equal(f.calls.get.length, 1);
});

test("range responses report selected bytes; HEAD and errors are not downloads", async () => {
  const f = fixture();
  f.env.R2_BUCKET.head = async key => { const { body, ...metadata } = f.object(key); return metadata; };
  f.env.R2_BUCKET.get = async key => ({ ...f.object(key), body: new Response("he").body });
  const range = await f.fetch("/hello.txt", { headers: { range: "bytes=0-1" } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), "he");
  assert.equal(range.headers.get("content-range"), "bytes 0-1/5");
  await f.flush();
  assert.equal(f.calls.events[0].doubles[1], 2);
  const head = await f.fetch("/hello.txt", { method: "HEAD" });
  assert.equal(await head.text(), "");
  assert.equal(f.calls.events[1].doubles[1], 0);
  assert.equal(f.calls.events[1].doubles[3], 0);
});

test("analytics failure never interrupts a download", async () => {
  const f = fixture({ DOWNLOAD_ANALYTICS: { writeDataPoint() { throw Error("analytics unavailable"); } } });
  const response = await f.fetch("/hello.txt");
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "hello");
  await f.flush();
});

test("storage failures return controlled JSON errors without details", async () => {
  const f = fixture();
  f.env.R2_BUCKET.list = async () => { throw Error("secret bucket details"); };
  const response = await f.fetch("/?format=json");
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "Service Unavailable");
});

test("warm file cache cannot bypass the general limiter", async () => {
  const f = fixture();
  assert.equal(await (await f.fetch("/hello.txt")).text(), "hello");
  await f.flush();
  f.env.CDN_RATE_LIMITER = { async limit() { return { success: false }; } };
  assert.equal((await f.fetch("/hello.txt")).status, 429);
  assert.equal(f.calls.get.length, 1);
});

test("changed visibility cannot be bypassed by a previous HTML listing", async () => {
  const f = fixture({ PUBLIC_DIRECTORIES: "public/", DIRECTORY_CACHE_CONTROL: "max-age=60" });
  assert.equal((await f.fetch("/public/")).status, 200);
  await f.flush();
  f.env.PUBLIC_DIRECTORIES = "";
  assert.equal((await f.fetch("/public/")).status, 403);
  assert.equal((await f.fetch("/public/?format=json")).status, 403);
});

test("CORS preflight works without touching R2 or counting a download", async () => {
  const f = fixture();
  const response = await f.fetch("/?format=json", { method: "OPTIONS" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-methods"), "GET, HEAD, OPTIONS");
  assert.equal(f.calls.events.length, 0);
  assert.equal(f.calls.limits.length, 1);
  assert.equal(f.calls.list.length + f.calls.get.length, 0);
});

test("304 responses and custom 404 bodies do not count as downloads", async () => {
  const f = fixture();
  f.env.R2_BUCKET.get = async key => { const { body, ...metadata } = f.object(key); return metadata; };
  assert.equal((await f.fetch("/hello.txt", { headers: { "if-none-match": '"test-etag"' } })).status, 304);
  assert.equal(f.calls.events[0].doubles[3], 0);
  const g = fixture({ NOTFOUND_FILE: "404.txt" });
  const response = await g.fetch("/missing");
  assert.equal(response.status, 404);
  assert.equal(await response.text(), "hello");
  await g.flush();
  assert.equal(g.calls.events[0].doubles[1], 0);
  assert.equal(g.calls.events[0].doubles[3], 0);
});
