# Player-Funded TON Network Fees — Architecture Decision

Status: REQUIRED DESIGN CONSTRAINT; implementation and Testnet verification still pending.
Scope: WheelWin's server-controlled room-wallet payment flow on TON Testnet. This does not restore escrow or smart-contract payment code.

## Decision

All TON network fees attributable to a WheelWin game must be economically funded by that game's players, not absorbed as an untracked cost of the room wallet or project. The room wallet may be the on-chain sender for a payout/refund and therefore may physically pay the fee at broadcast time; an explicit, previously funded player fee reserve must cover it. The room wallet's stake principal and operator share must never be silently consumed to pay network fees.

## Distinguish the two fee paths

1. Incoming player -> room-wallet transfer: TON normally charges the sending player's wallet for the transaction fee. The amount credited to the room wallet remains the amount transferred. The UI must show the exact transfer amount and make clear that the player's wallet separately needs enough TON for its own network fee.
2. Outgoing room-wallet -> winner/operator/payer transfer: the room wallet is the sender and TON charges that wallet. Before accepting the room's stakes, the server must reserve enough player-funded fee contributions to cover every outgoing transaction required by the selected game outcome and the supported cancellation/refund paths.

## Required accounting

- Keep stake principal, operator share, player-funded fee reserve, estimated fees, and actual fees as separate ledger concepts. Never hide fees by changing the recorded stake principal.
- Use integer nanotons only. No floating-point monetary arithmetic.
- Obtain a current fee estimate from a trusted TON fee-estimation/simulation path; do not use an undocumented hard-coded fee as if it were exact.
- The server computes the required reserve before payment intents are issued. The UI discloses the fee contribution separately from the stake and shows the total to transfer.
- Persist fee-estimate evidence, estimate timestamp, reserve contribution per player, transaction purpose, actual finalized fee (when reliably available), and any surplus/shortfall.
- Use deterministic integer allocation across the three players. Any division remainder must be allocated by a documented deterministic rule and recorded.
- When actual fees are lower than the reserve, reconcile the surplus according to an explicit rule; do not silently convert it into operator revenue.
- If the fee estimate is missing, stale, invalid, or the reserve is insufficient, fail closed: do not accept the room for play and do not spend the room's principal to make up the difference.
- If a fee shortfall occurs after a transaction is required, keep the payout/refund obligation durable and blocked for reconciliation. Never retry an ambiguous broadcast blindly and never issue a second transfer without resolving the first transaction's identity.
- Every outgoing transfer must use a serialized per-wallet seqno/sign/broadcast/confirmation path. An ambiguous result must be reconciled against on-chain evidence before retrying.

## Before live payment acceptance can be enabled

1. Implement and test fee estimation/validation, per-player contribution calculation, durable fee-reserve ledger records, and reconciliation against actual fees.
2. Cover normal winner payout, operator-share transfer, each individual refund, partial-payment room cancellation, duplicate observations, fee-estimate expiry, underestimated fees, and restart recovery.
3. Demonstrate on Testnet that outgoing transaction fees are paid from the explicit player-funded reserve and that stake principal/operator share is unchanged by fee accounting.
4. Verify the UI disclosure and server-side payment amount agreement.
5. Keep live acceptance disabled until all above checks and the existing outgoing-refund/finality gates pass.

## Non-goals and constraints

- Do not introduce or restore escrow contracts or legacy smart-contract settlement.
- Do not treat a TON Connect connection or client report as payment evidence.
- Do not let the client author the fee estimate, reserve, payer identity, stake, or destination.
- Do not use room-wallet residuals, project funds, or the operator's share as an implicit fallback gas budget.
- This document is an architecture constraint, not evidence that fee estimation, signing, payouts, refunds, or live payment acceptance have been implemented.


## Mandatory trust boundary before integration

The current pure policy validates the shape and consistency of quote/evidence objects; it does **not** authenticate that those objects came from TON Center or the blockchain. Values such as `source`, `globalId`, `finalized`, `transactionId`, and `blockId` are not trustworthy merely because a caller supplies them.

Before this policy may authorize settlement, implement a server-only adapter that:

- obtains fee estimates directly from an approved Testnet provider and constructs quote objects internally;
- independently confirms the configured network identity is TON Testnet (global ID `-3`);
- verifies each outgoing transaction against the persisted operation, expected source wallet, destination, amount/value, wallet seqno, and transaction identity;
- derives the actual network fee from chain/provider transaction data rather than accepting a caller-supplied fee amount;
- applies a documented finality rule and reconciles ambiguous broadcasts before any retry;
- produces a verified evidence record that untrusted callers and client socket events cannot forge or submit as authoritative;
- persists the verified evidence/proof reference before allowing the reserve store to mark an operation reconciled.

Do not interpret a passing pure-policy test as proof of provider authenticity, chain finality, actual fee correctness, or safe live settlement. Keep live payment acceptance disabled until this trust boundary is implemented and tested end-to-end.


## Durable reconciliation evidence

A reserve may not transition to `RECONCILED` from aggregate numbers alone. The store must persist a complete per-operation record of transaction identity, destination, block reference, Testnet identity, observation time, and actual fee, and verify that these records match the reserved operation set and aggregate total. This is an audit-integrity check only; the store's structural validation does not authenticate the provider or prove finality. Only a trusted server-side chain verifier may supply evidence to the reconciliation path.


## Implemented seam: `PlayerFeeEvidenceBoundary`

A server-side dependency boundary now exists at `server/payment/fees/PlayerFeeEvidenceBoundary.js`. It reconstructs quote and actual-fee records instead of trusting caller-supplied network/finality labels, and checks the outgoing source wallet, destination, amount, transaction ID, seqno, block reference, and finalized status returned by injected providers. Unit tests cover mismatched network, destination, amount, transaction ID, seqno-bound evidence, and verifier rejection.

This is deliberately **not yet production evidence**: the estimator and finalized-transfer verifier are injected dependencies, and no concrete TONCenter fee-estimation implementation is connected. The adapter is not wired into the reserve store, ledger, payment intents, refund/payout lifecycle, sockets, or app startup. The quote's `TONCENTER_FEE_ESTIMATE` source label is assigned by the boundary only after a trusted estimator dependency is supplied; that label alone does not authenticate the provider. Live payment acceptance remains disabled.


## Concrete TON Center fee-estimation adapter

Added `server/payment/fees/ToncenterTestnetFeeEstimator.js`. It makes one authenticated `POST https://testnet.toncenter.com/api/v3/estimateFee` request for a prepared serialized message body, uses the existing `TON_API_KEY` variable, validates all returned fee components as non-negative integer nanotons, rejects malformed or stale/mismatched context, and does not retry on rate limits or network ambiguity. The estimator validates both documented `source_fees` and `destination_fees` objects, but the player-funded room-wallet reserve uses only `source_fees`. Recipient-side destination fees are exposed for diagnostics and are not added to the source wallet's reserve. No hard-coded fallback is used.

Added `ToncenterTestnetNetworkIdentityProvider.js`, which calls the existing read-only masterchain-info client and only returns Testnet identity when the provider reports `global_id: -3`. The estimator requires this independent identity provider before making the estimate request.

Important remaining constraints:
- The exact serialized body must come from the server's prepared transfer operation; this adapter does not build or sign a wallet message.
- This code has not been run against the live Testnet API in this session. Mocked unit tests are authored but have not been executed in a Node runtime here.
- The concrete estimator and identity provider are not wired into application startup, fee-reserve persistence, payout/refund execution, or payment acceptance.
- Estimation is not proof of the actual eventual network fee. A separate concrete outgoing transaction verifier must establish source wallet, destination, exact value, transaction identity, seqno, actual charged fees and finality.


## Fee estimate accounting correction

The estimator must not add recipient-side `destination_fees` to the source room-wallet reserve. Its `feeAtomic` is now exactly the validated `sourceFeeAtomic`; `destinationFeeAtomic` remains diagnostic metadata only. This distinction prevents the reserve from charging players for fees attributable to recipient accounts. The estimate is still only a quote: the final reserve policy must be checked against the exact outgoing message and the chain-observed transaction fee before settlement.

## Outgoing verifier implementation boundary

TON Center v3 transaction rows expose transaction hash, source account, `out_msgs`, `total_fees`, and `block_ref`, but the documented transaction schema does not expose the wallet contract's signed external-message `seqno` as a direct transaction field. The verifier must not confuse transaction logical time (`lt`) or block sequence with wallet `seqno`. A concrete verifier therefore still needs a trusted way to bind the prepared wallet operation and its expected seqno to the exact transaction (for example, validating the signed external-in message against the wallet version and operation record), plus independently obtained finalized inclusion evidence. Until that binding is implemented, no adapter may claim complete seqno verification or authorize reconciliation.
