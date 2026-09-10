# Независимый adversarial audit candidate/evidence NFT identity provenance v2

## Объект и baseline

Проверены `HEAD` и `origin/main`: `889a65810ba17305d36cc642222e1b0ed4d4fe58`. Сравнён полный диапазон `4afaa21290577130320c52224925fbf8e78029f9..889a65810ba17305d36cc642222e1b0ed4d4fe58`.

Изменения классифицированы как verifier/generation runtime (`src/reconciliation/...`), test infrastructure (`scripts/runHermeticTests.mjs`, `scripts/compileHermeticTests.mjs`, `tsconfig.hermetic.json`, `package.json`, `.gitignore`), fixtures/tests и task-04 reports. Нерелевантного production поведения в diff не обнаружено.

## Provenance chain

Candidate v2 действительно включает frozen identity и hash-commits payload; candidate envelope v2 сохраняет candidate artifact content hash; barrier связывает его через `candidateArtifactHash`; reader валидирует artifact/root hashes; reconstruction единожды добавляет результат в module-private `VALID_RECONSTRUCTED`; context берёт identity из candidate payload и root hash из `RootManifest.rootContentHash`.

`RequestIdentity` token не содержит. Provider `normalizedOrder.assetIdentifier` не заполняется локальным token.

## Findings

### HIGH-01 — wrong contract проходит candidate identity boundary

`validateOfflineCandidateIdentity` и `classifyOfflineCandidates` требуют только lowercase `0x` + 40 hex. `offlineGenerationBarrierModel.ts` дублирует ту же syntactic проверку. Wrong lowercase contract, включая zero address, фактически даёт `ABSENT_CANDIDATE`; такой candidate может быть persisted и reconstructed `VALID`. Лишь `deriveTargetedVerifierContext`/`validateTargetedVerifierEligibility` позже требует pinned OTG contract. Это нарушает требование блокировки вне trusted candidate boundary и оставляет persisted candidate evidence с чужой NFT scope.

Correct contract даёт `ABSENT_CANDIDATE`; uppercase/noncanonical malformed address блокируется. Collection и chain pinned (`gunzilla`, `off-the-grid`); protocol address syntactic-only, что соответствует order-specific protocol scope, но caller-controlled source должен быть upstream-authoritative.

### HIGH-02 — generation v1 acceptance contract изменён без version bump

`OFFLINE_GENERATION_MODEL_VERSION` остаётся v1, но `offlineGenerationBarrierModel.ts` теперь требует candidate model v2 и identity semantics. Ранее persisted generation v1/candidate v1 graph теперь отвергается. Это material semantic acceptance-contract change; сохранение v1 может сделать один version identifier означающим разные validation contracts.

### HIGH-03 — AttemptEvidence не закреплена за trusted context

`validateAttemptEvidence` требует frozen shape-valid `expectedIdentity`, но принимает любой `request.chain` как произвольную строку и не требует supported `gunzilla`; standalone validation не принимает `TargetedVerifierContext` и не доказывает, что identity получена от конкретного derived context. Context path pinned, однако public evidence validator допускает caller-created identity вне полного scope. 

### MEDIUM-01 — duplicated identity validation

Identity rules повторяются в candidate model и generation model. Сейчас заметный drift уже есть: candidate validator допускает syntactic contract, а context validator требует pinned contract. Это поддерживаемый fail-closed слой, но semantic drift опасен при дальнейшем изменении правил.

### MEDIUM-02 — hermetic runner robustness

`compileHermeticTests.mjs` использует `cp(...).catch(() => {})`, скрывая отсутствие fixtures/SQL; `runHermeticTests.mjs` не обрабатывает `child` `error` event. В текущем запуске parity прошла, но ошибки инфраструктуры могут маскироваться или завершать runner неуправляемо.

### MEDIUM-03 — adversarial coverage overstated

Suite зелёная, но dedicated provenance file содержит только 3 top-level tests, а общий count остался 656. Многие обязательные cases из task-03/04 не имеют отдельного executable assertion (wrong contract persistence, protocol/contract duplicate permutations, structuredClone/prototype/Proxy, root/barrier recombination, caller-bound AttemptEvidence, full coverage matrix).

## Authority и isolation

Во всех проверенных путях authority/deactivation authority остаются `false`; network/API key/DB/mutation/adapter/HTTP transport отсутствуют.

## Вердикт

**B. INDEPENDENT AUDIT FAIL — REMEDIATION REQUIRED.** Высокие findings исключают outcome A. PURE RESPONSE ADAPTER IMPLEMENTATION = NOT AUTHORIZED. HTTP TRANSPORT = NOT AUTHORIZED.
