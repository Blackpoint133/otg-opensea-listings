# Независимый audit — executable coverage и gates

## Реальные gates

- `npm run build`: PASS.
- `npm run typecheck`: PASS.
- `npm test`: PASS — 656 tests, 656 pass, 0 fail, 0 skipped, duration 6557.530916 ms.
- Temporary failing test injection: `npm test` returned exit code 1; `.codex-test-tmp` отсутствовал после failure cleanup. Temporary test/output удалены; clean rerun восстановил 656/656.
- `HEAD == origin/main == 889a65810ba17305d36cc642222e1b0ed4d4fe58`.

## Coverage matrix (audit)

### COVERED

Canonical `0`, large decimal, `007`, negative, exponent; malformed/uppercase order hash and address; wrong chain/collection/protocol at verifier context; duplicate same hash blocking; unrelated unique candidate; same token/different hashes; candidate v1 rejection; identity mutation isolation; candidate/barrier tamper checks; frozen/JSON fake evidence rejection; only reconstruction WeakSet result; PRESENT/BLOCKED/non-targeted context rejection; required AttemptEvidence field; attempt hash token binding; unchanged RequestIdentity; authority false; generation-v1/candidate-v2 nominal integration; source isolation; runner count/cleanup/exit propagation.

### PARTIALLY COVERED

Wrong-contract boundary (only later context rejection, not candidate fail-closed); conflicting contract/protocol duplicate permutations; candidate envelope recombination with independently valid pieces; rootContentHash tamper/context derivation; structuredClone, spread/Object.assign, prototype and Proxy provenance; AttemptEvidence wrong contract/collection/protocol and supported-chain enforcement; `canonicalVerifierIdentity` collision assertion; legacy TSX parity beyond structural discovery; runner compiler/spawn error paths.

### NOT COVERED

Dedicated executable assertions for `+7`, `1.0`, leading/trailing whitespace and empty token; zero-address/wrong lowercase contract persistence/reconstruction; every required duplicate identity permutation; full provider/local identity separation at future adapter boundary; proof that no arbitrary protocol source can be substituted; deliberate test of stale compiled output or production `dist` hash invariance; test-runner failure when required copied fixture is absent.

## Runner audit

The runner recursively discovers `tests/**/*.test.ts`, compiles source with local `tsc`, transpiles tests, passes an explicit compiled list to `node --test`, and removes its dedicated output. It is not tsx-dependent. However silent copy catches and missing child-process error handling remain robustness findings. No network/API key/DB process is invoked by the runner itself.

PURE RESPONSE ADAPTER NOT IMPLEMENTED. HTTP TRANSPORT NOT IMPLEMENTED. LIVE/API KEY NOT USED. DB/MUTATION NOT USED. DEACTIVATION AUTHORITY = FALSE.
