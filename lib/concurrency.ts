/**
 * Run tasks with a cap on how many are in flight.
 *
 * The sweep got away with running sequentially while every provider answered over HTTP in
 * well under a second. MongoDB Atlas changes that: a driver connection to a paused cluster
 * sits until its 8-second timeout, and seven of those in a row would exceed the cron's
 * 60-second budget on their own.
 *
 * Deliberately not `Promise.all`: fifty projects would open fifty sockets at once and trip
 * provider rate limits — Supabase's is 120 requests/minute per endpoint.
 */
export async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()),
  );
  return results;
}

/**
 * Stop handing out work once a deadline passes, returning what finished.
 *
 * Used per provider group so one provider's outage can't starve the others of the sweep's
 * budget. Tasks already running are awaited; the ones never started are reported as skipped
 * by the caller rather than silently dropped.
 */
export async function mapWithDeadline<T, R>(
  items: T[],
  limit: number,
  deadlineMs: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<{ results: R[]; skipped: T[] }> {
  const deadline = Date.now() + deadlineMs;
  const results: R[] = [];
  const skipped: T[] = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      if (Date.now() > deadline) {
        skipped.push(items[index]);
        continue;
      }
      results.push(await fn(items[index], index));
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()),
  );
  return { results, skipped };
}
