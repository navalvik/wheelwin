# Stage 1.1 — Financial Test Triage: Room-Wallet Refund and Recovery (READ-ONLY)

Date: 2026-09-27

Task: READ-ONLY forensic triage of two pre-existing failing financial test
suites before Mainnet implementation —
`server/tests/roomWalletSettlementAdapter.test.js` (failure `'refund-2'`
vs `'refund-1'` at line 500) and `server/tests/tonFinancialRecovery.test.js`
(failure `0 !== 1` at line 495). Both failures were previously established as
reproducible on committed HEAD `dfa8832` (Stage 1 report §4), i.e. they are
not caused by Stage 1 commit `0d3f93a`.

**No application code, tests, configuration or deployment files were
modified. Nothing was committed. Nothing was pushed. No Mainnet
implementation was performed. No smart-contract payment path was restored,
activated or reconnected. The only file created by this stage is this
report.**

---

## 1. Objective

Determine for each failing suite whether the failure is (A) a genuine defect
in the current Room-Wallet production implementation, (B) an outdated test
expectation, (C) a stale mock/fixture, (D) a legacy escrow-era expectation,
(E) an unrelated pre-existing regression, or (F) undetermined — using exact
failure output, production code paths, test fixtures, git history and
out-of-repo reproduction experiments as evidence. No changes were made.

## 2. Scope

- The two named test suites (run individually with the repository's own test
  mechanism — the suites are plain `node:test` files, executed here exactly
  as `server/scripts/run-tests.js` executes them: `node <test-file>`).
- Production paths under test:
  `server/payment/roomWallet/RoomWalletSettlementAdapter.js` (`refundPayments`),
  `server/payment/roomWallet/roomWalletTerminalRecoveryChain.js`
  (`confirmPayoutOnChain`, `extractOutboundTransfers`),
  `server/payment/roomWallet/RoomWalletFinancialPolicy.js`,
  `server/recovery/TonFinancialRecovery.js` (full recovery pipeline),
  and the production refund caller
  `server/gameplay/PaymentSessionManager._requestRoomWalletPartialPaymentRefund`.
- Git history of the four relevant files (read-only `git log` / `git show` /
  `git diff dfa8832 HEAD --stat`).
- Two diagnostic reproductions executed from `C:\Users\Public` (outside the
  repository) importing the production modules read-only.

Out of scope (per task): Page2/Page4/Page5, network selection, Room Network
handoff, wallet catalogs, PaymentSession network propagation, wallet routing,
deployment (Railway/Vercel/GitHub), GameEscrow / DepositContract /
DepositPackage implementation, legacy cleanup.

## 3. Files Inspected

Context documents (per `.clinerules`):

- `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`
- `AI_CONTEXT/ARCHITECTURE_RULES.md`
- `AI_CONTEXT/CURRENT_STATE.md`
- `AI_CONTEXT/AI_WORKING_RULES.md`
- Prior reports: `AI_CONTEXT/CLINE_REPORTS/2026-09-27_stage1_room_wallet_refund_restore_validation.md`,
  `AI_CONTEXT/CLINE_REPORTS/2026-09-27_stage0_local_baseline_audit.md`
  (+ report directory inventory)

Source and tests:

- `server/tests/roomWalletSettlementAdapter.test.js` (full, 537 lines)
- `server/tests/tonFinancialRecovery.test.js` (full, 748 lines)
- `server/payment/roomWallet/RoomWalletSettlementAdapter.js` (full, 761 lines)
- `server/payment/roomWallet/roomWalletTerminalRecoveryChain.js` (full)
- `server/payment/roomWallet/RoomWalletFinancialPolicy.js` (policy section)
- `server/recovery/TonFinancialRecovery.js` (full, 1375 lines)
- `server/gameplay/PaymentSessionManager.js` (1961–2074, refund request)
- `server/gameplay/PaymentSessionStates.js`, `server/models/PaymentSession.js`
  (import/lifecycle context)
- `server/scripts/run-tests.js`, `server/package.json` (test mechanism)

Git (read-only):

- `git log` for the four relevant files
- `git show 2daadcd` ( TonFinancialRecovery.js diff, 12 insertions / 515 deletions)
- `git show 854bcd2:server/tests/roomWalletSettlementAdapter.test.js` (fixture at introduction)
- `git diff dfa8832 HEAD --stat` (only `PaymentSessionManager.js` +26/−2 and
  new `restoreRoomWalletRefund.test.js` — confirms Stage 1 did not touch
  either triaged suite)
- `git status --porcelain` before and after (working tree unchanged: only the
  nine pre-existing untracked 2026-09-27 report files)

Diagnostic artifacts (created OUTSIDE the repository, deleted afterwards):
`C:\Users\Public\rw_diag_adapter.mjs`, `C:\Users\Public\rw_diag_recovery.mjs`
and their captured outputs.


---

## 4. `roomWalletSettlementAdapter.test.js` Findings

### 4.1 Exact failure (Step 1)

Run: `node --test tests/roomWalletSettlementAdapter.test.js` (from `server/`).
Result: 16 tests — 15 pass, 1 fail.

- Failing test: `"partial room-wallet refunds return exactly the paid amount
  and confirm on chain"` (test file line 460).
- Failing assertion (line 500):
  `assert.equal(result.results[0].txHash, "refund-1")`
- Expected: `'refund-1'` — Actual: `'refund-2'`
- Stack: `AssertionError [ERR_ASSERTION] ... at TestContext.<anonymous>
  (file:///G:/WheelWin/server/tests/roomWalletSettlementAdapter.test.js:500:12)`
- The later assertions (line 501 `assert.equal(calls.length, 1)`, lines
  502–504) were never reached; they would also fail (`calls.length` is 2 in
  this fixture — see 4.3).

All 15 other tests in the suite pass, including
`"existing room-wallet refund is adopted without a second send"`
(`REFUND_ADOPTED`, 0 sends) and the settlement dedup tests
(`DUPLICATE_PAYOUT`, `WALLET_REUSED`, `SETTLEMENT_ADOPTED`, both-payouts
adopted without sending).

### 4.2 Why the test expects `refund-1`

The test's mock `sendTransfer(input)` mints its hash from the shared fixture
recorder: `const hash = "refund-" + calls.length;` — i.e. the author's intent
is "the first (and only) refund broadcast for this target is recorded as the
first entry in `calls` and labelled `refund-1`", followed by
`calls.length === 1`. This is the correct *intent*: exactly one refund
broadcast, recorded once.

### 4.3 Why the harness produces `refund-2` — the fixture double-records the send

The shared fixture `createAdapter()` (test lines 7–59) builds the wallet
adapter wrapper:

```js
async sendTransfer(input) {
    calls.push(input);                       // push #1 (wrapper)
    if (typeof sendTransfer === "function") {
        return sendTransfer(input, calls);   // per-test mock
    }
    return { ok: true, code: "SENT", txHash: `tx-${calls.length}` };
}
```

and the failing test passes its own mock, which pushes again:

```js
sendTransfer(input) {
    calls.push(input);                       // push #2 (test mock)
    const hash = "refund-" + calls.length;   // minted AFTER the second push
    ...
    return { ok: true, code: "SENT", txHash: hash };
}
```

One adapter-level send therefore inserts the same input object twice into

### 4.4 Out-of-repo reproduction (empirical proof, no repo modification)

A diagnostic script (`C:\Users\Public\rw_diag_adapter.mjs`) replicated the
committed fixture exactly, adding only a counter on the wallet adapter's
`sendTransfer` itself. Output:

```
[refund-send] real sendTransfer invocations by adapter: 1
[refund-send] calls.length recorded by fixture: 2 (wrapper push + mock push)
[refund-send] calls[0] === calls[1]: true
[refund-send] result.results[0]: {"code":"REFUND_CONFIRMED","txHash":"refund-2","amountNano":"1000000000"}
[refund-adopt] real sendTransfer invocations by adapter: 0
[refund-adopt] calls.length: 0 | code: REFUND_ADOPTED | txHash: refund-existing
[idempotency] sends after FIRST call: 1 | first.code: REFUND_CONFIRMED | first.txHash: refund-1
[idempotency] sends after SECOND call: 1 | second.code: REFUND_ADOPTED | second.txHash: refund-1
[fixture-cutoff] sends after FIRST call: 1 | first.code: REFUND_CONFIRMED
[fixture-cutoff] sends after SECOND call: 2 | second.code: REFUND_CONFIRMED | second.txHash: refund-2
```

Interpretation:

1. Exactly **one** real `sendTransfer` invocation occurred (no duplicate
   financial broadcast). The `'refund-2'` string is purely the fixture's
   minted label for the single send.
2. The adoption test passes because no send occurs (0 invocations,
   `REFUND_ADOPTED` with the pre-existing hash).
3. `[idempotency]` models the production crash-recovery contract
   (`cutoffUtime = persisted refundRequestedAt`): the first call broadcasts
   once (`REFUND_CONFIRMED`); a second identical call **adopts** the existing
   transfer (`REFUND_ADOPTED`) and sends nothing — adapter-level dedup works.
4. `[fixture-cutoff]` shows that re-invoking with `cutoffUtime: Date.now()`
   (the committed test's synthetic value) re-sends on a second call — correct
   per the cutoff contract ("only transfers strictly newer than the cutoff
   are adoptable"); production never calls the adapter with "now" (see 6.3).

### 4.5 Answers to the Step 3 checklist

- Why `refund-1` expected: mock mints hash from `calls.length` assuming one
  recorded entry per broadcast (4.2).
- Why `refund-2` produced: double-push in the fixture inflates the counter
  before hash minting (4.3).
- Is the second refund an actual duplicate financial broadcast? **No** — one
  `sendTransfer` invocation per refund target, no retry loop in
  `refundPayments` (adapter lines 121–264).
- Is idempotency functioning correctly? **Yes** — pre-send history scan
  (`_findExistingRefund`, adapter lines 266–298) plus post-send
  `confirmPayoutOnChain` (read-only polling); adoption proven by the passing
  test and by the production-model experiment (4.4 item 3).
- Are persisted refund state / `refundRequestedAt` / participant refunded
  flags / adapter dedup involved? Not in this unit test (the adapter is
  stateless; `cutoffUtime: Date.now()` is a synthetic fixture value). At the
  production layer they are all involved and correctly layered — see 6.3.
- Real financial safety problem or outdated test expectation? **Outdated
  fixture only.** No financial safety problem.

`calls` (`calls[0] === calls[1]`), so the mock mints `refund-2` for the
first — and only — broadcast, and `calls.length` is 2 instead of 1.

Git evidence: the last commit touching this file is `854bcd2`
("test: cover partial room-wallet refunds"); the committed file content at
`854bcd2` is identical to the current working tree (verified via
`git show 854bcd2:...`), so the double-push existed from the day the refund
tests were introduced — the test has never passed in its committed form,
consistent with Stage 1's finding that the failure reproduces on `dfa8832`.


---

## 5. `tonFinancialRecovery.test.js` Findings

### 5.1 Exact failure (Step 1)

Run: `node --test tests/tonFinancialRecovery.test.js` (from `server/`).
Result: the file is a single top-level `node:test` script; it aborts on the
first uncaught assertion.

- Console progress before the crash: `full recovery: OK`,
  `recovery ordering: OK`, `wallet recovery: OK`.
- Failing assertion (line 495):
  `assert.equal(report.contractsRecovered, 1)`
- Expected: `1` — Actual: `0` (`AssertionError ... 0 !== 1` at
  `file:///G:/WheelWin/server/tests/tonFinancialRecovery.test.js:495:12`).
- Failing block: `"contract + payment + settlement recovery"`
  (test lines 450–504). The block seeds a legacy
  `GameContract` (`contract-1`, `status: AWAITING_PLAYER_PAYMENTS`,
  `contractAddress`), a `PaymentSession` and a `SettlementSession`, then
  asserts `contractsRecovered === 1` (line 495),
  `paymentSessionsRecovered === 1` (497), `settlementsRecovered === 1` (499)
  and `blockchainWatchesRecovered >= 2` (501). Execution stops at 495.

### 5.2 What the current recovery implementation actually does

`recover()` (TonFinancialRecovery.js lines 161–404) still runs the full
mandatory pipeline, including the CONTRACTS phase (line 206) — but the phase
itself was deliberately disabled for the Room-Wallet architecture
(commit `2daadcd`, "cleanup: disable legacy contract recovery in Room Wallet
architecture"; 12 insertions / 515 deletions):

```js
recoverContracts() {                                     // lines 462–476
    this._assertInitialized();
    this._assertRecoveryPhaseOrder(2, FINANCIAL_RECOVERY_PHASE.CONTRACTS);
    this._state = FINANCIAL_RECOVERY_STATE.RESTORING_CONTRACTS;
    this._currentPhase = FINANCIAL_RECOVERY_PHASE.CONTRACTS;
    this._emitProgress(FINANCIAL_RECOVERY_PHASE.CONTRACTS, 0.25);
    return Object.freeze({
        ok: true,
        restored: 0,
        warning: "contract_recovery_disabled_room_wallet_only"
    });
}
```

`_mergePhaseResult` then adds `result.restored ?? 0` (0) to
`report.contractsRecovered` (lines 1000–1004) and pushes the warning into
`report.warnings` (lines 977–981). The `2daadcd` diff additionally removed:

- the `gameContractManager` constructor dependency and
  `this._gameContractManager` field (so the harness's `gameContractManager`
  mock — including its `restoreContracts()` returning
  `restored: contracts.size` — is never consulted);
- `_validateContracts` logic and the "contracts" entry in
  `_buildRecoveredManagersList`;
- legacy watch re-registration: `_reregisterBlockchainWatches()`
  (lines 1183–1205) now returns `totalWatches: 0` with warning
  `"contract_watch_reregistration_disabled_room_wallet_only"`, so
  `report.blockchainWatchesRecovered` is also 0 by design.

### 5.3 Out-of-repo reproduction (empirical proof, no repo modification)

A minimal harness (`C:\Users\Public\rw_diag_recovery.mjs`) constructed
`TonFinancialRecovery` with the same mock shapes (payment session manager
with 1 session, settlement manager with 1 session, monitor with
`restoreCheckpoint`), ran `recover({ trigger: "process_restart" })` and
printed the report:

```
[recovery] contractsRecovered      = 0
[recovery] paymentSessionsRecovered= 1
[recovery] settlementsRecovered    = 1
[recovery] blockchainWatchesRecovered = 0
[recovery] warnings: ["wallet_recovery_skipped_no_manager","contract_recovery_disabled_room_wallet_only","contract_watch_reregistration_disabled_room_wallet_only"]
[recovery] errors: []
[recovery] failedRecoveries: []
[recovery] health.state = COMPLETED
```

This proves: (1) `contractsRecovered === 0` is the designed behaviour of the
current implementation, emitted with an explicit warning;
(2) the PAYMENTS and SETTLEMENTS phases still call their managers and count
`restored` correctly (`paymentSessionsRecovered === 1`,
`settlementsRecovered === 1` — the test's assertions at lines 497/499 remain
valid for the active architecture); (3) recovery completes with
`FINANCIAL_RECOVERY_STATE.COMPLETED`, no errors, no failed recoveries. The
only stale expectations in the block are line 495 (`contractsRecovered ===
1`) and line 501 (`blockchainWatchesRecovered >= 2`).

### 5.4 Answers to the Step 4 checklist

- What the test expects restored/invoked:
  `GameContractManager.restoreContracts()` invoked via the CONTRACTS phase
  with its `restored` count (1 seeded escrow `GameContract`) merged into
  `report.contractsRecovered`, plus ≥2 blockchain contract/payment watches
  re-registered.
- What the implementation does: the CONTRACTS phase is an intentional no-op
  stub (`restored: 0` + explicit warning); the game-contract manager
  dependency no longer exists in the recovery engine; watch re-registration
  is likewise disabled.
- Does the expectation belong to the active Room-Wallet architecture? **No.**
- Is the failure caused by a legacy escrow-era assumption? **Yes** — the
  seeded `GameContract` with `AWAITING_PLAYER_PAYMENTS` and the expectation
  that contracts/watches are restored belong to the GameEscrow/deposit
  architecture that `2daadcd` explicitly disabled.
- Could the failure affect real Room-Wallet payment recovery? **No** — the
  payment and settlement recovery phases are intact and functional (5.3);
  the disabled phases only remove escrow-era behaviour that the active
  architecture must not perform.


---

## 6. Evidence From Production Code

### 6.1 `RoomWalletSettlementAdapter.refundPayments` (adapter lines 121–264)

Per refund target, in order, with no retry loop:

1. Amount resolution (`resolveNano`) — GRAM number → bigint nanograms
   (`amount: 1` → `1_000_000_000n`).
2. **Pre-send idempotency** — `_findExistingRefund` (lines 266–298) scans
   `getTransactions(roomNumber, { limit: 40, archival: true })`, extracts
   outbound transfers via `extractOutboundTransfers`
   (`roomWalletTerminalRecoveryChain.js` lines 75–103) and returns the first
   transfer that is `success`, not bounced, exact `amountNano`, destination
   wallet-equal (`tonWalletAccountsEqual`), and `utime > cutoff`
   (`resolveCutoffUtime` normalises ms→s for values > 1e12, lines 648–658).
   A hit yields `REFUND_ADOPTED` and **no send**.
3. **Single broadcast** — `this._roomWalletAdapter.sendTransfer({...})`
   exactly once (lines 174–194); failures produce typed non-send outcomes
   (`REFUND_ADAPTER_ERROR`, `REFUND_BROADCAST_FAILED`,
   `REFUND_UNCERTAIN_BROADCAST` when no txHash is returned — fail-closed).
4. **Read-only confirmation** — `confirmPayoutOnChain`
   (`roomWalletTerminalRecoveryChain.js` lines 212–257) polls
   `getTransactions` only (never sends), filters by `expectedHash`,
   destination and exact amount; timeout yields `REFUND_NOT_CONFIRMED`
   (retryable) rather than a second broadcast.
5. Result `txHash: confirmed.hash ?? sent.txHash` — and
   `confirmPayoutOnChain` can only return the hash it was given, so the
   reported hash is always the single broadcast's hash.

### 6.2 Settlement-side idempotency (same file)

`settleContract` uses `inspectHistory` (default
`inspectRoomWalletHistory`) to adopt already-on-chain payouts
(`SETTLEMENT_ADOPTED`), fail closed on `DUPLICATE_PAYOUT` and
`WALLET_REUSED`, and treat RPC uncertainty as retryable without sending
(`CHAIN_INSPECT_UNKNOWN`). All these behaviours are covered by the 15
passing tests in the same suite.

### 6.3 Production refund caller — the layered idempotency that the unit test does not exercise

`PaymentSessionManager._requestRoomWalletPartialPaymentRefund`
(`server/gameplay/PaymentSessionManager.js` lines 1961–2074):

- builds refund targets via `buildPartialPaymentRefundTargets(session)` and
  filters out participants with `participant.refunded === true`
  (participant refunded flags — lines 1976–1979);
- uses the **persisted** `session.recoveryMetadata?.refundRequestedAt`
  (falling back to `Date.now()` only on first request), writes it back into
  `session.recoveryMetadata`, transitions the session with
  `markRefundPending()` and persists (`_persistSession`, lines 1986–2000);
- calls the adapter with `cutoffUtime: refundRequestedAt` (line 2029) —
  i.e. production dedup is anchored on persisted state, never "now";
- after the adapter result, marks confirmed participants
  `refunded = true` + `refundTxHash` and persists (lines 2044–2058);
- finalizes the unwind via `_finalizePartialPaymentUnwind` when all
  confirmed participants are refunded (lines 2061–2063) — the same machinery
  validated by Stage 1 commit `0d3f93a` and its
  `restoreRoomWalletRefund.test.js`.

### 6.4 `TonFinancialRecovery` (recovery engine)

- `recover()` pipeline (lines 161–404): WALLETS → CONTRACTS → PAYMENTS →
  deposit restore helpers → SETTLEMENTS → BLOCKCHAIN → VALIDATION, with
  phase-order guards and a frozen report.
- `recoverContracts()` (462–476): intentional no-op stub (see 5.2).
- `recoverPayments()` (530–572): calls
  `paymentSessionManager.restorePaymentSessions()` and merges
  `summary.restored` — the active Room-Wallet restore path (finalized by
  Stage 1 `0d3f93a`).
- `recoverSettlements()` (574–616): calls
  `contractSettlementManager.restoreSettlementSessions()` and merges
  `summary.restored`.
- `_reregisterBlockchainWatches()` (1183–1205): intentional no-op stub
  returning `totalWatches: 0` with warning.
- `_validateContracts` / `_validateBlockchainWatches`: emptied stubs.

## 7. Evidence From Test Fixtures

### 7.1 `roomWalletSettlementAdapter.test.js` fixture

- Shared `createAdapter()` (lines 7–59): wrapper `sendTransfer` pushes the
  input into `calls`, then delegates to the optional per-test mock. The
  settlement tests rely on the wrapper's push (they do not push themselves),
  which is why `calls.length === 2` after the two-payout settlement is
  correct there.
- The failing refund test (lines 460–505) passes a mock that ALSO pushes the
  input — the double-push. Its hash minting (`"refund-" + calls.length`) and
  the `calls.length === 1` assertion assume a single-push fixture. The
  second refund test (lines 507–537) has no send at all, so it is unaffected
  and passes.
- The fixture's `cutoffUtime: Date.now()` (ms) is normalised to seconds by
  `resolveCutoffUtime`, and the mock's `utime` (seconds) never exceeds it —
  irrelevant for the fresh-send path the test exercises.

### 7.2 `tonFinancialRecovery.test.js` fixture

- Harness mocks (lines 199–262): `gameContractManager.restoreContracts()`
  returns `restored: contracts.size`; `paymentSessionManager` and
  `contractSettlementManager` mocks return their map sizes; the blockchain
  monitor mock implements `restoreCheckpoint`/`registerContract`/
  `watchPayment`.
- The mocks themselves are structurally fine; the ESCROW-era parts are the
  seeded `GameContract` (`AWAITING_PLAYER_PAYMENTS`, lines 455–462) and the
  assertions at lines 495 and 501 that assume contract restoration and watch
  re-registration happen. The `gameContractManager` mock is no longer
  reachable by the engine (the constructor dependency was removed in
  `2daadcd`), which is itself evidence that the suite predates the disable
  commit (its last modification is `4c76510`, older than `2daadcd`).


---

## 8. Classification of Each Failure (Step 6)

| Suite | Classification | One-line justification |
|---|---|---|
| `roomWalletSettlementAdapter.test.js` (line 500) | **OUTDATED FIXTURE/MOCK** | Production adapter performs exactly one broadcast with correct idempotency (proven empirically and by code path); the failure is caused solely by the per-test mock double-pushing the send into the shared recorder, inflating the hash-minting counter and `calls.length`. |
| `tonFinancialRecovery.test.js` (line 495) | **LEGACY ESCROW EXPECTATION** | The suite expects the CONTRACTS phase to restore a seeded escrow-era `GameContract` (`contractsRecovered === 1`) and re-register contract watches (`>= 2`); commit `2daadcd` deliberately disabled both for the Room-Wallet-only architecture, and the suite predates that commit. |

Not applicable to either: REAL CURRENT DEFECT, UNRELATED PRE-EXISTING
FAILURE (both are tied to the Room-Wallet transition; the adapter one is a
fixture defect inside a Room-Wallet suite), UNDETERMINED.

## 9. Financial Safety Assessment

- **No duplicate refund broadcast exists.** The adapter invoked
  `sendTransfer` exactly once in the failing scenario (empirical counter),
  and `refundPayments` contains no retry loop; a failed/uncertain broadcast
  produces typed retryable outcomes without re-sending.
- **Idempotency is functioning and layered.** Adapter layer: history-scan
  adoption anchored on a caller-supplied cutoff
  (`REFUND_ADOPTED`, proven). Production layer: persisted
  `recoveryMetadata.refundRequestedAt` used as that cutoff
  (`PaymentSessionManager.js` line 2029), persisted per-participant
  `refunded`/`refundTxHash` flags, `REFUND_PENDING` state machine, and the
  no-broadcast `ALREADY_REFUNDED` finalize path (Stage 1 `0d3f93a`).
  The crash-re-request experiment confirmed: second call → `REFUND_ADOPTED`,
  zero new sends.
- **The failing assertion is not a financial signal.** `'refund-2'` is a
  minted mock label, not a second transaction. No persisted refund state,
  `refundRequestedAt`, or participant flags are involved in the unit test.
- **Recovery engine behaviour is fail-closed and by-design.** The disabled
  CONTRACTS/WATCHES phases return `ok: true, restored: 0` with explicit
  warnings; recovery completes with `COMPLETED`, no errors, no failed
  recoveries; payment/settlement restoration still works. Nothing in the
  failure affects real Room-Wallet payment recovery, refunds, or funds.
- **No casino/RTP/house-edge or smart-contract payment path is involved**
  anywhere in the two code paths triaged; the disabled escrow phases must
  stay disabled.

## 10. Recommended Future Action (Step 7 — do NOT execute now)

1. `roomWalletSettlementAdapter.test.js` — **update/retire the obsolete test
   fixture in a future dedicated stage.** Minimal fix: remove the duplicate
   `calls.push(input)` from the per-test mock in the refund tests (keep the
   wrapper's push as the single recorder) so the hash minting and the
   `calls.length === 1` assertion become meaningful again. No production
   change is warranted.
2. `tonFinancialRecovery.test.js` — **update/retire the obsolete
   expectations in a future dedicated stage.** Replace the escrow-era
   assertions in the "contract + payment + settlement recovery" block with
   the Room-Wallet contract: `contractsRecovered === 0` plus the warning
   `contract_recovery_disabled_room_wallet_only`, and
   `blockchainWatchesRecovered === 0` plus
   `contract_watch_reregistration_disabled_room_wallet_only`; keep the
   `paymentSessionsRecovered === 1` / `settlementsRecovered === 1`
   assertions (they hold). The GameContract seeding may remain as a negative
   assertion that the engine never consults it.
3. Do **not** "fix" `recoverContracts()` to restore contracts and do **not**
   re-enable watch re-registration — that would reintroduce a
   smart-contract payment path, which is forbidden for Mainnet.

## 11. Lifecycle Flow (observed)

Refund flow (active architecture): session failure/expiry/creator-left →
`_requestRoomWalletPartialPaymentRefund` → target build + `refunded`-flag
filter → persist `refundRequestedAt` + `REFUND_PENDING` →
`RoomWalletSettlementRouter` → `RoomWalletSettlementAdapter.refundPayments`
(history dedup → single broadcast → read-only chain confirmation) →
participant `refunded`/`refundTxHash` persisted →
`_finalizePartialPaymentUnwind` → `CANCELLED` + `PAYMENT_SESSION_FAILED`.
Restart flow: `TonFinancialRecovery.recover()` → WALLETS → CONTRACTS
(disabled stub) → PAYMENTS (`restorePaymentSessions`, Room-Wallet restore
per `0d3f93a`) → SETTLEMENTS → BLOCKCHAIN (checkpoint restore; watch
re-registration disabled) → VALIDATION → COMPLETED/FAILED.

## 12. Ownership Boundaries (observed, unchanged)

- Payment Domain owns refunds/settlement broadcasting:
  `RoomWalletSettlementAdapter` (stateless, chain-facing),
  `RoomWalletSettlementRouter` (active-adapter routing).

## 14. Final Conclusion (Step 6/7 summary)

Both failures are pre-existing (reproducible on `dfa8832`, per Stage 1 §4,
and re-verified live in this stage) and neither indicates a defect in the
current Room-Wallet production implementation:

1. `roomWalletSettlementAdapter.test.js` — the refund implementation sends
   exactly one broadcast per target and deduplicates correctly; the single
   failing assertion is produced by a self-contradictory test fixture that
   records the one send twice and then mints the tx-hash label from the
   inflated counter (`refund-2` instead of `refund-1`). Classification:
   **OUTDATED FIXTURE/MOCK**. Recommended future action: fixture-only test
   repair in a dedicated stage.
2. `tonFinancialRecovery.test.js` — `contractsRecovered` is 0 because
   legacy GameContract (escrow) restoration and contract-watch
   re-registration were deliberately disabled for the Room-Wallet-only
   architecture (commit `2daadcd`, explicit warning strings in the report);
   the suite still expects the escrow-era behaviour and predates that
   commit. Payment and settlement recovery phases are intact and verified.
   Classification: **LEGACY ESCROW EXPECTATION**. Recommended future action:
   update the obsolete expectations in a dedicated stage; never re-enable
   the escrow phases.

No financial safety problem was found in either path; no production code,
test, configuration or deployment file was touched; nothing was committed
or pushed.

## 15. Changes Made (per .clinerules)

- Created exactly one file:
  `AI_CONTEXT/CLINE_REPORTS/2026-09-27_stage1-1_financial_test_triage_refund_recovery.md`
  (this report).
- **No application code, tests, configuration or deployment files were
  modified. No files were committed. Nothing was pushed.** The working tree
  before and after this stage contains only the nine pre-existing untracked
  2026-09-27 report files (`git status --porcelain` verified).
- Two diagnostic scripts and their outputs were created and used strictly
  outside the repository (`C:\Users\Public\`), importing production modules
  read-only; they do not affect the working tree and were deleted after use.

- Payment/Recovery orchestration owns refund state:
  `PaymentSessionManager` (persisted `refundRequestedAt`, participant
  `refunded` flags, session state machine).
- Recovery Domain owns the restart pipeline: `TonFinancialRecovery`
  (orchestration only — no financial state, per its header).
- The triaged failures cross no ownership boundary: one is inside a test
  fixture; the other is inside a test's stale expectations of a deliberately
  disabled phase.

## 13. Risks

- Critical: none found in the triaged production paths.
- High: none.
- Medium: the two suites currently emit false alarms on every full
  `npm test` run, which weakens the financial test signal during Mainnet
  preparation (a real regression would be drowned in known-failure noise).
- Low: the fixture double-push pattern could be copied into future tests;
  the recovery suite's unreachable `gameContractManager` mock may confuse
  future maintainers. Both are resolved by the §10 recommendations.
