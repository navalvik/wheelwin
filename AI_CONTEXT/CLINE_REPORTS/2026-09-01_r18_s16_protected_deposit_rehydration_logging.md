# R18-S16 — Logging-Only Instrumentation for Protected Deposit Rehydration

Date: 2026-09-01

Task: Add diagnostic logging so the next TESTNET protected reconnect can prove whether `restoreDepositProjectionForSocket()` delivered the live Deposit projection to Page4. No production control-flow, financial, Page4 UI, Telegram, RoomManager, or anti-bot changes.

Classification: **LOGGING ONLY. RESTORE PATH UNCHANGED. FOCUSED TESTS PASS. REAL TESTNET RECONNECT STILL NOT PROVEN.**

---

## 1. Scope

Instrument the existing `6f45702` restore path:

```text
protected_connect / bound_recovery
        ↓
restoreDepositProjectionForSocket()
        ↓
projectDepositForPlayer()
        ↓
DEPOSIT_PACKAGE_PUBLISHED
        ↓
Page4 authoritativeSessionModel
```

Did not change recovery decisions, DepositSession, PaymentSession, GameEscrow, STAKE, SETTLE, Page4 `canFundSeat()`, or diagnostic SUCCESS/FAILED attempt accounting.

---

## 2. Files Inspected

- `server/socket/RoomLobbyBridge.js`
- `server/socket/SocketGateway.js`
- `server/deposit/projectDepositForPlayer.js`
- `server/logging/GameDiagnosticLogManager.js`
- `client/src/game/session/authoritativeSessionModel.js`
- `server/tests/depositProtectedReconnect.r18s16.test.js`
- `AI_CONTEXT/CLINE_REPORTS/2026-09-01_r18_s16_recovery_attempt_reconciliation_csU9.md`

---

## 3. Architecture Findings

Commit `6f45702` already calls restore on bound connect and bound `SESSION_RECOVERY_REQUEST`. The previous `[R18-S16 Recovery] deposit projection restored` INFO line was not copied into the room diagnostic archive (`_onLogRecord` only ingested `[R6.2A Recovery]`). csU9 therefore could not prove restore.

This task adds structured `[R18-S16 DepositRestore]` lines at the existing restore/emit points and copies those lines into the room diagnostic file **without** opening or completing recovery attempts.

---

## 4. Lifecycle Flow

Unchanged:

```text
bound=true connect
        → restoreDepositProjectionForSocket(reason=protected_connect)
bound=true SESSION_RECOVERY_REQUEST
        → reconnectSession skipped
        → restoreDepositProjectionForSocket(reason=bound_recovery)
```

New observation only:

```text
RESTORE_ATTEMPT
        ↓
existing restore / projectDepositForPlayer / emit
        ↓
PROJECTION_EMITTED  (actual payload fields)
        ↓
RESTORE_RESULT restored=true|false
        ↓
client DEPOSIT_PACKAGE_RECEIVED
        ↓
client DEPOSIT_STATE_APPLIED
```

---

## 5. Ownership Boundaries

Unchanged. Logging observes `projectDepositForPlayer` output. No second Deposit model. Frozen `metadata.depositPackage.bindings` are not used for restore fields.

---

## 6. Risks

- **Low** — Extra INFO logs on every restore, including `reconnectSession` emit (`reason=reconnect_session` on `PROJECTION_EMITTED`).
- **Low** — Client logs use `console.info`. They are proven in unit tests; Telegram Mini App console is not automatically inside the forensic zip unless the host captures it. Server `DepositRestore` lines **are** now written into the room diagnostic archive.
- **Medium** — A real TESTNET reconnect has not been run with this logging.

---

## 7. Recommendations

Keep Railway unset. Next step is a real three-device TESTNET reconnect during FundSeat, then read the new `DepositRestore` / `ClientDepositRestore` lines. Do not treat this commit as Page4 validation.

---

## 8. Changes Made

- `server/diagnostics/depositRestoreDiagnostics.js` — log formatter
- `server/socket/RoomLobbyBridge.js` — ATTEMPT / RESULT / PROJECTION_EMITTED around existing restore/emit
- `server/logging/GameDiagnosticLogManager.js` — copy `[R18-S16 DepositRestore]` into the room log; do not change attempt SUCCESS/FAILED
- `client/src/game/session/clientDepositRestoreDiagnostics.js` — client log formatter
- `client/src/game/session/authoritativeSessionModel.js` — RECEIVED / APPLIED after existing consumption
- tests listed below
- this report

---

## 1. Executive Summary

Protected Deposit restore still runs exactly as in `6f45702`. It now emits structured server logs (`RESTORE_ATTEMPT`, `RESTORE_RESULT`, `PROJECTION_EMITTED`) and Page4 logs (`DEPOSIT_PACKAGE_RECEIVED`, `DEPOSIT_STATE_APPLIED`). Focused tests pass. No TESTNET game was run. Page4 correctness after reconnect remains unproven until the next real session.

---

## 2. Existing Restore Path Inspected

```text
SocketGateway._handleConnection
    if bound.ok → restoreDepositProjectionForSocket({ reason: "protected_connect" })

SocketGateway._handleRecoveryRequest
    if context.ok → restoreDepositProjectionForSocket({ reason: "bound_recovery" })
    reconnectSession still skipped when bound=true
```

`restoreDepositProjectionForSocket` still re-joins the Socket.IO room and calls `_deliverDepositProjectionToSocket` → `projectDepositForPlayer`. Control flow was not rewritten.

---

## 3. Server Logging Added

On every `restoreDepositProjectionForSocket` invocation:

```text
[R18-S16 DepositRestore] event=RESTORE_ATTEMPT
    | roomId=... | playerId=... | socketId=... | reason=protected_connect|bound_recovery
```

After the existing restore returns:

```text
[R18-S16 DepositRestore] event=RESTORE_RESULT
    | roomId=... | playerId=... | socketId=... | reason=... | restored=true|false
```

When `restored=true`, RESULT also logs live projection fields already returned/emitted:

```text
depositAddress  state  confirmedSeats  mySeatStatus
```

`state` is the existing projector `phase` (live `DepositSession.state`). No new calculation.

---

## 4. Projection Emission Logging Added

Immediately after the existing `_deliverToSocket(..., DEPOSIT_PACKAGE_PUBLISHED, { deposit })` in `_deliverDepositProjectionToSocket`:

```text
[R18-S16 DepositRestore] event=PROJECTION_EMITTED
    | roomId=... | playerId=... | socketId=... | reason=...
    | depositAddress=... | state=... | confirmedSeats=... | mySeatStatus=...
```

The emitted payload object is unchanged.

Room diagnostic ingest writes these lines into the per-room log. It does **not** call `_beginRecoveryAttempt` / `_completeRecoveryAttempt` / `_failRecoveryAttempt`.

---

## 5. Client Logging Added

In `authoritativeSessionReducer` `DEPOSIT_PACKAGE_PUBLISHED`, after a valid `deposit` object is accepted and after the applied mirror is built:

```text
[R18-S16 ClientDepositRestore] event=DEPOSIT_PACKAGE_RECEIVED
[R18-S16 ClientDepositRestore] event=DEPOSIT_STATE_APPLIED
```

Fields are included only when present. `deployValueNanotons` is taken from the received package when present; it is not hardcoded. Invalid payloads still fail closed and do not log. `canFundSeat()` was not modified.

---

## 6. Exact Files Changed

| File | Role |
| --- | --- |
| `server/diagnostics/depositRestoreDiagnostics.js` | Server log formatter (new) |
| `server/socket/RoomLobbyBridge.js` | ATTEMPT / RESULT / EMITTED around existing restore |
| `server/logging/GameDiagnosticLogManager.js` | Archive ingest, no attempt accounting |
| `server/tests/depositProtectedReconnect.r18s16.test.js` | Restore log tests |
| `server/tests/gameDiagnosticLogManager.test.js` | Ingest without SUCCESS/FAILED change |
| `client/src/game/session/clientDepositRestoreDiagnostics.js` | Client log formatter (new) |
| `client/src/game/session/authoritativeSessionModel.js` | RECEIVED / APPLIED logs |
| `client/src/game/session/clientDepositRestoreDiagnostics.r18s16.test.js` | Client log tests |
| `AI_CONTEXT/CLINE_REPORTS/2026-09-01_r18_s16_protected_deposit_rehydration_logging.md` | This report |

`SocketGateway.js` restore call sites were not modified.

---

## 7. Exact Log Events Added

```text
[R18-S16 DepositRestore] event=RESTORE_ATTEMPT
[R18-S16 DepositRestore] event=RESTORE_RESULT
[R18-S16 DepositRestore] event=PROJECTION_EMITTED
[R18-S16 ClientDepositRestore] event=DEPOSIT_PACKAGE_RECEIVED
[R18-S16 ClientDepositRestore] event=DEPOSIT_STATE_APPLIED
```

---

## 8. Focused Tests

| Requirement | Test |
| --- | --- |
| 1. protected_connect RESTORE_ATTEMPT | `depositProtectedReconnect.r18s16.test.js` |
| 2. bound_recovery RESTORE_ATTEMPT | same |
| 3. restored=true on success | same |
| 4. RESTORE_RESULT live projection fields | same |
| 5. PROJECTION_EMITTED actual emit fields | same |
| 6. client DEPOSIT_PACKAGE_RECEIVED | `clientDepositRestoreDiagnostics.r18s16.test.js` |
| 7. client DEPOSIT_STATE_APPLIED | same |
| bound path still skips reclaim | same server tests (`reclaim success` absent) |
| diagnostic attempts unchanged | `gameDiagnosticLogManager.test.js` |
| existing reconnect + financial constants | existing tests in `depositProtectedReconnect` |
| existing Page4 reducer behaviour | `authoritativeSessionModel.test.js` |

---

## 9. Test Results

```text
depositProtectedReconnect.r18s16.test.js: pass 6, fail 0
gameDiagnosticLogManager.test.js: all assertions passed
  including "R18-S16 DepositRestore diagnostic ingest passed"
setupTimer.r770c19.test.js: all assertions passed
clientDepositRestoreDiagnostics.r18s16.test.js: all assertions passed
authoritativeSessionModel.test.js: all assertions passed
```

No TESTNET E2E game was run.

---

## 10. Financial Constants Verification

Unchanged and still asserted:

```text
deployValueNanotons = 10000000
TON_DEPOSIT_CREATION_FEE_PER_SEAT_NANO = 1000000
player stake = 10000000
FundSeat = 11000000
DEFAULT_SETUP_DURATION_MS = 8 * 60 * 1000 = 480000
DEFAULT_PAYMENT_SESSION_DURATION_MS = 8 * 60 * 1000 = 480000
```

---

## 11. Recovery Control-Flow Verification

`SocketGateway.js` still:

```text
bound=true connect → restoreDepositProjectionForSocket(reason="protected_connect")
bound=true SESSION_RECOVERY_REQUEST → restoreDepositProjectionForSocket(reason="bound_recovery")
reconnectSession skipped when bound=true
```

Focused tests assert no `reclaim success` on those paths. Restore still uses live `projectDepositForPlayer`.

---

## 12. Railway Verification

Railway was not modified. No `PAYMENT_SESSION_DURATION_MS` or other env change.

---

## 13. Git Status

Commit includes only this logging task’s production, test, and report files. Forensic extracts, banners, and unrelated reports were not added.

---

## 14. Commit SHA

```text
dbaa5ff test(recovery): instrument protected deposit rehydration
```

---

## 15. Push Result

```text
To https://github.com/navalvik/wheelwin.git
   b70e393..dbaa5ff  main -> main
```

---

## 16. FACT

- Restore control flow from `6f45702` is still the production path.
- Structured `RESTORE_ATTEMPT` / `RESTORE_RESULT` / `PROJECTION_EMITTED` logs are emitted from the existing restore/emit functions.
- Page4 reducer logs `DEPOSIT_PACKAGE_RECEIVED` and `DEPOSIT_STATE_APPLIED` after consuming a valid package.
- Diagnostic ingest copies server `DepositRestore` lines without creating SUCCESS/FAILED attempts.
- Focused tests listed above passed.
- Financial and timeout constants were not modified.

---

## 17. INFERENCE

After deploy, the next TESTNET forensic archive should contain server `DepositRestore` lines for Lena-like reconnects. Client `ClientDepositRestore` lines will appear where the Telegram/WebView console (or a future host capture) records `console.info`.

---

## 18. NOT PROVEN

- That a real TESTNET reconnect currently results in the correct Page4 Deposit state.
- That the complete protected-reconnect Deposit flow is production-ready.
- Page5 reached by this task.
- Full Page4 adaptation complete.

---

## 19. Final Verdict

```text
PROVEN:
The existing protected Deposit restore path remains unchanged.

PROVEN:
The next TESTNET session will produce server-side evidence showing
whether restoreDepositProjectionForSocket() executed and what it returned.

PROVEN:
The next TESTNET session will produce evidence of the actual Deposit
projection emitted to the reconnecting socket.

PROVEN:
The next TESTNET session will produce client-side evidence of the
Deposit state received and applied by Page4.

NOT PROVEN:
That a real TESTNET reconnect currently results in the correct Page4
Deposit state. This requires the next real TESTNET session.

NOT PROVEN:
That the complete protected-reconnect Deposit flow is production-ready.
```
