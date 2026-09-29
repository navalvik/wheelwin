# Stage 1 — Mainnet Preparation: Validate and Finalize the Room-Wallet Restore/Refund Fix

Date: 2026-09-27

Task: Validate and finalize the pre-existing uncommitted working-tree change
(`server/gameplay/PaymentSessionManager.js` modified, untracked
`server/tests/restoreRoomWalletRefund.test.js`) before any Mainnet
implementation. Read-only context per `.clinerules` was completed first.

---

## 1. Objective

- Determine exactly what problem the existing uncommitted change solves.
- Validate it with the smallest relevant focused test set.
- Correct it only if the implementation was incomplete or incorrect.
- Confirm the architecture rules hold (Room Wallet intake → server-side
  observation → ledger validation → settlement/refund; no smart-contract
  payment path).
- Review the final diff and create exactly one commit
  (`fix(recovery): finalize room wallet refund restore`), no push.

## 2. Existing Change Reviewed

Context documents read: `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`,
`AI_CONTEXT/ARCHITECTURE_RULES.md`, `AI_CONTEXT/CURRENT_STATE.md`,
`AI_CONTEXT/AI_WORKING_RULES.md`, plus prior reports:
`2026-09-27_stage0_local_baseline_audit.md`,
`2026-09-27_payment_session_restore_room_wallet_refund_gap.md`,
`2026-09-27_xsdd_live_setup_expiry_refund_forensic.md`,
`2026-09-26_xsd_page5_start_authorization_setup_expiry_refund_fix.md`.

Files inspected:

- `server/gameplay/PaymentSessionManager.js` — `restorePaymentSessions()`
  (716–869), `_finalizePartialPaymentUnwind()` (1462–1516),
  `_requestRoomWalletPartialPaymentRefund()` (1961–2074), `failSession()`
  (2076+).
- `server/gameplay/partialPaymentEscrowUnwind.js` — decision helpers.
- `server/gameplay/PaymentSessionStates.js` — lifecycle transitions, terminal
  and in-progress sets.
- `server/models/PaymentSession.js` — `markRefundPending()` usage context.
- `server/tests/restoreRoomWalletRefund.test.js` (new, full read).
- Failing regions of `paymentSession.manager.test.js`,
  `financialPersistence.wiring.r810.test.js`,
  `setupSessionRestartRearm.test.js`, `tonFinancialRecovery.test.js`,
  `roomWalletSettlementAdapter.test.js`.
- `server/scripts/run-tests.js`, `server/package.json` (test commands).

### 2.1 Problem the change solves (confirmed against the gap analysis)

Two barriers stranded Room Wallet player funds after a server restart:

1. **Gate 1 (terminal skip).** `restorePaymentSessions()` skipped every
   terminal session (`FULLY_PAID` is terminal) unless `CANCELLED`, so a
   persisted FULLY_PAID (3/3 confirmed) session with unrefunded paid funds was
   never re-indexed into `_sessionsByRoom`; `getSession(roomId)` returned null
   forever and no later expiry/creator-left event could refund it.
2. **Gate 2 (refund re-request condition).** The condition used the
   escrow-era helper `sessionNeedsEscrowUnwind()`, which returns `false` when
   `allConfirmed()` — so an all-confirmed session could never re-enter the
   refund chain, and a persisted REFUND_PENDING mid-unwind session whose
   participants were all already refunded (refund broadcast completed, crash
   before finalize) could never be finalized.

### 2.2 What the change does

All inside `restorePaymentSessions()` only:

1. Adds `refundableRestoredFullyPaid` (intake-enabled AND status FULLY_PAID
   AND `sessionHasUnrefundedPaidFunds(session)`) and lets such sessions
   survive the terminal skip.
2. Keeps those sessions FULLY_PAID instead of rewriting to RECOVERED, because
   `RECOVERED → REFUND_PENDING` is not an allowed transition while
   `FULLY_PAID → REFUND_PENDING` is legal since R18.XSDd
   (`PaymentSessionStates.js` 45–52); `_requestRoomWalletPartialPaymentRefund()`
   then performs the transition itself via `markRefundPending()`.
3. Replaces `sessionNeedsEscrowUnwind(session)` in the refund re-request
   condition with `sessionHasUnrefundedPaidFunds(session)` (strict superset
   for intake sessions; bit-identical for 1–2/3 partial sessions) OR the
   completed-unwind case `REFUND_PENDING && allConfirmedParticipantsRefunded()`,
   which re-enters the existing refund function so its ALREADY_REFUNDED branch
   finalizes via `_finalizePartialPaymentUnwind()` with no new broadcast.

The change reuses the entire existing refund machinery
(`_requestRoomWalletPartialPaymentRefund` → `buildPartialPaymentRefundTargets`
→ `RoomWalletSettlementAdapter.refundPayments` → `_finalizePartialPaymentUnwind`
→ CANCELLED + `PAYMENT_SESSION_FAILED`). No new refund engine, no smart-contract
path, `failSession()` and all legacy escrow branches untouched, and every new
behaviour is gated on `_roomWalletPaymentIntakeEnabled` (fail-closed: with
intake disabled the restore decision is unchanged, verified by test case E).

## 3. Tests Executed

Focused set (per the gap report §7 and the task's topic list), run directly
with node (repository command `npm test` in `server/` runs the whole suite;
focused files were run individually per the task's "smallest relevant set"
rule):

- `server/tests/restoreRoomWalletRefund.test.js` (NEW — restore of payment
  sessions; FULLY_PAID restored after restart; mid-unwind partial refund;
  idempotent completed-unwind finalize; partial-paid regression guard;
  intake-disabled fail-closed guard)
- `server/tests/paymentSession.model.test.js` (state machine incl. the
  FULLY_PAID → REFUND_PENDING transition)
- `server/tests/partialPaymentEscrowUnwind.test.js` (decision helpers)
- `server/tests/creatorLeftRoomWalletRefund.test.js` (creator-left refund)
- `server/tests/setupExpiryRoomWalletRefund.test.js` (setup expiry refund,
  incl. FULLY_PAID all-refunded idempotency)
- `server/tests/setupSession.paymentExpiry.r770c23.test.js` (payment
  timeout/expiry)
- Regression candidates that failed and were additionally classified against
  committed HEAD `dfa8832` (see §4): `paymentSession.manager.test.js`,
  `financialPersistence.wiring.r810.test.js`, `tonFinancialRecovery.test.js`,
  `roomWalletSettlementAdapter.test.js`, `setupSessionRestartRearm.test.js`.

Verification method for the failures: `git stash push` of only
`server/gameplay/PaymentSessionManager.js`, re-run of the failing suites
against HEAD, `git stash pop`, and comparison of the assertion signatures
(line + expected/actual values). The working tree was verified restored after
each pop (stash list empty, file back to modified state).

## 4. Test Results

PASSING with the change applied (exit code 0):

| Suite | Result |
|---|---|
| `restoreRoomWalletRefund.test.js` (new) | PASS — cases A–E all pass; re-run after stash round-trip also PASS |
| `paymentSession.model.test.js` | PASS |
| `partialPaymentEscrowUnwind.test.js` | PASS |
| `creatorLeftRoomWalletRefund.test.js` | PASS |
| `setupExpiryRoomWalletRefund.test.js` | PASS |
| `setupSession.paymentExpiry.r770c23.test.js` | PASS |

FAILING — diagnosed as PRE-EXISTING on committed HEAD `dfa8832`
(identical assertion line and values with the change stashed; NOT caused by
this change):

| Suite | Failure (same on HEAD) |
|---|---|
| `paymentSession.manager.test.js` | line 396 — legacy lobby-flow block: session creation rejected ("Room Wallet address is required for player payment"), `0 !== 1` |
| `financialPersistence.wiring.r810.test.js` | line 490 — legacy escrow contract creation: `PaymentValidationError: Contract not ready for payments / status=DEPLOYING` |
| `tonFinancialRecovery.test.js` | line 495 — `0 !== 1` |
| `roomWalletSettlementAdapter.test.js` | line 500 — partial refund txHash `'refund-2'` vs `'refund-1'` |
| `setupSessionRestartRearm.test.js` | line 244 — setup-session (SetupSessionLifecycle, not payment sessions) restore `0 !== 1` |

These are legacy-era suites whose harnesses predate the Room-Wallet intake
requirements (R18) or that exercise the separate setup-session restart repair
from commits `53fe3ba`/`dfa8832`; they fail identically without the change and
are out of scope for this stage (the task forbids unrelated cleanup and broad
refactors).

## 5. Changes Made

**No application code changes were necessary.** The existing implementation
was already complete and correct for the restore/refund problem:

- Gate conditions verified against `PaymentSessionStates.js` transitions.
- Idempotency verified: persisted per-participant `refunded` flags, persisted
  `recoveryMetadata.refundRequestedAt` cutoff, adapter on-chain dedup, and the
  no-broadcast ALREADY_REFUNDED finalize path.
- The third refund-condition conjunct (REFUND_PENDING / deadline passed /
  room gone) correctly defers to the live setup-expiry and creator-left paths
  for a restored FULLY_PAID session whose room legitimately still exists
  pre-GAME_INITIALIZED.
- New behaviour is strictly intake-gated (fail-closed), matching the Recovery
  Domain "never invent state" rule.

No files were modified; the pre-existing change was validated as-is and
committed together with its test file.

## 6. Final Diff Scope

Committed diff (HEAD `0d3f93a` vs parent `dfa8832`):

- `server/gameplay/PaymentSessionManager.js` — 24 insertions, 2 deletions,
  entirely inside `restorePaymentSessions()` (the three items in §2.2).
- `server/tests/restoreRoomWalletRefund.test.js` — new file (585 lines), the
  focused A–E suite for the validated fix.

Checks performed before commit:

- `git diff` reviewed — only the restore/refund fix is present.
- No secrets, no credentials, no `.env` files modified.
- No Mainnet implementation, Page2/Page4, Room Network selection (R20/R24
  handoff), wallet catalog, or deployment configuration touched.
- No GameEscrow / DepositContract / DepositPackage flow restored, activated,
  or reconnected; legacy `failSession()` escrow branch untouched.
- No unrelated untracked reports included in the commit.

## 7. Commit Result

- Commit: `0d3f93a` — `fix(recovery): finalize room wallet refund restore`
- Branch: `payment/room-wallet-integration` (parent `dfa8832`)
- Files: `server/gameplay/PaymentSessionManager.js`,
  `server/tests/restoreRoomWalletRefund.test.js`
- Statistics: 2 files changed, 609 insertions(+), 2 deletions(-)
- **Not pushed** — per task instructions, GitHub synchronization is deferred
  until the local Mainnet preparation stages are complete
  (`origin/payment/room-wallet-integration` still at `dfa8832`).

## 8. Remaining Working-Tree Changes

After the commit the working tree contains only the pre-existing untracked
2026-09-27 report files (intentionally NOT committed, per task Step 5):

- `AI_CONTEXT/CLINE_REPORTS/2026-09-27_stage0_local_baseline_audit.md`
- `AI_CONTEXT/CLINE_REPORTS/2026-09-27_payment_session_restore_room_wallet_refund_gap.md`
- `AI_CONTEXT/CLINE_REPORTS/2026-09-27_gameescrow_depositcontract_remaining_links_analysis.md`
- `AI_CONTEXT/CLINE_REPORTS/2026-09-27_setup_session_restart_rearm_analysis.md`
- `AI_CONTEXT/CLINE_REPORTS/2026-09-27_stage1_recovery_identity_inspection.md`
- `AI_CONTEXT/CLINE_REPORTS/2026-09-27_stage2_recovery_credential_repair.md`
- `AI_CONTEXT/CLINE_REPORTS/2026-09-27_stage3_final_validation_commit_push.md`
- `AI_CONTEXT/CLINE_REPORTS/2026-09-27_xsdd_live_setup_expiry_refund_forensic.md`

(plus this report). No modified tracked files remain; no stash entries exist.

## 9. Recommendation for the Next Stage

1. The five pre-existing baseline test failures (§4) should be triaged in a
   dedicated, approved stage before Mainnet: decide per suite whether to
   repair the harness (Room-Wallet intake requirements) or retire the legacy
   escrow-era expectations. Highest value first:
   `roomWalletSettlementAdapter.test.js` (refund idempotency evidence) and
   `tonFinancialRecovery.test.js` (recovery entry). Do not fix them inside a
   Mainnet stage.
2. Consider the forensic report's follow-up: add a regression test modelling
   the full incident (FULLY_PAID + SERVER_SHUTDOWN + fresh boot + restore +
   players gone → refunds re-requested and room closed), extending
   `restoreRoomWalletRefund.test.js`.
3. Keep all legacy residue per the Stage 0 residue analysis; no cleanup during
   Mainnet stages.
4. Proceed with the next Mainnet preparation stage only after the Stage 0
   §15/§17 items are approved; do not modify the R22/R24 handoff or the wallet
   catalog in the same stage as any other change.

## Changes Made (per .clinerules)

- Validated (not modified) the pre-existing `PaymentSessionManager.js` change
  and committed it with its test file as `0d3f93a`.
- Created exactly one report file:
  `AI_CONTEXT/CLINE_REPORTS/2026-09-27_stage1_room_wallet_refund_restore_validation.md`
  (this report).
- No other files created or modified; nothing pushed.




