# Task-22 executable evidence

Baseline: ef02afa08f9f618ade2b9961f9a1b568007408bb. Tests run offline inside Codex.

## Permanent coverage

| File/group | Executable evidence | Result |
| --- | --- | --- |
| tests/losslessJson.test.ts | Objects/arrays, null prototype and special property names; exact JSON whitespace; four forbidden whitespace code points outside strings | PASS |
| Same parser file | Root/nested/escaped-equivalent duplicate keys; BMP including E000/FFFF; surrogate pairs in values and keys; invalid escaped/literal surrogates | PASS |
| Same parser file | Bad escapes, unterminated strings, controls, malformed/truncated grammar, trailing garbage | PASS |
| Same parser file | Integer/negative/fraction/exponent/-0 lexical preservation, unsafe integer/int64 text, large decimal string; branded number versus string/object; bounded int32 | PASS |
| Same parser file | Depth boundary, object-member boundary/overflow, array boundary/overflow | PASS |
| tests/openSeaExactOrderAdapter.test.ts | Integer 2 versus string, fraction, exponent, -0, overflow and kind/raw impostor; order type 0 equivalents; string field type rejection | PASS |
| Same adapter file | Exact-byte duplicate root.order, order.status, order_hash, asset.identifier, protocol_data, parameters.offer, offer.token, offer identifier, unknown nested field | PASS: MALFORMED |
| Same adapter file | Context/observation clone rejection; different contexts; separately reconstructed same orderHash with token 1 versus token 2 | PASS |
| Same adapter file | Runtime export surface is only observation normalizer and validator; forbidden legacy helpers absent; one private mint location | PASS |
| tests/targetedVerifierNormalizer.test.ts | Existing state, identity, HTTP, retry, shape, temporal, fence, artifact, immutability and forgery assertions migrated to real adapter fixtures | PASS |
| tests/providerFenceRuntimeCrosspair.test.ts | Real A/B contexts, cross-order rejection and same-context ACTIVE/INACTIVE canonical cross-pair rejection remain executable | PASS |
| Full suite | Candidate/generation/evidence/context, AttemptEvidence hashes, restart, idempotency and artifact regressions | PASS |

Zero-test fixture modules: tests/helpers/providerResultFixtures.ts and tests/helpers/trustedVerifierContexts.ts. The latter supports token/protocol options but still classifies candidates, evaluates generation, persists/reconstructs evidence and derives context. No test module imports another test module. tests/attemptEvidenceBinding.test.ts now asserts exact policy v7.

## Reproduction and gates

Initial new parser tests against unmodified runtime: tests 726, pass 719, fail 7, skipped 0, duration_ms 7254.773442. Failures reproduce the whitespace and Unicode defects documented in the main report. Baseline numeric conversion was separately replayed from git show and asserted number/string collapse. No temporary reproduction file is committed.

Final npm run build: PASS, exit 0.

Final npm run typecheck: PASS, exit 0.

Final npm test: PASS, exit 0; compiled test files 35; tests 741; suites 0; pass 741; fail 0; cancelled 0; skipped 0; todo 0; duration_ms 7202.179328. Counts reflect actual execution, not a target. A previous successful 740-test run preceded the additional same-hash/different-token provenance case.

## Source and isolation audit

Search of runtime verifier sources finds no interpretTargetedOrderResponse, parseJson, rawBody or duplicateKeys. The only RUNTIME_PROVIDER_PROOF.add is private base in targetedVerifierNormalizer, called only by the adapter-observation normalizer. No exported compatibility replacement exists. The new helper's raw shorthand is test-only and always goes through adapter admission.

Changed runtime modules use only parsing/validation/hash and existing pure provenance utilities. No HTTP client, fetch/axios, key access, pg/SQL, Stream/DB mutation, deactivation writer or background service was introduced. Existing repository transport/writer tests use their offline harnesses; running them is not live execution. Both authority values remain false. Source/test changes plus exactly these two reports are the intended commit scope.

OVERALL PURE ADAPTER STILL REQUIRES TASK-23 TIMING/OPENAPI COMPLETION

HTTP TRANSPORT NOT IMPLEMENTED

LIVE GET ORDER NOT CALLED

API KEY NOT USED

DB/MUTATION NOT USED

DEACTIVATION AUTHORITY = FALSE
