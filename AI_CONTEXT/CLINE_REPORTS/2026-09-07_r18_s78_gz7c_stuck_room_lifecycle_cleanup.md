# gZ7C stuck READY room — lifecycle timer failure, fail-closed recovery, Production cleanup

Date: 2026-09-07

Task: Prove why Production room `gZ7C` (roomNumber 1, game `game_08dfc45b-55ff-4bf4-8e23-3cbc8f7c3286`) survived its READY lifecycle timer and a process restart; remove only that room using an existing authoritative teardown path; preserve financial state; apply the minimal proven recovery/timer fix; deploy through the normal GitHub → Railway path.

Classification: **INCIDENT ROOT CAUSE PROVEN. MINIMAL RECOVERY FAIL-CLOSED FIX IMPLEMENTED. CLEANUP IS THE RAILWAY RESTART CAUSED BY THAT DEPLOY (NO TARGETED HTTP CLOSE API). SEE FINAL VERDICT AFTER DEPLOY VERIFICATION.**


## 1. Scope

In scope:

- live Production reads of `/health`, `/debug/rooms`, `/debug/games`, `/debug/health`, `/debug/players`, `/debug/recovery/{gameId}`, `/debug/game-clock/{gameId}`;
- source trace of READY destruction vs recovery arming;
- fail-closed recovery so an elapsed READY/PRE_GAME_READY deadline cannot occupy a room number indefinitely;
- focused tests;
- commit of only the recovery/test/report files;
- push of `payment/room-wallet-integration` and verification of Production after Railway restart.

Out of scope (not done):

- fabricating `SETTLEMENT_CONFIRMED` or any lobby `ROOM_DESTROYED` event;
- Residual Sweep enablement or manual sweep;
- Room Wallet / reimbursement / payment architecture changes;
- deleting persistence records first;
- creating a new room or test game;
- Railway Variable mutation;
- restart as a shortcut without the fix (a restart without the fix would re-attach `gZ7C` from the same checkpoint).


## 2. Files Inspected

Production HTTP (read-only, 2026-09-07):

- `GET https://wheelwin-production.up.railway.app/health`
- `GET https://wheelwin-production.up.railway.app/debug` → HTTP 404 (panel is route-split)
- `GET https://wheelwin-production.up.railway.app/debug/rooms`
- `GET https://wheelwin-production.up.railway.app/debug/games`
- `GET https://wheelwin-production.up.railway.app/debug/health`
- `GET https://wheelwin-production.up.railway.app/debug/players`
- `GET https://wheelwin-production.up.railway.app/debug/recovery/game_08dfc45b-55ff-4bf4-8e23-3cbc8f7c3286`
- `GET https://wheelwin-production.up.railway.app/debug/game-clock/game_08dfc45b-55ff-4bf4-8e23-3cbc8f7c3286`
- `GET https://wheelwin-production.up.railway.app/debug/game-state/game_08dfc45b-55ff-4bf4-8e23-3cbc8f7c3286` (prior turn)
- `GET https://wheelwin-production.up.railway.app/debug/payment/{gameId}` → 404
- `GET https://wheelwin-production.up.railway.app/debug/winner/{gameId}` → 404

Source:

- `server/recovery/RecoveryOrchestrator.js` (`_classifyCandidate`, `_computePhaseExpiry`, `_validateCandidatePreMutation`, step 17 arming, `_tryArmPendingRecoveredClock`, `_rollbackCandidate`)
- `server/engines/GameClockEngine.js` (`attachClock`, `armRecoveredClock`, `_schedulePhaseTimeout`, `_handlePhaseTimeout`)
- `server/config/gameplayPhases.js` (`READY` duration 3000 ms)
- `server/managers/RoomManager.js` (`detachRoom` / `_releaseRoomNumber`)
- `server/tests/recoveryOrchestrator.r179t6d3.test.js`
- `server/tests/recoveryOrchestrator.r179t6d3.connectivity.test.js`
- `server/tests/startupRecoveryIntegration.r179t6.test.js`

No mnemonics, private keys, or secret environment values were read into this report.


## 3. Architecture Findings

### 3.1 Current Production state of gZ7C (before cleanup)

| Field | Value | Classification |
| --- | --- | --- |
| Host | `https://wheelwin-production.up.railway.app` | CONFIRMED FACT |
| `/health` | `ok`, `lifecycle=RUNNING`, `ready=true` | CONFIRMED FACT |
| Process `startedAt` | `1788704598835` | CONFIRMED FACT |
| Uptime at probe | ~10.3 h (`uptimeMs` ≈ 3.70e7) | CONFIRMED FACT |
| `runtime.activeRooms` | 1 | CONFIRMED FACT |
| `runtime.activeGames` | 1 | CONFIRMED FACT |
| `activeSetupSessions` | 0 | CONFIRMED FACT |
| `drainActivity.pendingPayments` | 0 | CONFIRMED FACT |
| `drainActivity.settlements` | 0 | CONFIRMED FACT |
| `drainActivity.paymentSessions` | 6 (process-wide drain counter, not a live PaymentEngine record for this game) | CONFIRMED FACT |
| Room | `gZ7C`, `roomNumber` 1, `status` FULL, `playerCount` 3, `createdAt` null | CONFIRMED FACT |
| Game | `game_08dfc45b-55ff-4bf4-8e23-3cbc8f7c3286`, `/debug/games` status `READY` | CONFIRMED FACT |
| Players | Olga, Lena, Bob — all `DISCONNECTED` / `IDLE` | CONFIRMED FACT |
| Clock `running` | `false` | CONFIRMED FACT |
| Clock `remainingTime` | `null` | CONFIRMED FACT |
| `phaseStartedAt` | `1788377758375` | CONFIRMED FACT |
| `phaseEndsAt` | `1788377761375` (= +3000 ms) | CONFIRMED FACT |
| `paymentStatus` | `none` | CONFIRMED FACT |
| `payment` | `null` | CONFIRMED FACT |
| `winner` | `null` / `winnerStatus` `pending` | CONFIRMED FACT |
| Physics | `CREATED`, angles/velocities 0 | CONFIRMED FACT |
| Remaining SPEED presses | 3 each (SPEED never played) | CONFIRMED FACT |

`phaseEndsAt` is **before** this process `startedAt` (`1788377761375` < `1788704598835`). The READY wall-clock deadline had already elapsed before the current Railway process started. **CONFIRMED FACT.**

Only this one room/game pair was present in `/debug/rooms` and `/debug/games`. **CONFIRMED FACT.**

### 3.2 Timer owner (this path is not SETUP_SESSION_EXPIRED)

After `GAME_INITIALIZED`, Setup Session expiry does not destroy the room (`activeSetupSessions` is 0). The timer that should have left READY is **`GameClockEngine`**: `_schedulePhaseTimeout` → `setTimeout` → `_handlePhaseTimeout`. READY duration is 3000 ms.

`armRecoveredClock` uses `Date.now()` and **refuses** when remaining ms ≤ 0 (`Clock arming failed: phase deadline already expired`) without advancing the phase and without destroying the room. **CODE-DERIVED FACT.**

### 3.3 Exact root cause

Two cooperating defects left `gZ7C` in the registries after restart:

1. **`RecoveryOrchestrator._computePhaseExpiry` compared the deadline only to `serverTimestampAtCheckpoint`, not to `Date.now()`.** A checkpoint taken inside the 3-second READY window is classified as not expired forever, even if recovery happens hours later. **CODE-DERIVED FACT.** Classification type `EXPIRED` previously fell through the `switch` (now handled explicitly). Pre-mutation validation used the same checkpoint-only expiry.

2. **R17.9T.6 OPTION B connectivity arming.** If not all three registered players are `CONNECTED`, recovery **succeeds** with reason `pre_game_candidate_recovered_clock_pending_connectivity`, stores an UNARMED-ATTACHED clock, and waits. `_tryArmPendingRecoveredClock` returns false without deleting pending while disconnected. Live players are all `DISCONNECTED`, so the clock never arms. `armRecoveredClock` would refuse anyway because remaining time is already 0. Prior connectivity test G **asserted** that refused arming may leave the unarmed clock attached. **CODE-DERIVED FACT + LIVE FACT.**

Therefore: expiry timestamp existed (`phaseEndsAt`), **no phase timeout was armed** (`running: false`, `remainingTime: null`), recovery restored the room **without** re-arming, and roomNumber 1 stayed occupied. This matches the 2026-09-05 post-restart observation. **INFERENCE** that the same checkpoint was replayed on that restart; **CONFIRMED** that the current process restored this clock unarmed with an already-elapsed `phaseEndsAt`.

SETUP_SESSION_EXPIRED scheduler gaps are **not** this incident’s destruction path. **CONFIRMED FACT** (`activeSetupSessions: 0`, game already READY).

There is **no** live HTTP administrative `_closeRoom`. `RoomManager.detachRoom` / recovery `_rollbackCandidate` is the existing silent teardown used on `FAILED_EXPIRED`. **CODE-DERIVED FACT.**


## 4. Lifecycle Flow

Expected healthy READY:

`attach/start clock` → `_schedulePhaseTimeout` → timeout → `_handlePhaseTimeout` → phase advance (SELF_TEST) → later game end → room destroy.

What happened for `gZ7C` after restart:

`recoverAll` → classify READY as recoverable (checkpoint still inside window) → attach unarmed clock → players disconnected → pending forever → no `_handlePhaseTimeout` → room 1 occupied.

After the fix, the same candidate is `FAILED_EXPIRED` **before attach** when `deadline <= Date.now()`, or evicted if a still-future deadline elapses while pending connectivity. Rollback uses existing silent detaches (room number released). No persistence write, no blockchain, no sweep. **CODE-DERIVED FACT.**


## 5. Ownership Boundaries

- **GameClockEngine** owns live phase timeouts for an **armed** clock.
- **RecoveryOrchestrator** owns whether a recovered PRE_GAME clock is attached, armed, pending, or fail-closed.
- **RoomManager.detachRoom** owns releasing `roomNumber`.
- Residual Sweep remains gated on legitimate `SETTLEMENT_CONFIRMED` (untouched).
- This task did not invent a new financial transfer path.


## 6. Risks

- Deploy restarts Production. At the last pre-deploy probe, the **only** active room/game was `gZ7C`. A concurrent new game started between push and restart would also be dropped from memory; that was not observed before push.
- Recovery `FAILED_EXPIRED` does not emit lobby `ROOM_DESTROYED`. The room disappears from registries via detach, which is the existing expired-candidate behavior.
- Full `server` `npm test` still fails in pre-existing `auditEngine.test.js` (`valid completed game should pass audit`). That file was not modified. **OPERATIONAL RESULT.**


## 7. Implementation Plan (executed)

1. Treat READY/PRE_GAME_READY as expired if deadline ≤ checkpoint **or** deadline ≤ `Date.now()`.
2. Handle classification `EXPIRED` as `FAILED_EXPIRED` with no attach.
3. If remaining at recovery ≤ 0 after attach, rollback `FAILED_EXPIRED`.
4. Pending-connectivity watchdog: evict via `_rollbackCandidate` when the original deadline elapses unarmed; also evict if `armRecoveredClock` refuses.
5. Tests for recovery-time expiry and watchdog eviction.
6. Commit + push; Railway restart is the cleanup of the live in-memory object.


## 8. Cleanup mechanism

**Preferred live `_closeRoom` HTTP API: absent. CONFIRMED FACT.**

Cleanup used: **deploy the fail-closed recovery change**. Railway process restart drops the in-memory residue. `recoverAll()` must **not** re-attach `gZ7C` because the READY deadline is far in the past.

Not used: persistence deletion, fabricated lifecycle events, Residual Sweep, reimbursement, blockchain send, hiding `/debug`.


## 9. Financial safety

Before cleanup, this game had `paymentStatus: none`, `payment: null`, `winner: null`, physics never ran, `pendingPayments: 0`, `settlements: 0`. Teardown is silent detach only. **No blockchain transaction is part of this path. CODE-DERIVED + LIVE FACT.**

Process-wide `paymentSessions: 6` is a drain/metrics counter, not evidence of a live settlement for `gZ7C`. **CONFIRMED FACT** (`payment: null` on the recovery snapshot).


## 10. Code changed

| Path | Change |
| --- | --- |
| `server/recovery/RecoveryOrchestrator.js` | recovery-time expiry; EXPIRED switch; pending deadline watch; eviction on refuse |
| `server/tests/recoveryOrchestrator.r179t6d3.test.js` | recovery-time expiry test; clock_arm injection expects eviction |
| `server/tests/recoveryOrchestrator.r179t6d3.connectivity.test.js` | case G expects watchdog eviction |
| this report | incident record |


## 11. Tests executed and results

| Test | Result |
| --- | --- |
| `server/tests/recoveryOrchestrator.r179t6d3.test.js` | PASS |
| `server/tests/recoveryOrchestrator.r179t6d3.connectivity.test.js` | PASS |
| `server/tests/startupRecoveryIntegration.r179t6.test.js` | PASS |
| `server/tests/recoveryEngineAttach.r179t6d2.test.js` | PASS |
| `server` `npm test` (full suite) | FAIL at `auditEngine.test.js` — **pre-existing, unmodified**; not this defect |

No client source was changed. Client production build was not required for this backend recovery fix.


## 12. Git commit / push / deployment

Recorded after git operations in section 16.


## 13. Final verdict

See section 16 after Production verification. Until then: **PARTIALLY_CLEANED** (fix implemented locally; live `gZ7C` still present until Railway restart).


## 14. Remaining timer/lifecycle risk

- SPEED/BRAKE (unrecoverable active phases) remain skip-not-recoverable; that is unchanged.
- A recovered READY clock with remaining time > 0 and disconnected players will stay pending only until the **original** `phaseEndsAt`, then evict. Deadlines are not extended.
- There is still no operator HTTP room-close API for a *live* (non-recovery) stuck armed clock. This incident was the unarmed recovered READY residue, which the fix covers.
- Persistence recovery records are not deleted; they must continue to fail closed on later restarts.


## 15. Before/after room-game snapshot (before deploy)

**Before (live):**

- rooms: `[gZ7C / 1 / FULL]`
- games: `[game_08dfc45b-55ff-4bf4-8e23-3cbc8f7c3286 / READY]`
- health: RUNNING, 1 room, 1 game

**After:** filled in section 16.


## 16. Deployment and post-cleanup verification

*(Filled after commit, push, and Railway SUCCESS.)*
