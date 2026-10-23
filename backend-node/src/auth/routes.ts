import { Router } from "express";
import { googleEnabled, signupAllowed } from "../config/env";
import { badRequest, conflict, forbidden, unauthorized } from "../http/errors";
import { handler } from "../http/handler";
import { clearCookie, readCookie, setCookie } from "../http/cookies";
import { toCurrentUser } from "../http/serialize";
import { lockVault } from "../vault/session";
import { auth, requireUser } from "./middleware";
import { hashPassword, needsRehash, passwordProblem, verifyPassword } from "./password";
import { currentUser, endAllSessions, endSession, SESSION_COOKIE, startSession } from "./sessions";
import {
  authorizeUrl,
  exchangeCode,
  newState,
  returnTo,
  stateMatches,
  STATE_COOKIE,
  STATE_TTL_MS,
} from "./google";
import {
  countUsers,
  createUser,
  findUserByEmail,
  findUserByGoogleSub,
  linkGoogle,
  normalizeEmail,
  patchUser,
} from "./users";

export const authRoutes = Router();

/**
 * What the sign-in page needs to render itself: whether the Google button should appear, and
 * whether signup is open. Both are environment facts, and asking the server beats shipping
 * them to the client as build-time constants that can drift from the deployment.
 */
authRoutes.get(
  "/config",
  handler(async (_req, res) => {
    res.json({
      google: googleEnabled(),
      signup: signupAllowed() || (await countUsers()) === 0,
      password: true,
    });
  }),
);

/**
 * Create an account.
 *
 * Closed by default. A self-hosted Keepstack is usually one person's, so an open signup
 * endpoint on a URL that is reachable from the internet is a worse default than a flag —
 * except for the very first account, which is allowed through unconditionally. Without that
 * exception a fresh deployment would have no way to create its first user, and the
 * alternative (a bootstrap token in the environment) is a secret to manage for a single use.
 * Once one user exists the exception stops applying, so the window closes on its own.
 */
authRoutes.post(
  "/signup",
  handler(async (req, res) => {
    const email = typeof req.body?.email === "string" ? normalizeEmail(req.body.email) : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!email || !password) throw badRequest("Enter both an email and a password.");
    if (!email.includes("@")) throw badRequest("That doesn't look like an email address.");

    const problem = passwordProblem(password);
    if (problem) throw badRequest(problem);

    const isFirstUser = (await countUsers()) === 0;
    if (!signupAllowed() && !isFirstUser) {
      throw forbidden(
        "Signup is closed on this deployment. Set ALLOW_SIGNUP=true to open it.",
      );
    }

    const user = await createUser({
      email,
      passwordHash: hashPassword(password),
      displayName: typeof req.body?.display_name === "string" ? req.body.display_name.trim() : null,
    });

    await startSession(req, res, user._id);
    res.status(201).json({ user: toCurrentUser(user), first_user: isFirstUser });
  }),
);

authRoutes.post(
  "/login",
  handler(async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!email || !password) throw badRequest("Enter both an email and a password.");

    const user = await findUserByEmail(email);

    /*
     * One message for every failure, and the hash is computed even when the account doesn't
     * exist. Both halves matter: a distinct "no such account" reply turns this endpoint into
     * a way to enumerate who has one, and returning early without hashing makes a missing
     * account answer in a millisecond while a real one takes a hundred — which leaks the same
     * thing through timing instead of through prose.
     */
    const stored = user?.password_hash ?? null;
    const ok = stored
      ? verifyPassword(password, stored)
      : (verifyPassword(password, DECOY_HASH), false);

    if (!user || !ok) throw unauthorized("That email and password don't match an account.");

    // Transparently strengthen an old hash now that the right password is in hand.
    if (needsRehash(stored!)) {
      await patchUser(user._id, { password_hash: hashPassword(password) });
    }

    await startSession(req, res, user._id);
    res.json({ user: toCurrentUser(user) });
  }),
);

/**
 * A hash to verify against when no account matched, so the failing path costs the same as
 * the succeeding one. Generated once at module load from a value nothing can ever match.
 */
const DECOY_HASH = hashPassword(`decoy:${Math.random()}:${Date.now()}`);

authRoutes.get(
  "/me",
  requireUser,
  handler(async (req, res) => {
    res.json({ user: toCurrentUser(auth(req).user) });
  }),
);

/**
 * Sign out.
 *
 * Closes the vault first, for the reason `signOut` in `app/auth/actions.ts` gives: a sealed
 * DEK row and its cookie must not outlive the login session that opened them. Cross-user
 * reuse is already impossible — the row is bound to a user id — but leaving either behind is
 * needless exposure, and vault cleanup never blocks the sign-out.
 */
authRoutes.post(
  "/logout",
  handler(async (req, res) => {
    const user = await currentUser(req);
    if (user) {
      try {
        await lockVault(user._id, req, res);
      } catch {
        // The vault session expires on its own regardless; never block sign-out on it.
      }
    }
    await endSession(req, res);
    res.json({ ok: true });
  }),
);

/** Change a password. Revokes every other session, because a password change should mean that. */
authRoutes.post(
  "/password",
  requireUser,
  handler(async (req, res) => {
    const { user } = auth(req);
    const current = typeof req.body?.current_password === "string" ? req.body.current_password : "";
    const next = typeof req.body?.new_password === "string" ? req.body.new_password : "";

    const problem = passwordProblem(next);
    if (problem) throw badRequest(problem);

    // An account created through Google has no password yet, so there is none to confirm.
    if (user.password_hash) {
      if (!verifyPassword(current, user.password_hash)) {
        throw unauthorized("That isn't your current password.");
      }
    }

    await patchUser(user._id, { password_hash: hashPassword(next) });
    await endAllSessions(user._id);
    await startSession(req, res, user._id);

    res.json({ ok: true, notice: "Password changed. Other sessions were signed out." });
  }),
);

authRoutes.post(
  "/sessions/revoke-all",
  requireUser,
  handler(async (req, res) => {
    const { user } = auth(req);
    const revoked = await endAllSessions(user._id);
    clearCookie(res, SESSION_COOKIE);
    res.json({ ok: true, revoked });
  }),
);

// ─── Google ───────────────────────────────────────────────────────────────────

authRoutes.get(
  "/google",
  handler(async (req, res) => {
    const state = newState();
    // The state lives in a cookie rather than in memory, so the callback can be served by a
    // different instance than the one that started the flow.
    setCookie(res, STATE_COOKIE, `${state}|${req.query.next ?? "/"}`, new Date(Date.now() + STATE_TTL_MS));
    res.redirect(authorizeUrl(state));
  }),
);

authRoutes.get(
  "/google/callback",
  handler(async (req, res) => {
    const cookie = readCookie(req, STATE_COOKIE);
    clearCookie(res, STATE_COOKIE);

    const [expectedState, next] = (cookie ?? "").split("|");
    if (!stateMatches(req.query.state, expectedState || null)) {
      throw badRequest("That sign-in link has expired or didn't start here. Try again.");
    }
    if (typeof req.query.code !== "string") {
      const reason = typeof req.query.error === "string" ? req.query.error : "no code";
      throw badRequest(`Google didn't complete the sign-in (${reason}).`);
    }

    const identity = await exchangeCode(req.query.code);

    /*
     * Matching an existing account on email is only safe because Google told us the address
     * is verified. Without that check, anyone able to set an unverified `email` claim on a
     * Google account could take over the local account at that address — the classic OAuth
     * account-linking hole.
     */
    let user = await findUserByGoogleSub(identity.sub);

    if (!user) {
      const byEmail = await findUserByEmail(identity.email);
      if (byEmail) {
        if (!identity.emailVerified) {
          throw conflict(
            "An account already uses that email, and Google hasn't verified the address on this profile. Sign in with your password instead.",
          );
        }
        await linkGoogle(byEmail._id, identity.sub, {
          displayName: byEmail.display_name ? null : identity.name,
          avatarUrl: byEmail.avatar_url ? null : identity.picture,
        });
        user = byEmail;
      }
    }

    if (!user) {
      const isFirstUser = (await countUsers()) === 0;
      if (!signupAllowed() && !isFirstUser) {
        throw forbidden("Signup is closed on this deployment, and that Google account has no Keepstack user.");
      }
      user = await createUser({
        email: identity.email,
        googleSub: identity.sub,
        displayName: identity.name,
        avatarUrl: identity.picture,
        // No password: this account signs in with Google until it sets one.
        passwordHash: null,
      });
    }

    await startSession(req, res, user._id);
    res.redirect(returnTo(next));
  }),
);
