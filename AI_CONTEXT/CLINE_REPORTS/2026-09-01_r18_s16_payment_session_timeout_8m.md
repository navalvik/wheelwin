# R18-S16 — Payment Session Timeout Extension: 5 Minutes to 8 Minutes

Date: 2026-09-01

Task: Increase only `DEFAULT_PAYMENT_SESSION_DURATION_MS` from 300000 ms (5 minutes) to 480000 ms (8 minutes). Leave setup timeout at 480000 ms. No TESTNET game. No financial, reconnect, Telegram, RoomManager, or anti-bot changes.

Classification: **PAYMENT SESSION DEFAULT IS NOW 8 MINUTES. SETUP TIMEOUT REMAINS 8 MINUTES. FOCUSED TESTS PASS. REAL TESTNET SESSION NOT YET PROVEN.**

---

## 1. Scope

Operational timeout change only:

```text
DEFAULT_PAYMENT_SESSION_DURATION_MS
    5 minutes = 300000 ms
        ↓
    8 minutes = 480000 ms
```

Did not change DepositContract economics, GameEscrow, STAKE, SETTLE, Telegram authorization, RoomManager, anti-bot, Page4 UI, or the protected-reconnect Deposit rehydration from commit `6f45702`. Did not run a real TESTNET game.

---

## 2. Files Inspected

- `server/config/rooms.js`
- `server/gameplay/PaymentSessionManager.js`
- `server/gameplay/SetupSessionLifecycle.js`
- `server/app.js` (paymentDurationMs wiring)
- `server/deposit/resolveDepositOrchestrationFinancials.js` (timeout fallback + financial env keys)
- `server/deposit/DepositOrchestrator.js` (`DEPOSIT_CONTRACT_DEPLOY_VALUE_NANOTONS`)
- `server/socket/RoomLobbyBridge.js` (wallet-connection 5-minute fallback; reconnect methods)
- `server/socket/SocketGateway.js` (reconnect restore path; not modified)
- `server/gameplay/ResultSessionLifecycle.js`
- `server/gameplay/GameContractManager.js` (`paymentDeadline` 5-minute literal — unrelated)
- `server/tests/setupTimer.r770c19.test.js`
- `server/tests/depositFundSeatPersistence.r18s16.test.js`
- `server/tests/depositProtectedReconnect.r18s16.test.js`
- `server/tests/paymentSession.manager.test.js`
- `server/tests/runtimeConfiguration.r179g1.test.js` (fixture 300000, not production default)

---

## 3. Architecture Findings

Authoritative production default lives in `server/config/rooms.js`. `loadRoomConfig()` uses `DEFAULT_PAYMENT_SESSION_DURATION_MS` when `PAYMENT_SESSION_DURATION_MS` is absent.

`PaymentSessionManager` reads `roomConfig.paymentSessionDurationMs` when finite and positive. If `roomConfig` is missing, it used a local fallback that was still `5 * 60 * 1000`. That fallback was aligned to 8 minutes so a ctor without roomConfig cannot silently expire at 5 minutes.

Setup remains independently `DEFAULT_SETUP_DURATION_MS = 8 * 60 * 1000` in `rooms.js` and `SetupSessionLifecycle.js`.

Wallet, result, deploy, and game-start-authorization timers were not changed.

---

## 4. Lifecycle Flow

```text
loadRoomConfig()
    SETUP_DURATION_MS absent → DEFAULT_SETUP_DURATION_MS = 8 * 60 * 1000
    PAYMENT_SESSION_DURATION_MS absent → DEFAULT_PAYMENT_SESSION_DURATION_MS = 8 * 60 * 1000
        ↓
app.js passes paymentSessionDurationMs / paymentDurationMs
        ↓
PaymentSessionManager._durationMs
    roomConfig.paymentSessionDurationMs if finite > 0
    else local DEFAULT_PAYMENT_SESSION_DURATION_MS = 8 * 60 * 1000
        ↓
PaymentSession wall-clock expiry at durationMs
```

Setup timer is a separate lifecycle (`SetupSessionLifecycle`) with its own 8-minute default.

---

## 5. Ownership Boundaries

Unchanged.

- `rooms.js` owns production room timer defaults.
- `PaymentSessionManager` owns PaymentSession wall-clock expiry.
- `SetupSessionLifecycle` owns setup expiry.
- Deposit economics remain in `DepositOrchestrator` / `resolveDepositOrchestrationFinancials`.
- Protected-reconnect Deposit restore remains in `RoomLobbyBridge` / `SocketGateway` from `6f45702`.

---

## 6. Risks

- **Low** — Existing `resolveDepositTimeoutMs` can fall back to `paymentDurationMs` when `TON_DEPOSIT_TIMEOUT_MS` is absent. That wiring already existed; this change does not add a second timer constant. Deposit expiry may follow PaymentSession (now 8 minutes) in that fallback case.
- **Low** — Railway `PAYMENT_SESSION_DURATION_MS` was not set as part of this task. Code default applies when the env key is absent. An explicit Railway override of 300000 would still win; none was added here.
- **Medium** — A real TESTNET session has not used the new 8-minute PaymentSession timeout.

---

## 7. Recommendations

Keep Railway unset unless production already requires an explicit override. Next separate step is the real TESTNET protected-reconnect game. Do not treat this timeout change as Page5 proof.

---

## 8. Changes Made

- `server/config/rooms.js` — `DEFAULT_PAYMENT_SESSION_DURATION_MS = 8 * 60 * 1000`
- `server/gameplay/PaymentSessionManager.js` — local fallback constant aligned to 8 minutes
- `server/tests/setupTimer.r770c19.test.js` — PaymentSession default expectation 8 minutes; wallet/result remain 5 minutes
- `server/tests/depositFundSeatPersistence.r18s16.test.js` — independent 8-minute setup and PaymentSession assertions; source-read both constants; reject leftover 5-minute PaymentSession default
- `server/tests/depositProtectedReconnect.r18s16.test.js` — `paymentSessionDurationMs` expectation 480000 only
- `server/tests/paymentSession.manager.test.js` — ctor without roomConfig → `getDurationMs() === 8 * 60 * 1000`
- this report

---

## 1. Executive Summary

PaymentSession default timeout is now 8 minutes (480000 ms). Setup timeout remains independently 8 minutes (480000 ms). Wallet, result, and deploy timers remain 5 minutes / 5 minutes / 2 minutes. Financial constants and the `6f45702` protected-reconnect Deposit restore are unmodified. Focused tests passed. No TESTNET game was run.

---

## 2. Previous PaymentSession Timeout

```text
DEFAULT_PAYMENT_SESSION_DURATION_MS = 5 * 60 * 1000
                                     = 300000 ms
                                     = 5 minutes
```

Defined in `server/config/rooms.js` and duplicated as the `PaymentSessionManager` ctor fallback.

---

## 3. New PaymentSession Timeout

```text
DEFAULT_PAYMENT_SESSION_DURATION_MS = 8 * 60 * 1000
                                     = 480000 ms
                                     = 8 minutes
```

Same named constant in `rooms.js` (production `loadRoomConfig` default) and `PaymentSessionManager.js` (ctor fallback when `roomConfig.paymentSessionDurationMs` is not finite).

---

## 4. Exact Authoritative Constant

Production path:

```text
server/config/rooms.js
const DEFAULT_PAYMENT_SESSION_DURATION_MS = 8 * 60 * 1000
```

`loadRoomConfig()` uses this when `env.PAYMENT_SESSION_DURATION_MS` is undefined.

Fallback path (no roomConfig):

```text
server/gameplay/PaymentSessionManager.js
const DEFAULT_PAYMENT_SESSION_DURATION_MS = 8 * 60 * 1000
```

No second timeout constant was created. Call sites still consume `roomConfig.paymentSessionDurationMs` / `getDurationMs()`.

---

## 5. Exact Files Changed

| File | Change |
| --- | --- |
| `server/config/rooms.js` | PaymentSession default 5 min → 8 min |
| `server/gameplay/PaymentSessionManager.js` | Fallback default 5 min → 8 min |
| `server/tests/setupTimer.r770c19.test.js` | Expect PaymentSession 8 min; wallet/result stay 5 min |
| `server/tests/depositFundSeatPersistence.r18s16.test.js` | Independent 8 min setup + PaymentSession; source-read constants |
| `server/tests/depositProtectedReconnect.r18s16.test.js` | Expect `paymentSessionDurationMs === 480000` |
| `server/tests/paymentSession.manager.test.js` | Default duration 8 minutes without roomConfig |
| `AI_CONTEXT/CLINE_REPORTS/2026-09-01_r18_s16_payment_session_timeout_8m.md` | This report |

`server/socket/RoomLobbyBridge.js` and `server/socket/SocketGateway.js` were not modified.

---

## 6. Setup Timeout Verification

```text
server/config/rooms.js
const DEFAULT_SETUP_DURATION_MS = 8 * 60 * 1000   // unchanged

server/gameplay/SetupSessionLifecycle.js
const DEFAULT_SETUP_DURATION_MS = 8 * 60 * 1000   // unchanged
```

`loadRoomConfig({ ROOM_MAX_PLAYERS: "3" }).setupDurationMs === 480000` in `setupTimer.r770c19.test.js`, `depositFundSeatPersistence.r18s16.test.js`, and `depositProtectedReconnect.r18s16.test.js`.

---

## 7. PaymentSession Timeout Verification

```text
loadRoomConfig({ ROOM_MAX_PLAYERS: "3" }).paymentSessionDurationMs === 480000
PaymentSessionManager({... no roomConfig}).getDurationMs() === 480000
```

Source-read assertions require both `rooms.js` and `PaymentSessionManager.js` to define:

```text
const DEFAULT_PAYMENT_SESSION_DURATION_MS = 8 * 60 * 1000
```

and reject:

```text
const DEFAULT_PAYMENT_SESSION_DURATION_MS = 5 * 60 * 1000
```

Existing PaymentSession expiry tests still inject a short `durationMs` (20 ms) to prove timeout behaviour; they do not depend on the production default.

`runtimeConfiguration.r179g1.test.js` still uses `{ paymentSessionDurationMs: 300000 }` as a **snapshot fixture**, not as `loadRoomConfig()` default. That fixture was not updated.

---

## 8. Other Timeout Verification

Left unchanged:

| Timer | Value |
| --- | --- |
| `DEFAULT_RESULT_SESSION_DURATION_MS` | `5 * 60 * 1000` |
| `DEFAULT_WALLET_CONNECTION_DURATION_MS` | `5 * 60 * 1000` |
| `RoomLobbyBridge` wallet-connection fallback | `5 * 60 * 1000` |
| `DEFAULT_GAME_CONTRACT_DEPLOY_TIMEOUT_MS` | `2 * 60 * 1000` |
| `DEFAULT_GAME_START_AUTHORIZATION_DURATION_MS` | `60 * 1000` |
| `GameContractManager` `paymentDeadline` literal | `5 * 60 * 1000` (not PaymentSession duration) |

Those 5-minute values were not changed merely because they share the old PaymentSession number.

---

## 9. Financial Constants Verification

Unchanged in source and asserted in focused tests:

```text
deployValueNanotons = 10000000
    DepositOrchestrator DEPOSIT_CONTRACT_DEPLOY_VALUE_NANOTONS = "10000000"

TON_DEPOSIT_CREATION_FEE_PER_SEAT_NANO = 1000000
    still required env in resolveDepositOrchestrationFinancials.js
    not hardcoded into DepositOrchestrator

player stake = 10000000
FundSeat = 11000000
```

`depositProtectedReconnect.r18s16.test.js` asserts:

```text
setupDurationMs = 480000
paymentSessionDurationMs = 480000
DEPLOY_VALUE_NANOTONS = 10000000
CREATION_FEE_PER_SEAT = 1000000
EXPECTED_STAKE = 10000000
FUNDSEAT_AMOUNT = 11000000
```

No Railway financial variable was modified.

---

## 10. Protected-Reconnect Regression Verification

```text
git diff 6f45702 HEAD -- server/socket/RoomLobbyBridge.js server/socket/SocketGateway.js
→ empty
```

Working-tree diff for those files is also empty. Last commit touching them:

```text
6f45702 fix(recovery): rehydrate deposit on protected reconnect
```

Reconnect tests still pass (same-id recovery, automatic connect restore, live bindings vs frozen metadata). Only the PaymentSession duration expectation in the financial/timeout assertion was updated from 300000 to 480000.

---

## 11. Security / Anti-Bot Verification

No edits to Telegram authorization, Room ID protection, RoomManager, or anti-bot modules. Those files are not in this task’s diff.

---

## 12. Focused Tests

| Coverage | File |
| --- | --- |
| Setup timer 8 min; PaymentSession 8 min; wallet/result remain 5 min | `setupTimer.r770c19.test.js` |
| PaymentSession creation / injected short expiry | `paymentSession.manager.test.js` |
| Default duration 8 minutes without roomConfig | `paymentSession.manager.test.js` |
| Independent setup + PaymentSession 8 min; financial constants | `depositFundSeatPersistence.r18s16.test.js` |
| Reconnect + financial/timeout constants | `depositProtectedReconnect.r18s16.test.js` |

---

## 13. Test Results

```text
setupTimer.r770c19.test.js: all assertions passed
depositFundSeatPersistence.r18s16.test.js: pass 6, fail 0
depositProtectedReconnect.r18s16.test.js: pass 4, fail 0
paymentSession.manager.test.js: all assertions passed
  including "default duration 8 minutes: OK"
```

No TESTNET E2E game was run.

---

## 14. Git Status

Commit includes only this timeout task’s production, test, and report files. Unrelated forensic archives, banners, probe scripts, and other modified reports were not added.

---

## 15. Commit SHA

Pending — filled after `git commit` / `git push`.

---

## 16. Push Result

Pending — filled after `git push origin main`.

---

## 17. FACT

- Authoritative `DEFAULT_PAYMENT_SESSION_DURATION_MS` is `8 * 60 * 1000` in `server/config/rooms.js`.
- `PaymentSessionManager` fallback of the same name is also `8 * 60 * 1000`.
- `DEFAULT_SETUP_DURATION_MS` remains `8 * 60 * 1000`.
- Wallet / result / deploy / game-start-auth defaults were not changed.
- `deployValueNanotons = 10000000`, `TON_DEPOSIT_CREATION_FEE_PER_SEAT_NANO = 1000000`, stake `10000000`, FundSeat `11000000` remain as asserted.
- `RoomLobbyBridge.js` and `SocketGateway.js` have no diff versus `6f45702`.
- Focused tests listed above passed.

---

## 18. INFERENCE

If Railway does not set `PAYMENT_SESSION_DURATION_MS`, production PaymentSession wall-clock will be 8 minutes after deploy. If `TON_DEPOSIT_TIMEOUT_MS` is also absent, existing Deposit timeout fallback may inherit the same 8 minutes via `paymentDurationMs`.

---

## 19. NOT PROVEN

- A real TESTNET game session has successfully used the new 8-minute PaymentSession timeout.
- A real TESTNET player disconnect during FundSeat successfully reconnects and receives the correct current Deposit state.
- Page5 / GameEscrow / STAKE / SETTLE.
- Full Page4 adaptation complete.

---

## 20. Final Verdict

```text
PROVEN:
DEFAULT_PAYMENT_SESSION_DURATION_MS is now 480000 ms / 8 minutes,
if the implementation and focused tests succeed.

PROVEN:
DEFAULT_SETUP_DURATION_MS remains 480000 ms / 8 minutes.

PROVEN:
The financial constants remain unchanged.

PROVEN:
The protected-reconnect Deposit fix remains intact.

NOT YET PROVEN:
A real TESTNET game session has successfully used the new 8-minute
PaymentSession timeout.

NOT YET PROVEN:
A real TESTNET player disconnect during FundSeat successfully reconnects
and receives the correct current Deposit state.

NOT PROVEN:
Page5 / GameEscrow / STAKE / SETTLE.
```
