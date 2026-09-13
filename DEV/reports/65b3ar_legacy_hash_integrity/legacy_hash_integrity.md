# Task 65B.3AR — Legacy semantic hash integrity

Outcome A. Task-65B.3A correctly separated providerResultStatus and finalResultStatus for new records, but its legacy decode treated every missing finalResultStatus as null. That was unsafe for pre-existing records with a non-null semanticEvidenceHash because the new semantic material includes finalResultStatus and the historical hash did not. Task-65B.3A also overclaimed explicit recovery/retry status-hash evidence.

This remediation now accepts missing finalResultStatus only when semanticEvidenceHash is null, rejects hashed legacy records with `LEGACY_OPERATIONAL_SEMANTIC_HASH_INCOMPATIBLE`, rejects explicit malformed final statuses, and restores deep freezing of normalized owned records. It does not rewrite historical hashes, emulate a legacy hash version, or add a migration.

New-format provider/final status separation, stable and invalidated fencing, recovery, retry, hash invariants, PostgreSQL payload parity, and all previously accepted Task-65B.1/2/store/throttle behavior remain intact. No frozen verifier/fence file, listing code, migration, or live system was changed.

