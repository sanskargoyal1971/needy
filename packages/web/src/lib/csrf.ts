import { API_BASE as API } from "./apiConfig";

/** ── CSRF token, client side ───────────────────────────────────────────────
 *  The token is fetched from `GET /auth/csrf` and held in a module variable rather than read
 *  out of the cookie. That is not a stylistic choice: the SPA and the API are different
 *  origins (`:3000` and `:4000` in dev), so `document.cookie` on this page cannot see the
 *  cookie the API set. Reading the value from a response body is the only way this works
 *  cross-origin — and it is exactly what an attacker's page cannot do, because CORS will not
 *  let an origin outside the allowlist read that body.
 *
 *  In memory and never in localStorage. A token in localStorage survives the tab and is
 *  readable by any script that ends up on the page, and there is no reason to keep it that
 *  long — re-fetching costs one request.
 */

let token: string | null = null;
/** Concurrent callers share one in-flight fetch instead of racing to mint several tokens,
 *  each of which would overwrite the last one's cookie and invalidate the others. */
let inFlight: Promise<string> | null = null;

async function fetchToken(): Promise<string> {
  inFlight ??= (async () => {
    try {
      const res = await fetch(`${API}/auth/csrf`, { credentials: "include" });
      if (!res.ok) throw new Error(`csrf-${res.status}`);
      const body = (await res.json()) as { token?: unknown };
      if (typeof body.token !== "string") throw new Error("csrf-malformed");
      token = body.token;
      return token;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Drop the cached token. Called after a logout, since the next session gets a new one. */
export function clearCsrfToken(): void {
  token = null;
}

const MUTATING = /^(POST|PUT|PATCH|DELETE)$/i;

/**
 * `fetch` with credentials and, for mutating requests, a CSRF token.
 *
 * Retries ONCE on a `csrf-invalid` response. That path is not an edge case to be tolerated,
 * it is the ordinary one: the server restarted, the cookie expired, or this tab has been open
 * since before the last deploy. Without the retry every one of those surfaces to the user as
 * a failed action they have to repeat for no reason they could understand.
 *
 * The retry is deliberately bounded to one attempt — if a fresh token is also rejected, the
 * problem is not staleness and looping would turn it into a hammer.
 */
export async function csrfFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  if (!MUTATING.test(method)) {
    return fetch(`${API}${path}`, { ...init, credentials: "include" });
  }

  const send = async (t: string): Promise<Response> =>
    fetch(`${API}${path}`, {
      ...init,
      credentials: "include",
      headers: { ...(init.headers ?? {}), "X-CSRF-Token": t },
    });

  let res = await send(token ?? (await fetchToken()));
  if (res.status === 403) {
    // Read the body to tell a stale token apart from a genuine refusal. Cloned first, because
    // a caller that gets this response back still needs to read it themselves.
    const body = (await res
      .clone()
      .json()
      .catch(() => ({}))) as { error?: unknown };
    if (body.error === "csrf-invalid") {
      token = null;
      res = await send(await fetchToken());
    }
  }
  return res;
}
