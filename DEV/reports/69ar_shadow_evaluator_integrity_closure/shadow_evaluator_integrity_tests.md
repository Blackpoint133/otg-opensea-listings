# Task 69AR — Test evidence

Coverage includes the real worker-backed `SHADOW_ELIGIBLE` path and deterministic replay, strict v2 decision validation, top-level and evidence tampering rejection, incomplete later-provider admission precedence, accepted operational-record rehydration, generation/current-generation separation, exact later order identity, fence/journal suppression, and later ACTIVE ordering projections.

The existing 69A positive test was retained. New tests prove that a decision cannot be repaired by changing an enum or outer digest without changing the canonical evidence material. Malformed evidence cannot be hidden by PRESENT active evidence or another lower-precedence state. No persistence or mutation path was added.
