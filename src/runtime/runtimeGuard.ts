import type { DbPool, TransactionClient } from "../db/types.js";

export type V2RuntimeMode = "legacy_atomic" | "durable_inbox";

export const V2_RUNTIME_GUARD_KEY = "843950805125226711" as const;

export class RuntimeGuardConflictError extends Error {
  constructor(public readonly runtimeMode: V2RuntimeMode) {
    super(`runtime_conflict:${runtimeMode}`);
    this.name = "RuntimeGuardConflictError";
  }
}

export interface V2RuntimeGuard {
  runtimeMode: V2RuntimeMode;
  lockKey: typeof V2_RUNTIME_GUARD_KEY;
  held: boolean;
  release(): Promise<void>;
}

class SessionV2RuntimeGuard implements V2RuntimeGuard {
  readonly lockKey = V2_RUNTIME_GUARD_KEY;
  held = true;
  private released = false;

  constructor(readonly runtimeMode: V2RuntimeMode, private readonly client: TransactionClient) {}

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try {
      if (this.held) {
        const result = await this.client.query<{ unlocked: boolean }>("SELECT pg_advisory_unlock($1::bigint) AS unlocked", [V2_RUNTIME_GUARD_KEY]);
        const unlocked = Boolean(result.rows[0]?.unlocked);
        this.held = false;
        if (!unlocked) throw new Error(`runtime_guard_unlock_failed:${this.runtimeMode}`);
      }
    } finally {
      this.client.release();
    }
  }
}

export async function acquireV2RuntimeGuard(pool: DbPool, runtimeMode: V2RuntimeMode): Promise<V2RuntimeGuard> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [V2_RUNTIME_GUARD_KEY]);
    if (!Boolean(result.rows[0]?.acquired)) {
      client.release();
      throw new RuntimeGuardConflictError(runtimeMode);
    }
    return new SessionV2RuntimeGuard(runtimeMode, client);
  } catch (error) {
    if (!(error instanceof RuntimeGuardConflictError)) client.release();
    throw error;
  }
}
