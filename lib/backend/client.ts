import "server-only";
import { cookies, headers } from "next/headers";
import { apiBaseUrl } from "./env";

/**
 * The HTTP client for the Node backend.
 *
 * Next.js acts as a backend-for-frontend here: the browser only ever talks to Next.js, and
 * Next.js talks to `backend-node`. That shape is worth stating because of what it removes.
 * The alternative — letting the browser call the API directly — would need CORS with an
 * explicit origin allowlist, `SameSite=None` cookies, and therefore HTTPS in development.
 * Proxying instead means the API can stay on loopback, unreachable from anywhere else, and
 * the session cookie is a plain same-site cookie on the Next.js origin.
 *
 * Two jobs follow from that:
 *
 *  1. **Forward the browser's cookies on the way out.** `ks_session` and `ks_vault` live in
 *     the browser against the Next.js origin; the API needs them to know who is asking and
 *     whether the vault is open.
 *
 *  2. **Relay `Set-Cookie` on the way back.** When the API opens a session or a vault window
 *     it answers with a cookie for its own host. That has to be re-issued on the Next.js
 *     origin or the browser drops it and the user is signed out again immediately.
 */

/** Cookies this client carries in both directions. Nothing else is forwarded. */
const FORWARDED = ["ks_session", "ks_vault"] as const;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }

  /** The vault is locked, as distinct from "not signed in". Callers branch on this. */
  get isVaultLocked(): boolean {
    return this.code === "vault_locked";
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** Query parameters; undefined and null values are dropped rather than sent as "undefined". */
  query?: Record<string, string | number | boolean | undefined | null>;
  /**
   * Relay any `Set-Cookie` the API returns back to the browser. Only legal from a server
   * action or route handler — a server component can't set cookies, and Next throws if it
   * tries.
   */
  relayCookies?: boolean;
};

async function cookieHeader(): Promise<string> {
  const jar = await cookies();
  const pairs: string[] = [];
  for (const name of FORWARDED) {
    const value = jar.get(name)?.value;
    if (value) pairs.push(`${name}=${encodeURIComponent(value)}`);
  }
  return pairs.join("; ");
}

/**
 * Re-issue the API's cookies on the Next.js origin.
 *
 * Only the names in `FORWARDED` are honoured. A backend that started setting some other
 * cookie shouldn't be able to plant it in the user's browser through this proxy just because
 * it appeared in a response.
 */
async function relay(setCookie: string[]): Promise<void> {
  if (setCookie.length === 0) return;
  const jar = await cookies();

  for (const raw of setCookie) {
    const [pair, ...attributes] = raw.split(";");
    const eq = pair.indexOf("=");
    if (eq === -1) continue;

    const name = pair.slice(0, eq).trim();
    if (!(FORWARDED as readonly string[]).includes(name)) continue;

    let value: string;
    try {
      value = decodeURIComponent(pair.slice(eq + 1).trim());
    } catch {
      value = pair.slice(eq + 1).trim();
    }

    const attrs = new Map(
      attributes.map((a) => {
        const i = a.indexOf("=");
        return i === -1
          ? [a.trim().toLowerCase(), ""]
          : [a.slice(0, i).trim().toLowerCase(), a.slice(i + 1).trim()];
      }),
    );

    // An empty value with Max-Age=0 or a past Expires is the API clearing the cookie — on
    // logout, or on vault lock. Deleting is not the same as setting it to "".
    const maxAge = attrs.get("max-age");
    const clearing = !value || maxAge === "0";

    if (clearing) {
      jar.delete(name);
      continue;
    }

    const expires = attrs.get("expires");
    jar.set(name, value, {
      httpOnly: true,
      // The API's own `Secure` flag reflects *its* deployment, not ours. What matters here is
      // whether the Next.js origin is HTTPS, which is what this process knows.
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      ...(expires ? { expires: new Date(expires) } : {}),
    });
  }
}

export async function apiRequest<T>(pathname: string, options: RequestOptions = {}): Promise<T> {
  const url = new URL(`${apiBaseUrl()}${pathname}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const requestHeaders: Record<string, string> = {
    Accept: "application/json",
    Cookie: await cookieHeader(),
  };
  if (options.body !== undefined) requestHeaders["Content-Type"] = "application/json";

  // Pass the real client's address through, so the API's audit entries record the user's IP
  // rather than this process's. Same reason `trust proxy` is on at the other end.
  try {
    const incoming = await headers();
    const forwardedFor = incoming.get("x-forwarded-for") ?? incoming.get("x-real-ip");
    if (forwardedFor) requestHeaders["X-Forwarded-For"] = forwardedFor;
    const agent = incoming.get("user-agent");
    if (agent) requestHeaders["User-Agent"] = agent;
  } catch {
    // No request context — a background call. Nothing to forward.
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers: requestHeaders,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      // Registry data changes on every write; a cached read would show stale projects.
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    // A connection refused here is the single most likely thing to go wrong in this mode, so
    // the message says what to do rather than surfacing `fetch failed`.
    throw new ApiError(
      503,
      `Couldn't reach the Keepstack API at ${apiBaseUrl()}. Is backend-node running? (${(e as Error).message})`,
      "api_unreachable",
    );
  }

  if (options.relayCookies) {
    await relay(response.headers.getSetCookie());
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiError(
        response.status,
        `The API returned a non-JSON response (${response.status}).`,
        "bad_response",
      );
    }
  }

  if (!response.ok) {
    const error = payload as { error?: string; code?: string } | null;
    throw new ApiError(
      response.status,
      error?.error ?? `The API returned ${response.status}.`,
      error?.code ?? "api_error",
    );
  }

  return payload as T;
}

/** GET, for server components. Cannot relay cookies — see `relayCookies`. */
export const apiGet = <T>(pathname: string, query?: RequestOptions["query"]): Promise<T> =>
  apiRequest<T>(pathname, { method: "GET", query });

/** Mutations, from server actions and route handlers, where cookies may be set. */
export const apiPost = <T>(pathname: string, body?: unknown): Promise<T> =>
  apiRequest<T>(pathname, { method: "POST", body, relayCookies: true });

export const apiPatch = <T>(pathname: string, body?: unknown): Promise<T> =>
  apiRequest<T>(pathname, { method: "PATCH", body, relayCookies: true });

export const apiDelete = <T>(pathname: string, body?: unknown): Promise<T> =>
  apiRequest<T>(pathname, { method: "DELETE", body, relayCookies: true });
