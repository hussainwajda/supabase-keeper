import type { Filter } from "mongodb";

/**
 * The replacement for row level security.
 *
 * This is the single most important difference between this backend and the Supabase one, so
 * it's worth being precise about what was lost. In Postgres, `lib/registry/queries.ts`
 * deliberately contains no `.eq("user_id", …)` anywhere — the comment at the top of that file
 * says why: "RLS in Postgres is what scopes the data — not a `.eq("user_id", …)` we might
 * forget." The database refused to return another user's row even if the query asked for it.
 *
 * MongoDB has no equivalent. There is no per-document policy engine, and the credentials this
 * backend connects with can read every document in the database. So the guarantee has to move
 * into the application, and the only question is whether it moves somewhere disciplined or
 * gets sprinkled across three hundred call sites — where forgetting it once is a cross-tenant
 * data leak that no test is likely to catch.
 *
 * The discipline here is a nominal type. `Scope` cannot be constructed from a bare string, so
 * a query helper that takes a `Scope` cannot be called without one, and the only way to get
 * one is `scopeFor(userId)` — which the HTTP layer calls in exactly one place, after
 * authenticating the request (`src/auth/middleware.ts`). An unscoped read is therefore a type
 * error rather than a judgement call.
 */
declare const scopeBrand: unique symbol;

export type Scope = {
  readonly userId: string;
  readonly [scopeBrand]: true;
};

/**
 * Mint a scope. Called by the auth middleware once per request, and by the few places that
 * legitimately act for a user without a request behind them: the sweep (which loops over
 * every user, as the Postgres cron did under the service role) and the migration script.
 */
export function scopeFor(userId: string): Scope {
  if (!userId) throw new Error("A scope needs a user id.");
  return { userId } as Scope;
}

/**
 * Add the owner to a filter.
 *
 * Deliberately overwrites any `user_id` already in the filter rather than merging it: a
 * caller passing their own `user_id` is either redundant or an attempt to read someone
 * else's rows, and neither should win over the authenticated scope.
 */
export function owned<T extends { user_id: string }>(
  scope: Scope,
  filter: Filter<T> = {},
): Filter<T> {
  return { ...filter, user_id: scope.userId } as Filter<T>;
}

/** The owner stamp for an insert, so a new document can't be created unowned. */
export function ownedBy(scope: Scope): { user_id: string } {
  return { user_id: scope.userId };
}
