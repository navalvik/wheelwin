# Stage 2 — Propagate Authoritative Room Network into PaymentSession

Date: 2026-09-28

Task: Implement ONLY the missing server-side propagation of the authoritative
room network selection (RoomLobbyBridge) into PaymentSession creation, so that
`PaymentSession.network` becomes room-authoritative instead of silently
inheriting the process-level `TON_NETWORK`. Room-Wallet-only architecture
preserved; no smart-contract payment path restored or activated.

## 1. Scope

- Production call chain: `RoomLobbyBridge._deliverPaymentConnectionReady` →
  `PAYMENT_CONNECTION_READY` domain event →
  `PaymentSessionManager._handlePaymentConnectionReady` → `createAndRequest` →
  `createPaymentSession`.
- The R20 authoritative room network store (`RoomLobbyBridge._roomNetworkByRoom`).
- Fail-closed behavior when the room network is unavailable at creation time.
- Focused test coverage for TESTNET/MAINNET propagation, TON_NETWORK
  non-override, fail-closed behavior, and the bridge payload wiring.
- Explicitly out of scope (untouched): Mainnet wallet catalogs, wallet
  allocation/routing, Page4, Page2 UI, payment amounts, refund logic,
  settlement logic, observer logic, deployment configuration, global
  `TON_NETWORK` semantics, legacy cleanup, unrelated tests, and any
  GameEscrow / DepositContract / DepositPackage code.

## 2. Files Inspected

Context (per `.clinerules`): `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`,
`AI_CONTEXT/ARCHITECTURE_RULES.md`, `AI_CONTEXT/CURRENT_STATE.md`,
`AI_CONTEXT/AI_WORKING_RULES.md`,
`AI_CONTEXT/CLINE_REPORTS/2026-09-27_stage0_local_baseline_audit.md`.

Source read directly:

- `server/gameplay/PaymentSessionManager.js` — `createPaymentSession`
  (existing `network` parameter and
  `network ?? contract?.tonNetwork ?? this._tonNetwork` precedence at 433–436),
  `createAndRequest` (563–679), `_handlePaymentConnectionReady` (2331–2365),
  `restorePaymentSessions` (716–869), network-mismatch guard (2766–2777),
  `_resolveRoomWalletPaymentAddress` (2837–2851), `_persistSession` metadata
  (`tonNetwork: session.network`, 2925).
- `server/socket/RoomLobbyBridge.js` — `_roomNetworkByRoom` (184),
  `_handleSelectRoomNetwork` commit (1523), destruction cleanup
  (3512/3918/4281), `_buildRoomState` network projection (4348),
  `_deliverPaymentConnectionReady` (6546–6609), reconnect socket mirror
  (3049–3057, socket-delivery only, no domain emit).
- `server/gameplay/PaymentSessionManagerErrors.js` (existing error
  conventions; `PaymentValidationError` reused).
- `server/models/PaymentSession.js` (`network` on payload/snapshots).
- `server/app.js` composition root (PSM construction with
  `tonNetwork: this._tonConfig?.network`; `setRoomWalletFinance` wiring).
- `server/payment/roomWallet/RoomWalletIncomingObserver.js`
  (`resolveIntendedRoomWalletAddress`).
- Tests: `paymentSession.manager.test.js`, `roomNetworkSelection.r20.test.js`,
  `roomNetworkHandoffCreation.r22.test.js`,
  `restoreRoomWalletRefund.test.js`, `setupExpiryRoomWalletRefund.test.js`,
  `creatorLeftRoomWalletRefund.test.js`,
  `gameContract.legacyDeployTriggerIsolation.r179l18.test.js`,
  `depositBackendE2E.r179l19.test.js` (+helper),
  `roomWalletOnlyPlayerPayment.r18s72.test.js`,
  `roomLobby.integration.test.js`, `debugStartGame.integration.test.js`,
  `helpers/lobbyIntegrationHarness.js`.

## 3. Architecture Findings

Pre-change defect (Stage 0 §14 risk 2 confirmed): the only production EventBus
emit of `PAYMENT_CONNECTION_READY` (`RoomLobbyBridge._deliverPaymentConnectionReady`)
carried `{ roomId, timestamp }` only. `_handlePaymentConnectionReady` passed
only `gameId` into `createAndRequest`, which called
`createPaymentSession(roomId, { gameId })` without `network`, so
`activeNetwork = network ?? contract?.tonNetwork ?? this._tonNetwork ?? null`
always resolved to the process-level `TON_NETWORK` for lobby-created sessions.
Every downstream consumer of `session.network` (persistence metadata
`tonNetwork`, the "Payment network mismatch" guard, Page4 display) therefore
trusted a runtime-derived value, not the room's authoritative Owner-selected
network.

Key structural facts established:

1. `createPaymentSession` already accepted a `network` argument — the API did
   not need redesign (task requirement 5).
2. `_roomNetworkByRoom` is the single authoritative per-room network store
   (R20); the bridge reads its own map at emit time. No second network state
   store was created (task requirement 4).
3. `restorePaymentSessions()` hydrates sessions directly via
   `PaymentSession.fromRecord(record)` and never routes through
   `createAndRequest`/`createPaymentSession`, so recovery is unaffected.
4. The reconnect mirror at bridge 3049–3057 is a socket delivery only; the
   domain event has exactly one production emit site.

## 4. Lifecycle Flow (after this stage)

```
Owner selects network (R20) → _roomNetworkByRoom.set(roomId, "testnet"|"mainnet")
        ↓
All wallets connected → RoomLobbyBridge._deliverPaymentConnectionReady(roomId)
        ↓
EVENT_TYPES.PAYMENT_CONNECTION_READY payload:
    { roomId, network: _roomNetworkByRoom.get(roomId) ?? null, timestamp }
        ↓
PaymentSessionManager._handlePaymentConnectionReady
        ↓
createAndRequest(roomId, { gameId, network })
    - inside existing try: if network is not exactly "testnet"|"mainnet"
      → throw PaymentValidationError("Authoritative room network unavailable
      for PaymentSession") → existing catch convention:
      decisionTrace TERMINAL_FAILURE + PAYMENT_SESSION_FAILED emit → null
    - else createPaymentSession(roomId, { gameId, network })
        ↓
activeNetwork = network  (explicit room network — first precedence;
                          TON_NETWORK can no longer override it)
        ↓
PaymentSession.network = authoritative room network → persisted, guarded,
displayed downstream
```

## 5. Ownership Boundaries

- Room/lobby domain (`RoomLobbyBridge`) remains the sole owner of the
  authoritative room network; it now also carries it on the payment handoff
  event. No state moved between domains.
- Payment domain (`PaymentSessionManager`) remains the sole owner of session
  creation and its fail-closed validation; it accepts the network as data and
  never reads lobby state directly (no new coupling).
- Recovery domain untouched (`restorePaymentSessions` bypasses creation).
- Client unchanged; never owns network authority.

## 6. Risks

- **Low (behavioral change, intended)** — a lobby-created PaymentSession now
  requires the room's committed network selection. Rooms whose selection is
  missing (e.g. in-memory map lost after a restart, per Stage 0 Medium risk)
  fail closed with `PAYMENT_SESSION_FAILED` instead of being silently labeled
  with the process-level `TON_NETWORK`. This is the task-mandated fail-closed
  behavior.
- **Pre-existing (not caused by this stage)** —
  `paymentSession.manager.test.js` and
  `gameContract.legacyDeployTriggerIsolation.r179l18.test.js` fail both before
  and after this stage: their harnesses construct `PaymentSessionManager`
  without a Room Wallet registry, so creation throws "Room Wallet address is
  required for player payment" (R18-S72 Room-Wallet-only requirement) before
  any session can exist. This stage changes only the throw order/reason inside
  `createAndRequest`; pass/fail status is identical pre/post (verified).
- **Low** — `_roomNetworkByRoom` remains in-memory; durable room network is a
  later Mainnet-stage concern (Stage 0 recommendation 3).

## 7. Recommendations

1. In a later approved Mainnet stage, make the room network durable (Room
   model/persistence or recovery rebuild of `_roomNetworkByRoom`) so recovered
   rooms can re-enter the payment flow instead of failing closed.
2. The two pre-existing fixture failures (missing Room Wallet registry in
   legacy stacks) should be fixed in a dedicated fixture-repair stage; do not
   fix them incidentally.
3. Later stage: decide the R22/R24 separate-application MAINNET launch path
   fate before per-room Mainnet rooms go live (Stage 0 recommendation 2).

## 8. Changes Made

Production (smallest possible, 2 files):

1. `server/socket/RoomLobbyBridge.js` — `_deliverPaymentConnectionReady`:
   reads the authoritative `this._roomNetworkByRoom.get(roomId) ?? null` once,
   adds `network` to the `[R7.50 DIAG]` emit log and to the
   `PAYMENT_CONNECTION_READY` domain event payload.
2. `server/gameplay/PaymentSessionManager.js`:
   - `_handlePaymentConnectionReady` logs and forwards
     `network: payload?.network ?? null` into `createAndRequest`;
   - `createAndRequest(roomId, { gameId = null, network = null } = {})`
     forwards `network` into `createPaymentSession(roomId, { gameId, network })`
     and fails closed inside the existing try/catch convention when `network`
     is not exactly `"testnet"` or `"mainnet"`
     (`PaymentValidationError("Authoritative room network unavailable for
     PaymentSession", { roomId, gameId, network })` → decisionTrace
     TERMINAL_FAILURE → `PAYMENT_SESSION_FAILED` → returns null).

Test (new, focused): `server/tests/paymentSessionRoomNetwork.test.js` — 5 tests.

Report: this file. No other files modified or deleted; no unrelated
pre-existing changes touched; nothing committed or pushed (task explicitly
defers commit for this stage).

---

## Task-Specific Confirmations

### Objective
Room-authoritative network now reaches `PaymentSession.network` at creation:
`RoomLobbyBridge._roomNetworkByRoom` → `PAYMENT_CONNECTION_READY` payload →
`createAndRequest({ network })` → `createPaymentSession({ network })` →
`session.network`.

### Tests Executed and Results

Pre-change baseline (established first, to separate pre-existing failures):

| Suite | Baseline | Post-change |
|---|---|---|
| `tests/paymentSessionRoomNetwork.test.js` (new, focused) | — | **5/5 PASS, exit 0** |
| `tests/roomNetworkSelection.r20.test.js` | PASS | PASS (exit 0) |
| `tests/roomNetworkHandoffCreation.r22.test.js` | PASS | PASS (exit 0) |
| `tests/restoreRoomWalletRefund.test.js` | PASS | PASS (exit 0) |
| `tests/setupExpiryRoomWalletRefund.test.js` | PASS | PASS |
| `tests/creatorLeftRoomWalletRefund.test.js` | PASS | PASS (exit 0) |
| `tests/paymentSession.manager.test.js` | FAIL (pre-existing, line 396 `0 !== 1`, exit 1) | FAIL — same assertion, same location, exit 1 (unchanged) |
| `tests/gameContract.legacyDeployTriggerIsolation.r179l18.test.js` | FAIL (pre-existing, missing Room Wallet registry fixture) | FAIL — 5/7 pass; the 2 failures are exactly the tests asserting session creation from network-less payloads; identical pre-existing status |

Focused test coverage proven (per task requirements):

- **A. TESTNET room → `session.network === "testnet"`** (test A; full
  production chain via `PAYMENT_CONNECTION_READY` on the event bus).
- **B. MAINNET room → `session.network === "mainnet"`** and explicitly not
  converted to testnet (test B).
- **C. Process-level `TON_NETWORK` does not override the explicit room
  selection** in both directions: manager `tonNetwork: "mainnet"` + room
  `testnet` → `testnet`; manager `tonNetwork: "testnet"` + room `mainnet` →
  `mainnet` (test C).
- **D. Missing authoritative room network fails safely per existing
  conventions** — no session created, exactly one `PAYMENT_SESSION_FAILED`
  with reason matching `Authoritative room network unavailable`, and a direct
  `createAndRequest(..., { network: "lan" })` also returns null with no
  session (test D).
- **Bridge wiring** — `RoomLobbyBridge._deliverPaymentConnectionReady`
  attaches the committed `_roomNetworkByRoom` value to the domain event
  payload, and `network: null` for rooms without a committed selection
  (test E).

### TESTNET behavior remains intact
TESTNET rooms (the entire current production population, `TON_NETWORK=testnet`)
produce `session.network === "testnet"` exactly as before — proven by tests A
and C, and by the unchanged passing Room-Wallet suites (refund/restore, R20,
R22). `TON_NETWORK` semantics elsewhere in the process are untouched.

### MAINNET selection is now propagated
A room explicitly committed as MAINNET produces
`PaymentSession.network === "mainnet"` with no silent conversion (test B), and
`network` takes first precedence over `contract?.tonNetwork` and
`this._tonNetwork` in the existing `activeNetwork` chain
(`PaymentSessionManager.js` 433–436, unchanged).

### TON_NETWORK no longer overrides explicit room selection
At this creation point the explicit room network is passed as the `network`
argument, which is first in the precedence chain; the process-level
`TON_NETWORK` can only apply to callers that pass no network (legacy direct
`createPaymentSession` callers — semantics unchanged there). Proven by test C
(both directions).

### No smart-contract payment path restored
`git diff -U0 -- server/` was grepped for
`GameEscrow|DepositContract|DepositPackage|gameEscrowMode|sendBoc|broadcastTransaction|deployContract|smartContract`
— **zero matches**. No contract import, no contract payment/deployment call,
no contract recovery/watch reconnection. The Room-Wallet-only architecture is
untouched.

### Git status / diff summary
- Branch `payment/room-wallet-integration`, HEAD `0d3f93a` (unchanged).
- Modified tracked files (only intended): `server/gameplay/PaymentSessionManager.js`
  (+24/−3 across 4 hunks), `server/socket/RoomLobbyBridge.js` (+15/−1 across 2 hunks).
- New untracked: `server/tests/paymentSessionRoomNetwork.test.js`,
  this report. The ten untracked 2026-09-27 reports predate this stage and
  were left untouched.
- Nothing committed or pushed (per task worktree rules for this stage).

## Conclusion

The single structural defect identified in Stage 0 (`session.network` being
runtime-derived instead of room-derived) is closed with a minimal, localized
change: the authoritative room network travels on the existing
`PAYMENT_CONNECTION_READY` domain event and is validated fail-closed at the
existing production creation call. TESTNET behavior is preserved, MAINNET
selection is propagated, the process-level `TON_NETWORK` can no longer
override an explicit room selection, and no smart-contract payment path was
restored or activated.

## Remaining Limitations (later Mainnet stage)

1. `_roomNetworkByRoom` is in-memory only; after a server restart a recovered
   room has no committed network and its PaymentSession creation fails closed
   until the room network becomes durable (Room model persistence or recovery
   rebuild) — Stage 0 recommendation 3.
2. Wallet catalog/allocation remains `TON_NETWORK`-scoped
   (`ROOM_WALLETS_TESTNET_JSON`); Mainnet Room Wallet catalogs and
   per-network routing are explicitly later stages.
3. The R22/R24 MAINNET separate-application launch path still coexists with
   the single-app per-room wallet model and must be neutralized/decided in a
   later approved stage.
4. Legacy fixture stacks without a Room Wallet registry
   (`paymentSession.manager.test.js`,
   `gameContract.legacyDeployTriggerIsolation.r179l18.test.js`) remain red for
   their own pre-existing reason and need a dedicated fixture-repair stage.




