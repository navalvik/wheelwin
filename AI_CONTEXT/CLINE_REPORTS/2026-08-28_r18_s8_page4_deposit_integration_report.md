# R18-S8 — Page4 DepositContract Integration

Date: 2026-08-28

Task: Integrate the existing Page4Payment UI with the authoritative DepositContract
architecture (R18-S5 FundSeat builder, R18-S6 deployment builder, TonConnect
submission), preserving Page4 UX and server financial authority.

## 1. Scope

Full audit of Page4Payment.jsx, the R18-S5/S6 builder contracts, the authoritative
Deposit projection pipeline, and the TonConnect wire schema, to determine whether a
safe Page4 integration could be completed without fabricating financial data
client-side and without modifying the server.

## 2. Files Inspected

- client/src/pages/Page4Payment.jsx (inspected in full, ranges 1–3230)
- client/src/payment/buildTonConnectPaymentTransaction.js (old PaymentSession builder)
- client/src/payment/buildFundDepositTransaction.js (R18-S5)
- client/src/payment/buildDepositDeploymentTransaction.js (R18-S6)
- client/src/game/session/authoritativePaymentSessionView.js
- client/src/game/session/index.js, authoritativeSessionModel.js
- client/src/context/AuthoritativeSessionContext.jsx
- client/src/components/PlayerPaymentRow/index.jsx
- server/deposit/DepositOrchestrator.js (freezeDepositPackage, lines 55–115)
- server/deposit/projectDepositForPlayer.js (projectPackage, lines 150–200)
- server/tests/testnet/r179l25/l25PlayerDepositDeploy.js (deployment reference)
- client/node_modules/@tonconnect/protocol/lib/types/index.d.ts (wire schema)
- client/node_modules/@ton/core (storeStateInit availability)

## 3. Current Page4 architecture (before changes)

- Payment/session data: Page4 consumes the authoritative session via
  AuthoritativeSessionContext and the old-flow view helper
  authoritativePaymentSessionView.js (payment-session era).
- CONFIRM IN TELEGRAM WALLET (handler ~lines 2940–3040): resolves the connected
  TonConnect wallet, builds a transaction with the OLD builder
  buildTonConnectPaymentTransaction (GameEscrow STAKE, imported at line 25, used
  ~line 2950), calls tonConnectUI.sendTransaction, and on wallet success emits
  PAYMENT_CONFIRM_INTENT (~line 3019).
- Duplicate-submission protection: existing in-flight/submitted guards around the
  confirm handler (canConfirm / localPaymentRequest pattern).
- NEXT (footer, ~lines 3080–3230): existing navigation logic, unchanged by this task.
- Player rows: PlayerPaymentRow components populated from the old payment view model.
- Diagnostics: existing detailed TonConnect autopsy/diagnostic logging is present
  and must be preserved by any future integration.

## 4. Old PaymentSession/GameEscrow dependencies found in Page4

1. Line 25: import of buildTonConnectPaymentTransaction (old STAKE/GameEscrow builder).
2. ~Line 2950: CONFIRM handler builds the old GameEscrow transaction.
3. ~Line 3019: PAYMENT_CONFIRM_INTENT emitted after wallet success.
4. authoritativePaymentSessionView.js drives the current payment status rows.

These belong to the old PaymentSession/GameEscrow flow. Per task rules they were
NOT blindly deleted; the CONFIRM handler was left untouched because the creator
deployment flow could not be safely completed (see §8–§9).

## 5. Authoritative Deposit data available to Page4

authoritativeSession.deposit (server-owned mirror, delivered via the verified
R18-S4/S7 transport) contains exactly:

- phase, depositId, depositAddress, network
- package (ONLY while the creator still needs to deploy):
  { stateInit: { codeBoc, dataBoc }, deployValueNanotons }
- mySeatIndex (0..2 | null), isCreator (true | false | null)
- mySeatStatus ("PENDING" | "FUNDED"), myExpectedAmountNanotons, confirmedSeats

No roomId/gameId/creationFeePerSeat/expectedStake fields exist in the projection
(current source verified; nothing invented here).

## 6. CREATOR determination (verified available)

isCreator comes from the authoritative projection (RoomLobbyBridge._roomCreators
on the server; requester-scoped). Contradictory creator/seat state fails closed
server-side. Page4 must use isCreator — never mySeatIndex === 0. The field IS
available where required, so this stop condition did NOT trigger.

## 7. FLOW B — non-creator FundSeat: FULLY SUPPORTED (not wired)

All authoritative inputs required by buildFundDepositTransaction() are present:
depositAddress, mySeatIndex, myExpectedAmountNanotons (exact), network. The S5
output shape (amount as string nanotons, payload as base64 BOC string) matches
the TonConnect sendTransaction schema, so the existing Page4 TonConnect
integration could submit it unchanged. NOT wired in this task — see §9.

## 8. FLOW A — creator deployment: STOP CONDITION TRIGGERED (data gap)

The S6 builder `buildDepositDeploymentTransaction()` fails closed unless the
authoritative package carries `deployValueNanotons`. Verified from current
server source:

- `DepositOrchestrator.js` `freezeDepositPackage()` (lines 55–115): the frozen
  package embeds `stateInit.{codeBoc,dataBoc}` and per-binding
  `expectedAmount` (stake + creation fee) but NEVER `deployValueNanotons`.
- `projectDepositForPlayer.js` `projectPackage()` (lines 160–186): exposes
  `deployValueNanotons` ONLY if the frozen package itself carries it — and
  documents that the frozen package does not embed it today. The projection
  therefore always delivers `deployValueNanotons: null`.
- Repository-wide search (`deployValueNanotons|DEPLOY_VALUE`) across
  server/deposit and server/config: only test-only constants exist
  (`L25_DEFAULT_DEPLOY_VALUE_TON = "0.05"` in
  server/tests/testnet/r179l25/l25PlayerDepositDeploy.js:35 and
  `DEPOSIT_TESTNET_DEPLOY_VALUE_TON` in testnet E2E code). No production
  configuration or authoritative source defines a deployment value.

Per the R18-S8 rules the client must NOT calculate/fabricate the deployment
amount, must NOT reuse `myExpectedAmountNanotons` (that is the FundSeat
amount — a different operation), and the server must not be modified here.
Therefore the creator deployment flow cannot be wired without violating a
task invariant → STOP condition honored.

## 9. Integration decision

Neither flow was wired into Page4 in this task:

- FLOW B (FundSeat) is fully supported by authoritative data and was
  technically wireable, but wiring it alone would produce a half-integrated
  Page4 (non-creators could fund a DepositContract the creator can never
  deploy), altering established UX for a partial result. The safer, smallest
  change was to preserve the existing working Page4 flow until both flows
  can be delivered together.
- FLOW A (deployment) is blocked by §8.

No partial/misleading commit was created, per task STOP-condition rules.

## 10. S6 builder wire-format defect (proven, unfixed per scope)

TonConnect wire schema, verified from the installed dependency
(`@tonconnect/protocol/lib/types/index.d.ts:460-475`, `RpcTonItem`):
`stateInit?: string` — "Optional one-cell BoC `StateInit`, base64-encoded".

The S6 builder (`buildDepositDeploymentTransaction.js:181-184`) currently
emits `stateInit: { code, data }` — an OBJECT. Passing that to
`tonConnectUI.sendTransaction()` would be rejected by the wallet/protocol.

This is a direct defect in R18-S6's stated goal ("follow existing TonConnect
conventions"). R18-S8 scope forbids modifying the S6 builder unless a direct
transport-compatibility issue is proven AND allows stopping to report it —
it is proven here and REPORTED, not patched, because the creator flow is
already blocked by §8, so patching it now cannot unblock integration.

Feasibility note (verified): `@ton/core` exports `storeStateInit` /
`loadStateInit`, so a future minimal fix — serialize
`beginCell().storeStateInit({code,data}).endCell().toBoc().toString("base64")`
inside S6 — is client-side only and requires no server change.

## 11. Tests executed and exact results (verification runs, this task)

All suites executed with the repository test runner
(`node --import "file:///G:/WheelWin/client/scripts/register.js" <test>`;
server: `node tests/<test>`). Exit codes verified from `$LASTEXITCODE`.

| Suite | Result |
|---|---|
| client `src/payment/buildFundDepositTransaction.test.js` (S5) | all assertions passed, `rc=0` |
| client `src/payment/buildDepositDeploymentTransaction.test.js` (S6) | all assertions passed, `rc=0` |
| client `src/game/session/authoritativeSessionModel.test.js` (S4 model incl. deposit mirror, RESET, fail-closed) | all assertions passed, `rc=0` |
| client `src/socket/socketSyncLayer.test.js` (S4 transport incl. DEPOSIT_PACKAGE_PUBLISHED dispatch) | all assertions passed, `rc=0` |
| server `tests/r18S4DepositReconnect.test.js` (S4 reconnect restoration) | all assertions passed, `rc=0` |

These runs are regression verification only — no R18-S8 production code was
written, so no new tests were required or added. No existing test was
weakened or modified.

## 12. STOP-CONDITION BLOCKER 1 — no authoritative deployment amount

The S6 creator flow requires `depositPackage.deployValueNanotons`, and the
S6 builder fails closed without it (by design). Verified from current source:

- `server/deposit/DepositOrchestrator.js:55-94` (`freezeDepositPackage`) —
  the frozen authoritative package embeds ONLY:
  `{ depositId, roomId, gameId, depositAddress, network, stateInit: { codeBoc, dataBoc } }`.
  It does NOT embed `deployValueNanotons`.
- `server/deposit/projectDepositForPlayer.js:150-186` (`projectPackage`) —
  passes `deployValueNanotons` through ONLY if the frozen package itself
  carries it; its own comment states the frozen package does not embed a
  deploy value today and it never substitutes another field.
- Repository-wide search: no production server module or config defines a
  Deposit deployment value. The only deployment values in the repository are
  TEST-ONLY constants (`L25_DEFAULT_DEPLOY_VALUE_TON = "0.05"` in
  `server/tests/testnet/r179l25/l25PlayerDepositDeploy.js:35`;
  `DEPOSIT_TESTNET_DEPLOY_VALUE_TON` in testnet harness files).

R18-S8 scope explicitly forbids: calculating the deployment amount on the
client, fabricating a fallback value, and modifying the server package
schema (`freezeDepositPackage` / DepositOrchestrator financial calculations)
without a STOP-and-report. All three apply. The creator flow therefore
CANNOT be wired safely from verified authoritative data.

Consequence: wiring only FLOW B (FundSeat) would let non-creators fund a
DepositContract the creator can never deploy — a half-integrated state that
contradicts the task's synchronization requirements. Both flows must land
together or not at all.

## 13. Unblocking requirements (for a future task — NOT implemented here)

1. **Server (authority) decision**: the authoritative Deposit package must
   carry the deployment value. Smallest change consistent with existing
   architecture: embed `deployValueNanotons` in `freezeDepositPackage`
   (DepositOrchestrator) from a server-owned immutable configuration value,
   so `projectDepositForPlayer()` can pass it through (its pass-through
   already exists and needs no change). Requires an explicit architecture
   approval per .clinerules §8 before implementation.
2. **S6 builder fix (client, minimal)**: serialize StateInit to the
   TonConnect wire format using the already-available `@ton/core`
   `storeStateInit`:
   `beginCell().storeStateInit({ code, data }).endCell().toBoc().toString("base64")`
   — replacing the current `stateInit: { code, data }` object emission at
   `buildDepositDeploymentTransaction.js:181-184`. Client-side only;
   verified feasible (`@ton/core` exports `storeStateInit`/`loadStateInit`).
3. **Then** the R18-S8 Page4 wiring of both flows behind authoritative
   `isCreator` can proceed per the original task contract: FLOW A via the
   fixed S6 builder + creator's TonConnect wallet; FLOW B via the S5 builder
   (already wire-compatible) + player's TonConnect wallet; both preserving
   the existing UI, duplicate-submission guard, diagnostics, and
   server-authoritative status consumption.

## 14. Server financial logic — NOT modified

Verified via `git --no-pager status` and targeted diff checks:
`server/deposit/*` (DepositOrchestrator, DepositMonitor,
DepositOnChainVerificationCoordinator, DepositSessionCoordinator,
projectDepositForPlayer), `server/payment/*`, `server/socket/*` —
no modifications. No server change was made despite the data gap, per the
task's explicit STOP rule ("a Page4 integration task must not silently turn
into a server redesign").

## 15. S5 and S6 builders — NOT modified

- `client/src/payment/buildFundDepositTransaction.js` — untouched.
- `client/src/payment/buildDepositDeploymentTransaction.js` — untouched.
  The proven wire-format defect (§10) is REPORTED, not patched: patching it
  cannot unblock the integration while §12 blocks the creator flow, and the
  task requires STOP-and-report rather than unsanctioned builder edits.

## 16. Git state

- HEAD: `22799a8` (`docs: add R18-S6 implementation report`).
- Recent history (verified): `22799a8` → `46b3970` (R18-S6) → `d9747d2`
  (docs S5) → `30ee96e` (R18-S5) → `f6964cc` (R18-S4). All pushed to
  `origin/main`; branch in sync with origin.
- Working tree: no changes to
  `client/src/pages/Page4Payment.jsx`, S5/S6 builders, or any server file.
  Only pre-existing unrelated untracked/modified artifacts (reports, logs,
  samples) remain, none produced by this task.
- **Commit SHA: none.** No R18-S8 commit was created — deliberately. The
  task forbids a misleading partial commit when implementation is blocked
  by an architectural issue, and Page4 must not be half-wired
  (FundSeat-only would let non-creators fund an undeployable contract).

## 17. Remaining DepositContract/Page4 integration gaps

1. Creator deployment amount authority (§12) — server-side package field;
   requires an architecture-approved server change.
2. S6 StateInit wire-format fix (§10/§13) — client-side, one cell
   serialization; blocked-in-practice only by scope, ready to implement.
3. Page4 wiring of both flows behind authoritative `isCreator` (the original
   R18-S8 goal) — pending 1+2. The authoritative data channel (S4/S7
   transport, `authoritativeSession.deposit`, `isCreator` field) is verified
   ready for consumption.
4. Page4 → Page5 server-authoritative transition — unchanged/deferred; no
   client navigation logic exists or was added. GameContract deployment
   integration is a separate later task.

## 18. Verdict

**R18_S8_BLOCKED**

Reason: safe Page4 integration requires an authoritative deployment amount
that the server does not currently expose in the frozen Deposit package, and
the S6 builder output is not wire-compatible with the installed TonConnect
protocol schema. Both are proven from source (§10, §12). Per the task's
STOP conditions and the .clinerules modification-approval rule, the correct
action is to report and wait for an architecture decision rather than
fabricate values client-side or silently change the server package schema.

Not blocked: FLOW B (non-creator FundSeat) data and builder are verified
ready; the blocker is specifically the creator deployment amount authority
and the S6 wire format, and a partial FundSeat-only integration was
rejected as unsafe/contrary to the synchronization requirement (§12).
