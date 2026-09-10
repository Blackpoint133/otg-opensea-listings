# Project contract

Project root: `C:\VAMBAM\Projects\OTG\parsers\parser_opensea_listings_v2`.
Report root: `C:\VAMBAM\Projects\OTG\parsers\parser_opensea_listings_v2\DEV\reports`.
Initialize Git only in the project root; never import parent files, sibling projects,
production data, or historical `C:\VAMBAM\Projects\OTG\DEV` reports.

Every completed implementation, remediation, audit, design review, reconnaissance,
or publication/security task must create one report directory per task/stage.
Inspect existing report directories, find the highest numeric prefix, and allocate
the next zero-padded, monotonically increasing `NN_short_report_topic` directory
(for example `01_github_publication_security`). Never reuse or overwrite a directory.
Put all reports for the task there; normally use exactly two Markdown reports when
there is a main report and a test/gate report.

`DEV/reports/**` must be tracked and committed/pushed with the work it describes.
Do not ignore these reports. Audit-only means application source is read-only;
creating Markdown reports is allowed, as are report-only commits/pushes when requested.

This repository is public. Reports must never reproduce API/OpenSea keys, passwords,
PostgreSQL passwords, credential-bearing DATABASE_URL values, private/SSH keys,
session/Bearer tokens, cookies, Authorization or X-API-KEY values, or secret
environment values. Never paste raw secret-bearing command output. For discoveries,
record only the affected path, category, severity, and remediation requirement.
Stop before staging/committing/pushing a real secret.

After completing a task:
1. Allocate the next report directory and write sanitized Markdown reports.
2. Run required validation; for code changes run `npm run build`,
   `npm run typecheck`, and `npm test`. Never present failed gates as successful.
3. Inspect Git status/diff and every staged filename/content for secrets/artifacts.
4. Commit changes and reports together using the existing configured Git identity.
5. Push `main` only when the user task allows pushing; never push secrets.
6. Verify status/remote and report the commit hash.

Keep production TLS verification enabled. Generate test keys at runtime; never
embed reusable private keys. Preserve required test fixtures and schema migrations.
