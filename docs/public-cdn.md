# Public CDN operations

This Worker serves public, read-only files from the `cdn` R2 bucket (S3-compatible storage).
Uploads, deletes, credentials, and administration remain in
`NightSquawk/explorer-nightsquawk-tech`. Explorer's configured bucket `publicUrl`
can continue to point to `https://cdn.nightsquawk.tech`; existing file URLs do not change.
No management endpoints or analytics credentials are exposed by this Worker.

## Rate limiting

`RATE_LIMITING = true` enables both bindings in `wrangler.toml`:

| Binding | Default | Scope |
| --- | --- | --- |
| `CDN_RATE_LIMITER` | 600 requests / 60 seconds | All requests, before cache and R2 access |
| `DIRECTORY_RATE_LIMITER` | 60 requests / 60 seconds | Additional allowance for GET/HEAD directory paths and JSON requests |

The key uses Cloudflare's `CF-Connecting-IP`, prefixed with this application's name.
Changing paths, query parameters, or `X-Forwarded-For` does not reset the allowance.
Missing client IPs share an `unknown` allowance; there is no unprotected fallback.
The directory allowance also applies when a directory serves `index.html`.
OPTIONS consumes the general allowance only.

Exceeded allowances return `429`, `Retry-After: 60`, `Cache-Control: no-store`, and
the usual CORS headers. Missing or failing limiter bindings return `503` instead
of silently disabling protection. Change the `simple.limit` values to tune the
allowances; retain `period = 60` to match the retry header. The namespace IDs must
be unique to these counters within your account.

Anonymous visitors sharing a public IP share an allowance. These are approximate,
per-Cloudflare-location request limits, not global quotas or bandwidth caps.
Distributed traffic can exceed them. Zone-level WAF rules can provide an additional
layer before Worker execution. Direct R2 public/S3 URLs bypass this Worker entirely;
these controls apply to traffic through the CDN Worker.

For consumers importing this project as a package, new bindings and flags are
optional. Enable `RATE_LIMITING` only with both limiter bindings configured.

Reference: [Cloudflare Workers rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

## JSON directory API

```http
GET /?format=json
GET /downloads/?format=json&limit=100
GET /downloads/?format=json&limit=100&cursor=URL_ENCODED_CURSOR
HEAD /downloads/?format=json
```

Both `JSON_DIRECTORY_API` and `DIRECTORY_LISTING` must be enabled. Explicit JSON
requests list the folder even when it contains an `index.html`; normal file and
HTML URLs keep their existing behavior. A directory path must end in `/`.

Example response:

```json
{
  "path": "/downloads/",
  "directories": [{ "name": "images", "url": "/downloads/images/" }],
  "files": [{
    "name": "example.zip",
    "url": "/downloads/example.zip",
    "size": 2048,
    "uploaded": "2026-09-13T12:00:00.000Z",
    "etag": "\"example-etag\""
  }],
  "truncated": false,
  "cursor": null
}
```

URLs are encoded public paths without the internal `PATH_PREFIX`. `size` is bytes.
`limit` must be an integer from 1 through `ITEMS_PER_PAGE` (capped at 1000).
Omit it for the configured maximum. Cursors are opaque; URL-encode them and keep
the same folder when requesting the next page. Pages can contain fewer visible
entries than the limit because hidden entries are filtered after the R2 listing.
Continue while `truncated` is true, even if a page has no visible entries.

The API follows `DIRECTORY_LISTING_DEFAULT`, `PUBLIC_DIRECTORIES`, `.public` marker
checks, and `HIDE_HIDDEN_FILES`. Marker visibility may lag changes by
`PUBLIC_MARKER_CACHE_TTL` (default 300 seconds). Prefix allowlist entries respect
folder boundaries: `public` matches `public/`, not `publicity/`.
With `PATH_PREFIX`, allowlist entries refer to full bucket paths, as do marker checks.

An allowed folder without objects returns empty arrays and HTTP 200. Errors have
the shape `{"error":"message","status":400}`. Typical statuses are 400 for
invalid arguments, 403 for disabled folder visibility, 404 for a disabled API,
405 for unsupported methods, 429 for rate limiting, and 503 for service failures.
All JSON responses use `Cache-Control: no-store`. HEAD returns the same response
status and content type with no body.

Directory visibility controls browsing only. Files remain publicly downloadable
by their known URLs, including files in unlisted folders. Do not use a listing
setting as authentication. The existing default `HIDE_HIDDEN_FILES = false`
continues to include dotfiles in listings.

HTML directory pages now escape filenames and paths and have a restrictive CSP.
The Worker does not cache directory listings, so it reevaluates visibility on
each request (with the marker cache above). `DIRECTORY_CACHE_CONTROL` still
controls browser caching of HTML; `no-store` is recommended. File cache keys are
versioned, causing a one-time cold cache after this update. CORS is applied after
cache lookup; `X-CDN-Cache` reports `HIT`, `MISS`, or `BYPASS`.

## Download analytics

`DOWNLOAD_ANALYTICS_ENABLED = true` writes GET/HEAD events to the private Analytics
Engine dataset `cdn_downloads`. It includes cache hits, failed requests, and range
requests. OPTIONS and unsupported methods are excluded.

| Column | Meaning |
| --- | --- |
| `index1` | CDN hostname (sampling index) |
| `blob1` | Requested URL pathname, truncated to 2048 characters |
| `blob2` | HTTP method |
| `blob3` | Resource: `file`, `directory`, or `other` |
| `blob4` | Worker cache result: `HIT`, `MISS`, or `BYPASS` |
| `double1` | HTTP status |
| `double2` | Advertised response bytes for successful file GETs; otherwise 0 |
| `double3` | Time to construct response headers, in milliseconds |
| `double4` | 1 for a file GET returning 200 or 206; otherwise 0 |

These are file-response counts, not unique visitors or confirmed completed
downloads. Range requests each count as a response, with the selected byte count.
Disconnected clients may receive fewer bytes than advertised. Requests served by
browser caches never reach this Worker and cannot be counted. Revalidations,
HEAD requests, directory pages, and errors do not count as downloads.

The dataset stores no IP addresses, query strings, referrers, cookies, or user
agents. Analytics write failures do not block downloads. The dataset binding is
required for collection; removing it or disabling the flag stops recording.

Example: top requested files over the last seven days, accounting for sampling:

```sql
SELECT blob1 AS path,
       SUM(_sample_interval * double4) AS file_responses,
       SUM(_sample_interval * double2) AS advertised_bytes
FROM cdn_downloads
WHERE timestamp >= NOW() - INTERVAL '7' DAY
  AND double4 = 1
GROUP BY path
ORDER BY file_responses DESC
LIMIT 50
```

Example: errors and rate-limited requests over the last day:

```sql
SELECT double1 AS status, SUM(_sample_interval) AS requests
FROM cdn_downloads
WHERE timestamp >= NOW() - INTERVAL '1' DAY
  AND double1 >= 400
GROUP BY status
ORDER BY requests DESC
```

Query using Cloudflare's authenticated Analytics Engine SQL API or your private
reporting tools. Keep the Account Analytics Read token on the management backend;
do not put it in the public browser or expose an unauthenticated analytics route.
A future Explorer dashboard can use these queries without changing file storage.

Reference: [Analytics Engine setup and queries](https://developers.cloudflare.com/analytics/analytics-engine/get-started/).

## Validation and rollout

```sh
pnpm install --frozen-lockfile
pnpm run types
pnpm run typecheck
pnpm test
pnpm exec wrangler deploy --dry-run
```

On systems where a globally installed libvips causes sharp to try to compile,
use `SHARP_IGNORE_GLOBAL_LIBVIPS=1 pnpm install --frozen-lockfile`.

The deployment workflow runs type checking and tests before publishing. Enabling
bindings in this file does not deploy anything by itself. Before deploying,
ensure Analytics Engine is available in the target Cloudflare account and the
deployment token can update the Worker with these bindings. The dataset is
created on the first write; live rate-limit behavior and dataset ingestion must
be checked after deployment. No changes to Explorer or the S3/R2 objects are
required.
