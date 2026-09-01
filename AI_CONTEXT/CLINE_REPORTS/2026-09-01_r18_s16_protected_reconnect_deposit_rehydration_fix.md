# R18-S16 — Protected-Reconnect Deposit Rehydration Fix

Date: 2026-09-01

Task: Restore live DepositSession projections on protected same-id reconnect, including Socket.IO connect without `SESSION_RECOVERY_REQUEST`. No financial-constant, timeout, Telegram, RoomManager, anti-bot, GameEscrow, Page5, or GAME_START-clear changes.

Classification: **PROTECTED SAME-ID RECONNECT NOW REHYDRATES LIVE DEPOSIT. FOCUSED TESTS PASS. NEW TESTNET SESSION NOT YET PROVEN.**

---

## 1. Scope

Implemented the Keah forensic fix only:

```text
protected session
    → soft disconnect
    → same socket.id reconnects
    → GameplayContextResolver bound=true
    → live Deposit projection restored
```

Also covered the second hole: connect without `SESSION_RECOVERY_REQUEST`.

Did not change DepositContract economics, FundSeat amounts, GameEscrow, Page5, Telegram authorization, RoomManager, anti-bot, PaymentSession timing, or the GAME_START stale-deposit clear.

---

## 2. Files Inspected

- `AI_CONTEXT/CLINE_REPORTS/2026-09-01_r18_s16_keah_deposit_ui_state_divergence_forensic.md`
- `server/socket/RoomLobbyBridge.js`
- `server/socket/SocketGateway.js`
- `server/socket/GameplayContextResolver.js`
- `server/socket/gameplayRecoveryProtocol.js`
- `server/deposit/projectDepositForPlayer.js`
- `client/src/game/session/authoritativeSessionModel.js`
- `client/src/game/session/page4PaymentPhase.js`
- `server/tests/r18S4DepositReconnect.test.js`
- `server/tests/recoveryIntegration.r178d.test.js`
- `server/config/rooms.js`

---

## 3. Architecture Findings

`reconnectSession()` already restored Deposit via `projectDepositForPlayer`. `SocketGateway._handleRecoveryRequest` called that method only when `GameplayContextResolver.resolve(socket.id)` was `ok: false`. Soft-disconnect keeps the binding, so same-id reconnect skipped reclaim and never re-sent `DEPOSIT_PACKAGE_PUBLISHED`.

Live FundSeat delivery remains per-mapped-socket and still drops while the transport is down. This fix does not replay missed events during the gap; it restores current server state when the socket is live again.

---

## 4. Lifecycle Flow

```text
soft disconnect (maps kept, Socket.IO room left)
        ↓
same socket.id connected  → restoreDepositProjectionForSocket(reason=protected_connect)
        ↓
optional SESSION_RECOVERY_REQUEST with bound=true
        → restoreDepositProjectionForSocket(reason=bound_recovery)
        → reconnectSession still skipped (identity already bound)
        ↓
projectDepositForPlayer(live DepositSession.bindings)
        ↓
DEPOSIT_PACKAGE_PUBLISHED { deposit }
DEPOSIT_ACTIVATION_VERIFIED when VERIFIED
        ↓
client authoritative.deposit
        ↓
canFundSeat() false when mySeatStatus=FUNDED
```

Unbound reclaim still uses full `reconnectSession()`, which now calls the same `_deliverDepositProjectionToSocket`.

---

## 5. Ownership Boundaries

Unchanged.

- Server DepositSession remains funding authority.
- `projectDepositForPlayer` remains the only projector.
- Client still mirrors `DEPOSIT_PACKAGE_PUBLISHED`.
- No client blockchain query, no Page4 wallet-balance funding, no “assume funded on reconnect.”
- Soft-disconnect identity maps, Telegram auth, RoomManager, and anti-bot are untouched.

---

## 6. Risks

- **Low** — Bound connect and bound recovery can both restore (Keah had connect then recovery ~2s later). Delivery is idempotent; the client replaces `deposit` with the same live snapshot.
- **Low** — `_handleConnection` restore runs only when `GameplayContextResolver` is already `ok`. First join is unbound and is unchanged.
- **Medium** — A real TESTNET disconnect-during-FundSeat session has not been run after this commit.

---

## 7. Recommendations

Deploy this commit. Next real TESTNET session should disconnect a funded player on Page4 and confirm the UI shows current `confirmedSeats` / `mySeatStatus` after reconnect. Do not treat this as Page5 proof.

---

## 8. Changes Made

- `server/socket/RoomLobbyBridge.js` — extracted `_deliverDepositProjectionToSocket`; added `restoreDepositProjectionForSocket`
- `server/socket/SocketGateway.js` — call restore on bound `SESSION_RECOVERY_REQUEST` and bound `_handleConnection`
- `server/tests/depositProtectedReconnect.r18s16.test.js` — Keah regression
- `server/tests/recoveryIntegration.r178d.test.js` — bound recovery now expects Deposit restore, not reclaim
- `client/src/game/session/page4PaymentPhase.test.js` — `canFundSeat` false after 2/3 FUNDED
- `client/src/game/session/staleDepositGameStart.r18s16.test.js` — GAME_START clear still holds; live 2/3 disables FundSeat
- this report

---

## 1. Executive Summary

Keah’s Lena Page4 showed 0/3 because protected same-id reconnect skipped `reconnectSession()` and never rehydrated live Deposit state. The server already had Bob and Lena funded.

The fix reuses `projectDepositForPlayer`. On protected connect and on bound `SESSION_RECOVERY_REQUEST`, the server sends the current projection (`confirmedSeats`, `mySeatStatus`, phase, address, activation, expected FundSeat amount). Page4 and `canFundSeat()` consume that projection as before. Duplicate FundSeat is prevented by existing `mySeatStatus === "FUNDED"` → `canFundSeat() === false`.

Focused tests pass. A new TESTNET session is not claimed.

---

## 2. Original Keah Failure

```text
roomId = Keah
gameId = game_3f076a0f-76b2-402e-b402-fcc062b8d421
```

Server: Bob and Lena `funded=true`, Olga unfunded, `PARTIALLY_FUNDED`. Bob UI 2/3. Lena UI 0/3. Lena first FundSeat succeeded on TESTNET; later duplicates bounced.

---

## 3. Exact Root Cause

Protected soft-disconnect keeps `GameplayContextResolver` bound to the same `socket.id`. `SESSION_RECOVERY_REQUEST` therefore skipped `reconnectSession()`, which was the only Deposit restore. Automatic connect without a recovery request had the same gap.

---

## 4. Existing Recovery Architecture

`reconnectSession()` still does identity reclaim, room rejoin, setup/payment sync, and now the shared Deposit restore. Bound same-id reconnect must not call full reclaim: Lena’s recoveries had `credentialPresent=false`, and `reconnectSession()` would deny a playerId claim without a credential. Identity stays the existing server binding.

---

## 5. Files Changed

See Changes Made above. Production code: `RoomLobbyBridge.js`, `SocketGateway.js` only.

---

## 6. Exact Code Change

`RoomLobbyBridge._deliverDepositProjectionToSocket` is the single restore implementation (same `projectDepositForPlayer` + `DEPOSIT_PACKAGE_PUBLISHED` + optional `DEPOSIT_ACTIVATION_VERIFIED`).

`RoomLobbyBridge.restoreDepositProjectionForSocket(socketId, { reason })`:

- resolves identity from `_getSocketContext` (existing maps)
- marks `CONNECTION_STATE.CONNECTED`
- re-joins the Socket.IO room (`_attachSocketToRoom`) after soft-disconnect leave
- delivers the live projection
- fail-closed if unbound or no DepositSession

`SocketGateway`:

- `_handleConnection`: if `bound.ok`, `restoreDepositProjectionForSocket(..., { reason: "protected_connect" })`
- `_handleRecoveryRequest`: if `context.ok`, `restoreDepositProjectionForSocket(..., { reason: "bound_recovery" })` before PRE_GAME_SYNC return
- unbound path still calls `reconnectGameplaySession` unchanged

Minimal log (no wallets/credentials):

```text
[R18-S16 Recovery] deposit projection restored
 | playerId | socket.id | gameId | depositId | confirmedSeats | mySeatStatus | reason
```

---

## 7. Protected Same-ID Reconnect Behavior

After soft-disconnect, `GameplayContextResolver.resolve` remains `ok: true`. `SESSION_RECOVERY_REQUEST` still does not call `reconnectSession()`. It now restores live Deposit through `restoreDepositProjectionForSocket`. Tests assert `confirmedSeats=2` and `mySeatStatus=FUNDED` for the Keah-shaped session.

---

## 8. Automatic Reconnect Behavior

`_handleConnection` is the existing Socket.IO `connection` hook (the same log line as Keah `05:55:53Z`). When the reconnecting socket is already bound, Deposit is restored without a new auth flow and without unbinding. No `SESSION_RECOVERY_REQUEST` is required.

---

## 9. Deposit Projection Behavior

Restore uses live `DepositSession.bindings` via `projectDepositForPlayer`. Frozen `metadata.depositPackage.bindings` (all `funded=false` at publish) are not used for `confirmedSeats` / `mySeatStatus`. Tests keep the freeze unfunded and assert the live projection is 2/3 FUNDED.

---

## 10. GAME_START Regression Verification

`authoritativeSessionModel.js` `GAME_START` still sets `deposit: null` and `depositActivationVerified: false`. Client tests still pass, including a new Keah-shaped case: Game A clear → initial 0/3 → live 2/3 FUNDED → `canFundSeat() === false`.

---

## 11. canFundSeat Verification

No new duplicate-payment blocker. Existing `page4PaymentPhase.canFundSeat` returns false when `mySeatStatus === "FUNDED"`. Tests cover the rehydrated 2/3 projection.

---

## 12. Financial Constants Verification

Unchanged:

```text
deployValueNanotons = 10000000
TON_DEPOSIT_CREATION_FEE_PER_SEAT_NANO = 1000000
player stake = 10000000
FundSeat = 11000000
```

Covered by `depositFundSeatPersistence.r18s16.test.js` and `depositProtectedReconnect.r18s16.test.js`.

---

## 13. 8-Minute Timeout Verification

`DEFAULT_SETUP_DURATION_MS = 480000` unchanged. `DEFAULT_PAYMENT_SESSION_DURATION_MS` remains 5 minutes. `setupTimer.r770c19.test.js` and FundSeat persistence timeout assertions passed.

---

## 14. Security Verification

No edits to Telegram init-data validation, Room ID alphabet, RoomManager admission, or anti-bot. Re-ran:

- `socketTelegramAuth.r179t6b.test.js` (7 pass)
- `roomCreationTelegramAuthorization.r179t6c.test.js`
- `identityRecovery.r131e.test.js`
- `gameplayRecovery.integration.test.js`

Identity maps are not unbound to force recovery. Credential reclaim is still required for unbound sockets.

---

## 15. Focused Tests

| Test | File |
|---|---|
| Same-id protected `SESSION_RECOVERY_REQUEST` → 2/3 FUNDED | `server/tests/depositProtectedReconnect.r18s16.test.js` |
| Automatic connect without recovery request | same |
| Live bindings vs frozen metadata | same |
| Financial constants / 8-minute setup | same + `depositFundSeatPersistence` + `setupTimer.r770c19` |
| Bound recovery still skips reclaim, now restores Deposit | `recoveryIntegration.r178d.test.js` Test A |
| Existing S4 reconnect projector | `r18S4DepositReconnect.test.js` |
| GAME_START stale clear + live 2/3 | `staleDepositGameStart.r18s16.test.js` |
| `canFundSeat` after rehydrate | `page4PaymentPhase.test.js` |
| Authoritative session mirror | `authoritativeSessionModel.test.js` |
| Telegram / RoomManager / identity | listed in §14 |

---

## 16. Test Results

All focused tests above passed (`fail 0`). No unrelated failure was used to broaden the task.

---

## 17. Git Status

Commit includes only this task’s production, test, and report files. Unrelated forensic archives, banners, and probe scripts were not added.

---

## 18. Commit SHA

Filled after push in this section.

---

## 19. Push Result

Filled after push in this section.

---

## 20. FACT

- Keah forensic: server 2/3 funded; Lena UI 0/3 after bound same-id recovery skipped `reconnectSession`.
- Production restore now runs on bound `_handleConnection` and bound `SESSION_RECOVERY_REQUEST` using `projectDepositForPlayer`.
- `reconnectSession` still skipped when bound; identity maps are not cleared.
- GAME_START still nulls `deposit` and `depositActivationVerified`.
- Focused recovery, projection, Page4, timeout, financial-constant, and Telegram tests passed.

---

## 21. INFERENCE

After deploy, a Lena-like disconnect during FundSeat should receive `confirmedSeats=2` / `mySeatStatus=FUNDED` on reconnect, so `canFundSeat()` becomes false and duplicate FundSeats should stop.

---

## 22. NOT PROVEN

- A new real TESTNET Page4 session that disconnects during FundSeat and shows the correct UI after reconnect.
- Page5 / GameEscrow / STAKE / SETTLE.
- Full Page4 adaptation complete.

---

## 23. Final Verdict

```text
PROVEN:
The Keah failure was caused by stale client Deposit state after protected
same-id reconnect/recovery.

PROVEN:
The first Lena FundSeat succeeded on TESTNET and later duplicate attempts
bounced.

IMPLEMENTED:
Current Deposit state is rehydrated on the affected protected reconnect
path, if the fix succeeds.

IMPLEMENTED:
The existing Page4 authoritativeSessionModel remains the consumer of the
server projection.

PROVEN BY TESTS:
The focused recovery regression tests pass, if they pass.

NOT YET PROVEN:
A new real TESTNET Page4 session successfully survives a player disconnect
during FundSeat and reaches the correct UI state after reconnect.

NOT YET PROVEN:
Page5 / GameEscrow / STAKE / SETTLE.
```

Page5 is not claimed. The full Page4 adaptation is not claimed complete.
