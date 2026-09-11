# Task 41 — executable verification

Новый файл `tests/task41FinalAdversarialAudit.test.ts` добавил 9 независимых adversarial test cases: status/body precedence с 8 MiB body; raw metadata sanitization; malformed Content-Encoding; lexical integer/int32/int64 matrix; huge exponents/timestamps; schema-valid targeted-unsupported split; bounded hash behavior; provenance/cross-context rejection. Existing Task-32–40 tests также прогнаны без изменений.

Результаты gates:

- `npm run build`: PASS
- `npm run typecheck`: PASS
- `npm test`: PASS — 898 total, 898 passed, 0 failed, 0 skipped; duration `7174.770258 ms`
- `git diff --check`: PASS

`git diff 5b36c6eb7507c6ba2d37e5f07e26cb693bf218ff..HEAD -- src/` пуст: production runtime byte-identical baseline. Изменены только новый audit test и два отчёта.

Покрытие подтверждает: non-200/transport branches не хэшируют body; oversized 200 body не хэшируется до size gate; valid bounded body получает точный SHA; malformed input не бросает; schema-invalid и targeted-invalid семантически разделены; observation/result forgery не проходит normalizer; authority/deactivation authority всегда false.

Immutable Task-32 OpenAPI snapshot и generated fixture не изменялись.

Explicit boundary: HTTP TRANSPORT NOT IMPLEMENTED; LIVE GET ORDER NOT CALLED; API KEY NOT USED; DB/MUTATION NOT USED; DEACTIVATION AUTHORITY = FALSE.
