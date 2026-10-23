/**
 * Constant-time string compare, used to check `CRON_SECRET`.
 *
 * `===` on a secret leaks its prefix through timing: it returns on the first differing byte,
 * so a caller can learn the secret one character at a time. Ported unchanged from
 * `lib/auth.ts`, where it exists for the same reason.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
