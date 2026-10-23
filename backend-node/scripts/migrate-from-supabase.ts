/**
 * Copy an existing Supabase registry into MongoDB.
 *
 *   pnpm migrate -- --dry-run     # report what would move, write nothing
 *   pnpm migrate                  # do it
 *
 * Needs the Supabase project's URL and **service role** key (it has to read `auth.users` and
 * every row regardless of RLS), plus this backend's `MONGODB_URI`. Re-runnable: every write
 * is an upsert keyed on the original primary key, so a second run corrects a partial first
 * one instead of duplicating it.
 *
 * ── The one thing that must not be got wrong ──────────────────────────────────────────────
 *
 * Primary keys are carried across verbatim. Not for tidiness: `lib/crypto/secrets.ts` seals
 * every secret with AAD of `("keepstack/secret/v1", userId, kind, tier)`, and
 * `lib/crypto/dek.ts` binds both wrapped copies of a user's DEK to their id the same way. The
 * AAD is authenticated, so a ciphertext decrypts under one user id and under no other. Mint a
 * new id for a user here and every credential they own becomes undecryptable noise, their
 * vault PIN stops working, and the recovery copy of their key stops working too — silently,
 * and with no way back. So `_id` is the Postgres `id`, everywhere, and the vault keeps
 * working across the move without re-encrypting anything.
 *
 * Deliberately *not* migrated: `vault_sessions` and `otp_challenges`. Both are ephemeral by
 * design — a ten-minute sudo window and a ten-minute email code. Carrying them over would
 * move live credentials for no benefit; sign in again instead.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { closeMongo, connectMongo } from "../src/db/client";
import { ensureIndexes } from "../src/db/indexes";
import {
  accounts,
  auditLog,
  pingLogs,
  projects,
  secrets,
  usageSnapshots,
  users,
} from "../src/db/collections";
import { newId } from "../src/db/ids";
import { vaultConfigured } from "../src/crypto/env";
import { sealServerSecret } from "../src/crypto/secrets";
import type { Lifecycle, ProviderId, Strategy } from "../src/providers/types";

const DRY_RUN = process.argv.includes("--dry-run");

type Row = Record<string, any>;

const date = (v: unknown): Date | null => (v ? new Date(v as string) : null);
const dateOr = (v: unknown, fallback = new Date()): Date => date(v) ?? fallback;
const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

function env(name: string, ...alternatives: string[]): string {
  for (const key of [name, ...alternatives]) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  throw new Error(
    `${name} is not set. The migration reads from Supabase, so it needs that project's URL and service-role key — put them in backend-node/.env or pass them inline.`,
  );
}

/**
 * Read a whole table.
 *
 * PostgREST caps a response at 1000 rows by default, and it does so *silently* — a registry
 * with 1200 ping logs would migrate 1000 of them and report success. Hence the explicit
 * paging rather than a single select.
 */
async function fetchAll(db: SupabaseClient, table: string): Promise<Row[] | null> {
  const PAGE = 1000;
  const out: Row[] = [];

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from(table).select("*").range(from, from + PAGE - 1);

    if (error) {
      // 42P01 / PGRST205: the table doesn't exist, i.e. that migration was never run on this
      // registry. Not a failure — an older registry simply has less to move.
      if (error.code === "42P01" || error.code === "PGRST205") return null;
      throw new Error(`Reading ${table} failed: ${error.message}`);
    }
    if (!data?.length) break;

    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

type Counts = Record<string, number>;
const counts: Counts = {};
const bump = (key: string, n = 1) => {
  counts[key] = (counts[key] ?? 0) + n;
};

async function main(): Promise<void> {
  const supabaseUrl = env("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  await connectMongo();
  if (!DRY_RUN) await ensureIndexes();

  console.log(`\nMigrating ${supabaseUrl} -> MongoDB${DRY_RUN ? "  (dry run)" : ""}\n`);

  // ── users ───────────────────────────────────────────────────────────────────
  //
  // Two sources, because Supabase split them: `auth.users` holds the email and is reachable
  // only through the Admin API, `public.profiles` holds the vault columns. They merge into one
  // document here — the `handle_new_user` trigger that kept them in step has nothing to do.
  const authUsers: Row[] = [];
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`Listing auth users failed: ${error.message}`);
    if (!data.users.length) break;
    authUsers.push(...(data.users as unknown as Row[]));
    if (data.users.length < 200) break;
  }

  const profiles = (await fetchAll(supabase, "profiles")) ?? [];
  const profileById = new Map(profiles.map((p) => [p.id as string, p]));

  for (const u of authUsers) {
    const profile = profileById.get(u.id as string) ?? {};
    const meta = (u.user_metadata ?? {}) as Row;

    bump("users");
    if (DRY_RUN) continue;

    await users().updateOne(
      { _id: u.id as string },
      {
        $set: {
          email: String(u.email ?? "").toLowerCase(),
          display_name:
            text(profile.display_name) ?? text(meta.full_name) ?? text(meta.name) ?? null,
          avatar_url: text(profile.avatar_url) ?? text(meta.avatar_url),
          // The wrapped DEKs move as-is. They are base64 envelopes bound to this same user
          // id, so they keep opening with the same PIN and the same master key.
          vault_initialized_at: date(profile.vault_initialized_at),
          pin_salt: text(profile.pin_salt),
          dek_pin: text(profile.dek_pin),
          dek_srv: text(profile.dek_srv),
          pin_failed_attempts: Number(profile.pin_failed_attempts ?? 0),
          pin_locked_until: date(profile.pin_locked_until),
          updated_at: new Date(),
        },
        $setOnInsert: {
          // Supabase Auth stores a bcrypt hash this backend can't read, and shouldn't try to.
          // The account signs in with Google, or gets a password from `pnpm set-password`.
          password_hash: null,
          google_sub: null,
          created_at: dateOr(u.created_at),
        },
      },
      { upsert: true },
    );
  }

  // ── accounts ────────────────────────────────────────────────────────────────
  const accountRows = (await fetchAll(supabase, "accounts")) ?? [];
  for (const a of accountRows) {
    if (!a.user_id) {
      // Pre-0004 rows with no owner. There is no "claim" flow here to adopt them later, and
      // guessing an owner would file someone's credentials under the wrong account.
      bump("accounts skipped (no owner)");
      continue;
    }
    bump("accounts");
    if (DRY_RUN) continue;

    await accounts().updateOne(
      { _id: a.id as string },
      {
        $set: {
          user_id: a.user_id as string,
          provider: (a.provider ?? "supabase") as ProviderId,
          email: String(a.email ?? ""),
          label: text(a.label),
          login_method: text(a.login_method),
          notes: text(a.notes),
          last_synced_at: date(a.last_synced_at),
          last_sync_status: text(a.last_sync_status),
          last_sync_error: text(a.last_sync_error),
        },
        $setOnInsert: { created_at: dateOr(a.created_at) },
      },
      { upsert: true },
    );
  }

  // ── projects ────────────────────────────────────────────────────────────────
  const projectRows = (await fetchAll(supabase, "projects")) ?? [];
  const projectOwner = new Map<string, string>();

  for (const p of projectRows) {
    if (!p.user_id) {
      bump("projects skipped (no owner)");
      continue;
    }
    projectOwner.set(p.id as string, p.user_id as string);

    // Normalising reads exactly as `normalizeProject` does, so a registry that never ran
    // 0002 or 0006 still migrates: `external_id` falls back to the old `ref`, and
    // `ping_table` falls back to the column 0006 dropped.
    const metadata = (p.metadata ?? {}) as Row;
    if (p.ping_table && metadata.ping_table === undefined) metadata.ping_table = p.ping_table;

    bump("projects");
    if (DRY_RUN) continue;

    await projects().updateOne(
      { _id: p.id as string },
      {
        $set: {
          user_id: p.user_id as string,
          account_id: text(p.account_id),
          provider: (p.provider ?? "supabase") as ProviderId,
          external_id: String(p.external_id ?? p.ref ?? ""),
          name: String(p.name ?? p.external_id ?? p.ref ?? "Untitled"),
          region: text(p.region),
          plan: text(p.plan),
          provider_status: text(p.provider_status),
          lifecycle: (p.lifecycle ?? "unknown") as Lifecycle,
          strategy: (p.strategy ?? "ping") as Strategy,
          keep_alive: p.keep_alive !== false,
          interval_days: Math.min(60, Math.max(1, Number(p.interval_days ?? 5))),
          repo_url: text(p.repo_url),
          local_path: text(p.local_path),
          notes: text(p.notes),
          metadata,
          last_pinged_at: date(p.last_pinged_at),
          last_status: (text(p.last_status) as "ok" | "error" | null) ?? null,
          last_error: text(p.last_error),
          discovered_at: date(p.discovered_at),
        },
        $setOnInsert: { created_at: dateOr(p.created_at) },
      },
      { upsert: true },
    );
  }

  // ── secrets ─────────────────────────────────────────────────────────────────
  //
  // Ciphertext moves byte for byte. No decrypt, no re-encrypt — which is only possible
  // because the user ids in the AAD are unchanged. See the note at the top of this file.
  const secretRows = (await fetchAll(supabase, "secrets")) ?? [];
  for (const s of secretRows) {
    if (!s.user_id || !s.ciphertext) {
      bump("secrets skipped (incomplete)");
      continue;
    }
    bump("secrets");
    if (DRY_RUN) continue;

    await secrets().updateOne(
      { _id: s.id as string },
      {
        $set: {
          user_id: s.user_id as string,
          account_id: text(s.account_id),
          project_id: text(s.project_id),
          kind: String(s.kind),
          label: text(s.label),
          tier: s.tier === "server" ? "server" : "personal",
          ciphertext: String(s.ciphertext),
          key_version: Number(s.key_version ?? 1),
          last_used_at: date(s.last_used_at),
          last_verified_at: date(s.last_verified_at),
          updated_at: dateOr(s.updated_at),
        },
        $setOnInsert: { created_at: dateOr(s.created_at) },
      },
      { upsert: true },
    );
  }

  // ── plaintext anon keys, if any are left ────────────────────────────────────
  //
  // A registry that hasn't finished the 0005 → 0006 sequence still has keys sitting in
  // `projects.anon_key` in clear. `lib/vault/migrate-keys.ts` would have moved them; doing it
  // here too means the migration doesn't quietly drop them. Same order as that file for the
  // same reason: write the encrypted copy first, and only then is the plaintext redundant.
  const plaintext = projectRows.filter((p) => p.anon_key && p.user_id);
  if (plaintext.length && !vaultConfigured()) {
    console.warn(
      `\n  ! ${plaintext.length} project(s) still hold a plaintext anon_key, but KEEPSTACK_MASTER_KEY is not set here,\n    so they cannot be encrypted. Set it and re-run, or those keys will not be migrated.\n`,
    );
  }
  for (const p of plaintext) {
    if (!vaultConfigured()) break;
    bump("plaintext anon keys encrypted");
    if (DRY_RUN) continue;

    await secrets().updateOne(
      { user_id: p.user_id as string, project_id: p.id as string, kind: "anon_key" },
      {
        $set: {
          ciphertext: sealServerSecret(String(p.anon_key), p.user_id as string, "anon_key"),
          tier: "server",
          updated_at: new Date(),
        },
        $setOnInsert: {
          _id: newId(),
          user_id: p.user_id as string,
          account_id: null,
          project_id: p.id as string,
          kind: "anon_key",
          label: "Encrypted during the MongoDB migration",
          key_version: 1,
          last_used_at: null,
          last_verified_at: null,
          created_at: new Date(),
        },
      },
      { upsert: true },
    );
  }

  // ── ping logs ───────────────────────────────────────────────────────────────
  //
  // `user_id` is derived from the parent project, because the SQL table didn't have one: its
  // RLS policy joined through `projects`. Without a policy engine the owner has to be on the
  // document — see src/db/documents.ts, rule 3.
  const logRows = (await fetchAll(supabase, "ping_logs")) ?? [];
  for (const l of logRows) {
    const owner = projectOwner.get(l.project_id as string);
    if (!owner) {
      bump("ping logs skipped (orphan)");
      continue;
    }
    bump("ping logs");
    if (DRY_RUN) continue;

    await pingLogs().updateOne(
      { legacy_id: Number(l.id) },
      {
        $set: {
          project_id: l.project_id as string,
          user_id: owner,
          status: String(l.status ?? "unknown"),
          strategy: (l.strategy ?? "ping") as Strategy,
          via: text(l.via),
          http_status: l.http_status === null ? null : Number(l.http_status),
          duration_ms: l.duration_ms === null ? null : Number(l.duration_ms),
          error: text(l.error),
          created_at: dateOr(l.created_at),
        },
        $setOnInsert: { _id: newId(), legacy_id: Number(l.id) },
      },
      { upsert: true },
    );
  }

  // ── usage snapshots ─────────────────────────────────────────────────────────
  const usageRows = (await fetchAll(supabase, "usage_snapshots")) ?? [];
  for (const u of usageRows) {
    const owner = projectOwner.get(u.project_id as string);
    if (!owner) {
      bump("usage snapshots skipped (orphan)");
      continue;
    }
    const capturedAt = dateOr(u.captured_at);
    bump("usage snapshots");
    if (DRY_RUN) continue;

    await usageSnapshots().updateOne(
      // Keyed on the daily uniqueness tuple, not the legacy id, so the unique index can't be
      // violated by a registry that somehow holds two readings for one metric and day.
      {
        project_id: u.project_id as string,
        metric: String(u.metric),
        captured_on: String(u.captured_on ?? capturedAt.toISOString().slice(0, 10)),
      },
      {
        $set: {
          user_id: owner,
          value: Number(u.value ?? 0),
          limit_value: u.limit_value === null ? null : Number(u.limit_value),
          unit: String(u.unit ?? ""),
          period_start: date(u.period_start),
          period_end: date(u.period_end),
          captured_at: capturedAt,
          legacy_id: Number(u.id),
        },
        $setOnInsert: { _id: newId() },
      },
      { upsert: true },
    );
  }

  // ── audit log ───────────────────────────────────────────────────────────────
  const auditRows = (await fetchAll(supabase, "audit_log")) ?? [];
  for (const a of auditRows) {
    if (!a.user_id) continue;
    bump("audit entries");
    if (DRY_RUN) continue;

    await auditLog().updateOne(
      { legacy_id: Number(a.id) },
      {
        $set: {
          user_id: a.user_id as string,
          action: String(a.action),
          target_type: text(a.target_type),
          target_id: text(a.target_id),
          method: text(a.method),
          ip: text(a.ip),
          user_agent: text(a.user_agent),
          detail: (a.detail ?? {}) as Record<string, unknown>,
          created_at: dateOr(a.created_at),
        },
        $setOnInsert: { _id: newId(), legacy_id: Number(a.id) },
      },
      { upsert: true },
    );
  }

  // ── report ──────────────────────────────────────────────────────────────────
  const width = Math.max(...Object.keys(counts).map((k) => k.length), 10);
  console.log(DRY_RUN ? "Would migrate:" : "Migrated:");
  for (const [key, n] of Object.entries(counts)) {
    console.log(`  ${key.padEnd(width)}  ${n}`);
  }
  if (Object.keys(counts).length === 0) console.log("  (nothing found)");

  if (!DRY_RUN) {
    const withoutPassword = await users().countDocuments({ password_hash: null, google_sub: null });
    console.log("\nDone.");
    if (withoutPassword > 0) {
      console.log(
        `\n  ${withoutPassword} migrated account(s) have no password: Supabase stored a bcrypt hash this\n  backend can't read, and shouldn't try to. Give yourself one with:\n\n    pnpm set-password -- you@example.com\n\n  Or configure GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET and sign in with Google — the account\n  is matched on your verified email address.`,
      );
    }
    console.log(
      "\n  Your vault PIN is unchanged, and every stored credential still decrypts: the user ids\n  the ciphertexts are bound to came across untouched. KEEPSTACK_MASTER_KEY and\n  KEEPSTACK_PIN_PEPPER must be the same values this registry was using.\n",
    );
  }

  await closeMongo();
}

main().catch(async (e) => {
  console.error(`\nMigration failed: ${(e as Error).message}\n`);
  await closeMongo().catch(() => {});
  process.exit(1);
});
