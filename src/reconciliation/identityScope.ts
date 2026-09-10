export const SUPPORTED_CHAIN = "gunzilla" as const;
export const SUPPORTED_COLLECTION_SLUG = "off-the-grid" as const;
export const SUPPORTED_CONTRACT_ADDRESS = "0x9ed98e159be43a8d42b64053831fcae5e4d7d271" as const;

export const ORDER_HASH_PATTERN = /^0x[0-9a-f]{64}$/;
export const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
export const TOKEN_ID_PATTERN = /^(0|[1-9][0-9]*)$/;

export interface CanonicalLocalIdentity {
  readonly orderHash: string;
  readonly chain: typeof SUPPORTED_CHAIN;
  readonly contractAddress: string;
  readonly tokenId: string;
  readonly collectionSlug: typeof SUPPORTED_COLLECTION_SLUG;
  readonly protocolAddress: string;
}

export type IdentityValidation = "VALID" | "INVALID_LOCAL_IDENTITY" | "UNSUPPORTED_LOCAL_SCOPE";

export function validateCanonicalIdentity(value: unknown): IdentityValidation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "INVALID_LOCAL_IDENTITY";
  const row = value as Record<string, unknown>;
  if (typeof row.orderHash !== "string" || !ORDER_HASH_PATTERN.test(row.orderHash)
    || row.chain !== SUPPORTED_CHAIN
    || typeof row.contractAddress !== "string" || !ADDRESS_PATTERN.test(row.contractAddress)
    || typeof row.tokenId !== "string" || !TOKEN_ID_PATTERN.test(row.tokenId)
    || row.collectionSlug !== SUPPORTED_COLLECTION_SLUG
    || typeof row.protocolAddress !== "string" || !ADDRESS_PATTERN.test(row.protocolAddress)) return "INVALID_LOCAL_IDENTITY";
  if (row.contractAddress !== SUPPORTED_CONTRACT_ADDRESS) return "UNSUPPORTED_LOCAL_SCOPE";
  return "VALID";
}

export function isCanonicalIdentity(value: unknown): value is CanonicalLocalIdentity {
  return validateCanonicalIdentity(value) === "VALID";
}

export function canonicalIdentityMaterial(value: CanonicalLocalIdentity): string {
  return JSON.stringify({ orderHash: value.orderHash, chain: value.chain, contractAddress: value.contractAddress, tokenId: value.tokenId, collectionSlug: value.collectionSlug, protocolAddress: value.protocolAddress });
}
