import { Router } from "express";
import { requireUser, scope } from "../auth/middleware";
import { handler, param } from "../http/handler";
import { badRequest } from "../http/errors";
import { latestUsage, usageHistory } from "../jobs/usage";
import { projectIdsWithStoredKey } from "../vault/secrets";
import {
  createAccount,
  deleteAccount,
  listAccounts,
  slotsUsed,
  updateAccount,
} from "./accounts";
import {
  createProject,
  deleteProject,
  exportRegistry,
  findProject,
  getProjectWithAccount,
  listProjects,
  recentLogs,
  updateProject,
} from "./projects";
import { toAccount } from "../http/serialize";

/**
 * The registry's CRUD surface.
 *
 * `requireUser` is attached to each route individually rather than once with
 * `registryRoutes.use(...)`, and that is a correction rather than a style preference. A
 * router-level guard runs for every request that *enters* the router, including paths it
 * doesn't handle — so mounting this at `/api` made it reject `/api/cron/sweep` and
 * `/api/providers` with "Sign in first." before either could fall through to the router that
 * does serve them. The blanket version turns mount order into a security-relevant detail; the
 * per-route version cannot, because a route either names its guard or it is public on its
 * face.
 *
 * Beyond the guard, every handler passes `scope(req)` into the data layer — which is the only
 * way to call it, since those functions take a `Scope` and a `Scope` can't be conjured from a
 * path parameter. That is the whole of what replaces RLS, and it's why it's worth being
 * slightly tedious: the tedium is the guarantee.
 */
export const registryRoutes = Router();

const body = (req: { body?: unknown }): Record<string, unknown> =>
  req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};

// ─── accounts ─────────────────────────────────────────────────────────────────

registryRoutes.get(
  "/accounts",
  requireUser,
  handler(async (req, res) => {
    const [accounts, projects] = await Promise.all([
      listAccounts(scope(req)),
      listProjects(scope(req)),
    ]);
    res.json({
      accounts: accounts.map(toAccount),
      // Sent alongside, because every caller that lists accounts also wants the free-tier
      // slot counters and would otherwise immediately ask for the projects too.
      slots_used: slotsUsed(projects),
    });
  }),
);

registryRoutes.post(
  "/accounts",
  requireUser,
  handler(async (req, res) => {
    res.status(201).json({ account: await createAccount(scope(req), body(req)) });
  }),
);

registryRoutes.patch(
  "/accounts/:id",
  requireUser,
  handler(async (req, res) => {
    res.json({ account: await updateAccount(scope(req), param(req, "id"), body(req)) });
  }),
);

registryRoutes.delete(
  "/accounts/:id",
  requireUser,
  handler(async (req, res) => {
    await deleteAccount(scope(req), param(req, "id"));
    res.json({ ok: true });
  }),
);

// ─── projects ─────────────────────────────────────────────────────────────────

registryRoutes.get(
  "/projects",
  requireUser,
  handler(async (req, res) => {
    const projects = await listProjects(scope(req));
    const withKeys = await projectIdsWithStoredKey(scope(req), projects);
    // `has_key` rather than the key itself: the dashboard needs to warn about missing
    // credentials without any of them ever crossing this boundary.
    res.json({ projects: projects.map((p) => ({ ...p, has_key: withKeys.has(p.id) })) });
  }),
);

registryRoutes.post(
  "/projects",
  requireUser,
  handler(async (req, res) => {
    res.status(201).json({ project: await createProject(scope(req), body(req)) });
  }),
);

registryRoutes.get(
  "/projects/:id",
  requireUser,
  handler(async (req, res) => {
    res.json({ project: await getProjectWithAccount(scope(req), param(req, "id")) });
  }),
);

registryRoutes.patch(
  "/projects/:id",
  requireUser,
  handler(async (req, res) => {
    res.json({ project: await updateProject(scope(req), param(req, "id"), body(req)) });
  }),
);

registryRoutes.delete(
  "/projects/:id",
  requireUser,
  handler(async (req, res) => {
    await deleteProject(scope(req), param(req, "id"));
    res.json({ ok: true });
  }),
);

registryRoutes.get(
  "/projects/:id/logs",
  requireUser,
  handler(async (req, res) => {
    const limit = Number(req.query.limit ?? 15);
    res.json({ logs: await recentLogs(scope(req), param(req, "id"), limit) });
  }),
);

// ─── usage ────────────────────────────────────────────────────────────────────

registryRoutes.get(
  "/projects/:id/usage",
  requireUser,
  handler(async (req, res) => {
    const id = param(req, "id");
    /*
     * The ownership check is explicit here, and it is about consistency rather than safety.
     * `latestUsage` is scoped, so without it another user's project id returns `{usage: []}` —
     * nothing leaks, but it is the one project route that answers 200 for an id it should not
     * recognise, while `/logs` and the rest answer 404. An API where the same mistake gets two
     * different shapes of reply is an API whose clients grow two code paths.
     */
    await findProject(scope(req), id);
    res.json({ usage: await latestUsage(scope(req), id) });
  }),
);

registryRoutes.get(
  "/projects/:id/usage/:metric",
  requireUser,
  handler(async (req, res) => {
    const days = Number(req.query.days ?? 30);
    if (!Number.isFinite(days) || days < 1 || days > 400) {
      throw badRequest("days must be between 1 and 400.");
    }
    const id = param(req, "id");
    await findProject(scope(req), id);
    res.json({ history: await usageHistory(scope(req), id, param(req, "metric"), days) });
  }),
);

// ─── export ───────────────────────────────────────────────────────────────────

/**
 * The safety net that has to exist before anything risky — the same promise as the Next.js
 * app's `/api/export`, including that secrets are left out so the file is safe on disk.
 */
registryRoutes.get(
  "/export",
  requireUser,
  handler(async (req, res) => {
    const payload = await exportRegistry(scope(req));
    const stamp = new Date().toISOString().slice(0, 10);
    res
      .status(200)
      .setHeader("Content-Type", "application/json")
      .setHeader("Content-Disposition", `attachment; filename="keepstack-export-${stamp}.json"`)
      .setHeader("Cache-Control", "no-store")
      .send(JSON.stringify(payload, null, 2));
  }),
);
