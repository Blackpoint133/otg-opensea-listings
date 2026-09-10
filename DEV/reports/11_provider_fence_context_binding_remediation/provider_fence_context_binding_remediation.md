# Provider/fence/context remediation

Аудит-база: `4ea73547e4ecc45c0e1a6d7bdd168043ca23e3ff`.

Исправлены HIGH-01/HIGH-02: добавлен единый coherence check для `buildAttemptEvidence` и `buildTargetedVerifierArtifact`. Он требует canonical equality providerResult/fenceResult.providerResult, pre/post fingerprint orderHash == trusted context orderHash и normalized provider scope == context scope. Durable validator также требует pre/post fingerprint orderHash == requestIdentity.orderHash.

Verifier policy version повышен с v4 до v5; schema остаётся v4, так как durable byte fields не изменились. Candidate v3, envelope v3, generation v2, barrier v2, normalizer v1 и provider contract unchanged.

Удалён redundant loop из 18 self-equality тестов. Authority/deactivation остаются false. PURE RESPONSE ADAPTER NOT IMPLEMENTED; HTTP TRANSPORT NOT IMPLEMENTED; LIVE/API KEY NOT USED; DB/MUTATION NOT USED.
