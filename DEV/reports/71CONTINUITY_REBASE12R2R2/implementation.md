# TASK 71CONTINUITY-REBASE12R2R2

The continuity-loss replay path now follows the production `applyOrderEvent` contract. Production persists every reducer result that contains state; the `ignored` flag is an outcome classification and does not mean that state is unchanged. This matters for `order_revalidate` and terminal-conflict transitions, which can return an updated state while marking the event ignored.

Order replay therefore calls `upsertOrderState` whenever `reduceOrderState` returns state. Transfer replay intentionally retains production's separate rule: order suppression is written only for a non-ignored `applyTransferToOrder` result, and NFT state is outside this recovery path.

Replay normalization now validates the normalized order hash and, when present, normalized NFT chain/contract/token identity against the durable journal row before reducer application. Conflicts fail closed with `CONTINUITY_LOSS_REBASELINE_EVENT_IDENTITY_INVALID`.

Executable stateful fixtures cover ignored revalidation state, terminal conflict state, and rollback on normalized NFT identity mismatch. Existing recovery-entry high-water, snapshot-time filtering, receipt contract, production CLI, managed runtime, transfer behavior, and ordinary v1 semantics remain unchanged.
