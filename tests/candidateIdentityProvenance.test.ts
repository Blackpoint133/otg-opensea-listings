import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyOfflineCandidates, validateOfflineCandidateIdentity, type OfflineLocalOrder } from "../src/reconciliation/offlineCandidateModel.js";
import { deriveTargetedVerifierContext } from "../src/reconciliation/verifier/targetedVerifierContext.js";

const HASH = "0x" + "a".repeat(64);
const IDENTITY = { orderHash: HASH, chain: "gunzilla" as const, contractAddress: "0x9ed98e159be43a8d42b64053831fcae5e4d7d271", tokenId: "7", collectionSlug: "off-the-grid" as const, protocolAddress: "0x0000000000000000000000000000000000000001" };
const manifest = { sweepId: "s", generationState: "TRANSPORT_COMPLETE" as const, transportResult: "COMPLETE" as const, snapshotStartedAt: "2026-01-01T00:00:00.000Z", snapshotCompletedAt: "2026-01-01T00:01:00.000Z", paginationExhausted: true, nextCursor: null, truncatedByPageLimit: false, truncatedByListingLimit: false, malformedCount: 0, unsupportedCount: 0, conflictCount: 0, cursorCycleDetected: false, repeatedPageDetected: false, sourceProvenance: { a: "a".repeat(64) } };
function order(identity = IDENTITY): OfflineLocalOrder { return { ...identity, identity, status: "active", isActive: true, needsReconciliation: false, lastOrderEventTimestamp: "2025-12-31T23:00:00.000Z", lastOrderEventVersion: "1" }; }

test("canonical identity and arbitrary-size token are accepted without Number", () => {
  assert.equal(validateOfflineCandidateIdentity(IDENTITY), true);
  assert.equal(validateOfflineCandidateIdentity({ ...IDENTITY, tokenId: "007" }), false);
  assert.equal(validateOfflineCandidateIdentity({ ...IDENTITY, tokenId: "9".repeat(100) }), true);
  assert.equal(validateOfflineCandidateIdentity({ ...IDENTITY, tokenId: "-1" }), false);
  assert.equal(validateOfflineCandidateIdentity({ ...IDENTITY, tokenId: "1e3" }), false);
});

test("malformed identity and conflicting duplicate order hash fail closed", () => {
  const bad = classifyOfflineCandidates({ manifest, seenOrders: [], localOrders: [order({ ...IDENTITY, tokenId: "007" })], journalEvents: [] });
  assert.equal(bad.orders[0].classification, "BLOCKED");
  assert.ok(bad.orders[0].reasons.includes("INVALID_LOCAL_IDENTITY"));
  const conflict = classifyOfflineCandidates({ manifest, seenOrders: [], localOrders: [order(), order({ ...IDENTITY, tokenId: "8" })], journalEvents: [] });
  assert.equal(conflict.orders.every((x) => x.classification === "BLOCKED"), true);
});

test("caller-created, frozen or cloned VALID evidence cannot derive context", () => {
  const fake = Object.freeze({ status: "VALID" });
  assert.throws(() => deriveTargetedVerifierContext(fake as any, HASH, { preVerification: {} as any }), /UNTRUSTED_INTEGRATED_EVIDENCE/);
  assert.throws(() => deriveTargetedVerifierContext(JSON.parse(JSON.stringify(fake)) as any, HASH, { preVerification: {} as any }), /UNTRUSTED_INTEGRATED_EVIDENCE/);
});
