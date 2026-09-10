import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyOfflineCandidates, validateOfflineCandidateIdentity, type OfflineSweepManifest } from "../src/reconciliation/offlineCandidateModel.js";
import { SUPPORTED_CONTRACT_ADDRESS } from "../src/reconciliation/identityScope.js";

const hash = "0x" + "a".repeat(64);
const base = { orderHash: hash, chain: "gunzilla" as const, contractAddress: SUPPORTED_CONTRACT_ADDRESS, tokenId: "7", collectionSlug: "off-the-grid" as const, protocolAddress: "0x" + "1".repeat(40) };
const manifest: OfflineSweepManifest = { sweepId: "s", generationState: "TRANSPORT_COMPLETE", transportResult: "COMPLETE", snapshotStartedAt: "2026-01-01T00:00:00.000Z", snapshotCompletedAt: "2026-01-01T00:01:00.000Z", paginationExhausted: true, nextCursor: null, truncatedByPageLimit: false, truncatedByListingLimit: false, malformedCount: 0, unsupportedCount: 0, conflictCount: 0, cursorCycleDetected: false, repeatedPageDetected: false, sourceProvenance: { x: "a".repeat(64) } };
function classify(identity: Record<string, unknown>) { return classifyOfflineCandidates({ manifest, seenOrders: [], journalEvents: [], localOrders: [{ ...base, identity: identity as never, status: "active", isActive: true, needsReconciliation: false, lastOrderEventTimestamp: null, lastOrderEventVersion: null }] }).orders[0]; }

test("exact supported contract is canonical", () => assert.equal(validateOfflineCandidateIdentity(base), true));
test("wrong lowercase contract blocks", () => assert.equal(classify({ ...base, contractAddress: "0x" + "2".repeat(40) }).classification, "BLOCKED"));
test("zero contract blocks", () => assert.equal(classify({ ...base, contractAddress: "0x" + "0".repeat(40) }).classification, "BLOCKED"));
test("uppercase contract is noncanonical", () => assert.equal(validateOfflineCandidateIdentity({ ...base, contractAddress: base.contractAddress.toUpperCase() }), false));
test("malformed contract blocks", () => assert.equal(classify({ ...base, contractAddress: "bad" }).classification, "BLOCKED"));
test("zero token is accepted", () => assert.equal(validateOfflineCandidateIdentity({ ...base, tokenId: "0" }), true));
test("leading zero token is rejected", () => assert.equal(validateOfflineCandidateIdentity({ ...base, tokenId: "007" }), false));
test("signed token is rejected", () => assert.equal(validateOfflineCandidateIdentity({ ...base, tokenId: "+7" }), false));
test("negative token is rejected", () => assert.equal(validateOfflineCandidateIdentity({ ...base, tokenId: "-1" }), false));
test("exponent token is rejected", () => assert.equal(validateOfflineCandidateIdentity({ ...base, tokenId: "1e3" }), false));
test("decimal token is rejected", () => assert.equal(validateOfflineCandidateIdentity({ ...base, tokenId: "1.0" }), false));
test("whitespace token is rejected", () => assert.equal(validateOfflineCandidateIdentity({ ...base, tokenId: " 7" }), false));
test("empty token is rejected", () => assert.equal(validateOfflineCandidateIdentity({ ...base, tokenId: "" }), false));
test("arbitrary precision token remains string", () => { const token = "9".repeat(128); assert.equal(validateOfflineCandidateIdentity({ ...base, tokenId: token }), true); assert.equal(typeof token, "string"); });
test("wrong chain blocks", () => assert.equal(classify({ ...base, chain: "ethereum" }).classification, "BLOCKED"));
test("wrong collection blocks", () => assert.equal(classify({ ...base, collectionSlug: "other" }).classification, "BLOCKED"));
test("wrong protocol syntax blocks", () => assert.equal(classify({ ...base, protocolAddress: "0x0" }).classification, "BLOCKED"));
test("identity order hash mismatch blocks", () => assert.equal(classify({ ...base, orderHash: "0x" + "b".repeat(64) }).classification, "BLOCKED"));
test("same token distinct hashes remain independent", () => { const secondHash = "0x" + "b".repeat(64); const second = { ...base, orderHash: secondHash }; const out = classifyOfflineCandidates({ manifest, seenOrders: [], journalEvents: [], localOrders: [{ ...base, identity: base, status: "active", isActive: true, needsReconciliation: false, lastOrderEventTimestamp: null, lastOrderEventVersion: null }, { ...second, identity: { ...base, orderHash: secondHash }, status: "active", isActive: true, needsReconciliation: false, lastOrderEventTimestamp: null, lastOrderEventVersion: null }] }); assert.deepEqual(out.orders.map((x) => x.classification), ["ABSENT_CANDIDATE", "ABSENT_CANDIDATE"]); });
test("wrong contract does not poison unrelated valid candidate", () => { const secondHash = "0x" + "b".repeat(64); const second = { ...base, orderHash: secondHash, identity: { ...base, orderHash: secondHash } }; const out = classifyOfflineCandidates({ manifest, seenOrders: [], journalEvents: [], localOrders: [{ ...base, identity: { ...base, contractAddress: "0x" + "2".repeat(40) }, status: "active", isActive: true, needsReconciliation: false, lastOrderEventTimestamp: null, lastOrderEventVersion: null }, { ...second, status: "active", isActive: true, needsReconciliation: false, lastOrderEventTimestamp: null, lastOrderEventVersion: null }] }); assert.equal(out.orders.find((x) => x.orderHash === hash)?.classification, "BLOCKED"); assert.equal(out.orders.find((x) => x.orderHash === secondHash)?.classification, "ABSENT_CANDIDATE"); });
test("duplicate same hash is blocked", () => { const out = classifyOfflineCandidates({ manifest, seenOrders: [], journalEvents: [], localOrders: [{ ...base, status: "active", isActive: true, needsReconciliation: false, lastOrderEventTimestamp: null, lastOrderEventVersion: null }, { ...base, status: "active", isActive: true, needsReconciliation: false, lastOrderEventTimestamp: null, lastOrderEventVersion: null }] }); assert.equal(out.orders.every((x) => x.classification === "BLOCKED"), true); });
test("duplicate conflicting token is blocked", () => { const out = classifyOfflineCandidates({ manifest, seenOrders: [], journalEvents: [], localOrders: [{ ...base, status: "active", isActive: true, needsReconciliation: false, lastOrderEventTimestamp: null, lastOrderEventVersion: null }, { ...base, identity: { ...base, tokenId: "8" }, status: "active", isActive: true, needsReconciliation: false, lastOrderEventTimestamp: null, lastOrderEventVersion: null }] }); assert.equal(out.orders.every((x) => x.classification === "BLOCKED"), true); });
test("permutation does not change classifications", () => { const a = classify({ ...base, contractAddress: "0x" + "2".repeat(40) }); const b = classify({ ...base, contractAddress: "0x" + "2".repeat(40) }); assert.deepEqual(a.classification, b.classification); });
test("identity validator never coerces numbers", () => assert.equal(validateOfflineCandidateIdentity({ ...base, tokenId: 7 }), false));
