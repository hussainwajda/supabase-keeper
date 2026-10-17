# Contributing to Keepstack

Thanks for looking. The most useful contribution is usually **a new provider adapter** — the
architecture exists specifically to make that a small, self-contained change.

## Getting set up

```bash
pnpm install
cp .env.example .env.local   # fill in the three NEXT_PUBLIC_SUPABASE_* / SUPABASE_SERVICE_ROLE_KEY values
pnpm dev
```

You need a Supabase project to act as the registry. Run `supabase/migrations/*.sql` in its SQL
editor in order.

Before opening a PR:

```bash
pnpm typecheck
pnpm test        # crypto unit tests — fast, no database needed
pnpm build
```

## Adding a provider

Three files, in this order:

1. **`docs/PROVIDERS.md`** — research first, code second. Document how a project is identified,
   how it dies on the free tier, what management API exists and how it authenticates, and what
   credentials matter. **Link a source for every policy claim.** Free tiers change constantly, and
   an undated assertion is worse than no assertion.
2. **`lib/providers/<id>.ts`** — implement `ProviderAdapter` (see `lib/providers/types.ts`).
3. **`lib/providers/registry.ts`** — one line in `ADAPTERS`, plus the enum value in a new
   migration. Adding a provider is a migration on purpose: it forces step 1 into the same commit.

### Rules that keep adapters honest

- **An adapter never lies about what it did.** `PingOutcome.strategy` records the model the
  attempt actually ran under. If a provider can't be kept alive by pinging, say so in `policy`
  and let the UI render an alert instead of a false success.
- **Capabilities drive the UI.** No `if (provider === "neon")` outside `lib/providers/`. If the
  UI needs to know something, express it as a capability or a policy field.
- **Adapters are pure-ish.** They take credentials and return normalised data. They do not touch
  the registry database, read `process.env`, or decrypt anything — callers hand them plaintext.
  This is what makes them testable against recorded fixtures.
- **Be pessimistic about policy windows.** Where sources disagree (Upstash says 14 days in one
  place and 30 in another), encode the shorter window and note the conflict in the docs.
- **Validate credentials at the field.** `CredentialField.validate` is how every provider gets the
  same "you pasted the wrong key" protection, like rejecting a `service_role` JWT in an anon-key
  field.

## Working on the vault

Anything touching `lib/crypto/`, `lib/vault/`, or a migration gets extra scrutiny:

- Never log a secret value — not in `console.log`, not in a thrown error, not in `audit_log.detail`.
  The audit log records *that* a secret was touched, never its contents.
- Secrets never cross the server/client boundary. Select the columns you need; don't `select *`
  on `secrets`.
- Vault routes pin `runtime = "nodejs"`, opt out of caching, and are rate-limited.
- Run `/security-review` on the diff and say in the PR that you did.
- Add tests. `lib/crypto/__tests__/crypto.test.ts` is the model: it asserts the *negative* cases
  (wrong key, tampered tag, a blob moved between rows or tiers) as carefully as the happy path,
  because those are the properties the threat model actually depends on.

If you believe you've found a vulnerability, please don't open a public issue — see the contact
in `docs/SECURITY.md`.

## Style

Match the surrounding code. A few conventions worth naming:

- Comments explain **why**, not what. Most existing comments mark a non-obvious constraint (a
  provider quirk, a security trade-off, a migration ordering reason) — that's the bar.
- Colours are tokens in `app/globals.css`, never hex literals in a component.
- Status never relies on colour alone; the label carries the meaning.
- Icon-only buttons get an `aria-label`. Focus rings get restyled, never removed.

## Commits and PRs

Small, reviewable commits with a clear subject line. In the PR, say what you verified by hand —
especially for provider work, since CI can't talk to real providers. Recorded fixtures are the
substitute; live calls never run in CI.
