# Безопасная публикация парсера

## CURRENT FINAL STATE

Публикация: **PASS**.

- Корень проекта и Git: `C:\VAMBAM\Projects\OTG\parsers\parser_opensea_listings_v2`.
- Репозиторий: `Blackpoint133/otg-opensea-listings`.
- Ветка: `main`.
- Начальный коммит: `bf8bc4b8dbbd74b1a2be84388af9575f884af590`.
- Начальный ручной push из обычного cmd.exe: **PASS**.
- Удалённая `main` существует и перед финализацией указывала на начальный коммит.
- Secret/publication audit: **PASS**.
- RSA-remediation: **PASS**.
- Герметичность REST Tx B release-evidence тестов: **PASS**.
- `npm run build`: **PASS**.
- `npm run typecheck`: **PASS**.
- **EXTERNAL MANUAL CMD VALIDATION: 653/653 PASS**.

Для будущих операций Codex репозиторий использует GitHub SSH deploy key с write
access только к этому репозиторию. Remote использует `ssh.github.com:443`, а
`core.sshCommand` задан только в локальном `.git/config`. Приватный ключ хранится
вне Git-репозитория, в выделенном каталоге workspace с ограниченным ACL, и не
публикуется. Git Credential Manager этому репозиторию больше не требуется.
Глобальные Git/SSH-настройки и ssh-agent не изменялись.

Read-only `git ls-remote origin refs/heads/main` успешно подтвердил SSH host key,
deploy-key authentication, доступ к репозиторию и начальный remote SHA. Предыдущая
HTTPS-ошибка Schannel `SEC_E_NO_CREDENTIALS` обойдена repository-scoped SSH, без
ослабления песочницы, TLS или проверки host key.

## Выполненные remediation

В `tests/activeListingsLifecycle.test.ts` удалены статические приватный RSA-ключ и
сертификат. Тест генерирует одноразовые RSA 2048 / SHA-256 key и self-signed X.509
в памяти на один час, с SAN только localhost и 127.0.0.1. Материал не записывается
на диск; `selfsigned` закреплён как devDependency. Production TLS не изменён и
глобальная проверка сертификатов не отключена.

В `tests/restTxbSingleEventCanary.test.ts` удалена зависимость от исторических
файлов в `C:\VAMBAM\Projects\OTG\DEV`. Минимальный детерминированный test-only
builder создаёт четыре синтетических артефакта во временном каталоге, вычисляет
реальные SHA-256 и очищает каталог. Общая строгая проверка вынесена в
`verifyRestTxbReleaseEvidenceFiles`; production-wrapper сохраняет прежний закрытый
манифест исторических хешей и release-gate семантику. Проверки COMPLETE,
детерминизма, tamper, missing file, false completeness, candidate incomplete,
non-SAFE и отсутствия Tx B mutation сохранены. Машинно-зависимых путей в tests нет.

Архивные production evidence не копировались: при структурном аудите секретов не
найдено, но обнаружены реальные операционные идентификаторы, агрегаты и provenance,
которые не нужны публичному репозиторию.

## Аудит публикации

Финальный рекурсивный аудит проверил 1979 файлов полного дерева, включая локальные
зависимости, npm-кэш, dist и runtime. Публикуемая часть не содержит действительных
ключей, PEM-блоков, токенов, credential URL, env-файлов, дампов или credential
headers. Срабатывания строгих шаблонов относились к исключённым зависимостям/кэшу,
именам переменных и синтетическим тестовым значениям.

`.gitignore` исключает node_modules, dist/build/coverage, env и key/certificate
файлы, логи/temp/cache/runtime evidence, базы/дампы, CSV-экспорты и IDE/OS-файлы.
Три исходные SQL-миграции, src, tests, package metadata, AGENTS.md и DEV/reports
остаются tracked. Staging-аудит начального коммита проверил 130 blobs: подозрительных
имён, секретных шаблонов, бинарников, symlink/submodule modes и запрещённых
каталогов не было.

## PAST INTERMEDIATE STATE

Первый аудит остановил публикацию из-за встроенного тестового RSA-ключа. После его
удаления полный npm test внутри Codex не запускался: Node v24.15.0 и tsx 4.23.5
завершались до импорта тестов с `uv_os_get_passwd` / ENOMEM. Доступной памяти было
достаточно, а проект не вызывал os.userInfo; это ограничение Codex Windows sandbox.

Первый HTTPS push из Codex также не состоялся из-за отсутствия Schannel credentials
у sandbox identity. Пользователь успешно отправил начальный коммит вручную. Затем
для этого репозитория был создан отдельный SSH deploy key и pinned `known_hosts` для
GitHub SSH over port 443. Эти промежуточные блокировки устранены для публикации;
ограничение tsx/os.userInfo внутри sandbox остаётся и не считается дефектом проекта.
