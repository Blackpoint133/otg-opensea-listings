# Task 43 — transport boundary remediation

Baseline: `09c9e3031e15d95fa367c94f216567425f25a773`.

Исправлены два MEDIUM-дефекта transport v1. Production `executeOpenSeaExactOrderRequest` теперь принимает только trusted context, явный API key и overall deadline. `requestFactory`, `clock`, host/origin/protocol/options недоступны через production API. Native `https.request`, fixed `api.opensea.io`, HTTPS GET и context-derived path принадлежат модулю.

Нижний seam `__executeOpenSeaExactOrderRequestForTest` явно помечен internal test-only и используется исключительно fake tests. Для settlement введены claim-before-destroy: результат и флаг settled фиксируются до `destroy()`, deadline очищается, затем ресурс отменяется и уже заявленный результат разрешается. Синхронные destroy-error события не меняют TIMEOUT, HTTP или BODY_TOO_LARGE.

Monotonic elapsed проверяется перед status/header acceptance и перед HTTP-200 completion. Ровно `elapsedMs <= overallDeadlineMs` допускает completion; большее значение даёт TIMEOUT. Native timer range ограничен явным `MAX_OVERALL_DEADLINE_MS = 2147483647`, поэтому Node timer clamping не скрывает radically different deadline.

Adapter/provider/normalizer/policy версии не менялись; transport остаётся `opensea-exact-order-http-transport-v1-2026-09`. Body bound, non-200 isolation, duplicate headers, no decompression/redirect/retry и pure adapter handoff сохранены.

HTTP TRANSPORT IMPLEMENTED; LIVE GET ORDER NOT CALLED; REAL API KEY NOT USED; DB/MUTATION NOT USED; DEACTIVATION AUTHORITY = FALSE.
