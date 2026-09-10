export type OrderStatus = "active" | "cancelled" | "sold" | "invalidated" | "expired" | "stale" | "unknown";
export type OrderEventType = "item_listed" | "item_cancelled" | "item_sold" | "order_invalidate" | "order_revalidate";
export type EventVersion = string | null;

export interface NormalizedNftIdentity {
  nftId: string;
  chain: string;
  contractAddress: string;
  tokenId: string;
}

export interface NormalizedPrice {
  raw: string;
  normalizedDecimalString: string;
  tokenAddress: string | null;
  symbol: string | null;
  decimals: number | null;
}

export interface NormalizedItem {
  name: string | null;
  imageUrl: string | null;
  permalink: string | null;
}

export interface NormalizedOrderEvent {
  eventType: OrderEventType;
  eventTimestamp: string | null;
  eventVersion: EventVersion;
  orderHash: string | null;
  nft: NormalizedNftIdentity | null;
  seller: string | null;
  buyerCandidate: string | null;
  price: NormalizedPrice | null;
  listingStartAt: string | null;
  expirationAt: string | null;
  item: NormalizedItem;
  transactionHash: string | null;
  receivedAt: string;
  rawPayload: unknown;
  mappingSuspicious: boolean;
  mappingIssues: string[];
}

export interface NormalizedTransferEvent {
  eventType: "item_transferred";
  nft: NormalizedNftIdentity | null;
  from: string | null;
  to: string | null;
  transactionHash: string | null;
  transactionTimestamp: string | null;
  eventTimestamp: string | null;
  eventVersion: EventVersion;
  receivedAt: string;
  rawPayload: unknown;
  item: NormalizedItem;
}

export interface OrderState {
  orderHash: string;
  nft: NormalizedNftIdentity;
  collectionSlug: string;
  seller: string | null;
  price: NormalizedPrice | null;
  listingStartAt: string | null;
  expirationAt: string | null;
  status: OrderStatus;
  isActive: boolean;
  needsReconciliation: boolean;
  reconciliationReason: string | null;
  lastOrderEventType: string | null;
  lastOrderEventTimestamp: string | null;
  lastOrderEventVersion: EventVersion;
  lastNftEventTimestamp: string | null;
  lastNftEventVersion: EventVersion;
  lastTransferTransactionHash: string | null;
  item: NormalizedItem;
  source: string;
  lastStreamReceivedAt: string | null;
  lastReconciledAt: string | null;
  createdAt: string;
  updatedAt: string;
  rawLastEvent: unknown;
}

export interface OrderReducerResult {
  state: OrderState | null;
  applyResult: string;
  ignored: boolean;
  reason: string | null;
  requiresReconciliation: boolean;
}

export interface NftState {
  identity: NormalizedNftIdentity;
  collectionSlug: string;
  currentOwnerAddress: string | null;
  lastTransferFromAddress: string | null;
  lastTransferToAddress: string | null;
  lastTransferTransactionHash: string | null;
  lastTransferAt: string | null;
  lastNftEventTimestamp: string | null;
  lastNftEventVersion: EventVersion;
  item: NormalizedItem;
  metadataUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NftReducerResult {
  state: NftState | null;
  applyResult: string;
  ignored: boolean;
  reason: string | null;
}
