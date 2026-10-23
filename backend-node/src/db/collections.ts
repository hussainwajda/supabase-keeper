import type { Collection } from "mongodb";
import { getDb } from "./client";
import {
  COLLECTIONS,
  type AccountDoc,
  type AuditLogDoc,
  type AuthSessionDoc,
  type OtpChallengeDoc,
  type PingLogDoc,
  type ProjectDoc,
  type SecretDoc,
  type UsageSnapshotDoc,
  type UserDoc,
  type VaultSessionDoc,
} from "./documents";

/**
 * Typed collection handles.
 *
 * Every data access in this backend goes through one of these, so the document type and the
 * collection name are decided in exactly one place.
 */
export const users = (): Collection<UserDoc> => getDb().collection<UserDoc>(COLLECTIONS.users);
export const authSessions = (): Collection<AuthSessionDoc> =>
  getDb().collection<AuthSessionDoc>(COLLECTIONS.authSessions);
export const accounts = (): Collection<AccountDoc> =>
  getDb().collection<AccountDoc>(COLLECTIONS.accounts);
export const projects = (): Collection<ProjectDoc> =>
  getDb().collection<ProjectDoc>(COLLECTIONS.projects);
export const secrets = (): Collection<SecretDoc> =>
  getDb().collection<SecretDoc>(COLLECTIONS.secrets);
export const vaultSessions = (): Collection<VaultSessionDoc> =>
  getDb().collection<VaultSessionDoc>(COLLECTIONS.vaultSessions);
export const otpChallenges = (): Collection<OtpChallengeDoc> =>
  getDb().collection<OtpChallengeDoc>(COLLECTIONS.otpChallenges);
export const pingLogs = (): Collection<PingLogDoc> =>
  getDb().collection<PingLogDoc>(COLLECTIONS.pingLogs);
export const usageSnapshots = (): Collection<UsageSnapshotDoc> =>
  getDb().collection<UsageSnapshotDoc>(COLLECTIONS.usageSnapshots);
export const auditLog = (): Collection<AuditLogDoc> =>
  getDb().collection<AuditLogDoc>(COLLECTIONS.auditLog);
