# Candidate Identity Provenance V2 — тестовый отчёт

## Проверки

- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- Добавлены проверки canonical decimal token ID, больших значений без `Number`, reject `007`, знака, exponent и malformed identity; конфликтующий duplicate order hash блокируется.
- Добавлена проверка, что caller-created/frozen/JSON-cloned `VALID` evidence не может получить targeted context.
- Source isolation: в изменённых offline/verifier модулях нет HTTP/HTTPS, API-key, pg/SQL, Stream, worker loop, timer или deactivation writer imports.

Полный `npm test` в Codex Windows sandbox не стартует из-за ранее подтверждённого `tsx`/`os.userInfo()` `uv_os_get_passwd ENOMEM`; тесты не объявляются PASS. Требуется внешний запуск в обычном cmd.exe после публикации изменений.

Все изменения сохраняют authority=false и не реализуют response adapter или transport.
