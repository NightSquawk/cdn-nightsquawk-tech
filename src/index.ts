import parseRange from "range-parser";

export interface Env {
  R2_BUCKET: R2Bucket;
  ALLOWED_ORIGINS?: string;
  CACHE_CONTROL?: string;
  PATH_PREFIX?: string;
  INDEX_FILE?: string;
  NOTFOUND_FILE?: string;
  DIRECTORY_LISTING?: boolean;
  ITEMS_PER_PAGE?: number;
  HIDE_HIDDEN_FILES?: boolean;
  DIRECTORY_CACHE_CONTROL?: string;
  LOGGING?: boolean;
  R2_RETRIES?: number;
  DIRECTORY_LISTING_DEFAULT?: "show" | "hide";
  PUBLIC_DIRECTORIES?: string;
  ENABLE_PUBLIC_MARKER?: boolean;
  PUBLIC_MARKER_FILE?: string;
  PUBLIC_MARKER_CACHE_TTL?: number;
}

const units = ["B", "KB", "MB", "GB", "TB"];

type ParsedRange = { offset: number; length: number } | { suffix: number };

function rangeHasLength(
  object: ParsedRange
): object is { offset: number; length: number } {
  return (<{ offset: number; length: number }>object).length !== undefined;
}

function hasBody(object: R2Object | R2ObjectBody): object is R2ObjectBody {
  return (<R2ObjectBody>object).body !== undefined;
}

function hasSuffix(range: ParsedRange): range is { suffix: number } {
  return (<{ suffix: number }>range).suffix !== undefined;
}

function getRangeHeader(range: ParsedRange, fileSize: number): string {
  return `bytes ${hasSuffix(range) ? fileSize - range.suffix : range.offset}-${
    hasSuffix(range) ? fileSize - 1 : range.offset + range.length - 1
  }/${fileSize}`;
}

async function isDirectoryVisible(
  path: string,
  env: Env,
  ctx: ExecutionContext,
  cache: Cache
): Promise<boolean> {
  // Normalize path
  let normalizedPath = path;
  if (normalizedPath.startsWith("/")) normalizedPath = normalizedPath.substring(1);
  if (normalizedPath !== "" && !normalizedPath.endsWith("/")) normalizedPath += "/";

  // Legacy mode: show all
  if (env.DIRECTORY_LISTING_DEFAULT === "show") return true;

  // Check config whitelist (FREE - no R2)
  if (env.PUBLIC_DIRECTORIES) {
    const whitelist = env.PUBLIC_DIRECTORIES.split(",").map(p => p.trim());
    for (const allowed of whitelist) {
      // Empty string = root only, non-empty = exact match or prefix match
      if (allowed === "") {
        if (normalizedPath === "") return true;
      } else if (normalizedPath === allowed || normalizedPath.startsWith(allowed)) {
        return true;
      }
    }
  }

  // Optional: Check marker file with caching
  if (env.ENABLE_PUBLIC_MARKER) {
    const markerFile = env.PUBLIC_MARKER_FILE || ".public";
    const markerPath = normalizedPath + markerFile;

    // Check cache first
    const cacheKey = new Request(`https://marker-cache/${markerPath}`);
    const cached = await cache.match(cacheKey);
    if (cached) return (await cached.text()) === "true";

    // R2 HEAD operation
    const marker = await env.R2_BUCKET.head(markerPath);
    const isVisible = marker !== null;

    // Cache result
    const ttl = env.PUBLIC_MARKER_CACHE_TTL || 300;
    ctx.waitUntil(cache.put(cacheKey, new Response(String(isVisible), {
      headers: { "cache-control": `max-age=${ttl}` }
    })));

    return isVisible;
  }

  return false; // Default: hidden
}

// some ideas for this were taken from / inspired by
// https://github.com/cloudflare/workerd/blob/main/samples/static-files-from-disk/static.js
async function makeListingResponse(
  path: string,
  env: Env,
  request: Request
): Promise<Response | null> {
  if (path === "/") path = "";
  else if (path !== "" && !path.endsWith("/")) {
    path += "/";
  }
  let cursor = new URL(request.url).searchParams.get("cursor") || undefined;
  let listing = await env.R2_BUCKET.list({
    prefix: path,
    delimiter: "/",
    cursor,
    limit: env.ITEMS_PER_PAGE || 1000,
  });

  if (listing.delimitedPrefixes.length === 0 && listing.objects.length === 0) {
    return null;
  }

  let html: string = "";
  let lastModified: Date | null = null;

  if (request.method === "GET") {
    let htmlList = [];

    if (path !== "") {
      htmlList.push(
        `      <tr>` +
          `<td><a href="../">../</a></td>` +
          `<td>-</td><td>-</td></tr>`
      );
    }

    for (let dir of listing.delimitedPrefixes) {
      if (dir.endsWith("/")) dir = dir.substring(0, dir.length - 1);
      let name = dir.substring(path.length, dir.length);
      if (name.startsWith(".") && env.HIDE_HIDDEN_FILES) continue;
      htmlList.push(
        `      <tr>` +
          `<td><a href="${encodeURIComponent(name)}/">${name}/</a></td>` +
          `<td>-</td><td>-</td></tr>`
      );
    }
    for (let file of listing.objects) {
      let name = file.key.substring(path.length, file.key.length);
      if (name.startsWith(".") && env.HIDE_HIDDEN_FILES) continue;

      let dateStr = file.uploaded.toISOString();
      dateStr = dateStr.split(".")[0].replace("T", " ");
      dateStr = dateStr.slice(0, dateStr.lastIndexOf(":")) + "Z";

      htmlList.push(
        `      <tr>` +
          `<td><a href="${encodeURIComponent(name)}">${name}</a></td>` +
          `<td>${dateStr}</td><td>${niceBytes(file.size)}</td></tr>`
      );

      if (lastModified == null || file.uploaded > lastModified) {
        lastModified = file.uploaded;
      }
    }

    if (listing.truncated) {
      htmlList.push(
        `      <tr>` +
          `<td><a href="?cursor=${listing.cursor}">...see more.../</a></td>` +
          `<td>-</td><td>-</td></tr>`
      );
    }

    if (path === "") path = "/";

    html = `<!DOCTYPE html>
<html>
  <head>
    <title>Index of ${path}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta charset="utf-8">
    <style>
      td { padding-right: 16px; text-align: right; font-family: monospace }
      td:nth-of-type(1) { text-align: left; overflow-wrap: anywhere }
      td:nth-of-type(3) { white-space: nowrap }
      th { text-align: left; }
      @media (prefers-color-scheme: dark) {
        body {
          color: white;
          background-color: #1c1b22;
        }
        a {
          color: #3391ff;
        }
        a:visited {
          color: #C63B65;
        }
      }
    </style>
  </head>
  <body>
    <h1>Index of ${path}</h1>
    <table>
      <tr><th>Filename</th><th>Modified</th><th>Size</th></tr>
${htmlList.join("\n")}
    </table>
  </body>
</html>
  `;
  }

  return new Response(html === "" ? null : html, {
    status: 200,
    headers: {
      "access-control-allow-origin": env.ALLOWED_ORIGINS || "",
      "last-modified": lastModified === null ? "" : lastModified.toUTCString(),
      "content-type": "text/html",
      "cache-control": env.DIRECTORY_CACHE_CONTROL || "no-store",
    },
  });
}

async function retryAsync<T>(env: Env, fn: () => Promise<T>): Promise<T> {
  const maxAttempts = env.R2_RETRIES || 0;
  let attempts = 0;

  while (maxAttempts == -1 || attempts <= maxAttempts) {
    try {
      return await fn();
    } catch (err) {
      attempts++;
      if (env.LOGGING) console.error(`Attempt ${attempts} failed:`, err);

      if (attempts <= maxAttempts) {
        const delay = Math.min(1000 * Math.pow(2, attempts - 1), 30000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        throw err;
      }
    }
  }
  throw new Error("unreachable");
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const allowedMethods = ["GET", "HEAD", "OPTIONS"];
    if (allowedMethods.indexOf(request.method) === -1) {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: {
          allow: allowedMethods.join(", "),
          "content-type": "text/plain",
        },
      });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: { allow: allowedMethods.join(", ") },
      });
    }

    let triedIndex = false;

    let response: Response | undefined;

    const isCachingEnabled = env.CACHE_CONTROL !== "no-store";
    const cache = caches.default;
    if (isCachingEnabled) {
      response = await cache.match(request);
    }

    // Since we produce this result from the request, we don't need to strictly use an R2Range
    let range: ParsedRange | undefined;

    if (!response || !(response.ok || response.status == 304)) {
      if (env.LOGGING) {
        console.warn("Cache MISS for", request.url);
      }
      const url = new URL(request.url);
      let path = (env.PATH_PREFIX || "") + decodeURIComponent(url.pathname);

      // directory logic
      if (path.endsWith("/")) {
        // if theres an index file, try that. 404 logic down below has dir fallback.
        if (env.INDEX_FILE && env.INDEX_FILE !== "") {
          path += env.INDEX_FILE;
          triedIndex = true;
        } else if (env.DIRECTORY_LISTING) {
          const isVisible = await isDirectoryVisible(path, env, ctx, cache);
          if (!isVisible) {
            return new Response("Directory listing not available", {
              status: 403,
              headers: { "content-type": "text/plain" },
            });
          }
          // return the dir listing
          let listResponse = await makeListingResponse(path, env, request);

          if (listResponse !== null) {
            if (listResponse.headers.get("cache-control") !== "no-store") {
              ctx.waitUntil(cache.put(request, listResponse.clone()));
            }
            return listResponse;
          }
        }
      }

      if (path !== "/" && path.startsWith("/")) {
        path = path.substring(1);
      }

      let file: R2Object | R2ObjectBody | null | undefined;

      // Range handling
      if (request.method === "GET") {
        const rangeHeader = request.headers.get("range");
        if (rangeHeader) {
          file = await retryAsync(env, () => env.R2_BUCKET.head(path));
          if (file === null)
            return new Response("File Not Found", {
              status: 404,
              headers: { "content-type": "text/plain" },
            });
          const parsedRanges = parseRange(file.size, rangeHeader);
          // R2 only supports 1 range at the moment, reject if there is more than one
          if (
            parsedRanges !== -1 &&
            parsedRanges !== -2 &&
            parsedRanges.length === 1 &&
            parsedRanges.type === "bytes"
          ) {
            let firstRange = parsedRanges[0];
            range =
              file.size === firstRange.end + 1
                ? { suffix: file.size - firstRange.start }
                : {
                    offset: firstRange.start,
                    length: firstRange.end - firstRange.start + 1,
                  };
          } else {
            return new Response("Range Not Satisfiable", {
              status: 416,
              headers: { "content-type": "text/plain" },
            });
          }
        }
      }

      // Etag/If-(Not)-Match handling
      // R2 requires that etag checks must not contain quotes, and the S3 spec only allows one etag
      // This silently ignores invalid or weak (W/) headers
      const getHeaderEtag = (header: string | null) =>
        header?.trim().replace(/^['"]|['"]$/g, "");
      const ifMatch = getHeaderEtag(request.headers.get("if-match"));
      const ifNoneMatch = getHeaderEtag(request.headers.get("if-none-match"));

      const ifModifiedSince = Date.parse(
        request.headers.get("if-modified-since") || ""
      );
      const ifUnmodifiedSince = Date.parse(
        request.headers.get("if-unmodified-since") || ""
      );

      const ifRange = request.headers.get("if-range");
      if (range && ifRange && file) {
        const maybeDate = Date.parse(ifRange);

        if (isNaN(maybeDate) || new Date(maybeDate) > file.uploaded) {
          // httpEtag already has quotes, no need to use getHeaderEtag
          if (ifRange.startsWith("W/") || ifRange !== file.httpEtag)
            range = undefined;
        }
      }

      if (ifMatch || ifUnmodifiedSince) {
        file = await retryAsync(env, () =>
          env.R2_BUCKET.get(path, {
            onlyIf: {
              etagMatches: ifMatch,
              uploadedBefore: ifUnmodifiedSince
                ? new Date(ifUnmodifiedSince)
                : undefined,
            },
            range,
          })
        );

        if (file && !hasBody(file)) {
          return new Response("Precondition Failed", {
            status: 412,
            headers: { "content-type": "text/plain" },
          });
        }
      }

      if (ifNoneMatch || ifModifiedSince) {
        // if-none-match overrides if-modified-since completely
        if (ifNoneMatch) {
          file = await retryAsync(env, () =>
            env.R2_BUCKET.get(path, {
              onlyIf: { etagDoesNotMatch: ifNoneMatch },
              range,
            })
          );
        } else if (ifModifiedSince) {
          file = await retryAsync(env, () =>
            env.R2_BUCKET.get(path, {
              onlyIf: { uploadedAfter: new Date(ifModifiedSince) },
              range,
            })
          );
        }
        if (file && !hasBody(file)) {
          return new Response(null, { status: 304 });
        }
      }

      file =
        request.method === "HEAD"
          ? await retryAsync(env, () => env.R2_BUCKET.head(path))
          : file && hasBody(file)
          ? file
          : await retryAsync(env, () => env.R2_BUCKET.get(path, { range }));

      let notFound: boolean = false;

      if (file === null) {
        if (env.INDEX_FILE && triedIndex) {
          // remove the index file since it doesn't exist
          path = path.substring(0, path.length - env.INDEX_FILE.length);
        }

        if (env.DIRECTORY_LISTING && (path.endsWith("/") || path === "")) {
          const isVisible = await isDirectoryVisible(path, env, ctx, cache);
          if (!isVisible) {
            return new Response("Directory listing not available", {
              status: 403,
              headers: { "content-type": "text/plain" },
            });
          }
          // return the dir listing
          let listResponse = await makeListingResponse(path, env, request);

          if (listResponse !== null) {
            if (listResponse.headers.get("cache-control") !== "no-store") {
              ctx.waitUntil(cache.put(request, listResponse.clone()));
            }
            return listResponse;
          }
        }

        if (env.NOTFOUND_FILE && env.NOTFOUND_FILE != "") {
          notFound = true;
          path = env.NOTFOUND_FILE;
          file =
            request.method === "HEAD"
              ? await retryAsync(env, () => env.R2_BUCKET.head(path))
              : await retryAsync(env, () => env.R2_BUCKET.get(path));
        }

        // if it's still null, either 404 is disabled or that file wasn't found either
        // this isn't an else because then there would have to be two of them
        if (file == null) {
          return new Response("File Not Found", {
            status: 404,
            headers: { "content-type": "text/plain" },
          });
        }
      }

      // Content-Length handling
      let body;
      let contentLength = file.size;
      if (hasBody(file) && file.size !== 0) {
        if (range && !notFound) {
          contentLength = rangeHasLength(range) ? range.length : range.suffix;
        }
        let { readable, writable } = new FixedLengthStream(contentLength);
        file.body.pipeTo(writable);
        body = readable;
      }
      response = new Response(body, {
        status: notFound ? 404 : range ? 206 : 200,
        headers: {
          "accept-ranges": "bytes",
          "access-control-allow-origin": env.ALLOWED_ORIGINS || "",

          etag: notFound ? "" : file.httpEtag,
          // if the 404 file has a custom cache control, we respect it
          "cache-control":
            file.httpMetadata?.cacheControl ??
            (notFound ? "" : env.CACHE_CONTROL || ""),
          expires: file.httpMetadata?.cacheExpiry?.toUTCString() ?? "",
          "last-modified": notFound ? "" : file.uploaded.toUTCString(),

          "content-encoding": file.httpMetadata?.contentEncoding ?? "",
          "content-type":
            file.httpMetadata?.contentType ?? "application/octet-stream",
          "content-language": file.httpMetadata?.contentLanguage ?? "",
          "content-disposition": file.httpMetadata?.contentDisposition ?? "",
          "content-range":
            range && !notFound ? getRangeHeader(range, file.size) : "",
          "content-length": contentLength.toString(),
        },
      });

      if (request.method === "GET" && !range && isCachingEnabled && !notFound)
        ctx.waitUntil(cache.put(request, response.clone()));
    } else {
      if (env.LOGGING) {
        console.warn("Cache HIT for", request.url);
      }
    }

    return response;
  },
};

function niceBytes(x: number) {
  let l = 0,
    n = parseInt(x.toString(), 10) || 0;

  while (n >= 1000 && ++l) {
    n = n / 1000;
  }

  return n.toFixed(n < 10 && l > 0 ? 1 : 0) + " " + units[l];
}
