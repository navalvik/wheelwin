# WheelWin — Testnet protected refund intent journal

Prepared: 2026-10-25  
Branch: `feature/testnet-guarded-refund-intents`  
Scope: **offline integration only; no live payment / refund / payout release**

## Implemented

- Independent refund-intent journal built against the **current** `SqlitePaymentIntentStore` and `RefundObligationStore`; no escrow, contracts or the older `TonFinancialPersistence` modules.
- The stored refund must come from a settled Testnet **native GRAM** SQLite payment intent with exact room, participant, incoming transaction, amount, sender and originally assigned room-wallet destination.
- The room must have durable destruction context. An arbitrary payment, repeated participant wallet or an old transaction with a different payment reference does not authorize a refund.
- One immutable gross / recipient-charged-fee / net plan per obligation. A conflicting amount or fee quote fingerprint is rejected rather than silently rewritten.
- The wallet claims an **atomic shared-filesystem directory lock** before any future signer could act. Competing workers, including separate OS processes, cannot claim the same wallet.
- No auto-expiry of locks. A crash between claiming the wallet and persisting signer metadata conservatively leaves the wallet blocked. Only future independently verified chain-proof reconciliation may release it.
- Signed-message identity metadata can be frozen once, with 5-minute maximum validity and no replay; uncertain transfer status remains permanently held.
- Read integrity fingerprints reject journal-file corruption.
- **NO signing, BOC verification, RPC broadcast, automatic retry or wallet-release function is exposed.** The optional identity-freeze method is not evidence of a valid signature. All current payment execution entry points and flags are unchanged.

## Verified isolated cloud checks

- 8 tests in `server/tests/protectedRefundIntentJournal.test.js`: immutable gas plan, real SQLite identity, closed-room debt, old-state rejection, unchanged ambiguous hold after restart, same-wallet competing refunds, corrupted record, separate OS-process locking.
- Targeted expanded regression: **44 passed / 44 tests** across 9 selected files on the current isolated branch commit `d759a5f`.
- Separate read-only TonAPI/TonCenter source comparison library remains in the parent integration branch.
- Neither these suites nor the earlier 71-test read-only subset certify live Testnet refunds or actual chain finality.

## Remaining release gates

1. Attach this journal to a single authorized payout/refund coordinator and validate actual signed TON V4 BOCs **before** permitting a single broadcast. Existing `RefundLifecycleCoordinator.submitRefund` currently sends before recording an UNKNOWN attempt; it must never coexist as an unguarded second sender. No connection yet.
2. Implement two-provider chain-confirmed finalizer with immutable external hash, LT, amount, recipient and seqno; release the wallet lock only after finality and settled debt. Never resend UNKNOWN.
3. Protect the **wallet allocation path** from all held refunds, including orphan lock directories and rooms recovered after restart; merely destroying RoomManager's room must not free the corresponding wallet.
4. Confirm Railway's single financial writer and real persistent volume; this journal is not safe with independent filesystem replicas.
5. Repair the legacy payout accounting profile: the checked-in `RoomPayoutCalculator` currently encodes a permanent **zero reserve**, contradictory to the accepted 3 GRAM scenario of **2.85 GRAM winner + 0.14 GRAM owner + 0.01 GRAM safety margin**. Do not enable winner/owner settlement until corrected and independently tested.
6. All unpaid old-room `oj7v` obligations (Lena and Bob) remain unresolved. Wallet #1 must not be allocated to new sessions. Olga's confirmed return must not be paid twice.
7. Conduct an authorized three-real-player Testnet end-to-end session only when all monetary gates and provider quotas for 50 simultaneous rooms pass.

**Keep `LIVE_PAYMENT_ACCEPTANCE_ENABLED = false`. No Railway, Vercel production or Mainnet deployment, and no funds moved in this work.**

## Additional offline V4 BOC and two-provider proof stage

- New `server/payment/refund/ProtectedRefundV4Boc.js` parses a complete TON Wallet V4 serialized external message. Its actual bytes must contain exactly one internal native GRAM transfer to the frozen beneficiary and net amount, with the workchain-0 source wallet, standard V4 wallet ID, one send action, recipient-payable gas accounting and a short expiration.
- `ProtectedRefundIntentJournal.holdSignedIdentity()` now deliberately throws `REFUND_UNVERIFIED_SIGNED_IDENTITY_DISABLED`. The only way to freeze a prepared payment is `holdPreparedBoc()`, which derives the message hash, seqno and expiry from the parsed BOC rather than trusting caller-supplied values.
- **A syntactically valid BOC does NOT prove a genuine Ed25519 signature.** Tests use fabricated signature bytes. Cryptographic verification against the deployed wallet public key, authoritative seqno/balance and the complete single-writer executor are MANDATORY before a real broadcast. Nothing in this stage enables broadcast.
- New `server/payment/refund/ProtectedRefundChainProof.js` compares the held external hash against two independently supplied indexer transaction lists, exact LT, source transaction hash, native amount, recipient and outgoing message hash. This is **advisory read-only**; its result explicitly cannot mark a refund complete, clear a hold, reuse wallet #1 or authorize another broadcast. Caller-supplied provider arrays are NOT a trusted live data acquisition boundary.
- Fresh focused tests: 11 passed, 0 failed. Includes forged identity rejection, invalid BOC action / sender / beneficiary / amount / extra output / payload, empty second provider, contradictory provider data and restart hold preservation.
- Historical incoming/payout accounting conflicts remain unresolved; no live transfer or blockchain finality proof occurred.

## Ed25519 wallet V4R2 authentication continuation

- New `ProtectedRefundV4Authorization.js` validates an **actual Ed25519 signature** over the hash of the Wallet V4 body excluding the 64-byte signature. It uses Node crypto verification, not simulated signing. The 32-byte public key must deterministically recreate the expected TON Wallet V4R2 address and standard code hash using pinned `@ton/ton@16.3.0`.
- Two separately attributed Testnet account-state snapshots must match account, derived public key, **code hash**, wallet `seqno`, latest transaction LT/hash, exact native balance, active status and recent observation times. A mismatch, stale data, invalid wallet version or underfunded wallet rejects the preflight; nonce mismatch forbids stale signed messages.
- The journal now exposes `holdSignatureVerifiedBoc()`, which persists `signatureAuthenticated:true` with the frozen external message hash, seqno and account head. The older structure-only `holdPreparedBoc()` persists `signatureAuthenticated:false`: it is NOT eligible for a future guarded broadcaster. Caller-only `holdSignedIdentity()` remains prohibited.
- **Important:** Currently the two snapshot objects are input arguments, not authenticated live TonAPI/TON Center responses. This is OFFLINE VALIDATION, not a verified source of real-time blockchain state. The Testnet pool's actual Wallet V4R2 contract type must be checked; if a wallet is V3/V5/custom the validator intentionally blocks it.
- Verified offline with generated ephemeral Ed25519 keys (never persisted to the repo or production): valid signatures succeed; forged signatures, incorrect public keys, stale/mismatched provider state, wrong `seqno`, wrong transfer target/value and inadequate balance are rejected. The signature-verified journal path is covered. `npm ci` succeeded after pinning the V4 address-derivation dependency.
- The new result is **never authority to broadcast, mark a refund complete or release a wallet**. Do not enable live signing or payments. Production still needs trusted two-source state acquisition, second pre-broadcast account-state check, frozen gas estimator, a single exclusive signer, durable unknown-result handling, source-wallet allocation quarantine and exact independent outgoing finality before releases.
