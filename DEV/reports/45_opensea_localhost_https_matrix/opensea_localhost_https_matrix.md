# Task 45 — localhost HTTPS exact-order matrix

Baseline: `cf9e3331595e2cd00ddb23bdc4e447dc0d3bd87b`.

Добавлен только `tests/openSeaExactOrderLocalhostHttpsMatrix.test.ts`; production `src/` не изменялся. Каждый тест создаёт native `https.createServer`, binds only `127.0.0.1` на ephemeral port и генерирует runtime self-signed test certificate с SAN `localhost`/`127.0.0.1`. Физический request factory maps the logical fixed options to `127.0.0.1:<port>` while asserting logical host `api.opensea.io`, HTTPS, GET, exact context path, Accept and fake-key header. No public DNS or external socket is used.

Native HTTPS/TCP behavior verified: canonical 200, one/small/irregular writes, raw duplicate headers, gzip/no-decompression, bounded oversized cancellation, 404/429/503/302 large-body isolation, no redirect target hit, timeout before headers and after headers, reset before and during response, verified TLS positive, wrong-CA TLS failure, one attempt/no body. Server handles are closed in `finally`.

No production request/API key is used. Test credential is in-memory only and is not reported. Task-32 evidence, accepted adapter and transport source remain unchanged. Outcome A: BLOCKER/HIGH/MEDIUM = 0.

LOCALHOST HTTPS MATRIX RUN; LIVE GET ORDER NOT CALLED; REAL API KEY NOT USED; EXTERNAL NETWORK NOT USED; DB/MUTATION NOT USED; DEACTIVATION AUTHORITY = FALSE.
