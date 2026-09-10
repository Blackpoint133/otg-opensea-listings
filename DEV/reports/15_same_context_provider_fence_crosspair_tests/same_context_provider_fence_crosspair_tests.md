# Same-context provider/fence cross-pair evidence

Baseline: `cbd1ed3393bedb5d2ddd55b69daf47d6d5aaf742`.

Расширен `tests/providerFenceRuntimeCrosspair.test.ts`. Context A создаётся через candidate classification → generation evaluation → durable persistence/reconstruction → `deriveTargetedVerifierContext`; trust marker не подделывается.

`providerA1` и `providerA2` создаются `interpretTargetedOrderResponse` для одного context A; ACTIVE и INACTIVE дают разные canonical provider semantics, оба проходят `validateProviderResult`. `fenceA1`/`fenceA2` создаются `applyJournalFence` на одном A fingerprint и проходят `validateFenceResult`.

Проверены matching A1/A1 и A2/A2, crossed A1/A2 и A2/A1 для AttemptEvidence и final artifact. Runtime source не изменён.

RUNTIME SOURCE MODIFIED = NO
PURE RESPONSE ADAPTER NOT IMPLEMENTED
HTTP TRANSPORT NOT IMPLEMENTED
LIVE/API KEY NOT USED
DB/MUTATION NOT USED
DEACTIVATION AUTHORITY = FALSE
