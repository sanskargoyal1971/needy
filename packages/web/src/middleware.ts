import { NextResponse, type NextRequest } from "next/server";

/** ── Content Security Policy ───────────────────────────────────────────────
 *  There was none. The API sets `helmet({ contentSecurityPolicy: false })` with a comment
 *  correctly explaining that a CSP on a JSON API gives false assurance because "the document's
 *  own policy is what actually governs the browser" — and then the document had no policy at
 *  all. This file is the half that comment was waiting for.
 *
 *  Nonce-based with `strict-dynamic`, rather than an allowlist. An allowlist of hosts is only
 *  as strong as the weakest thing hosted on any of them, and it has to be maintained by hand
 *  forever. A nonce says something simpler and stronger: the only scripts that run are the
 *  ones this server put in this response.
 *
 *  THE COST, stated plainly: generating a per-request nonce makes every page dynamically
 *  rendered — the twenty-odd marketing pages that used to be prerendered at build time are
 *  now rendered per request. That is a real regression and it was taken deliberately. The
 *  alternative that keeps them static is `script-src 'unsafe-inline'`, which is not a weaker
 *  CSP so much as an absent one; and the alternative that keeps them static *and* strict is
 *  applying the policy only to some routes, which fails OPEN — the day someone adds a page
 *  that renders a chat message outside the matcher, it silently has no policy. On a platform
 *  handling Aadhaar scans and live locations, the failure direction matters more than the
 *  prerender.
 */

/** Origins the browser is allowed to talk to. Derived from the same env vars the app itself
 *  reads, so pointing the app at a different API or tile provider cannot leave the policy
 *  behind — a CSP that has to be edited in a second place is a CSP that will be wrong. */
function connectOrigins(): string[] {
  const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const origins = new Set<string>();
  try {
    const url = new URL(api);
    origins.add(url.origin);
    // Socket.io upgrades to a WebSocket against the same origin, and `connect-src` does not
    // treat ws:// as covered by http://. Forgetting this is the classic way a CSP ships
    // looking fine and silently kills every realtime feature — including the SOS feed.
    origins.add(`${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`);
  } catch {
    // A malformed API URL is a configuration error the app will hit anyway; the policy just
    // omits it rather than throwing inside middleware on every request.
  }
  return [...origins];
}

/** Map tiles come from whatever provider is configured. `{s}` and `{z}/{x}/{y}` are Leaflet's
 *  templating, not URL syntax, so the origin is extracted from a de-templated copy. */
function tileOrigin(): string | null {
  const raw =
    process.env.NEXT_PUBLIC_MAP_TILE_URL ??
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
  try {
    // `{s}` is a subdomain shard (a, b, c). Replaced with a wildcard host so all shards match.
    const host = new URL(raw.replace(/\{s\}\./, "")).host;
    return `https://*.${host}`;
  } catch {
    return null;
  }
}

export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV === "development";

  const policy = [
    `default-src 'self'`,
    // `strict-dynamic` means: trust scripts this nonce loaded, and ignore any host allowlist.
    // Next's dev server needs `eval` for React Refresh; production emphatically does not.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${isDev ? "'unsafe-eval'" : ""}`,
    // `'unsafe-inline'` for styles only, and it is not the same risk as inline script: React
    // renders `style={{…}}` props as style attributes, which this covers, and CSS cannot
    // execute. Removing it would mean hashing every inline style Framer Motion emits.
    `style-src 'self' 'unsafe-inline'`,
    // `blob:` is required, not incidental — the admin document viewer deliberately fetches
    // KYC images and video through an authenticated request and renders them from an object
    // URL rather than pointing an <img> at a signed link.
    `img-src 'self' blob: data:${tileOrigin() ? ` ${tileOrigin()}` : ""}`,
    `media-src 'self' blob:`,
    `font-src 'self' data:`,
    `connect-src 'self' ${connectOrigins().join(" ")}`,
    // Clickjacking. `frame-ancestors` is the directive that actually works — `X-Frame-Options`
    // is the legacy spelling and cannot express 'none' plus exceptions.
    `frame-ancestors 'none'`,
    `frame-src 'none'`,
    `object-src 'none'`,
    // Stops an injected <base> from re-pointing every relative URL on the page.
    `base-uri 'self'`,
    // A form that posts a user's session somewhere else is a whole attack on its own.
    `form-action 'self'`,
    isDev ? "" : "upgrade-insecure-requests",
  ]
    .filter(Boolean)
    .join("; ");

  // Set on the REQUEST as well as the response. Next reads the nonce back out of the request's
  // CSP header to stamp it onto its own bootstrap scripts; without this the policy is applied
  // and then blocks the framework's own script, which looks like a completely broken app.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);

  // Headers that are not CSP but belong with it.
  response.headers.set("X-Content-Type-Options", "nosniff");
  // `strict-origin-when-cross-origin` would still leak the origin; there is nothing on an
  // outbound link that benefits from knowing which page of this app someone came from, and
  // some of those paths contain a user id. Map tiles are the one exception and opt in to
  // `origin` on their own <img> elements (see LiveMap / OriginPicker), because the tile
  // provider refuses requests that carry no Referer.
  response.headers.set("Referrer-Policy", "no-referrer");
  // Nothing here needs a camera or microphone except the onboarding capture, which is
  // same-origin and therefore unaffected by denying them to embedded content.
  response.headers.set(
    "Permissions-Policy",
    "camera=(self), microphone=(self), geolocation=(self), payment=(), usb=()",
  );

  return response;
}

export const config = {
  matcher: [
    /**
     * Everything except Next's own build output and static files.
     *
     * `_next/static` is immutable hashed content and `_next/image` is the image optimiser;
     * neither is a document, so neither needs a policy, and running middleware on them costs
     * a function invocation per asset.
     */
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
