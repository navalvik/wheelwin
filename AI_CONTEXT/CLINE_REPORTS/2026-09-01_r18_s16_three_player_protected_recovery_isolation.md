# R18-S16 — Three-Player Protected Recovery Isolation Test

Date: 2026-09-01

Task: Add a focused test proving Bob, Lena, and Olga can independently perform protected Deposit recovery in the same room without recovery-identity collision or cross-socket projection delivery.

Classification: **TEST ONLY. PRODUCTION SOURCE CHANGES = 0. NO TESTNET. NO RAILWAY CHANGE.**

Test commit: `18dfe86` `test(recovery): verify multi-player protected isolation`

---

## 1. Scope

Close the focused-test gap recorded in `AI_CONTEXT/CLINE_REPORTS/2026-09-01_r18_s16_generic_player_recovery_verification.md`:

```text
multiple players
+
same room
+
independent protected reconnects
+
independent projection delivery
```

Did not change recovery control flow, Page4, DepositContract, GameEscrow, Telegram, RoomManager, anti-bot, or Railway.

---

## 2. Files Inspected

- `server/tests/depositProtectedReconnect.r18s16.test.js` (extended)
- `server/tests/r18DepositProjection.test.js` (reviewed, not modified)
- `server/tests/r18S4DepositReconnect.test.js` (reviewed, not modified)
- `server/socket/SocketGateway.js` (`_handleConnection` protected_connect path — read only)
- `server/socket/RoomLobbyBridge.js` (`restoreDepositProjectionForSocket`, `_stashRecoveryOwnership` — read only)
- `server/deposit/projectDepositForPlayer.js` (read only)
- `server/config/rooms.js` (timeout defaults — read only)
- `AI_CONTEXT/CLINE_REPORTS/2026-09-01_r18_s16_generic_player_recovery_verification.md`

---

## 3. Architecture Findings

Production restore remains:

```text
socket.id
    ↓
GameplayContextResolver.resolve / _socketToPlayer
    ↓
playerId
    ↓
projectDepositForPlayer(...)
    ↓
_deliverToSocket(reconnectingSocketId, DEPOSIT_PACKAGE_PUBLISHED)
```

Soft-disconnect still stashes per `playerId` / `socketId` into `_recoveryOwnershipByPlayer` and `_recoveryOwnershipBySocket`. Restore does not collapse those maps onto the last recovered player.

Nicknames in the new fixture are labels only. Identity assertions use distinct `playerId` and `socketId` values issued by `PlayerManager` / test constants.

---

## 4. Lifecycle Flow

```text
arrange 3 bound players in one room
        ↓
soft-disconnect all three (protected session stash)
        ↓
Bob   protected_connect restore
Lena  protected_connect restore
Olga  protected_connect restore
        ↓
assert per-player RESTORE_RESULT, projection, socket delivery
        ↓
assert three independent recovery-ownership entries remain
```

Second test repeats restore order `Olga → Bob → Lena`.

---

## 5. Ownership Boundaries

| Owner | Responsibility |
|---|---|
| `SocketGateway._handleConnection` | production protected_connect restore trigger |
| `RoomLobbyBridge` | maps, stash, restore, unicast delivery |
| `projectDepositForPlayer` | requester-scoped seat fields |
| Test file | fixture, assertions; no production hooks |

---

## 6. Risks

### Low — unit isolation is not TESTNET

The new test proves in-process isolation. It does not prove Bob or Olga recovered on Railway.

### Low — activation unicast

`DEPOSIT_ACTIVATION_VERIFIED` may also unicast to the restoring socket. Assertions filter `DEPOSIT_PACKAGE_PUBLISHED` only, which is the private Deposit projection event.

No production-behavior risk from this test-only change.

---

## 7. Recommendations

1. Keep using this test as the regression for multi-player protected restore.
2. Do not treat this test as Bob/Olga real TESTNET recovery.
3. Do not change production restore because this test passed.

---

## 8. Changes Made

- `server/tests/depositProtectedReconnect.r18s16.test.js` — added isolation fixture and two tests
- This report

Production source: **no files modified.**

---

# Verification Report (task sections 1–23)

---

## 1. Executive Summary

The remaining focused-test gap is closed.

Three distinct players in one room independently complete protected Deposit restore (`protected_connect`) with:

- `RESTORE_RESULT restored=true` for each player
- player-specific `mySeatIndex` / `isCreator` / `mySeatStatus`
- unicast `DEPOSIT_PACKAGE_PUBLISHED` only to that player's socket
- three remaining `_recoveryOwnershipByPlayer` and `_recoveryOwnershipBySocket` entries
- last restore (Olga or Lena) does not overwrite Bob or the earlier player

**PROVEN BY CODE:** recovery is player-scoped and not Lena-specific (prior audit + this fixture uses the same production path).

**PROVEN BY REAL TESTNET:** Lena independently recovered in a real TESTNET session (prior sessions; not re-run here).

**PROVEN BY FOCUSED TEST:** Bob, Lena, and Olga can independently perform protected recovery in the same room without recovery-identity collision and with player-specific socket delivery.

```text
Bob real TESTNET recovery = NOT PROVEN
Olga real TESTNET recovery = NOT PROVEN
```

---

## 2. Existing Test Coverage Reviewed

| File | What it already proved | Gap |
|---|---|---|
| `depositProtectedReconnect.r18s16.test.js` | Lena same-id protected restore; live bindings; restore logs | Only Lena's socket restored |
| `r18DepositProjection.test.js` | Three synthetic seats get distinct projections on publish | Does not call `restoreDepositProjectionForSocket` |
| `r18S4DepositReconnect.test.js` | Unbound `reconnectGameplaySession` for creator and seat 2 | Not the bound protected_connect path |

Existing Lena assertions were preserved.

---

## 3. New Test Added

File: `server/tests/depositProtectedReconnect.r18s16.test.js`

```text
R18-S16: three players independently restore without identity collision
R18-S16: three-player restore isolation does not depend on restore order
```

Helpers reuse `buildStack`, `createGateway`, `captureInfo`, `restoreLogsMatching`, `stubCoordinator`, and the same financial constants. New fixture `arrangeIsolationRoom` uses the same RoomLobbyBridge / PlayerManager / DepositSession shape. Not a parallel mock architecture.

---

## 4. Exact Test Scenario

```text
player 0 = Bob   socket = BOB_SOCKET_ID    mySeatIndex = 0  isCreator = true   mySeatStatus = PENDING
player 1 = Lena  socket = LENA_SOCKET_ID   mySeatIndex = 1  isCreator = false  mySeatStatus = FUNDED
player 2 = Olga  socket = OLGA_SOCKET_ID   mySeatIndex = 2  isCreator = false  mySeatStatus = PENDING
```

`playerId` values come from `playerManager.createPlayer` (distinct UUIDs). Identity correctness does not depend on Telegram nickname strings.

Primary sequence: Bob → Lena → Olga via `SocketGateway._handleConnection` (`reason=protected_connect`).

Optional sequence: Olga → Bob → Lena (same assertions).

---

## 5. Bob Recovery Result

**PROVEN BY FOCUSED TEST**

- `RESTORE_ATTEMPT` includes Bob `playerId` and `BOB_SOCKET_ID`
- `RESTORE_RESULT restored=true` for Bob
- projection `mySeatIndex = 0`, `isCreator = true`, `mySeatStatus = PENDING`
- `DEPOSIT_PACKAGE_PUBLISHED` delivered only to `BOB_SOCKET_ID`

---

## 6. Lena Recovery Result

**PROVEN BY FOCUSED TEST**

- `RESTORE_RESULT restored=true` for Lena
- projection `mySeatIndex = 1`, `isCreator = false`, `mySeatStatus = FUNDED`
- delivered only to `LENA_SOCKET_ID`

---

## 7. Olga Recovery Result

**PROVEN BY FOCUSED TEST**

- `RESTORE_RESULT restored=true` for Olga
- projection `mySeatIndex = 2`, `isCreator = false`, `mySeatStatus = PENDING`
- delivered only to `OLGA_SOCKET_ID`

After Olga restore, Bob ownership still maps to `BOB_SOCKET_ID` and Lena to `LENA_SOCKET_ID`.

---

## 8. Projection Isolation Results

Each restore's payload:

| Player | mySeatIndex | isCreator | mySeatStatus | myExpectedAmountNanotons |
|---|---|---|---|---|
| Bob | 0 | true | PENDING | 11000000 |
| Lena | 1 | false | FUNDED | 11000000 |
| Olga | 2 | false | PENDING | 11000000 |

Room-global `confirmedSeats = 1` (only Lena funded) and `depositAddress` match the fixture. Player-specific fields are not replaced by another seat. After all three restores, the captured Bob/Lena/Olga projection objects still match those seat fields.

---

## 9. Socket Delivery Isolation Results

Mapping asserted:

```text
Bob    → BOB_SOCKET_ID
Lena   → LENA_SOCKET_ID
Olga   → OLGA_SOCKET_ID
```

Each restore emits exactly one `DEPOSIT_PACKAGE_PUBLISHED`. That event's `socketId` is the restoring player. The other two sockets receive **zero** projection events from that restore. Delivery is `_deliverToSocket`, not a room broadcast.

---

## 10. Recovery Ownership Isolation Results

After all three protected restores:

```text
_recoveryOwnershipByPlayer.size === 3
_recoveryOwnershipBySocket.size === 3
```

Each `playerId` maps to its own `{ roomId, socketId }`. Each `socketId` maps to its own `{ playerId, roomId }`. `_playerToSocket` / `_socketToPlayer` remain 1:1.

The test fails if Bob's ownership is overwritten by Lena, or Lena's by Olga, or if the last recovered player becomes a room-wide identity.

---

## 11. Focused Test Commands

From `G:\WheelWin\server`:

```text
node --test tests/depositProtectedReconnect.r18s16.test.js tests/r18DepositProjection.test.js tests/r18S4DepositReconnect.test.js
```

---

## 12. Test Results

```text
✔ R18-S16: same-id protected SESSION_RECOVERY_REQUEST restores live 2/3 FUNDED
✔ R18-S16: automatic Socket.IO connect without SESSION_RECOVERY_REQUEST restores Deposit
✔ R18-S16: recovery projection uses live bindings, not frozen metadata snapshot
✔ R18-S16: financial constants and setup timeout remain unchanged
✔ R18-S16: protected_connect restore emits RESTORE_ATTEMPT and RESTORE_RESULT
✔ R18-S16: bound_recovery restore emits RESTORE_ATTEMPT and live projection logs
✔ R18-S16: three players independently restore without identity collision
✔ R18-S16: three-player restore isolation does not depend on restore order
✔ tests/r18DepositProjection.test.js
✔ tests/r18S4DepositReconnect.test.js

pass 10, fail 0
```

Existing recovery assertions still pass. `r18DepositProjection` and `r18S4DepositReconnect` still pass.

---

## 13. Production Source Changes

```text
production source changes = 0
```

No `TESTABILITY_BLOCKER`. Existing public restore path and private maps already used by this test file were sufficient.

---

## 14. Financial Constants Verification

Unchanged. Isolation test reuses the same constants and the existing financial-constants test still asserts:

```text
deployValueNanotons = 10000000
TON_DEPOSIT_CREATION_FEE_PER_SEAT_NANO = 1000000
player stake = 10000000
FundSeat = 11000000
DEFAULT_PAYMENT_SESSION_DURATION_MS = 480000
DEFAULT_SETUP_DURATION_MS = 480000
```

---

## 15. Anti-Bot Verification

No modifications to Telegram authorization, Room ID authorization, RoomManager, active room creation quota, or anti-bot protection.

---

## 16. Railway Verification

```text
Railway changes = none
```

---

## 17. Git Status

Before the test commit, the only file belonging to this task was:

```text
server/tests/depositProtectedReconnect.r18s16.test.js  (+411)
```

Production socket/deposit/config/manager files had no diff.

After `git push origin main`:

```text
## main...origin/main
18dfe86 test(recovery): verify multi-player protected isolation
```

Unrelated untracked forensic extracts and older reports were not staged.

This report file is recorded in a follow-up docs commit.

---

## 18. Commit Hash

```text
18dfe86 test(recovery): verify multi-player protected isolation
```

---

## 19. Push Result

```text
To https://github.com/navalvik/wheelwin.git
   244e7cd..18dfe86  main -> main
```

`origin/main` includes `18dfe86`.

---

## 20. FACT

- New focused tests pass for Bob, Lena, and Olga independent protected_connect restore in one room.
- Each restore unicasts that player's projection to that player's socket.
- Recovery ownership maps keep three distinct player/socket entries after all restores.
- Production source was not modified.
- Financial constants and timeouts were not modified.
- Existing Lena protected-reconnect tests still pass.

---

## 21. INFERENCE

- The same isolation would hold for `bound_recovery` (`SESSION_RECOVERY_REQUEST`) because both reasons call `restoreDepositProjectionForSocket(socket.id)`. This task exercised `protected_connect` only, matching the existing Lena automatic-connect path.

---

## 22. NOT PROVEN

```text
Bob real TESTNET recovery = NOT PROVEN
Olga real TESTNET recovery = NOT PROVEN
```

Also not proven by this test:

- Page5 reached
- Page4 adaptation complete
- Production readiness
- Railway reconnect against a live replica

A focused unit/integration test is **not** equivalent to real TESTNET.

---

## 23. Final Verdict

**PROVEN BY CODE:** Recovery is player-scoped and not Lena-specific.

**PROVEN BY REAL TESTNET:** Lena independently recovered in a real TESTNET session.

**PROVEN BY FOCUSED TEST:** Bob, Lena, and Olga can independently perform protected recovery in the same room without recovery-identity collision and with player-specific socket delivery.

Do not claim Bob or Olga real TESTNET recovery. Do not claim Page5, Page4 adaptation complete, or production readiness.
