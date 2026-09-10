# Проверки безопасной публикации

## CURRENT FINAL STATE

| Gate | Результат |
| --- | --- |
| RSA static private material removed | PASS |
| Runtime-only localhost certificate/key | PASS |
| Hermetic REST Tx B evidence | PASS |
| Secret/publication audit | PASS |
| `npm run build` | PASS |
| `npm run typecheck` | PASS |
| `npm test` | **EXTERNAL MANUAL CMD VALIDATION: 653/653 PASS** |
| Initial commit remote | PASS: `bf8bc4b8dbbd74b1a2be84388af9575f884af590` |
| Repository-scoped SSH authentication | PASS |
| Remote `main` read-only verification | PASS |

Внешний запуск `npm test` в обычном cmd.exe выполнил 653 теста: 653 pass,
0 fail, 0 cancelled, 0 skipped, 0 todo. Этот результат предоставлен пользователем
после герметизации тестов и не заявляется как запуск внутри Codex.

Полный тестовый запуск внутри Codex остаётся недоступен: Node/tsx завершается до
импорта тестовых модулей с `uv_os_get_passwd` / ENOMEM. Это подтверждённое
ограничение Windows workspace-write sandbox, а не сбой приложения или нехватка RAM.

## Security и test coverage

- В tracked source отсутствуют PEM-блоки приватных ключей. Локальный HTTPS-тест
  создаёт key/certificate только во время выполнения и только для localhost;
  production TLS не изменён.
- REST Tx B safety-тесты вызывают реальный строгий verifier на минимальном
  синтетическом временном evidence graph. Проверяются четыре обязательных имени,
  SHA-256, provenance, окно, counts, COMPLETE/SAFE, tamper, missing file, false
  completeness, candidate incomplete, non-SAFE и отсутствие production mutation.
- Рекурсивный аудит 1979 файлов не обнаружил публикуемых секретов. Исключённые
  зависимости, кэш и build/runtime output не staged; parent `DEV` и production
  evidence не импортированы.
- Начальный index-аудит проверил 130 файлов, включая `AGENTS.md` и оба отчёта в
  `DEV/reports/01_github_publication_security`.

## Repository-scoped SSH gate

Remote настроен на
`ssh://git@ssh.github.com:443/Blackpoint133/otg-opensea-listings.git`.
Локальный `core.sshCommand` использует отдельный repository deploy key,
`IdentitiesOnly`, отключённый agent, pinned `known_hosts`, строгую проверку host key
и batch mode. Приватный ключ находится вне репозитория, не читался в отчёты и не
публикуется. Deploy key имеет write access только к этому репозиторию.

Read-only `git ls-remote origin refs/heads/main` завершился успешно и подтвердил
remote `main` на начальном SHA. Git Credential Manager, глобальные Git/SSH-настройки,
ssh-agent и sandbox policy не изменялись.

## PAST INTERMEDIATE STATE

До герметизации два REST Tx B теста падали с ENOENT из-за абсолютной зависимости
от внешних исторических evidence. До настройки deploy key HTTPS-доступ из sandbox
был заблокирован Schannel-ошибкой credentials. Это исторические промежуточные
состояния, а не текущие блокировки публикации.
