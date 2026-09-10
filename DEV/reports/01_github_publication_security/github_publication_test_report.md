# Проверки и публикационные gates

Среда проверки: Windows, Node.js v24.15.0.

| Проверка | Результат |
| --- | --- |
| npm run build | PASS, код 0 |
| npm run typecheck | PASS, код 0 |
| npm test | FAIL, код 1 до запуска тестов |
| Lifecycle HTTPS, успешный ответ и HTTP-ошибка | НЕ ПОДТВЕРЖДЕНО: загрузчик тестов не запустился |
| Полное число выполненных тестов | 0; итоговый TAP-отчёт не создан |
| Повторный аудит собственных файлов | PASS в пределах выполненного сканирования |
| Приватные PEM-блоки в собственных исходниках после исправления | 0 |
| PEM в tracked source / проверка staged index | НЕ ПРИМЕНИМО: Git ещё не инициализирован |
| Commit / push / remote verification | НЕ ВЫПОЛНЕНО |

npm test остановлен системной ошибкой `uv_os_get_passwd` с кодом `ENOMEM`
при выполнении `node:os.userInfo` из модуля временных каталогов tsx.
Это сбой до выполнения тестов, а не подтверждённое падение lifecycle-проверки.
Естественный выход дочернего процесса и отсутствие зависших handles пока не доказаны.
Ограничение теста в пять секунд и проверки завершения процесса сохранены.

Рекурсивный скан 1951 файла после удаления встроенного ключа не обнаружил
приватных PEM-блоков в собственном коде, включая tests. Найденные маркеры в
node_modules и .cache относятся к исключённым зависимостям/документации.
Также проверялись credential URL, известные форматы токенов и подозрительные имена
файлов. Значения секретов и сырой чувствительный вывод в отчёт не включены.

Финальное состояние Git: `git rev-parse --show-toplevel` сообщает отсутствие
репозитория. Ветки, index и коммита нет; working tree clean неприменимо.
Оба отчёта сохранены локально в UTF-8, но ещё не закоммичены и не отправлены.
Публикация запрещена до успешного повторного запуска всех обязательных проверок.

## Изолированные диагностические проверки

Классификация C: окружение Codex Windows sandbox; sandbox-only остаётся гипотезой
до сравнения с запуском вне Codex. TEST EXECUTION BLOCKED BY CODEX WINDOWS SANDBOX ENVIRONMENT.

| Проверка | Фактический результат |
| --- | --- |
| node --version | v24.15.0 |
| npm --version | 11.12.1 |
| libuv | 1.51.0 |
| where.exe node | C:\Program Files\nodejs\node.exe |
| where.exe npm | C:\Program Files\nodejs\npm; C:\Program Files\nodejs\npm.cmd |
| where.exe npx | C:\Program Files\nodejs\npx; C:\Program Files\nodejs\npx.cmd |
| node -e, os.userInfo() | FAIL: ERR_SYSTEM_ERROR, uv_os_get_passwd, ENOMEM |
| node -e, os.homedir() | OK: C:\Users\Administrator |
| npx --no-install tsx --version | FAIL до вывода версии |
| node node_modules/tsx/dist/cli.mjs --version | тот же FAIL |
| Версия из node_modules/tsx/package.json | 4.23.5 |
| Поиск os.userInfo, userInfo(, uv_os_get_passwd, username-sync в src/tests/scripts/package.json | совпадений нет |
| Test-Path .git | False |

Разрешённые переменные проверены без полного дампа окружения:
USERNAME=Administrator; USERPROFILE=C:\Users\Administrator; HOME отсутствует;
HOMEDRIVE=C:; HOMEPATH=\Users\Administrator;
TEMP и TMP=C:\Users\ADMINI~1\AppData\Local\Temp\3.
Наличие этих строк не доказывает доступность профиля через Windows API.

Память: totalmem=15,999481 ГиБ; freemem=3,673996 ГиБ; RSS Node=43,074219 МиБ.
Признаков общей нехватки RAM нет; ENOMEM здесь не является доказательством её
исчерпания. Запуск чистого Node успешно выполняет остальные диагностические API.

Точное место: top-level инициализация tsx/dist/temporary-directory-BDDVQOvU.mjs,
строка 1, столбец 84; выражение выбора пользователя вызывает os.userInfo().username,
если process.geteuid отсутствует. Выполняется до тестового кода.

Полный стек прямого Node-вызова:

```text
SystemError [ERR_SYSTEM_ERROR]: A system error occurred: uv_os_get_passwd returned ENOMEM (not enough memory)
    at Object.userInfo (node:os:306:11)
    at [eval]:1:66
    at runScriptInThisContext (node:internal/vm:219:10)
    at node:internal/process/execution:451:12
    at [eval]-wrapper:6:24
    at runScriptInContext (node:internal/process/execution:449:60)
    at evalFunction (node:internal/process/execution:283:30)
    at evalTypeScript (node:internal/process/execution:295:3)
    at node:internal/main/eval_string:71:3
info: errno=-4057, code=ENOMEM, message=not enough memory, syscall=uv_os_get_passwd
```

Полный стек обоих изолированных запусков tsx одинаков:

```text
node:os:306
    throw new ERR_SYSTEM_ERROR(ctx);
          ^

SystemError [ERR_SYSTEM_ERROR]: A system error occurred: uv_os_get_passwd returned ENOMEM (not enough memory)
    at Object.userInfo (node:os:306:11)
    at file:///C:/VAMBAM/Projects/OTG/parsers/parser_opensea_listings_v2/node_modules/tsx/dist/temporary-directory-BDDVQOvU.mjs:1:84
    at ModuleJob.run (node:internal/modules/esm/module_job:437:25)
    at async node:internal/modules/esm/loader:639:26
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5)
code: ERR_SYSTEM_ERROR
info: errno=-4057, code=ENOMEM, message=not enough memory, syscall=uv_os_get_passwd
errno: [Getter/Setter]
syscall: [Getter/Setter]
Node.js v24.15.0
```

Тесты в этом диагностическом этапе не запускались: изолированный tsx не проходит
инициализацию. Число реально выполненных тестов остаётся 0, lifecycle не подтверждён.
Предыдущие build/typecheck PASS сохраняются; повторный запуск не требовался,
поскольку менялись только отчёты. Код и node_modules не исправлялись, обходов нет.
Точная связь с restricted token требует внешнего сравнения; ни снятие sandbox,
ни изменение политики безопасности не выполнялись и не требуются.

Следующий контроль пользователя в обычном cmd.exe вне Codex:

```cmd
cd /d C:\VAMBAM\Projects\OTG\parsers\parser_opensea_listings_v2 && npm test
```

Оба отчёта обновлены в прежнем каталоге 01. Git init/commit/push по-прежнему NO.

## Проверка исправления внешней evidence-зависимости

Внешний результат до исправления: 653 теста, 651 PASS, 2 FAIL; оба падения были
ENOENT в `copyAuthoritativeReleaseEvidence` до вызова проверяемого валидатора.

| Проверка после исправления | Результат |
| --- | --- |
| Абсолютные `C:\VAMBAM` / `Projects\OTG\DEV` ссылки в tests | 0 |
| Копирование внешних release-evidence файлов | удалено |
| Синтетические обязательные артефакты | 4, создаются в temp и очищаются |
| Реальный SHA-256 каждого артефакта | проверяется |
| Точный набор имён манифеста | проверяется |
| Provenance summary ↔ preflight | проверяется |
| Окно, тип запроса, COMPLETE и semantic/admission gates | проверяются |
| 42 строки: 16 inserted + 26 duplicate | проверяются |
| Tamper с неизменным манифестом | отклонён по hash mismatch |
| Отсутствующий файл | отклонён |
| Ложная полнота с пересчитанным хешем | отклонена семантически |
| Вызов Tx B при ложной полноте | 0; fake pool остался pending |
| Candidate incomplete / non-SAFE | прежние проверки сохранены |
| npm run build | PASS |
| npm run typecheck | PASS |
| Точечный запуск двух исправленных тестов через скомпилированный JS и node --test | 2/2 PASS |
| Полный npm test внутри Codex | НЕ ЗАПУСКАЛСЯ; PASS НЕ ЗАЯВЛЯЕТСЯ |

Точечная проверка использовала TypeScript `--noCheck` только для эмиссии в
игнорируемый `.cache/test-build`; синтаксическая диагностика отдельно не выявила
ошибок, а обычные project build/typecheck прошли. Это вспомогательная проверка двух
исправленных сценариев, не замена обязательному `npm test`.

Архивные production evidence не добавлены. Их безопасный структурный аудит не
выявил секретных маркеров, но выявил реальные операционные идентификаторы,
агрегаты и provenance; поэтому выбран минимальный синтетический builder.
Проверка изменённых исходников и отчётов не выявила приватных PEM-блоков,
credential URL или известных форматов токенов. RSA-remediation не изменялась.

Следующая обязательная проверка в обычном cmd.exe вне Codex:

```cmd
cd /d C:\VAMBAM\Projects\OTG\parsers\parser_opensea_listings_v2 && npm test
```

До внешнего полного PASS Git не инициализируется; commit/push не выполняются.

## Внешний полный тестовый gate

Пользователь выполнил `npm test` в обычном cmd.exe вне Codex после исправления:

**EXTERNAL MANUAL CMD VALIDATION: 653/653 PASS.** Итог: tests 653, pass 653,
fail 0, cancelled 0, skipped 0, todo 0. Оба ранее падавших REST Tx B release-evidence
теста прошли. Результат предоставлен пользователем и не выдаётся за запуск внутри
Codex. Ограничение Codex Windows sandbox сохраняется: tsx не доходит до тестового
кода из-за `uv_os_get_passwd` / ENOMEM.

Повторные gates перед Git init:

- `npm run build`: PASS;
- `npm run typecheck`: PASS;
- полный `npm test` внутри Codex не запускался и его PASS не заявляется;
- финальный аудит публикации: PASS.

Проверено полное дерево из 1979 файлов. Публикуемая часть не содержит приватных
PEM-блоков, известных токенов, credential URL, секретных env-файлов или дампов.
Срабатывания внутри node_modules и `.cache/npm` не являются содержимым проекта и
исключены `.gitignore`. Runtime и dist также исключены. RSA-remediation и проверки
герметичного synthetic evidence сохранены.
