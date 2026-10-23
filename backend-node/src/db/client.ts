import { MongoClient, type Db } from "mongodb";
import { mongoDbName, mongoUri } from "../config/env";

/**
 * One MongoClient for the process.
 *
 * The driver maintains its own connection pool, so creating a second client would mean a
 * second pool — the mistake equivalent to `createClient()` per request in the Supabase code,
 * which is why `lib/supabase/service.ts` caches too.
 */
let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectMongo(): Promise<Db> {
  if (db) return db;

  client = new MongoClient(mongoUri(), {
    // Fail fast with a useful message instead of hanging a request for 30 seconds when the
    // deployment is unreachable.
    serverSelectionTimeoutMS: 8_000,
    retryWrites: true,
  });

  await client.connect();
  db = client.db(mongoDbName());
  return db;
}

/**
 * The database handle.
 *
 * Throws rather than connecting lazily: connection happens once at boot, in `src/index.ts`,
 * where a failure can be reported clearly and the process can refuse to start. A lazy
 * connect here would turn a misconfigured URI into a confusing per-request error instead.
 */
export function getDb(): Db {
  if (!db) {
    throw new Error("MongoDB is not connected yet. connectMongo() runs at startup — see src/index.ts.");
  }
  return db;
}

export async function closeMongo(): Promise<void> {
  await client?.close();
  client = null;
  db = null;
}

/** Liveness check for GET /health. */
export async function pingMongo(): Promise<boolean> {
  try {
    await getDb().command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}
