# Mainnet Delivery of the Validated Recipient-Pays-Gas Implementation

Date: 2026-10-02

Task: Merge the Testnet-validated recipient-pays-gas implementation branch
`testnet/recipient-pays-gas-validation` into the Mainnet branch
`payment/room-wallet-integration` (Railway Auto Deploy enabled), preserving the
existing Mainnet Railway deployment-trigger commit, without redesigning the
payment architecture, without force operations, and without triggering any
manual Mainnet deployment. Validate with the focused payment/settlement suites
and compare against the documented Testnet baseline.

## 1. Scope

- Git state inspection (branch refs, SHAs, merge-base, per-side deltas).
- Controlled non-force merge of the validated Testnet branch into the Mainnet
  branch.
- Merged-diff verification of the required invariants (recipient-pays-gas
  architecture, sequential seqno protection, Railway trigger preservation,
  Owner minimum / 0.01 GRAM retention / 0.01 GRAM reserve policy, residual
  sweep source-pays-gas semantics, absence of a smart-contract player-payment
  path, absence of unrelated refactoring).
- Focused test execution and baseline comparison.
- Mandatory delivery report, commit, and branch push (push only; no deploy).

## 2. Files Inspected

- AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md
- AI_CONTEXT/ARCHITECTURE_RULES.md
- AI_CONTEXT/CURRENT_STATE.md
- AI_CONTEXT/AI_WORKING_RULES.md
- AI_CONTEXT/CLINE_REPORTS/2026-09-30_recipient_pays_gas_architecture.md
- AI_CONTEXT/CLINE_REPORTS/2026-10-01_testnet_recipient_pays_gas_branch_delivery.md
  (the documented Testnet test baseline used for comparison)
- git refs/logs/diffs: `payment/room-wallet-integration`,
  `origin/payment/room-wallet-integration`,
  `testnet/recipient-pays-gas-validation`,
  `origin/testnet/recipient-pays-gas-validation`, merge-base, `a24fdba` commit
- server/payment/roomWallet/RoomWalletFinancialPolicy.js (merged content + diff)
- server/payment/roomWallet/RoomWalletSettlementAdapter.js (merged content)
- server/payment/ContractSettlementManager.js (merged diff)
- server/payment/RoomWalletSettlementRouter.js (merged diff)

## 3. Architecture Findings

### 3.1 Git topology (verified)

- Common ancestor: `77efbba00dc89c424a3fa28d1064c0f36780d900`
  (`fix(room-wallet): enforce sequential payout seqno confirmation`).
- Original Mainnet state: local `payment/room-wallet-integration` pointed at
  the ancestor `77efbba`; the remote ref pointed at `a24fdba6c26fb177a7b7d568a5b821d57d23754e`
  (`chore(deploy): trigger Mainnet deployment for seqno fix`, pushed by the
  repository owner). `a24fdba` is exactly one commit ahead of the ancestor and
  adds ONLY `.railway-deploy-trigger-20260930.txt` (2 insertions; content:
  "Railway deployment trigger only. No application or configuration changes.
  Parent application commit: 77efbba00dc89c424a3fa28d1064c0f36780d900").
  Confirmed via `git log 77efbba..origin/payment/room-wallet-integration` and
  `git diff --stat 77efbba origin/payment/room-wallet-integration`.
- Testnet validated branch: `testnet/recipient-pays-gas-validation` =
  `6e034add5aa266b15d1b27c71d87dd4c5455b4c8` (local = remote), containing
  implementation commit `d754a62a914bfd1178615fc4d59f06e4646e0c8b`
  (`feat(payment): validate recipient pays gas on testnet`, parent `77efbba`)
  plus the Testnet delivery report commit `6e034add`.
- The local Mainnet branch was fast-forwarded `77efbba` → `a24fdba`
  (`git merge --ff-only origin/payment/room-wallet-integration`) so the local
  ref matches the remote deployment-trigger lineage exactly. Nothing was
  discarded, reset, or overwritten.

### 3.2 Merge result

- `git merge --no-edit testnet/recipient-pays-gas-validation` (on
  `payment/room-wallet-integration`, after the fast-forward) completed with the
  `ort` strategy.
- Merge commit: `c4ca8aabebe09168ce3077f579279f78f4eaff12`
  - parent 1: `a24fdba6c26fb177a7b7d568a5b821d57d23754e` (Mainnet lineage,
    preserved),
  - parent 2: `6e034add5aa266b15d1b27c71d87dd4c5455b4c8` (Testnet validated
    HEAD).
- Merge conflicts: NONE.
- `git diff --name-status a24fdba..c4ca8aa` = exactly the Testnet delivery
  file set listed in §3.4. `git diff --name-status 77efbba..c4ca8aa` = those
  files plus `.railway-deploy-trigger-20260930.txt`. No other files changed,
  no deletions of Mainnet content, no unrelated refactoring.
- The final Mainnet branch tip at push time is the commit that adds this
  report (direct child of the merge commit). No commits were made after the
  push.

### 3.3 Verified invariants (merged tree)

1. Recipient-pays-gas architecture: PRESENT — `PAYOUT_GAS_MODE`
   (`RECIPIENT_PAYS_GAS` / `SOURCE_PAYS_GAS`), `PAYOUT_GAS_POLICY_VERSION`,
   `PAYOUT_GAS_PLAN_CODES`, `buildRecipientGasCharge`,
   `buildRecipientPaysGasTransfer`, strict persisted-value parsers
   (`parseNanoString`, `nanoToPersistedString`) in
   `RoomWalletFinancialPolicy.js`; plan freezing / fail-closed boundaries in
   `RoomWalletSettlementAdapter.js` and compute-only `planSettlement`
   passthrough in `RoomWalletSettlementRouter.js`.
2. Sequential seqno protection: PRESENT — merged
   `RoomWalletSettlementAdapter.js` keeps the "SEQUENTIAL SETTLEMENT SAFETY"
   gating: winner payout confirmed via `confirmPayoutOnChain` before the Owner
   payout is submitted (~line 998, ~1437); completion requires positive
   on-chain Owner confirmation. `roomWalletSettlement.seqnoSequencing.test.js`
   passes 13/13 on the merged tree.
3. Existing Mainnet Railway trigger content: PRESERVED —
   `.railway-deploy-trigger-20260930.txt` exists in the merged HEAD with
   unchanged content; `a24fdba` remains a first-parent ancestor.
4. Owner minimum semantics: UNCHANGED — `ownerPayoutMinimumNano:
   140_000_000n` is an untouched context line in the policy diff; only the
   comment was clarified (Owner gross share ≥ 0.14 GRAM; the recipient gas
   charge reduces the transfer value, not the economic gross share).
5. 0.01 GRAM Owner retention: UNCHANGED — `ownerRetainedNano: 10_000_000n`
   untouched.
6. 0.01 GRAM Room Wallet reserve policy: UNCHANGED —
   `initialRoomReserveNano: 10_000_000n` untouched.
7. Residual sweep source-pays-gas: UNCHANGED — `buildResidualSweep` is pure
   context in the policy diff (only additions AFTER the function); sweep keeps
   `SOURCE_PAYS_GAS` economics (0.49 GRAM recipient value, 0.01 GRAM source
   envelope, source-funded fee). `roomWalletResidualSweep.test.js` 19/19 and
   recipient-pays-gas test J confirm.
8. No smart-contract player-payment path reintroduced: CONFIRMED — the merged
   `ContractSettlementManager.js` diff contains zero lines touching
   GameEscrow/escrow/v4/smart-contract/deploy paths; player payouts and
   refunds route through the Room Wallet settlement path
   (`RoomWalletSettlementRouter` acting as the CSM settlement adapter); the
   only-player-payment test file (`roomWalletOnlyPlayerPayment.r18s72.test.js`)
   is unchanged from the Mainnet lineage.
9. No unrelated refactoring: CONFIRMED — the merged diff is byte-identical to
   the validated Testnet delivery set (§3.4).

### 3.4 Exact files changed by the recipient-pays-gas delivery (merge content)

Added (6):

- AI_CONTEXT/CLINE_REPORTS/2026-09-30_mainnet_19a88f7_deployment.md
- AI_CONTEXT/CLINE_REPORTS/2026-09-30_recipient_pays_gas_architecture.md
- AI_CONTEXT/CLINE_REPORTS/2026-09-30_room_wallet_sequential_settlement_seqno_git_delivery.md
- AI_CONTEXT/CLINE_REPORTS/2026-09-30_vercel_mainnet_872562d_production_promotion.md
- AI_CONTEXT/CLINE_REPORTS/2026-10-01_testnet_recipient_pays_gas_branch_delivery.md
- server/tests/roomWalletSettlement.recipientPaysGas.test.js

Modified (12):

- server/gameplay/PaymentSessionManager.js
- server/payment/ContractSettlementManager.js
- server/payment/RoomWalletSettlementRouter.js
- server/payment/roomWallet/ROOM_WALLET_RUNTIME.md
- server/payment/roomWallet/RoomWalletAdapter.js
- server/payment/roomWallet/RoomWalletFinancialPolicy.js
- server/payment/roomWallet/RoomWalletService.js
- server/payment/roomWallet/RoomWalletSettlementAdapter.js
- server/payment/roomWallet/RoomWalletTerminalSettlementRecovery.js
- server/payment/roomWallet/roomWalletTerminalRecoveryChain.js
- server/services/TonService.js
- server/tests/roomNumberWalletMapping.test.js
- server/tests/roomWalletSettlement.r18s75.test.js
- server/tests/roomWalletSettlement.r18s80.uhquHandoff.test.js
- server/tests/roomWalletSettlement.seqnoSequencing.test.js
- server/tests/roomWalletSettlementAdapter.test.js

(6 added + 10 modified code/doc paths = the Testnet implementation set, plus
the 6 report files that travelled with the validated branch; the authoritative
enumeration is `git diff --name-status a24fdba..c4ca8aa`.)

## 4. Lifecycle Flow

1. Common ancestor `77efbba` (seqno fix) — shared by both branches.
2. Mainnet side: `a24fdba` (Railway trigger file only).
3. Testnet side: `d754a62` (validated implementation) → `6e034add` (Testnet
   delivery report). A real Testnet game completed on this code before this
   delivery (winner NET + Owner NET received on-chain, settlement completed,
   Room Wallet economics matched the recipient-pays-gas model).
4. This task: fast-forward local Mainnet ref to `a24fdba`, then merge
   `6e034add` → merge commit `c4ca8aa`; report commit added on top; push of
   the branch ref only.

## 5. Ownership Boundaries

- No architectural or ownership change: PaymentSessionManager,
  ContractSettlementManager, RoomWalletSettlementRouter, RoomWalletService,
  RoomWalletAdapter, RoomWalletSettlementAdapter,
  RoomWalletTerminalSettlementRecovery, roomWalletTerminalRecoveryChain,
  TonService keep their existing responsibilities; the delivery only adds the
  recipient-pays-gas economic layer and frozen-plan persistence inside the
  existing modules. Server authority, deterministic gameplay, and financial
  verification paths are untouched.

## 6. Risks

- Critical: none found.
- High: none found.
- Medium: pushing `payment/room-wallet-integration` may trigger the Mainnet
  Railway Auto Deploy (it watches this branch). This is inherent to delivering
  the branch and was explicitly acknowledged; no manual deploy was performed.
  The merged code is the same code that completed a real Testnet game.
- Low: the three pre-existing failing suites (adapter 1 fail, r18s80 2 fails,
  mapping 3 fails) remain documented, identical to the baseline; per the task
  they were NOT "fixed" here.
- Low: pre-existing untracked working-tree files
  (`AI_CONTEXT/CLINE_REPORTS/2026-10-01_testnet_railway_source_branch_switch.md`,
  `_stage2_tmp_out.txt`) were left untracked and were NOT committed (not part
  of this task's mandated content).

## 7. Recommendations

- Observe the (possibly auto-triggered) Railway deployment of this branch on
  the Railway dashboard; verify the deployed commit hash equals the final
  Mainnet branch SHA.
- Keep the documented pre-existing failures in the baseline report until a
  dedicated task addresses them.
- Consider committing the currently untracked
  `2026-10-01_testnet_railway_source_branch_switch.md` in a dedicated docs
  commit for traceability.

## 8. Changes Made

- Fast-forwarded local `payment/room-wallet-integration` `77efbba` → `a24fdba`
  (ref sync only; no content change beyond the pre-existing remote commit).
- Merge commit `c4ca8aabebe09168ce3077f579279f78f4eaff12` merging
  `6e034add5aa266b15d1b27c71d87dd4c5455b4c8` into
  `payment/room-wallet-integration` (no conflicts).
- This report, committed on `payment/room-wallet-integration` directly on top
  of the merge commit.
- No source file, test file, configuration file, environment variable,
  Railway/Vercel setting, or deployment action was changed or executed by this
  task. No force-push, no manual Railway redeploy, no Railway configuration
  change, no Mainnet/Vercel deployment command.

## 9. Required Confirmations

1. Common ancestor SHA: `77efbba00dc89c424a3fa28d1064c0f36780d900`.
2. Original Mainnet branch SHA: `a24fdba6c26fb177a7b7d568a5b821d57d23754e`
   (remote; local ref was at the ancestor `77efbba` before the controlled
   fast-forward sync).
3. Testnet validated branch SHA: `6e034add5aa266b15d1b27c71d87dd4c5455b4c8`.
4. Merge result SHA: `c4ca8aabebe09168ce3077f579279f78f4eaff12` (final branch
   tip = the commit containing this report, child of the merge commit).
5. Merge conflicts: NONE.
6. Tests: see §10.
7. Testnet validation completed BEFORE this delivery: CONFIRMED — a real
   Testnet game completed and settled on `6e034add` (implementation
   `d754a62`), with winner/Owner NET payouts received on-chain, and the
   committed Testnet delivery report
   (`2026-10-01_testnet_recipient_pays_gas_branch_delivery.md`, included in
   the merge) documents the focused-suite baseline.
8. Mainnet Railway deployment NOT manually triggered: CONFIRMED — no deploy
   command, no Railway mutation, no service/environment action of any kind was
   executed. (The push itself may arm the existing Auto Deploy watcher on this
   branch; that is a pre-existing repository setting, not an action of this
   task.)
9. No Railway variables/configuration changed: CONFIRMED.
10. No Mainnet/Vercel deployment performed: CONFIRMED — no manual deployment
    command of any kind was executed.

## 10. Focused Test Results (merged tree, `node tests/<file>` from `server/`)

| Suite | Result | Documented Testnet baseline | Verdict |
| --- | --- | --- | --- |
| roomWalletSettlement.recipientPaysGas.test.js | tests 13 / pass 13 / fail 0 | 13 / 0 | MATCH |
| roomWalletSettlement.seqnoSequencing.test.js | tests 13 / pass 13 / fail 0 | 13 / 0 | MATCH |
| roomWalletTerminalSettlementRecovery.r18s82.test.js (terminal recovery) | tests 17 / pass 17 / fail 0 | 17 / 0 | MATCH |
| roomWalletResidualSweep.test.js (residual sweep) | tests 19 / pass 19 / fail 0 | 19 / 0 | MATCH |
| roomWalletSettlementAdapter.test.js (settlement adapter) | tests 25 / pass 24 / fail 1 — `refund-2` vs `refund-1` tx-hash counter at roomWalletSettlementAdapter.test.js:543 | 24 / 1, same assertion | MATCH (pre-existing) |
| roomWalletSettlement.r18s75.test.js | tests 7 / pass 7 / fail 0 | 7 / 0 | MATCH |
| roomWalletFinancialPolicy.test.js (financial policy) | OK (1 pass / 0 fail) | 1 / 0 | MATCH |
| roomWalletService.test.js (Room Wallet service) | tests 2 / pass 2 / fail 0 | 2 / 0 | MATCH |
| creatorLeftRoomWalletRefund.test.js (creator-left refund) | cases A–E passed | 1 / 0 | MATCH |
| roomWalletSettlement.r18s80.uhquHandoff.test.js | tests 2 / pass 0 / fail 2 — "adapter must receive the CSM request" (0 !== 1); SETTLEMENT_FAILED vs READY retryability | 0 / 2, same classes | MATCH (pre-existing, unchanged) |
| roomNumberWalletMapping.test.js | tests 8 / pass 5 / fail 3 | 5 / 3 | MATCH (pre-existing, unchanged) |

Zero new failures versus the documented Testnet baseline. All three failing
suites fail byte-identically (same assertion, same expected/actual values) to
the documented pre-existing baseline and were deliberately not "fixed".

## 11. Documentation Cleanup

Date: 2026-10-02

Task: Documentation-only cleanup of the CLINE report set carried on the
Mainnet branch `payment/room-wallet-integration`, keeping exactly ONE report
for this delivery stage. No source, test, package, Railway/Vercel
configuration, or environment changes; `.railway-deploy-trigger-20260930.txt`
untouched; the Testnet branch untouched; no reset, no rebase, no force-push.

- Cleanup commit: `docs(mainnet): keep single current delivery report` — the
  single commit directly on top of
  `78d6066812a5f383aa93d070a9d74497a7f7787c` (`docs(mainnet): record
  recipient-pays-gas delivery merge report`), containing this section together
  with the five deletions listed below. A commit cannot contain its own hash;
  the exact SHA of this cleanup commit is the post-push branch tip of
  `payment/room-wallet-integration` and is recorded in the delivery handoff
  response.
- Deleted historical reports (five):
  1. `AI_CONTEXT/CLINE_REPORTS/2026-09-30_mainnet_19a88f7_deployment.md`
  2. `AI_CONTEXT/CLINE_REPORTS/2026-09-30_recipient_pays_gas_architecture.md`
  3. `AI_CONTEXT/CLINE_REPORTS/2026-09-30_room_wallet_sequential_settlement_seqno_git_delivery.md`
  4. `AI_CONTEXT/CLINE_REPORTS/2026-09-30_vercel_mainnet_872562d_production_promotion.md`
  5. `AI_CONTEXT/CLINE_REPORTS/2026-10-01_testnet_recipient_pays_gas_branch_delivery.md`
- Single retained report: `2026-10-02_mainnet_recipient_pays_gas_delivery.md`
  (this file) is the ONLY CLINE report retained for this Mainnet
  recipient-pays-gas delivery set; no historical reports brought in by the
  Testnet delivery merge remain in it.
- No runtime/application files changed: this cleanup commit touches ONLY
  documentation files under `AI_CONTEXT/CLINE_REPORTS/`.
- No manual deployment was executed: no Railway deploy command, no Vercel
  deploy command, no Railway/Vercel configuration or variable mutation.
- The GitHub push of this cleanup commit may have triggered the existing
  Railway Mainnet Auto Deploy watcher on `payment/room-wallet-integration`;
  the change is documentation-only with no runtime impact.


