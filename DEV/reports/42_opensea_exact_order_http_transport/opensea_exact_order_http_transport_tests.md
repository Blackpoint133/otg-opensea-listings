# Task 42 executable verification

Добавлен `tests/openSeaExactOrderTransport.test.ts` с fake-only проверками:

- fixed host/method/path и credential header boundary;
- trusted-context rejection до request factory;
- одинаковый результат для разных chunk boundaries;
- oversized body и single-chunk bound;
- non-200 body isolation для 404/429/503/302;
- duplicate raw headers и gzip policy handoff;
- timeout/reset single settlement и late-event race;
- отсутствие redirect и retry.

Gates:

- `npm run build`: PASS
- `npm run typecheck`: PASS
- `npm test`: PASS — 906 total, 906 passed, 0 failed, 0 skipped; duration `7031.564904 ms`
- `git diff --check`: PASS

Task-32 immutable OpenAPI snapshot и generated fixture не изменялись. Tests не открывают sockets и не используют real API key. No HTTP transport outside the dedicated module, no DB/mutation/deactivation behavior.
