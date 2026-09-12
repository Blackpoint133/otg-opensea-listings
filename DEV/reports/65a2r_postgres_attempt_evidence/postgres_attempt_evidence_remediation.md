# Task 65A.2R PostgreSQL attempt evidence remediation

Task 65A.2 overclaimed its executable matrix. This remediation tightened the stateful PostgreSQL attempt simulator to match production listDue, claim, and CAS lifecycle/lease predicates and added explicit executable coverage for recovery claims, successful fail, full listDue lease matrix, terminal-claim rejection, future NOT_STARTED rejection, takeover, and all reclaim evidence preservation.

Production store changes are limited to safe reclaim JSON null/failureClassification parity and removal of an unused CAS parameter. Worker orchestration and Task-65A.1 throttle semantics were not changed.
