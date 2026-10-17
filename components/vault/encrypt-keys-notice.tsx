import Link from "next/link";
import { LockIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { SubmitButton } from "@/components/buttons";
import { encryptSavedKeys } from "@/app/vault/actions";

/**
 * Shown while any project still holds a plaintext anon key.
 *
 * This is the one data migration that can't be SQL: encrypting needs KEEPSTACK_MASTER_KEY,
 * which lives in the app environment and never reaches the database.
 */
export function EncryptKeysNotice({
  pending,
  pinReady,
}: {
  pending: number;
  pinReady: boolean;
}) {
  return (
    <Card className="border-warning/50 bg-warning/5 mb-5">
      <CardContent className="grid gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <LockIcon className="text-warning size-4" aria-hidden />
          {pending} project {pending === 1 ? "key is" : "keys are"} still stored in plain text
        </h2>
        <p className="text-muted-foreground text-[0.8125rem]">
          Anon keys predate the vault and sit unencrypted in the{" "}
          <code className="font-mono">projects.anon_key</code> column. Move them into encrypted
          storage — the keep-alive sweep reads from either location, so nothing breaks while you
          do.
        </p>
        {pinReady ? (
          <form action={encryptSavedKeys}>
            <SubmitButton size="sm" pending="Encrypting…">
              Encrypt saved keys
            </SubmitButton>
          </form>
        ) : (
          <p className="text-[0.8125rem]">
            <Link href="/vault" className="text-accent underline underline-offset-4">
              Set a vault PIN
            </Link>{" "}
            first — revealing a stored key needs an unlocked vault, so without a PIN these
            would become unreadable to you.
          </p>
        )}
        <p className="text-muted-foreground text-xs">
          Afterwards, run <code className="font-mono">0006_drop_plaintext_keys.sql</code> to drop
          the column for good.
        </p>
      </CardContent>
    </Card>
  );
}
