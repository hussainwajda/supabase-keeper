/**
 * Apply the indexes and print what's there.
 *
 * The server does this at boot, so this script exists for the two cases where that isn't
 * enough: checking what a deployment actually has without opening a Mongo shell, and applying
 * a newly added index to a running deployment without restarting it.
 */
import { closeMongo, connectMongo } from "../src/db/client";
import { describeIndexes, ensureIndexes } from "../src/db/indexes";
import { mongoDbName } from "../src/config/env";

async function main(): Promise<void> {
  await connectMongo();
  await ensureIndexes();

  const applied = await describeIndexes();
  console.log(`\nIndexes in "${mongoDbName()}":\n`);
  for (const [collection, names] of Object.entries(applied)) {
    console.log(`  ${collection}`);
    for (const name of names) console.log(`    - ${name}`);
  }
  console.log();

  await closeMongo();
}

main().catch(async (e) => {
  console.error(`\nFailed: ${(e as Error).message}\n`);
  await closeMongo().catch(() => {});
  process.exit(1);
});
