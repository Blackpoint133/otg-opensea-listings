import assert from "node:assert/strict";
import test, { after } from "node:test";
import { deepFreeze } from "../src/reconciliation/evidence/canonicalEvidence.js";
import { applyJournalFence, buildTargetedVerifierArtifact, providerResultIsAuthoritative, sameAttemptEvidence, rehydrateAttemptEvidence, verifierArtifactHash, validateFenceResult } from "../src/reconciliation/verifier/targetedVerifierArtifact.js";
import { attemptIdentity, eventFingerprint, normalizeSafeHeaders, isIso, validateTargetedVerifierEligibility, semanticEvidenceMaterial } from "../src/reconciliation/verifier/targetedVerifierPolicy.js";
import { sha256Canonical } from "../src/reconciliation/evidence/canonicalEvidence.js";
import { validateProviderResult } from "../src/reconciliation/verifier/targetedVerifierNormalizer.js";
import {
  OPENSEA_ORDER_CONTRACT_VERSION, TARGETED_VERIFIER_CANDIDATE_MODEL_VERSION,
  TARGETED_VERIFIER_GENERATION_MODEL_VERSION, TARGETED_VERIFIER_NORMALIZER_VERSION,
  TARGETED_VERIFIER_POLICY_VERSION, TARGETED_VERIFIER_SCHEMA_VERSION,
  TARGETED_VERIFIER_SUPPORTED_CONTRACT, TARGETED_VERIFIER_SUPPORTED_CHAIN,
  TARGETED_VERIFIER_SUPPORTED_COLLECTION, type JournalFenceSnapshot,
  type TargetedVerifierContext
} from "../src/reconciliation/verifier/targetedVerifierTypes.js";

import { providerFixture } from "./helpers/providerResultFixtures.js";
import { makeTrustedContexts, disposeTrustedContexts } from "./helpers/trustedVerifierContexts.js";

const HASH = "0x" + "a".repeat(64);
const PROTOCOL = "0x" + "b".repeat(40);
const EMPTY_FINGERPRINT = eventFingerprint([], HASH);
const PRE: JournalFenceSnapshot = deepFreeze({ watermark: { eventId: "100", receivedAt: "2026-08-24T10:00:00.000Z" }, relevantOrderFingerprint: EMPTY_FINGERPRINT });
const CONTEXT: TargetedVerifierContext = deepFreeze({
  sweepId: "sweep-1", orderHash: HASH, candidateArtifactHash: "c".repeat(64), barrierArtifactHash: "d".repeat(64), generationRootHash: "e".repeat(64),
  candidateModelVersion: TARGETED_VERIFIER_CANDIDATE_MODEL_VERSION, generationModelVersion: TARGETED_VERIFIER_GENERATION_MODEL_VERSION,
  chain: TARGETED_VERIFIER_SUPPORTED_CHAIN, collectionSlug: TARGETED_VERIFIER_SUPPORTED_COLLECTION, contractAddress: TARGETED_VERIFIER_SUPPORTED_CONTRACT, protocolAddress: PROTOCOL,
  expectedIdentity: { orderHash: HASH, chain: TARGETED_VERIFIER_SUPPORTED_CHAIN, collectionSlug: TARGETED_VERIFIER_SUPPORTED_COLLECTION, contractAddress: TARGETED_VERIFIER_SUPPORTED_CONTRACT, protocolAddress: PROTOCOL, tokenId: "7" },
  candidateClassification: "ABSENT_CANDIDATE", targetedVerifierEligible: true, candidateAuthorityGranted: false, generationDeactivationAuthorityGranted: false,
  verifierSchemaVersion: TARGETED_VERIFIER_SCHEMA_VERSION, verifierPolicyVersion: TARGETED_VERIFIER_POLICY_VERSION, providerContractVersion: OPENSEA_ORDER_CONTRACT_VERSION, normalizerVersion: TARGETED_VERIFIER_NORMALIZER_VERSION,
  sourceProvenance: deepFreeze({ "snapshot.json": "f".repeat(64) }), preVerification: PRE
});

const fixture = await makeTrustedContexts({ tokenId: "7", protocolAddress: PROTOCOL });
const trustedContext = fixture.contexts[0];
after(() => disposeTrustedContexts(fixture.root));
function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ order_hash: HASH, chain: TARGETED_VERIFIER_SUPPORTED_CHAIN, protocol_address: PROTOCOL, asset: { contract: TARGETED_VERIFIER_SUPPORTED_CONTRACT, identifier: "7" }, status: "ACTIVE", type: "basic", price: {}, remaining_quantity: 1, protocol_data: { parameters: { offerer: "0x" + "2".repeat(40), offer: [{ itemType: 2, token: TARGETED_VERIFIER_SUPPORTED_CONTRACT, identifierOrCriteria: "7", startAmount: "1", endAmount: "1" }], consideration: [{ itemType: 2, token: TARGETED_VERIFIER_SUPPORTED_CONTRACT, identifierOrCriteria: "7", startAmount: "1", endAmount: "1", recipient: "0x" + "2".repeat(40) }], startTime: "1700000000", endTime: "2000000000", orderType: 0, zone: "0x" + "3".repeat(40), zoneHash: "0x" + "0".repeat(64), salt: "1", conduitKey: "0x" + "0".repeat(64), totalOriginalConsiderationItems: 1, counter: 0 } }, ...overrides });
}
function interpret(rawBody: string, overrides: Partial<Parameters<typeof providerFixture>[0]> = {}) {
  return providerFixture({ context: trustedContext, httpStatus: 200, rawBody, observedAt: "2026-08-24T10:00:00.000Z", repairShorthand: true, ...overrides });
}
function completeAttempt(active: ReturnType<typeof interpret>, fence: ReturnType<typeof applyJournalFence>, overrides: Record<string, unknown> = {}) {
  const evidence: any = {
    attemptNumber: 0, sweepId: CONTEXT.sweepId, candidateArtifactHash: CONTEXT.candidateArtifactHash, barrierArtifactHash: CONTEXT.barrierArtifactHash, generationRootHash: CONTEXT.generationRootHash, candidateModelVersion: CONTEXT.candidateModelVersion, generationModelVersion: CONTEXT.generationModelVersion,
    attemptId: attemptIdentity(CONTEXT, 0), responseBodySha256: active.responseBodySha256, rawResponseArtifactHash: null,
    normalizedProviderStatus: active.providerStatus, providerResultStatus: active.status, providerReasonCodes: active.reasonCodes,
    normalizedOrder: active.normalizedOrder, resultStatus: fence.status, reasonCodes: fence.reasonCodes,
    preVerificationWatermark: fence.preVerification.watermark, postVerificationWatermark: fence.postVerification.watermark,
    preRelevantFingerprint: fence.preVerification.relevantOrderFingerprint, postRelevantFingerprint: fence.postVerification.relevantOrderFingerprint,
    verifierSchemaVersion: CONTEXT.verifierSchemaVersion, verifierPolicyVersion: CONTEXT.verifierPolicyVersion,
    providerContractVersion: CONTEXT.providerContractVersion, normalizerVersion: CONTEXT.normalizerVersion,
    requestIdentity: { method: "GET" as const, endpointPath: "/api/v2/orders/chain/{chain}/protocol/{protocol_address}/{order_hash}" as const, chain: CONTEXT.chain, protocolAddress: CONTEXT.protocolAddress, orderHash: CONTEXT.orderHash },
    expectedIdentity: CONTEXT.expectedIdentity, semanticEvidenceHash: "", ...overrides
  };
  if (overrides.semanticEvidenceHash === undefined) evidence.semanticEvidenceHash = sha256Canonical(semanticEvidenceMaterial(evidence));
  return evidence;
}

test("valid exact context is eligible and mutable authority is impossible", () => {
  const result = validateTargetedVerifierEligibility(CONTEXT);
  assert.deepEqual(result, { valid: true, status: "READY", reasons: [] });
  assert.equal(Object.isFrozen(result), true);
  const invalid = validateTargetedVerifierEligibility({ ...CONTEXT, targetedVerifierEligible: false });
  assert.equal(invalid.status, "VERIFIER_NOT_ELIGIBLE");
  assert.match(invalid.reasons.join(","), /TARGETED_VERIFIER_NOT_ELIGIBLE/);
});

test("ACTIVE requires exact identity, positive quantity and reliable observation time", () => {
  assert.equal(interpret(body()).status, "ACTIVE_CONFIRMED");
  assert.equal(interpret(body({ order_hash: "0x" + "1".repeat(64) })).status, "AMBIGUOUS");
  assert.equal(interpret(body({ remaining_quantity: 0 })).status, "UNKNOWN");
  assert.equal(interpret(body(), { observedAt: null }).status, "UNKNOWN");
  assert.ok(["AMBIGUOUS", "UNSUPPORTED"].includes(interpret(body({ protocol_address: "0x" + "c".repeat(40) })).status));
  assert.equal(interpret(body({ asset: { contract: "0x" + "c".repeat(40), identifier: "7" } })).status, "AMBIGUOUS");
  assert.equal(interpret(body({ protocol_data: { parameters: { startTime: "1700000000", endTime: "1700000001" } } })).status, "UNKNOWN");
});

test("explicit provider states have distinct semantics", () => {
  assert.equal(interpret(body({ status: "INACTIVE" })).status, "INACTIVE_CONFIRMED");
  assert.equal(interpret(body({ status: "FULFILLED" })).status, "TERMINAL_CONFIRMED");
  assert.equal(interpret(body({ status: "CANCELLED" })).status, "TERMINAL_CONFIRMED");
  assert.equal(interpret(body({ status: "EXPIRED", protocol_data: { parameters: { startTime: "1700000000", endTime: "1700000001" } } })).status, "EXPIRED_CONFIRMED");
  assert.equal(interpret(body({ status: "MYSTERY" })).status, "UNKNOWN");
  assert.equal(interpret(body({ is_private: true })).status, "UNSUPPORTED");
  assert.equal(interpret(body({ criteria: {} })).status, "UNSUPPORTED");
});

test("404, empty/null/array, and transport outcomes never become inactive", () => {
  for (const status of ["UNKNOWN", "UNKNOWN", "UNKNOWN"] as const) void status;
  const notFound = providerFixture({ context: trustedContext, httpStatus: 404, rawBody: "", observedAt: null });
  assert.equal(notFound.status, "UNKNOWN");
  assert.notEqual(notFound.status, "INACTIVE_CONFIRMED");
  assert.notEqual(notFound.status, "TERMINAL_CONFIRMED");
  assert.notEqual(notFound.status, "EXPIRED_CONFIRMED");
  assert.equal(interpret("null").status, "MALFORMED_RESPONSE");
  assert.equal(interpret("[]").status, "MALFORMED_RESPONSE");
  assert.equal(interpret("{bad", {}).status, "MALFORMED_RESPONSE");
  assert.equal(interpret("", { httpStatus: 429, rawBody: undefined }).status, "RATE_LIMITED");
  assert.equal(interpret("", { httpStatus: 500, rawBody: undefined }).status, "TRANSPORT_FAILED");
  assert.equal(interpret("", { httpStatus: 200, rawBody: undefined, transportOutcome: "TIMEOUT" }).status, "TRANSPORT_FAILED");
  assert.equal(interpret("", { httpStatus: 200, rawBody: undefined, transportOutcome: "CONNECTION_RESET" }).status, "TRANSPORT_FAILED");
});

test("HTTP identity and response shape fail closed", () => {
  assert.equal(interpret(body({ chain: "ethereum" })).status, "AMBIGUOUS");
  assert.ok(["MALFORMED_RESPONSE", "AMBIGUOUS", "UNSUPPORTED"].includes(interpret(body({ protocol_address: "invalid" })).status));
  assert.ok(["MALFORMED_RESPONSE", "UNSUPPORTED"].includes(interpret(body({ asset: { contract: TARGETED_VERIFIER_SUPPORTED_CONTRACT, identifier: {} } })).status));
  assert.equal(interpret(body({ remaining_quantity: "bad" })).status, "MALFORMED_RESPONSE");
  assert.ok(["MALFORMED_RESPONSE", "UNKNOWN", "UNSUPPORTED"].includes(interpret(body({ protocol_data: { parameters: { startTime: "2", endTime: "1" } } })).status));
});

test("journal fence allows irrelevant watermark advance but blocks relevant events", () => {
  const active = interpret(body());
  const unchanged: JournalFenceSnapshot = deepFreeze({ watermark: { eventId: "101", receivedAt: "2026-08-24T10:00:01.000Z" }, relevantOrderFingerprint: EMPTY_FINGERPRINT });
  assert.equal(applyJournalFence(active, PRE, unchanged).status, "ACTIVE_CONFIRMED");
  const sold = eventFingerprint([{ eventId: "102", eventType: "item_sold", orderHash: HASH, eventVersion: "1" }], HASH);
  const soldPost: JournalFenceSnapshot = deepFreeze({ watermark: { eventId: "102", receivedAt: "2026-08-24T10:00:02.000Z" }, relevantOrderFingerprint: sold });
  assert.equal(applyJournalFence(active, PRE, soldPost).status, "RECONCILIATION_REQUIRED");
  const revalidate = eventFingerprint([{ eventId: "103", eventType: "order_revalidate", orderHash: HASH, eventVersion: null }], HASH);
  const revalidatePost: JournalFenceSnapshot = deepFreeze({ watermark: { eventId: "103", receivedAt: "2026-08-24T10:00:03.000Z" }, relevantOrderFingerprint: revalidate });
  const inactive = interpret(body({ status: "INACTIVE" }));
  assert.equal(applyJournalFence(inactive, PRE, revalidatePost).status, "RECONCILIATION_REQUIRED");
});

test("raw hashes, attempt identity, artifact determinism and conflict are pure", () => {
  const active = interpret(body());
  const fence = applyJournalFence(active, PRE, PRE);
  assert.notEqual(active.responseBodySha256, interpret(body({ status: "INACTIVE" })).responseBodySha256);
  assert.equal(attemptIdentity(CONTEXT, 0), attemptIdentity(CONTEXT, 0));
  assert.notEqual(attemptIdentity(CONTEXT, 0), attemptIdentity(CONTEXT, 1));
  const same = completeAttempt(active, fence);
  assert.equal(sameAttemptEvidence(same, { ...same }), "IDEMPOTENT");
  assert.equal(sameAttemptEvidence(same, rehydrateAttemptEvidence(JSON.parse(JSON.stringify(same)))), "IDEMPOTENT");
  assert.equal(sameAttemptEvidence({ attemptId: same.attemptId, responseBodySha256: same.responseBodySha256, rawResponseArtifactHash: null }, { attemptId: same.attemptId, responseBodySha256: same.responseBodySha256, rawResponseArtifactHash: null }), "INCOMPLETE");
  assert.equal(sameAttemptEvidence(same, { ...same, responseBodySha256: "0".repeat(64) }), "INCOMPLETE");
  assert.throws(() => buildTargetedVerifierArtifact({ context: CONTEXT, startedAt: "2026-08-24T10:00:00.000Z", completedAt: "2026-08-24T10:00:01.000Z", providerResult: active, fenceResult: fence, transportOutcome: "HTTP", safeHeaders: normalizeSafeHeaders({ date: "Mon", "x-api-key": "secret", authorization: "secret" }) }), /UNTRUSTED_TARGETED_VERIFIER_CONTEXT/);
});


test("no verifier source imports network, DB, stream or filesystem writer capability", async () => {
  const { readFile } = await import("node:fs/promises");
  const files = ["src/reconciliation/verifier/targetedVerifierTypes.ts", "src/reconciliation/verifier/targetedVerifierPolicy.ts", "src/reconciliation/verifier/targetedVerifierNormalizer.ts", "src/reconciliation/verifier/targetedVerifierArtifact.ts"];
  for (const file of files) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from ["']node:(https|http|fs)|from ["'](?:axios|pg)|\bfetch\s*\(|writeFile|createWriteStream|eth_call|DEACTIVATE|AUTHORIZED_DEACTIVATION/);
  }
});

test("strict UTC timestamps and ACTIVE temporal window are fail closed", () => {
  assert.equal(isIso("2028-02-29T10:00:00.000Z"), true);
  for (const value of ["2027-02-29T10:00:00.000Z", "2026-02-30T10:00:00.000Z", "2026-13-01T10:00:00.000Z", "2026-08-24T24:00:00.000Z", "2026-08-24T10:00:00Z", "2026-08-24T10:00:00.000+00:00", " 2026-08-24T10:00:00.000Z", null, 1]) assert.equal(isIso(value), false);
  assert.equal(interpret(body({ protocol_data: { parameters: { startTime: "1800000000", endTime: "1900000000" } } })).status, "UNKNOWN");
  assert.equal(interpret(body({ protocol_data: { parameters: { startTime: "1800000000", endTime: "1800000001" } } }), { observedAt: "2024-08-24T10:00:00.000Z" }).status, "UNKNOWN");
  assert.equal(interpret(body({ protocol_data: { parameters: { startTime: "1800000000", endTime: "1800000000" } } }), { observedAt: "2024-08-24T10:00:00.000Z" }).status, "UNKNOWN");
});

test("unsupported criteria and order shapes never produce positive provider evidence", () => {
  const variants = [
    { criteria: { hash: "0x1" } },
    { asset: { contract: TARGETED_VERIFIER_SUPPORTED_CONTRACT, identifier: "7", criteria: { collection: "x" } } },
    { protocol_data: { parameters: { startTime: "1700000000", endTime: "2000000000", offer: [{ itemType: "ERC721", identifierOrCriteria: "0" }] } } },
    { protocol_data: { parameters: { startTime: "1700000000", endTime: "2000000000", offer: [{}, {}] } } },
    { item_type: "ERC1155" },
    { order_type: "UNKNOWN_ORDER" },
    { is_private: true },
  ];
  for (const variant of variants) {
    const result = interpret(body(variant));
    assert.ok(["UNSUPPORTED", "UNKNOWN", "MALFORMED_RESPONSE"].includes(result.status));
    assert.notEqual(result.status, "ACTIVE_CONFIRMED");
    assert.notEqual(result.status, "INACTIVE_CONFIRMED");
    assert.notEqual(result.status, "TERMINAL_CONFIRMED");
    assert.notEqual(result.status, "EXPIRED_CONFIRMED");
  }
});

test("a present offer requires the complete exact Seaport asset contract", () => {
  const validOffer = { itemType: 2, token: TARGETED_VERIFIER_SUPPORTED_CONTRACT, identifierOrCriteria: "7", startAmount: "1", endAmount: "1" };
  assert.equal(interpret(body({ protocol_data: { parameters: { startTime: "1700000000", endTime: "2000000000", offer: [validOffer] } } })).status, "ACTIVE_CONFIRMED");
  for (const offer of [{}, { itemType: 2 }, { itemType: 2, token: TARGETED_VERIFIER_SUPPORTED_CONTRACT }, { itemType: 2, token: TARGETED_VERIFIER_SUPPORTED_CONTRACT, identifierOrCriteria: "7" }, { itemType: 1, token: TARGETED_VERIFIER_SUPPORTED_CONTRACT, identifierOrCriteria: "7", startAmount: "1", endAmount: "1" }, { itemType: 2, token: TARGETED_VERIFIER_SUPPORTED_CONTRACT, identifierOrCriteria: "7", startAmount: "2", endAmount: "1" }]) {
    const result = interpret(body({ protocol_data: { parameters: { startTime: "1700000000", endTime: "2000000000", offer: [offer] } } }));
    assert.ok(["UNSUPPORTED", "MALFORMED_RESPONSE", "UNKNOWN"].includes(result.status));
    assert.notEqual(result.status, "ACTIVE_CONFIRMED");
    assert.notEqual(result.status, "INACTIVE_CONFIRMED");
    assert.notEqual(result.status, "TERMINAL_CONFIRMED");
    assert.notEqual(result.status, "EXPIRED_CONFIRMED");
  }
  for (const offer of [null, {}, []]) assert.notEqual(interpret(body({ protocol_data: { parameters: { startTime: "1700000000", endTime: "2000000000", offer } } })).status, "ACTIVE_CONFIRMED");
});

test("ProviderResult and FenceResult are runtime validated before trust decisions", () => {
  const forgedProvider = { status: "ACTIVE_CONFIRMED", reasonCodes: [], providerStatus: "ACTIVE", normalizedOrder: null, observedAt: "2026-08-24T10:00:00.000Z", responseBodySha256: null, rawResponseArtifactHash: null, httpStatus: 200, retry: { retryable: false, retryReason: "NONE", recommendedPolicyClass: "NONE" }, authorityGranted: false, deactivationAuthorityGranted: false } as any;
  assert.equal(validateProviderResult(forgedProvider), false);
  assert.equal(providerResultIsAuthoritative(forgedProvider), false);
  assert.throws(() => applyJournalFence(forgedProvider, PRE, PRE), /INVALID_PROVIDER_RESULT/);
  const active = interpret(body());
  const fence = applyJournalFence(active, PRE, PRE);
  assert.equal(validateFenceResult(fence), true);
  const forgedFence = { ...fence, status: "ACTIVE_CONFIRMED", providerResult: forgedProvider } as any;
  assert.equal(validateFenceResult(forgedFence), false);
  assert.throws(() => buildTargetedVerifierArtifact({ context: CONTEXT, startedAt: "2026-08-24T10:00:00.000Z", completedAt: "2026-08-24T10:00:01.000Z", providerResult: forgedProvider, fenceResult: forgedFence, transportOutcome: "HTTP", safeHeaders: {} }), /UNTRUSTED_TARGETED_VERIFIER_CONTEXT|INVALID_PROVIDER_RESULT/);
});

test("complete-looking manually forged positive ProviderResult has no runtime provenance", () => {
  const forged = { status: "ACTIVE_CONFIRMED", reasonCodes: [], providerStatus: "ACTIVE", normalizedOrder: { orderHash: HASH, chain: CONTEXT.chain, protocolAddress: CONTEXT.protocolAddress, contractAddress: CONTEXT.contractAddress, assetIdentifier: "7", status: "ACTIVE", remainingQuantity: "1", startTime: "1700000000", endTime: "2000000000", isPrivate: false, isCriteria: false }, observedAt: "2026-08-24T10:00:00.000Z", responseBodySha256: null, rawResponseArtifactHash: null, httpStatus: 200, retry: { retryable: false, retryReason: "NONE", recommendedPolicyClass: "NONE" }, authorityGranted: false, deactivationAuthorityGranted: false } as any;
  assert.equal(validateProviderResult(forged), false);
  assert.equal(providerResultIsAuthoritative(forged), false);
  assert.throws(() => applyJournalFence(forged, PRE, PRE), /INVALID_PROVIDER_RESULT/);
  assert.equal(validateProviderResult(interpret(body())), true);
  for (const status of ["INACTIVE", "FULFILLED", "CANCELLED", "EXPIRED"]) assert.equal(validateProviderResult(interpret(body({ status }))), true);
});

test("runtime provenance marker helpers are not public trust primitives", async () => {
  const types = await import("../src/reconciliation/verifier/targetedVerifierTypes.js") as Record<string, unknown>;
  assert.equal("markRuntimeProviderResult" in types, false);
  assert.equal("markRuntimeFenceResult" in types, false);
  assert.equal("registerProviderResult" in types, false);
  assert.equal("trustProviderResult" in types, false);
  assert.equal("attachRuntimeProof" in types, false);
  const { readFile } = await import("node:fs/promises");
  const files = ["src/reconciliation/verifier/targetedVerifierTypes.ts", "src/reconciliation/verifier/targetedVerifierPolicy.ts", "src/reconciliation/verifier/targetedVerifierNormalizer.ts", "src/reconciliation/verifier/targetedVerifierArtifact.ts"];
  for (const file of files) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /export\s+(?:function|const)\s+(?:markRuntime|register|trust|attachRuntimeProof)/i);
  }
});

test("pre-interpreted ProviderResult trust constructor is not public", async () => {
  const modules = await Promise.all([
    import("../src/reconciliation/verifier/targetedVerifierTypes.js"),
    import("../src/reconciliation/verifier/targetedVerifierPolicy.js"),
    import("../src/reconciliation/verifier/targetedVerifierNormalizer.js"),
    import("../src/reconciliation/verifier/targetedVerifierArtifact.js"),
  ]);
  for (const module of modules as Array<Record<string, unknown>>) {
    assert.equal("constructTrustedProviderResult" in module, false);
    assert.equal("createTrustedProviderResult" in module, false);
    assert.equal("providerResultFromSemantics" in module, false);
    assert.equal("registerProviderResult" in module, false);
  }
});

test("only original internally constructed results retain transient provenance", () => {
  const active = interpret(body());
  const fence = applyJournalFence(active, PRE, PRE);
  assert.equal(validateProviderResult(active), true);
  assert.equal(validateFenceResult(fence), true);
  const clones = [{ ...active }, JSON.parse(JSON.stringify(active)) as unknown, structuredClone(active) as unknown];
  for (const clone of clones) {
    assert.equal(validateProviderResult(clone), false);
    assert.equal(providerResultIsAuthoritative(clone), false);
  }
  const fenceClones = [{ ...fence }, JSON.parse(JSON.stringify(fence)) as unknown, structuredClone(fence) as unknown];
  for (const clone of fenceClones) assert.equal(validateFenceResult(clone), false);
});

test("semantic evidence differences conflict even when raw response is unchanged", () => {
  const active = interpret(body());
  const fence = applyJournalFence(active, PRE, PRE);
  const attemptId = attemptIdentity(CONTEXT, 0);
  const evidence = completeAttempt(active, fence, { attemptId });
  assert.equal(sameAttemptEvidence(evidence, { ...evidence }), "IDEMPOTENT");
  assert.equal(sameAttemptEvidence(evidence, { ...evidence, resultStatus: "RECONCILIATION_REQUIRED" }), "INCOMPLETE");
  assert.equal(sameAttemptEvidence(evidence, { ...evidence, postVerificationWatermark: { eventId: "101", receivedAt: "2026-08-24T10:00:01.000Z" } }), "INCOMPLETE");
  assert.equal(sameAttemptEvidence(evidence, { ...evidence, verifierPolicyVersion: "other" }), "INCOMPLETE");
});

test("artifact boundary strips secret headers and isolates caller-owned nested data", () => {
  const active = interpret(body());
  const fence = applyJournalFence(active, PRE, PRE);
  const mutableProvenance = { "snapshot.json": "f".repeat(64) };
  const mutablePre = { watermark: { eventId: "100", receivedAt: "2026-08-24T10:00:00.000Z" }, relevantOrderFingerprint: { orderHash: HASH, eventIds: [], events: [], orderingAmbiguous: false } };
  const context = Object.freeze({ ...CONTEXT, sourceProvenance: mutableProvenance, preVerification: mutablePre }) as TargetedVerifierContext;
  assert.throws(() => buildTargetedVerifierArtifact({ context, startedAt: "2026-08-24T10:00:00.000Z", completedAt: "2026-08-24T10:00:01.000Z", providerResult: active, fenceResult: fence, transportOutcome: "HTTP", safeHeaders: { authorization: "secret", Authorization: "secret", "x-api-key": "secret", Cookie: "secret", "set-cookie": "secret", unknown: "secret", date: "Mon", "retry-after": "1" } }), /UNTRUSTED_TARGETED_VERIFIER_CONTEXT/);
});
