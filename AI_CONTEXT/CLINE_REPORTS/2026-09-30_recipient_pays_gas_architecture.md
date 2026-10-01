# Recipient-Pays-Gas Payout Architecture (Room Wallet gas economics)

Date: 2026-09-30

Task: Financial-architecture sprint — move payout gas economically to payout
recipients so Room Wallet reserves are not continuously consumed by game
settlement/refunds. Delivery constraint honoured: NO commit, NO push, NO
deploy, NO Railway/Vercel or environment changes; all work is in the local
working tree only.

## 1. Exact root cause / business requirement being solved

Before this sprint, every Room Wallet transfer paid blockchain gas from the
source wallet's general balance on top of the full authoritative payout
value, and the settlement funding gate demanded the legacy blanket reserve
(`payouts + 2 x initialRoomReserveNano`) for every game. Consequences:

- The Room Wallet's pre-funded 0.01 GRAM safety envelope had to absorb every
  game's source-side fee, forever, for every repeated game in the same room.
- Each settlement required the wallet to hold the full pot plus a blanket
  reserve, so repeated (even coordinated) games permanently consumed wallet
  reserve headroom and could exhaust it.

Requirement implemented: winner/owner payout gas and player refund gas are
economically charged to the payout RECIPIENT by reducing the transfer value;
the Residues Wallet operational sweep keeps its legacy source-pays semantics.

## 2. Exact technical interpretation of "recipient pays gas"

The Room Wallet REMAINS the technical sender of every on-chain transaction
(the TON source-side fee is debited from the Room Wallet balance, because TON
charges the message sender). What changes is the economics:

```
recipientTransferAmountNano = authoritativeGrossPayoutNano
                              - recipientGasChargeNano
recipientGasChargeNano      = feeEstimateTotalNano
                              + max(recipientGasMarginFloorNano,
                                    feeEstimateTotalNano * marginBps / 10_000)
```

The gas charge stays in the Room Wallet (it is part of the pot the wallet
already received) and is exactly what funds the source-side fee the wallet
pays on-chain. The recipient's economic gross share is unchanged; only the
on-chain transfer value is reduced. With the default margin (20%, 0.001 GRAM
floor) the wallet retains slightly more than the estimated fee, so short-term
fee drift is also funded by the game economics, not by the reserve.

## 3. Exact fee-calculation method used

- `TonService.estimateExternalMessageFee(address, { body, initCode, initData,
  ignoreSignature })` wraps the existing `@ton/ton` TonClient
  `estimateExternalMessageFee` JSON-RPC capability (`estimateFee`) through the
  service's existing `_executeRpc` retry/error-normalisation path.
- `RoomWalletAdapter.estimateOutboundTransferFee(...)` builds the EXACT
  outbound wallet transfer message that `sendTransfer` would broadcast — same
  wallet derivation + identity-drift check, same authoritative seqno read
  (seqno 0 + StateInit fallback for fresh wallets), same
  `SendMode.PAY_GAS_SEPARATELY`, same internal message (value/bounce/queryId)
  — signs it with the wallet's own key material and submits its `body` plus
  StateInit cells for estimation with `ignoreSignature: true`. The signed body
  is never broadcast by this method.
- The response `source_fees` fields are normalised to bigint and summed:
  `totalFeeNano = in_fwd_fee + storage_fee + gas_fee + fwd_fee`.
- All amounts are bigint throughout (decimal strings only at the persistence
  boundary).
- Fail-closed: a transport without the estimation capability, an RPC failure,
  or a malformed `source_fees` payload yields
  `PAYOUT_GAS_ESTIMATE_UNAVAILABLE` and NO broadcast. There is no
  source-funded fallback anywhere.

## 4. Exact safety margin and why it was chosen

`recipientGasChargeNano = feeEstimate + max(floor, estimate * marginBps / 10_000)`
with defaults `marginBps = 2000` (20%) and `marginFloorNano = 1_000_000`
(0.001 GRAM), configurable via `ROOM_WALLET_RECIPIENT_GAS_MARGIN_BPS` and
`ROOM_WALLET_RECIPIENT_GAS_MARGIN_FLOOR_NANO` (strict validation; invalid
values fail startup rather than silently degrading the policy).

Rationale: the estimate covers the exact message at current chain config;
the percentage component absorbs fee-config drift and storage-fee growth
between estimation and broadcast; the absolute floor keeps very small
estimates from under-charging. Both components remain part of the recipient
gas charge (economically paid by the recipient), never an extra source cost.
Neither the 0.01 GRAM owner retention, the 0.01 GRAM residual retained floor,
nor the sweep envelope constants were changed.

## 5. Exact files changed

Implementation:

1. `server/services/TonService.js` — `estimateExternalMessageFee` wrapper
   (infrastructure only; bigint normalisation of `source_fees`).
2. `server/payment/roomWallet/RoomWalletFinancialPolicy.js` — explicit payout
   gas policy constants (`PAYOUT_GAS_MODE`, `PAYOUT_GAS_POLICY_VERSION`,
   `PAYOUT_GAS_PLAN_CODES`, margin constants), pure accounting functions
   `buildRecipientGasCharge`, `buildRecipientPaysGasTransfer`, and the strict
   persisted-value parser helpers (`parseNanoString`,
   `nanoToPersistedString`).
3. `server/payment/roomWallet/RoomWalletAdapter.js` —
   `estimateOutboundTransferFee` + shared `_buildSignedExternalMessage`
   (exact-message builder reused by send and estimation). Transfer semantics
   of `sendTransfer` unchanged; the optional `sourceReserveNano` gate
   parameter now also serves recipient-pays-gas funding gates.
4. `server/payment/roomWallet/RoomWalletSettlementAdapter.js` — plan
   computation (`planSettlement`, `planRefunds`), frozen-plan validation
   (`validatePersistedPayoutPlan`, `validateRefundPlanShape`,
   `findRefundPlanEntry`), plan-aware `preflight` /
   `preflightRemainingOwner` / `settleContract` / `refundPayments`, net-value
   on-chain matching with legacy alternation, non-secret accounting logs,
   `PAYOUT_PLAN_MISMATCH` safety code, fail-closed
   `PAYOUT_GAS_ESTIMATE_UNAVAILABLE` / `RECIPIENT_GAS_EXCEEDS_PAYOUT` /
   `PAYOUT_PLAN_ENTRY_MISSING` retryable codes.
5. `server/payment/roomWallet/roomWalletTerminalRecoveryChain.js` —
   `inspectRoomWalletHistory` accepts legacy alternation amounts (pre-sprint
   settlements broadcast at gross are still adopted, never duplicated).
6. `server/payment/RoomWalletSettlementRouter.js` — `planSettlement` /
   `planRefunds` compute-only passthroughs with `capabilityUnavailable`
   signalling for mocked/legacy adapters.
7. `server/payment/ContractSettlementManager.js` —
   `_ensureRoomWalletPayoutPlanFrozen`: freezes the plan into
   `session.request.payoutPlan` and persists it via the existing
   `_persistSession` BEFORE the first payout broadcast; wired into both
   adapter submit sites (`_resumeHashlessPendingNotSettled` and
   `_submitSettlementAdapter`).
8. `server/gameplay/PaymentSessionManager.js` —
   `_ensureRoomWalletRefundPlanFrozen`: freezes/merges the refund plan into
   `session.recoveryMetadata.refundPlan` and persists BEFORE the first refund
   broadcast; helpers `refundPlanCoversEntry` / `mergeRefundPlans`.
9. `server/payment/roomWallet/RoomWalletTerminalSettlementRecovery.js` —
   `_resolveRecoveryPayoutPlan`: reuses the persisted plan from the durable
   settlement record or a previous recovery attempt (invalid plan =
   `EVIDENCE_INCONSISTENT` fail-closed); recovery history inspection uses the
   frozen net amounts with legacy alternation.
10. `server/payment/roomWallet/RoomWalletService.js` — optional, strictly
    validated margin configuration from environment.
11. `server/payment/roomWallet/ROOM_WALLET_RUNTIME.md` — documentation of the
    payout gas policy and invariants.

Tests:

12. `server/tests/roomWalletSettlement.recipientPaysGas.test.js` (NEW) — the
    deterministic A–K regression suite (13 tests, real adapter stack over a
    simulated chain; no live funds, no secrets).
13. `server/tests/roomWalletSettlementAdapter.test.js` — mocks gained the
    deterministic fee-estimation stub; asserted on-chain values updated to
    the frozen net amounts; preflight field updates.
14. `server/tests/roomWalletSettlement.seqnoSequencing.test.js` — simulated
    chain gained `estimateExternalMessageFee`; production-evidence and
    recovery tests assert frozen net values; broadcast-capture accounting
    excludes estimation builds.
15. `server/tests/roomWalletSettlement.r18s75.test.js`,
    `server/tests/roomWalletSettlement.r18s80.uhquHandoff.test.js`,
    `server/tests/roomNumberWalletMapping.test.js` — estimation stubs + net
    amount expectations.
## 6. Settlement lifecycle before vs after

Before:

```
handoff -> settleContract
  -> inspect history (gross amounts)
  -> preflight: balance >= payouts + 2 x 0.01 blanket reserve
  -> send winner at FULL gross (source pays fee from reserve)
  -> confirm winner
  -> send owner at gross - 0.01 retention
  -> confirm owner
```

After:

```
handoff
  -> planSettlement (compute-only): estimate source fees for the exact
     winner/owner outbound messages, apply margin, deduct charge
  -> ContractSettlementManager freezes payoutPlan into session.request
     and persists the settlement session (existing durable persistence)
  -> settleContract:
       -> validate frozen plan (tamper-evident; mismatch = non-retryable
          safety failure)
       -> inspect history with frozen net amounts (+ legacy gross alternation
          for pre-sprint partial settlements)
       -> reused / duplicate-evidence guards unchanged
       -> preflight: balance >= sum(net transfers) + sum(estimated fees)
       -> send winner at frozen net (source reserve = fee budget)
       -> confirm winner (net amount)
       -> send owner at frozen net (gross share - retention - charge)
       -> confirm owner
       -> re-inspect; SETTLEMENT_BROADCAST / adopted as before
```

## 7. Winner accounting

Authoritative gross winner payout: UNCHANGED. On-chain transfer and economic
receipt: `gross - recipientGasCharge`. Source debit recorded as
`recipientTransferAmountNano + estimatedFeeBudgetNano`. Logging emits gross,
charge, net, fee source, fee total, margin, policy, seqno and tx hash (no
secrets).

## 8. Owner accounting

Owner gross share calculation and the 0.01 GRAM retention rule are untouched
(`buildOwnerPayout` unchanged). Owner receives
`grossShare - ownerRetainedNano - recipientGasCharge`. The Owner payout
minimum (0.14 GRAM after retention) still applies to the gross share.

## 9. Refund accounting

The authoritative refundable amount is unchanged (`grossRefundNano` in the
plan). The player receives `refundable - recipientGasCharge`. The exact gas
charge and net transfer are frozen per player in
`session.recoveryMetadata.refundPlan` BEFORE the first refund broadcast;
recovery reuses the persisted net (no recompute) and the existing
idempotency scan adopts both new-format (net) and legacy (gross) completed
refunds.

## 10. Residual-sweep treatment

UNCHANGED and explicitly classified SOURCE_PAYS_GAS: the sweep still sends
exactly 0.49 GRAM with the 0.01 GRAM source envelope (0.006 fee budget +
0.004 margin); recipient value is never reduced; sweep gating, eligibility
and repository semantics are untouched (regression-tested).
## 11. Persistence/recovery behaviour

- Frozen plans are JSON-safe (all nano values are decimal strings) and live
  inside EXISTING persistence: settlement plan in
  `SettlementSession.request.payoutPlan` (persisted via
  `financialPersistence.createSettlementRecord/updateSettlementRecord`),
  refund plan in `PaymentSession.recoveryMetadata.refundPlan`, operator
  recovery request in the existing recovery records.
- Plans are self-verifying on load: margin and gas charge are recomputed from
  the persisted fee evidence; any inconsistency fails closed
  (`PAYOUT_PLAN_MISMATCH`, non-retryable safety failure; operator recovery
  blocks with `EVIDENCE_INCONSISTENT`).
- Recovery never re-estimates: partial recovery (winner confirmed, owner
  missing) resends ONLY the owner payout at the persisted net value;
  refund recovery reuses persisted net amounts; seqno sequencing
  (authoritative seqno -> broadcast -> positive confirmation -> fresh
  authoritative seqno) is unchanged and regression-tested.

## 12. Tests executed and exact pass/fail counts

See the VALIDATION section at the end of this report.

## 13. Pre-existing unrelated failures

Documented in the VALIDATION section at the end of this report.

## 14. Seqno fix confirmation

The sequential settlement seqno fix from commit 77efbba is fully intact:
`RoomWalletAdapter` still serialises outbound sends per wallet and refuses to
sign while a previous broadcast is unconfirmed; `settleContract` still
confirms the winner payout with the existing `confirmPayoutOnChain` primitive
before submitting the owner payout and confirms the owner payout before
completing. The dedicated suite `roomWalletSettlement.seqnoSequencing.test.js`
passes 13/13 after this sprint (including the production-evidence test:
winner on seqno 31, owner on seqno 32 only after positive winner
confirmation), and the new A–K suite re-verifies 31 -> confirmed -> 32 under
the gas policy.

## 15. No smart-contract player payment reintroduced

No GameEscrow, DepositContract, smart-contract player payments, or legacy
player-payment path was reintroduced or re-enabled. All changes operate
strictly inside the Room-Wallet-only architecture; the GameEscrow financial
path remains disabled exactly as before.

## 16. Delivery confirmation

- NO git commit, NO git push (working tree left uncommitted for review).
- NO deployment, NO Railway deploy/trigger/variable change, NO Vercel change.
- No production environment variables were modified (only OPTIONAL new
  margin variables are documented; unset they fall back to policy defaults).

## 17. Security confirmation

- No production secrets, private keys, mnemonics, passwords or API keys were
  added. Test wallets use dummy key material derived from public seed labels
  at runtime (`tests/helpers/dummyRoomWallet.js` and per-test seed hashing).
- Logs emit only non-secret accounting evidence (amounts, fee source, margin,
  policy mode, seqno, tx hash, masked destination).
- The fee-estimation wrapper performs no signing itself; the signed body is
  used solely as estimation input and never persisted or logged.

---

# VALIDATION

## Method

- Full-suite baseline: a clean `git worktree` at the deployment baseline
  commit `77efbba` ("fix(room-wallet): enforce sequential payout seqno
  confirmation") with the same node_modules, running every
  `server/tests/*.test.js` in its own process (cwd = `server/`, matching
  `npm test`), continuing past failures.
- Full-suite after-sprint run: identical method against the modified working
  tree.
- Focused before/after verification for every directly touched suite.

## Exact file-level counts

- Baseline (HEAD `77efbba`): 270 test files — 211 file-processes passed,
  59 failed (one of them, `setupExpiryRoomWalletRefund.test.js`, completes
  its assertions but its process never exits — a pre-existing open-handle
  hang, reproduced at HEAD directly).
- After the sprint: 271 test files (the new recipient-pays-gas suite) —
  213 file-processes passed, 58 failed.
- Set-difference of failures:
  - failing at baseline but passing after the sprint:
    `testnetDepositDeployer.r179l14d.test.js` (network-dependent;
    environment flake, not sprint-related),
  - failing after the sprint but passing at baseline: **NONE — zero
    regressions**,
  - all other failing files are identical to the pre-existing baseline
    failures.

## Focused suites (exact test counts, after the sprint)

| Suite | Result |
| --- | --- |
| `roomWalletSettlement.recipientPaysGas.test.js` (NEW, tests A–K + C2/E2) | 13 pass / 0 fail |
| `roomWalletSettlement.seqnoSequencing.test.js` | 13 pass / 0 fail (31 → confirmed → 32 intact) |
| `roomWalletSettlementAdapter.test.js` | 24 pass / 1 fail — the single failure (`refund-2` vs `refund-1` tx-hash counter) is byte-identical to the pre-existing failure at HEAD 77efbba (verified by running the HEAD file in the baseline worktree: 24 pass / 1 fail, same assertion) |
| `roomWalletTerminalSettlementRecovery.r18s82.test.js` | 17 pass / 0 fail |
| `roomWalletSettlement.r18s75.test.js` | 7 pass / 0 fail |
| `roomWalletResidualSweep.test.js` | 19 pass / 0 fail (sweep semantics unchanged) |
| `roomWalletFinancialPolicy.test.js` | 1 pass / 0 fail |
| `roomWalletService.test.js` | 2 pass / 0 fail |
| `creatorLeftRoomWalletRefund.test.js` | 1 pass / 0 fail |

Pre-existing failing suites verified identical before/after (exit codes and
failure counts):

- `roomWalletSettlement.r18s83.retryable.test.js` (2 pass / 8 fail at HEAD,
  2 pass / 8 fail after),
- `roomWalletSettlement.r18s80.uhquHandoff.test.js` (0 pass / 2 fail at HEAD,
  0 pass / 2 fail after),
- `roomNumberWalletMapping.test.js` (5 pass / 3 fail at HEAD, 5 pass / 3
  fail after),
- `setupExpiryRoomWalletRefund.test.js` (pre-existing non-exiting process at
  HEAD, reproduced after; its assertions pass before the hang),
- the remaining 50+ failing files (`auditEngine`, `contractSettlement.manager`,
  GameEscrow E2E suites, gameplay/production integration suites, etc.) fail
  identically at HEAD and after the sprint (see the full-suite set-difference
  above: zero new failures).

## Requirement-mapping of the new A–K suite

- A — winner gross unchanged, net = gross − gas charge, plan evidence.
- B — owner gross share unchanged, 0.01 GRAM retention preserved,
  net = share − retention − gas charge.
- C/C2 — refund net = refundable − gas charge; exact net frozen in
  `recoveryMetadata.refundPlan` BEFORE broadcast (persist-before-broadcast
  ordering asserted via the persisted-session spy); recovery reuses the
  frozen net without re-estimation; idempotent adoption on retry.
- D — fee-estimation unavailability fails closed (settlement AND refunds):
  no source-paid fallback, zero broadcasts.
- E/E2 — gas charge ≥ payout fails closed (strict positivity, equality
  boundary), no zero-value broadcast; tampered frozen plan is a
  non-retryable safety failure.
- F — recovery reuses the exact persisted net amounts, performs zero fee
  estimations on retry, and plan computation is byte-identical across runs.
- G — partial settlement sends ONLY the missing owner payout at its
  persisted net value; the winner is never resent.
- H — seqno sequencing 31 → confirmed → 32 holds under the gas policy.
- I — 25 consecutive completed games starting from EXACTLY the 0.01 GRAM
  pre-funded reserve: the reserve is never consumed (balance strictly grows;
  final balance = reserve + 25 × (retention + gas-charge surplus)); every
  game's pot funds its own fees — coordinated repetition cannot drain the
  reserve.
- J — residual sweep keeps SOURCE_PAYS_GAS: exact 0.49 GRAM recipient value,
  0.01 GRAM source envelope, fee paid by the source wallet itself.
- K — conservation: pot = winner net + owner net + owner retention + actual
  fees + residual remainder (exact BigInt identity), and the wallet balance
  identity matches observation.



