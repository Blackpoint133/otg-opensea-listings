import { canonicalJson, sha256 } from "../state/normalizers.js";
import type { NormalizedNftIdentity } from "../state/types.js";
import type { Queryable } from "./types.js";

const LOCK_SCHEMA = "opensea-listings-v2-lock";
const TWO_63 = 1n << 63n;
const TWO_64 = 1n << 64n;

function signedInt64FromSha256(identity: unknown): string {
  const hash = sha256(canonicalJson(identity));
  const first64 = BigInt(`0x${hash.slice(0, 16)}`);
  const signed = first64 >= TWO_63 ? first64 - TWO_64 : first64;
  return signed.toString();
}

export function orderAdvisoryLockKey(orderHash: string): string {
  return signedInt64FromSha256({
    schema: LOCK_SCHEMA,
    family: "order",
    orderHash: orderHash.toLowerCase()
  });
}

export function nftAdvisoryLockKey(identity: NormalizedNftIdentity): string {
  return signedInt64FromSha256({
    schema: LOCK_SCHEMA,
    family: "nft",
    chain: identity.chain,
    contractAddress: identity.contractAddress.toLowerCase(),
    tokenId: identity.tokenId
  });
}

async function acquireTransactionLock(client: Queryable, key: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [key]);
}

export async function acquireOrderTransactionLock(client: Queryable, orderHash: string): Promise<void> {
  await acquireTransactionLock(client, orderAdvisoryLockKey(orderHash));
}

export async function acquireNftTransactionLock(client: Queryable, identity: NormalizedNftIdentity): Promise<void> {
  await acquireTransactionLock(client, nftAdvisoryLockKey(identity));
}
