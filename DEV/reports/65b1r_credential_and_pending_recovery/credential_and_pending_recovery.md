# Task 65B.1R credential and pending recovery

Task-65B.1 introduced an accidental double-escaped credential regex and its final response overclaimed explicit PENDING_FENCE recovery evidence. The regex is restored to actual CR/LF matching, with valid `r`/`n` credentials accepted and LF, CR, and CRLF rejected before provider execution. A dedicated restart test proves PENDING_FENCE recovery performs no provider permit, credential, or executor work.

Permit-before-claim orchestration, PostgreSQL store/throttle behavior, and accepted verifier/fence layers remain unchanged.
