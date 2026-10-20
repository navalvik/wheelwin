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
