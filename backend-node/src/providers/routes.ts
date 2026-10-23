import { Router } from "express";
import { auth, requireUser, scope } from "../auth/middleware";
import { projects, secrets } from "../db/collections";
import { owned } from "../db/scope";
import { badRequest, notFound, notImplemented, vaultLocked } from "../http/errors";
import { handler, param, requestOrigin } from "../http/handler";
import { openPersonalSecret, openServerSecret } from "../crypto/secrets";
import { captureUsage } from "../jobs/usage";
import { pingProject, pingProjects, toProjectRef, checkStatus } from "../jobs/ping";
import { findProject, recordSyncFailureFor } from "./support";
import { audit } from "../vault/audit";
import { currentDek } from "../vault/session";
import { putSecret } from "../vault/secrets";
import { resolveServerCredentials } from "../vault/resolve";
import { providerOptions } from "./options";
import { getProvider, parseIdentifier } from "./registry";
import { applySync, planSync } from "./sync";
import { asProviderId } from "../db/validate";

/**
 * Provider-facing actions — everything that talks to Supabase, Neon, Atlas or Upstash on the
 * user's behalf. The counterpart of `app/providers/actions.ts`.
 */
export const providerRoutes = Router();

/**
 * Provider metadata, with the validator callbacks stripped.
 *
 * Public on purpose: it's the same information docs/PROVIDERS.md publishes, and a sign-in
 * page that wants to say what Keepstack supports shouldn't need a session to find out. It
 * carries no user data at all.
 */
providerRoutes.get(
  "/providers",
  handler(async (_req, res) => {
    res.json({ providers: providerOptions() });
  }),
);

/**
 * Paste-anything parsing.
 *
 * Stays on the server for the same reason it was a server action: `parse()` lives inside the
 * adapters, and the rule is that nothing outside `src/providers/` branches on which provider
 * it's holding. Shipping the regexes to the browser would quietly break that.
 */
providerRoutes.post(
  "/parse",
  requireUser,
  handler(async (req, res) => {
    const input = typeof req.body?.input === "string" ? req.body.input : "";
    res.json({ parsed: parseIdentifier(input) });
  }),
);

// ─── sync ─────────────────────────────────────────────────────────────────────

/** Preview a sync. Reads only — nothing is written until the plan is confirmed. */
providerRoutes.post(
  "/accounts/:id/sync/preview",
  requireUser,
  handler(async (req, res) => {
    const provider = asProviderId(req.body?.provider);
    try {
      res.json({ plan: await planSync(scope(req), param(req, "id"), provider) });
    } catch (e) {
      await recordSyncFailureFor(scope(req), param(req, "id"), (e as Error).message);
      throw e;
    }
  }),
);

providerRoutes.post(
  "/accounts/:id/sync/apply",
  requireUser,
  handler(async (req, res) => {
    const provider = asProviderId(req.body?.provider);
    try {
      const result = await applySync(
        scope(req),
        param(req, "id"),
        provider,
        {
          adoptReassigned: req.body?.adopt === true,
          fetchCredentials: req.body?.fetch_keys === true,
        },
        requestOrigin(req),
      );

      const parts = [
        result.created && `imported ${result.created}`,
        result.updated && `updated ${result.updated}`,
        result.reassigned && `moved ${result.reassigned}`,
        result.keysFetched &&
          `fetched ${result.keysFetched} key${result.keysFetched === 1 ? "" : "s"}`,
      ].filter(Boolean);

      res.json({
        result,
        notice: parts.length
          ? `Synced: ${parts.join(", ")}.`
          : "Already in step — nothing to change.",
      });
    } catch (e) {
      await recordSyncFailureFor(scope(req), param(req, "id"), (e as Error).message);
      throw e;
    }
  }),
);

// ─── per-project actions ──────────────────────────────────────────────────────

providerRoutes.post(
  "/projects/:id/ping",
  requireUser,
  handler(async (req, res) => {
    const project = await findProject(scope(req), param(req, "id"));
    const adapter = getProvider(project.provider);
    // Route by strategy rather than always pinging, so an `alert_only` provider records a
    // status check instead of a keep-alive it never performed.
    const result =
      adapter.policy.strategy === "alert_only"
        ? await checkStatus(project)
        : adapter.policy.strategy === "watch"
          ? { ...(await captureUsage(project)), strategy: "watch" as const }
          : await pingProject(project);
    res.json({ result });
  }),
);

/** "Ping all now" — narrowed to the caller, so it can never reach another user's projects. */
providerRoutes.post(
  "/ping-all",
  requireUser,
  handler(async (req, res) => {
    const results = await pingProjects({ force: true, userId: auth(req).user._id });
    res.json({ processed: results.length, results });
  }),
);

/** Re-read one project's status from the provider. */
providerRoutes.post(
  "/projects/:id/status",
  requireUser,
  handler(async (req, res) => {
    const project = await findProject(scope(req), param(req, "id"));
    const adapter = getProvider(project.provider);
    if (!adapter.status) {
      throw notImplemented(`${adapter.name} reports no status Keepstack can read.`);
    }

    const credentials = await resolveServerCredentials(scope(req), {
      accountId: project.account_id,
      projectId: project._id,
    });

    try {
      const { lifecycle, raw } = await adapter.status(toProjectRef(project), credentials);
      await projects().updateOne(
        { ...owned(scope(req)), _id: project._id },
        { $set: { lifecycle, provider_status: raw } },
      );
      res.json({ lifecycle, provider_status: raw });
    } catch (e) {
      // A status read failing isn't worth an error state; the next sweep retries.
      res.json({ lifecycle: project.lifecycle, provider_status: project.provider_status, stale: true, error: (e as Error).message });
    }
  }),
);

/** Read a `watch` provider's usage on demand. */
providerRoutes.post(
  "/projects/:id/usage",
  requireUser,
  handler(async (req, res) => {
    const project = await findProject(scope(req), param(req, "id"));
    res.json({ result: await captureUsage(project) });
  }),
);

/** Un-pause a project through the provider's API. */
providerRoutes.post(
  "/projects/:id/restore",
  requireUser,
  handler(async (req, res) => {
    const project = await findProject(scope(req), param(req, "id"));
    const adapter = getProvider(project.provider);
    if (!adapter.revive) {
      throw notImplemented(`${adapter.name} can't be restored from Keepstack — open its console.`);
    }

    const credentials = await resolveServerCredentials(scope(req), {
      accountId: project.account_id,
      projectId: project._id,
    });
    await adapter.revive(toProjectRef(project), credentials);

    // Restoring is asynchronous at the provider; reflect the in-between state rather than
    // claiming it is already back.
    await projects().updateOne(
      { ...owned(scope(req)), _id: project._id },
      { $set: { lifecycle: "idle", provider_status: "RESTORING", last_error: null } },
    );

    await audit(
      auth(req).user._id,
      {
        action: "secret.migrated",
        targetType: "project",
        targetId: project._id,
        detail: { event: "project.restore_requested", provider: project.provider },
      },
      requestOrigin(req),
    );

    res.json({
      ok: true,
      notice: `Restore requested. ${adapter.name} takes a few minutes; re-read the status to see it change.`,
    });
  }),
);

/** Per-service health, fetched on demand. Not stored — it's a point-in-time reading. */
providerRoutes.get(
  "/projects/:id/health",
  requireUser,
  handler(async (req, res) => {
    const project = await findProject(scope(req), param(req, "id"));
    const adapter = getProvider(project.provider);
    if (!adapter.health) {
      res.json({ health: [] });
      return;
    }

    const credentials = await resolveServerCredentials(scope(req), {
      accountId: project.account_id,
      projectId: project._id,
    });

    try {
      res.json({ health: await adapter.health(toProjectRef(project), credentials) });
    } catch (e) {
      res.json({ health: [], error: (e as Error).message });
    }
  }),
);

/**
 * Pull the provider's own copy of a project's credentials (Supabase anon keys, Upstash REST
 * tokens) so the user doesn't paste them by hand.
 */
providerRoutes.post(
  "/projects/:id/keys",
  requireUser,
  handler(async (req, res) => {
    const project = await findProject(scope(req), param(req, "id"));
    const adapter = getProvider(project.provider);
    if (!adapter.fetchProjectCredentials) {
      throw notImplemented(`${adapter.name} doesn't expose its keys over an API.`);
    }

    const credentials = await resolveServerCredentials(scope(req), {
      accountId: project.account_id,
      projectId: project._id,
    });

    // Which account credential this needs is the adapter's business, not this route's:
    // Supabase wants a PAT, Upstash an email *and* an API key.
    const missing = adapter.accountFields
      .filter((f) => f.tier === "server" && !credentials[f.key])
      .map((f) => f.label.toLowerCase());
    if (missing.length > 0) {
      throw badRequest(
        `Add this account's ${missing.join(" and ")} first — that's what Keepstack asks ${adapter.name} with.`,
      );
    }

    const fetched = await adapter.fetchProjectCredentials(toProjectRef(project), credentials);
    const kinds = Object.keys(fetched);
    if (kinds.length === 0) {
      throw badRequest("The provider returned no usable keys for this project.");
    }

    for (const [kind, value] of Object.entries(fetched)) {
      await putSecret({
        scope: scope(req),
        owner: { projectId: project._id },
        kind,
        tier: "server",
        value,
        label: "Fetched from the provider",
        origin: requestOrigin(req),
      });
    }

    res.json({ stored: kinds, notice: `Stored ${kinds.join(", ")}, encrypted.` });
  }),
);

/**
 * Assemble `DATABASE_URL` / `DIRECT_URL` from the stored database password.
 *
 * The password is `personal` tier, so this needs an unlocked vault — and the assembled
 * strings contain it in clear, which is why they are returned to the caller and never stored.
 */
providerRoutes.post(
  "/projects/:id/connection-strings",
  requireUser,
  handler(async (req, res) => {
    const { user } = auth(req);
    const project = await findProject(scope(req), param(req, "id"));
    const adapter = getProvider(project.provider);
    if (!adapter.connectionStrings) {
      throw notImplemented(`${adapter.name} has no connection strings.`);
    }

    const dek = await currentDek(user._id, req);
    if (!dek) throw vaultLocked("Unlock your vault first.");

    const doc = await secrets().findOne({
      ...owned(scope(req)),
      project_id: project._id,
      kind: "db_password",
    });
    if (!doc) {
      throw notFound("No database password saved for this project. Add one under Credentials.");
    }

    const password =
      doc.tier === "personal"
        ? openPersonalSecret(doc.ciphertext, dek, user._id, "db_password")
        : openServerSecret(doc.ciphertext, user._id, "db_password");
    if (!password) throw badRequest("That password couldn't be decrypted.");

    const strings = adapter.connectionStrings(toProjectRef(project), { db_password: password });

    await audit(
      user._id,
      {
        action: "secret.reveal",
        targetType: "project",
        targetId: project._id,
        detail: { kind: "db_password", purpose: "connection_strings" },
      },
      requestOrigin(req),
    );

    res.json(strings);
  }),
);
