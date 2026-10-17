# Keepstack security design

Keepstack stores credentials for databases people care about. This document is the threat model and
the design that follows from it. It is written to be read by a stranger deciding whether to trust a
self-hosted deployment — so it states the limits as plainly as the protections.

---

## 1. What is stored, and in which tier

Two tiers, because two completely different things got called "a secret" in the original app.

| Tier | Encrypted with | Who can decrypt | What lives here |
| --- | --- | --- | --- |
| **`server`** | `KEEPSTACK_MASTER_KEY` (envelope) | the running server, unattended | Supabase PAT, Neon API key, Atlas service-account secret, Upstash API key, Appwrite API key, project anon/publishable keys, Upstash REST tokens, the Atlas ping SRV string |
| **`personal`** | the user's DEK, unwrapped by PIN or email OTP | only the signed-in user, after an unlock | account login passwords, project **database passwords**, connection strings the user wants kept but not used |

The split follows from a single question: **does the cron need it at 3am with nobody watching?**

- The keep-alive sweep must authenticate to provider APIs unattended, so those credentials are
  necessarily machine-readable. Pretending otherwise would be security theatre.
- Nothing in the sweep needs the password you type into supabase.com, or the Postgres password you
  chose at project creation. Those get the stronger treatment.

**The one honest exception.** MongoDB Atlas keep-alive needs a driver connection, so its SRV
connection string — password included — has to be `server` tier. The UI says so at the point of
entry, and recommends a dedicated read-only `keepstack-ping` user rather than the app's main one.
Users who won't accept that leave it blank and Atlas degrades to `alert_only`.

Any `personal` secret can be promoted to `server` only by an explicit per-secret toggle, with the
consequence spelled out: *"The server will be able to read this without you present."* Demotion is
free. Nothing is promoted silently.

---

## 2. Key hierarchy

```
KEEPSTACK_MASTER_KEY  (32 random bytes, env only, never in the database)
   │
   ├── wraps every `server`-tier secret       → AES-256-GCM, per-secret random 96-bit IV
   │
   └── wraps dek_srv ──┐
                       ├──→  DEK  (32 random bytes, per user, never stored unwrapped)
   PIN + PEPPER ───────┘            │
   scrypt(N=2^17, r=8, p=1)         └── wraps every `personal`-tier secret
   wraps dek_pin                         → AES-256-GCM, per-secret random 96-bit IV
```

Per the chosen model (**PIN + email OTP, both can decrypt**) the DEK is wrapped twice and stored
twice, in `profiles`:

- **`dek_pin`** — wrapped by `scrypt(pin ‖ KEEPSTACK_PIN_PEPPER, pin_salt)`. The pepper is in the
  environment, never the database, so a stolen database alone cannot be brute-forced offline.
- **`dek_srv`** — wrapped by `KEEPSTACK_MASTER_KEY`. This is the recovery path that email OTP opens.

Everything is AES-256-GCM. The GCM authentication tag is the integrity check and the PIN verifier —
a wrong PIN fails to unwrap rather than being compared against a stored hash, so there is no
verifier to attack separately. Primitives come from `node:crypto` (`scryptSync`, `createCipheriv`)
in Node-runtime routes only; `scrypt` is chosen over PBKDF2 because a short PIN needs memory
hardness, and over Argon2id only to avoid a WASM dependency in a security-critical path.

**As built** (`lib/crypto/`):

- **Envelope format.** One self-describing blob per secret, `[version:1][iv:12][ciphertext][tag:16]`,
  stored base64 in a `text` column. One blob rather than separate ciphertext/IV columns means
  nothing can get half-updated and no code path can pair the wrong IV with a ciphertext. `text`
  rather than `bytea` because PostgREST represents bytea as `\x…` hex over JSON, which is one more
  encoding layer to get wrong in both directions for no benefit at these sizes.
- **scrypt cost:** N=2^17, r=8, p=1 → 128 MB, about 170 ms on a dev laptop and roughly half a
  second in a serverless function. `maxmem` has to be raised explicitly because Node's 32 MB
  default would reject these parameters. The cost is paid once per unlock, not per secret.
- **PIN length:** 4-8 digits. Single repeated digits and consecutive runs are refused outright.
- **AAD everywhere.** Every blob is bound to its context: `user id + kind + tier` for secrets, and
  a distinct label for each DEK copy and for session seals. A ciphertext therefore cannot be moved
  between rows, between users, between kinds, or — the case that matters most — from a `personal`
  row into a `server` row to get the unattended server to decrypt it. `lib/crypto/__tests__`
  asserts each of these, including both cross-tier directions.

`key_version` on every secret row exists so a future `scripts/rotate-key.ts` can re-wrap everything
under a new master key without downtime.

---

## 3. Unlock: sudo mode

Modelled on GitHub's re-authentication for destructive operations, which is the behaviour asked
for. Being signed in is never enough to see a `personal` secret.

**Unlock by PIN.** User enters 4–8 digits → server derives the KEK, unwraps `dek_pin`, and on
success opens a vault session. Five wrong attempts locks the vault for 15 minutes
(`pin_failed_attempts`, `pin_locked_until`), escalating on repeats. Both outcomes are audited.

**Unlock by OTP.** A 6-digit code, generated with `crypto.randomInt`, is emailed to the address on
the Keepstack account. Only its SHA-256 hash is stored, and it is compared in constant time.
Expires in **10 minutes**, single use, **5 attempts**, with a 60-second resend cooldown; requesting
a new one invalidates the old, so an attacker cannot keep a pool of valid codes alive by triggering
sends. On success the server unwraps `dek_srv`. This is also the path to reset a forgotten PIN —
which re-wraps `dek_pin` under the new PIN, and is audited as `vault.pin_reset`.

Email delivery goes through Resend. **Without `RESEND_API_KEY` the OTP path is cleanly disabled in
the UI and the PIN still works** — only "I forgot my PIN" needs email. In development,
`KEEPSTACK_OTP_DEV_ECHO=true` prints codes to the server log instead of sending them; it is
double-gated on `NODE_ENV` so one environment variable cannot switch it on in production.

**The session.** An unlock mints a random 32-byte token; its SHA-256 goes in `vault_sessions.token_hash`
and the raw token goes to the browser in an httpOnly, Secure, SameSite=Lax cookie. The DEK is
stored as `dek_sealed` — encrypted under a key derived from *the raw token*, which the server does
not retain. So:

> A stolen database snapshot does not yield the DEK, because unsealing it needs a token that only
> ever existed in the user's cookie jar.

Sessions last **10 minutes**, are revocable individually or all at once, and are deleted on sign
out. Expired rows are pruned by the daily sweep.

**Reveal.** With a live session: unseal the DEK, decrypt the one requested secret, return it, write
an `audit_log` row (`secret.reveal`, which secret, which kind, which method, IP, user agent) —
including when decryption *fails*, so a wrong master key shows up in the log rather than silently.
Revealed values are rendered into a field that re-masks after 30 seconds, and **Copy** clears the
clipboard after 60 seconds and on unmount. Reveals are server actions on dynamic pages, never
cached, and never logged.

Revealing a `server`-tier secret is gated on an unlock too. The server can read those unattended
by design, so the gate is not about key custody — it stops a hijacked browser session from
exfiltrating provider API keys without re-authentication. A corollary: the vault must have a PIN
before `anon_key` values are migrated into it, or the owner would have no way to read them back.
The migration action enforces that.

---

## 4. Threat model

**What this design stops**

| Threat | Why it fails |
| --- | --- |
| Registry database leaked (dump, backup, SQL injection, a careless `select *`) | Every secret is ciphertext. No master key, no pepper, no DEK in the database. `dek_pin` is scrypt-hardened *and* peppered, so offline PIN brute force needs the env too. |
| Another Keepstack user attacks your rows | RLS on every table keyed to `auth.uid()`; the service role is used only by the cron. |
| Stolen session cookie / XSS on the dashboard | Signing in reveals nothing. `personal` secrets need a fresh PIN or OTP, and the unlock cookie is httpOnly with a 10-minute life. |
| Shoulder-surfing, screen sharing, stale tabs | Secrets masked by default, auto-re-masked at 30 s, clipboard cleared at 60 s. |
| PIN guessing | 5 attempts → 15-minute lock, escalating; every attempt audited. |
| Someone quietly reading your passwords | Every reveal is an `audit_log` row the user can see on the Vault page. |
| Compromised provider key used to escalate | Setup docs require **scoped** Supabase PATs and a read-only Atlas ping user. |
| A ciphertext moved between rows to get it decrypted by the wrong key | AAD binds every blob to its user, kind and tier; a moved blob fails to authenticate. |
| A vault session outliving the sign-in that opened it | Signing out deletes the session row and the cookie; the nightly sweep prunes anything expired. |

**What this design does *not* stop — stated plainly**

1. **An attacker holding both the database and the environment can decrypt everything.** This
   follows directly from choosing OTP recovery: `dek_srv` is wrapped by `KEEPSTACK_MASTER_KEY`, so
   whoever has both can unwrap the DEK without a PIN. Choosing PIN-only would remove this at the
   cost of permanent data loss on a forgotten PIN. The trade was made deliberately; the opt-out
   below is the mitigation.
2. **A malicious or compromised server operator can read `personal` secrets** — same reason. On a
   self-hosted deployment you are the operator, so this reduces to "trust your own Vercel account".
   On a shared deployment, it does not. `README.md` must say this above the deploy button.
3. **Compromised email = vault access**, because OTP goes there. Keepstack's own 2FA is only as
   strong as the mailbox behind it. The setup guide recommends 2FA on the email account.
4. **`server`-tier secrets have no PIN protection by construction.** A server compromise exposes
   provider API keys. Blast radius is limited by scoped tokens, not by encryption.
5. **Keepstack cannot protect a provider account you've already lost.** It is a registry, not a
   recovery service.

**Planned opt-out (Phase 2).** A per-user **"No recovery" switch** that deletes `dek_srv` and keeps
only `dek_pin`, making the deployment genuinely zero-knowledge for `personal` secrets. Turning it
on requires typing a confirmation phrase, because forgetting the PIN then means those secrets are
unrecoverable — by anyone, including us. Default stays PIN + OTP.

---

## 5. Required environment

```
# Registry (Supabase project holding Keepstack's own tables)
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY          # browser, RLS-protected
SUPABASE_SERVICE_ROLE_KEY              # server only — cron and the one-time claim

# Crypto — generate with: openssl rand -base64 32
KEEPSTACK_MASTER_KEY                   # wraps server-tier secrets and dek_srv
KEEPSTACK_PIN_PEPPER                   # mixed into the PIN KDF; separate from MASTER_KEY

# Scheduler
CRON_SECRET

# Email for OTP (Resend, or Supabase Auth's mailer)
RESEND_API_KEY
KEEPSTACK_FROM_EMAIL

# One-time, remove after use
KEEPSTACK_ALLOW_LEGACY_CLAIM=true
```

Boot-time assertions, because a silent misconfiguration here is worse than a crash: both keys
present, ≥32 bytes decoded, and **distinct**. Losing `KEEPSTACK_MASTER_KEY` means every `server`
secret and every OTP-path recovery is gone — `README.md` says to back it up to a password manager
before the first deploy, and `scripts/rotate-key.ts` exists for when it needs changing.

---

## 6. Practices

- `secrets.ciphertext` never crosses the server/client boundary. Server components select the
  columns they need; `select *` on `secrets` is banned by a lint rule and a code-review item.
- Secret values never appear in `console.log`, thrown errors, server-action return values, or
  `audit_log.detail`. The audit log records *that* a secret was touched, never its value.
- The existing anon-key guard (rejecting `sb_secret_` and `service_role` JWTs) generalises into each
  adapter's `CredentialField.validate`, so every provider gets the same "you pasted the wrong key"
  protection.
- Vault routes pin `runtime = "nodejs"`, opt out of caching, and are rate-limited per user.
- `/security-review` runs on every PR touching `lib/crypto/`, `lib/vault/`, or a migration, and
  `SECURITY.md` carries a disclosure contact before the repo goes public.
