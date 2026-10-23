/**
 * Re-exports that keep `src/providers/routes.ts` from importing the registry directly.
 *
 * Not ceremony: the architecture rule is that provider code doesn't reach into the registry
 * (docs/ARCHITECTURE.md §1 — "adapters never touch the registry DB"). The routes aren't
 * adapters, so they legitimately need both, and naming the two functions they borrow keeps
 * that boundary visible rather than letting the import list blur it.
 */
export { findProject } from "../registry/projects";
export { recordSyncFailure as recordSyncFailureFor } from "../registry/accounts";
