import type { UserDoc } from "../db/documents";
import type { Scope } from "../db/scope";

/**
 * What `requireUser` attaches to a request.
 *
 * The `scope` is here rather than a bare user id so a route handler physically cannot call a
 * query helper without it — see the note in `src/db/scope.ts` on why ownership is a type and
 * not a convention.
 */
declare global {
  namespace Express {
    interface Request {
      auth?: { user: UserDoc; scope: Scope };
    }
  }
}
