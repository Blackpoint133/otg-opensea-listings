# Task 65B.3AR2 — Current semantic hash admission

Task 65B.3AR correctly closed legacy hashed-record reinterpretation. It did not verify the persisted semanticEvidenceHash for current-format records that already carried finalResultStatus. This remediation adds strict admission checks without changing the provider/final status model or accepted fence behavior.

Missing finalResultStatus remains compatible only when semanticEvidenceHash is null. Current pre-fence records require a null hash; final records require provider status, post-fence evidence, a canonical hash, and exact recomputation. Mismatches, malformed hashes, and incomplete final states fail closed. Normalized records remain deeply frozen. No historical hash is rewritten, no legacy hash mode is emulated, and no migration is added.

The prior final report also overstated explicit recovery/retry status-hash assertions; this task closes those evidence gaps with executable worker and PostgreSQL admission tests.

