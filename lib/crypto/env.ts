import "server-only";

/**
 * Crypto environment. Both keys are 32 random bytes, base64-encoded:
 *   openssl rand -base64 32
 *
 * They must be different values. `KEEPSTACK_MASTER_KEY` wraps server-tier secrets and the
 * recovery copy of each user's DEK; `KEEPSTACK_PIN_PEPPER` is mixed into the PIN KDF so a
 * stolen database alone can't be brute-forced offline. Keeping them separate means a leak of
 * one does not hand over the other.
 */
const MIN_KEY_BYTES = 32;

function decodeKey(name: string, raw: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new Error(`${name} is not valid base64. Generate it with: openssl rand -base64 32`);
  }
  if (key.length < MIN_KEY_BYTES) {
    throw new Error(
      `${name} decodes to ${key.length} bytes; at least ${MIN_KEY_BYTES} are required. Generate it with: openssl rand -base64 32`,
    );
  }
  return key;
}

let cachedMaster: Buffer | null = null;

export function masterKey(): Buffer {
  if (cachedMaster) return cachedMaster;
  const raw = process.env.KEEPSTACK_MASTER_KEY;
  if (!raw) {
    throw new Error(
      "KEEPSTACK_MASTER_KEY is not set. Generate it with `openssl rand -base64 32`, then back it up to a password manager — losing it makes every server-tier secret unrecoverable.",
    );
  }
  // Use the first 32 bytes, so a longer key is accepted without silently changing behaviour.
  cachedMaster = decodeKey("KEEPSTACK_MASTER_KEY", raw).subarray(0, 32);
  return cachedMaster;
}

export function pinPepper(): Buffer {
  const raw = process.env.KEEPSTACK_PIN_PEPPER;
  if (!raw) {
    throw new Error(
      "KEEPSTACK_PIN_PEPPER is not set. Generate it with `openssl rand -base64 32`. It must be different from KEEPSTACK_MASTER_KEY.",
    );
  }
  return decodeKey("KEEPSTACK_PIN_PEPPER", raw);
}

export function vaultConfigured(): boolean {
  return !!process.env.KEEPSTACK_MASTER_KEY && !!process.env.KEEPSTACK_PIN_PEPPER;
}

/** Which crypto env vars are missing or wrong, for the setup screen. */
export function vaultEnvProblems(): string[] {
  const problems: string[] = [];
  for (const name of ["KEEPSTACK_MASTER_KEY", "KEEPSTACK_PIN_PEPPER"] as const) {
    const raw = process.env[name];
    if (!raw) {
      problems.push(`${name} is not set.`);
      continue;
    }
    try {
      decodeKey(name, raw);
    } catch (e) {
      problems.push((e as Error).message);
    }
  }
  if (
    problems.length === 0 &&
    process.env.KEEPSTACK_MASTER_KEY === process.env.KEEPSTACK_PIN_PEPPER
  ) {
    problems.push(
      "KEEPSTACK_MASTER_KEY and KEEPSTACK_PIN_PEPPER are the same value. They must be different, or the PIN adds no protection the master key doesn't already have.",
    );
  }
  return problems;
}

/** Fail loudly at the point of use: a silent crypto misconfiguration is worse than a crash. */
export function assertVaultEnv(): void {
  const problems = vaultEnvProblems();
  if (problems.length) throw new Error(`Vault is misconfigured:\n- ${problems.join("\n- ")}`);
}
