# Outgoing Wallet Operation Journal

Status: initial persistence seam only; not authorized for live transfers.

## Added components

- `server/payment/fees/OutgoingWalletOperationStore.js`
- `server/tests/outgoingWalletOperationStore.test.js`

The store persists server-created outgoing operation metadata, an idempotency key, the expected wallet seqno, transaction identity, block reference, actual fee, and lifecycle state. It enforces optimistic revision checks and allowed transitions. Finalization requires transaction ID, block ID, actual fee and finalization timestamp. It never stores private keys, mnemonics or signed message BOCs, and it does not sign or broadcast transactions.

An `InProcessWalletOperationQueue` serializes tasks by canonical wallet identity within a single Node.js process. It is not a distributed lock.

## Critical limitations

The file-backed journal uses atomic file replacement, which protects against partial writes but does not provide cross-process locking or transactional uniqueness across Railway replicas. It MUST NOT authorize live transfers. Before live use, replace it with a transactional shared store that supports uniqueness constraints and cross-process serialization.

The seqno must be durably recorded before broadcasting. If the broadcast result is ambiguous, the operation must enter `SUBMISSION_UNKNOWN` and remain held until authoritative chain evidence resolves it. Never blindly retry an ambiguous broadcast. A seqno increase alone does not identify which operation consumed that seqno.

The current store and queue are not wired into application startup, the payment lifecycle, refund/payout execution or Page4. Live payment acceptance must remain disabled.

## States

- `PREPARED`: durable operation exists, no seqno assigned.
- `SEQNO_RESERVED`: expected seqno persisted before broadcast.
- `SUBMISSION_UNKNOWN`: broadcast may have occurred, outcome unresolved; hold.
- `SUBMITTED`: transaction identity recorded, awaiting authoritative finality.
- `FINALIZED`: transaction, block, actual fee and finalization time recorded.
- `FAILED_PRE_BROADCAST`: operation failed before any broadcast could occur.
- `RECONCILIATION_REQUIRED`: blocked for manual or authoritative reconciliation.

Focused tests are authored but have not yet been executed in a Node.js runtime in this session.
