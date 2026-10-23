import { randomBytes, timingSafeEqual } from "node:crypto";
import { appUrl, googleOauth, googleRedirectUri } from "../config/env";
import { badRequest, notImplemented } from "../http/errors";

/**
 * Google sign-in, by hand.
 *
 * `signInWithGoogle` in the Next.js app is six lines because Supabase Auth owns the whole
 * exchange. Owning it here is the authorization-code flow and nothing more exotic: send the
 * user to Google with a state parameter, take the code back, trade it for tokens on a
 * server-to-server call, read the identity out of the `id_token`.
 *
 * Optional throughout. With no `GOOGLE_CLIENT_ID` the route is disabled and says so, which
 * matters because the thing that makes this backend demonstrable is that email and password
 * work with nothing configured but a MongoDB URI.
 */
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export const STATE_COOKIE = "ks_oauth_state";
/** The round trip is a person clicking a consent screen; ten minutes is generous. */
export const STATE_TTL_MS = 10 * 60 * 1000;

export const newState = (): string => randomBytes(24).toString("base64url");

/**
 * Compare the state from the callback against the one in the cookie.
 *
 * This is the CSRF control for the flow: without it, an attacker can complete a sign-in they
 * started and have the victim's browser land on a session that isn't theirs. Constant-time,
 * because there is no reason not to be.
 */
export function stateMatches(fromQuery: unknown, fromCookie: string | null): boolean {
  if (typeof fromQuery !== "string" || !fromCookie) return false;
  const a = Buffer.from(fromQuery, "utf8");
  const b = Buffer.from(fromCookie, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authorizeUrl(state: string): string {
  const config = googleOauth();
  if (!config) {
    throw notImplemented(
      "Google sign-in isn't configured on this deployment. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or sign in with an email and password.",
    );
  }

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: "openid email profile",
    state,
    // Ask every time rather than silently reusing a prior grant, so switching accounts works.
    prompt: "select_account",
  });

  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export type GoogleIdentity = {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
};

/** Exchange the authorization code for tokens, then read the identity out of the id_token. */
export async function exchangeCode(code: string): Promise<GoogleIdentity> {
  const config = googleOauth();
  if (!config) throw notImplemented("Google sign-in isn't configured on this deployment.");

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: googleRedirectUri(),
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    // Google echoes the request in its errors, and the request contains the client secret.
    // Status and a short reason only.
    const reason = (await res.text()).slice(0, 200);
    throw badRequest(`Google rejected the sign-in (${res.status}). ${reason}`);
  }

  const payload = (await res.json()) as { id_token?: string };
  if (!payload.id_token) throw badRequest("Google returned no id_token.");

  return readIdToken(payload.id_token);
}

/**
 * Read the claims out of an `id_token`.
 *
 * The signature is deliberately not verified, and that is correct here rather than a shortcut:
 * this token did not arrive from the browser. It came back on our own HTTPS POST to Google's
 * token endpoint, authenticated with our client secret, so TLS plus the fact that we made the
 * request is what establishes provenance. Google's own documentation says validation may be
 * skipped for tokens obtained directly from the token endpoint. A token handed to us by a
 * client would be a completely different situation and would need full JWKS verification.
 */
export function readIdToken(idToken: string): GoogleIdentity {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw badRequest("Google returned a malformed id_token.");

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw badRequest("Google returned an unreadable id_token.");
  }

  const sub = typeof claims.sub === "string" ? claims.sub : null;
  const email = typeof claims.email === "string" ? claims.email : null;
  if (!sub || !email) {
    throw badRequest("Google's response carried no account id or email address.");
  }

  return {
    sub,
    email,
    // Google sends this as a boolean or the string "true" depending on the endpoint.
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
    name: typeof claims.name === "string" ? claims.name : null,
    picture: typeof claims.picture === "string" ? claims.picture : null,
  };
}

/** Where to send the browser once a session exists. Kept on-site, so an open redirect isn't possible. */
export function returnTo(next: unknown): string {
  const base = appUrl();
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//")) return base;
  return `${base}${next}`;
}
