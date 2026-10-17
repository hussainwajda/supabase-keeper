/**
 * Constant-time string compare, used by the cron route to check `CRON_SECRET`.
 *
 * Dashboard auth moved to Supabase Auth in Phase 1; `APP_PASSWORD`, the HMAC session cookie
 * and `SESSION_SECRET` are gone. The cron keeps a shared secret because Vercel Cron has no
 * user session to present.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
