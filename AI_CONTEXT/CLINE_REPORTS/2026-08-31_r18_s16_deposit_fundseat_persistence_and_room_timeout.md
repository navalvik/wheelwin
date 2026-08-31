# R18-S16 — Deposit FundSeat Persistence + Room/Setup Timeout

Date: 2026-08-31

Task: Determine why successful on-chain FundSeat transactions in room `sZqc` did not update the persisted DepositSession, apply the smallest server-side correction, and raise the Setup Session wall-clock from 5 minutes to 8 minutes.

Classification: **INCREMENTAL FUNDSEAT APPLY ADDED. SETUP TIMEOUT 300s → 480s. PAGE5 NOT YET PROVEN.**

---

## 1. Scope

Server-side DepositSession mutation/persistence after validated `DEPOSIT_SEAT_FUNDED`, plus isolated `DEFAULT_SETUP_DURATION_MS` change. No TESTNET E2E, no Railway variable write, no Page4/GameEscrow/Telegram changes, no financial-constant changes.

---

## 2. Files Inspected

- Forensic: `AI_CONTEXT/CLINE_REPORTS/2026-08-31_r18_s16_page4_deposit_deployment_forensic_diagnosis.md`
- `_forensic_sZqc/ton-financial/active/deposit_session/dep_7fc340f9-4bcd-4c29-9a22-c54458062915.json`
- `_forensic_sZqc/ton-financial/active/payment_session/pay_02115475-ef06-4bd9-8113-0376056855a8.json`
- `server/deposit/DepositMonitor.js`
- `server/deposit/DepositOnChainVerificationCoordinator.js`
- `server/deposit/DepositSessionCoordinator.js`
- `server/deposit/DepositSession.js`
- `server/deposit/RealTonDepositBlockchainSource.js`
- `server/deposit/DepositObservation.js`
- `server/payment/BlockchainMonitor.js` (calls `depositMonitor.poll()`)
- `server/config/rooms.js`
- `server/gameplay/SetupSessionLifecycle.js`
- `server/app.js` (wiring only)

---

## 3. Architecture Findings

`DepositMonitor` observes chain, persists **observations**, and emits `DEPOSIT_SEAT_FUNDED` / `DEPOSIT_FULL_ONCHAIN`. It does **not** mutate DepositSession (documented at the top of `DepositMonitor.js`).

`DepositOnChainVerificationCoordinator` was the only mutator, and it subscribed **only** to `DEPOSIT_FULL_ONCHAIN`, which the monitor emits only when **all** watched seats are funded. Individual FundSeat success therefore never called `applyFunding`.

`paidMask` / `totalCredited` are on-chain getters (`RealTonDepositBlockchainSource.getDepositState`). Server authority for seats is `bindings[].funded` + `receivedAmount` + session `state`. Tests treat paidMask as the seat bitmask and totalCredited as the sum of `receivedAmount`.

Setup timeout is `DEFAULT_SETUP_DURATION_MS` in `server/config/rooms.js`, overridable by `SETUP_DURATION_MS`. Payment/wallet/result timers are **separate** 5-minute constants.

---

## 4. Lifecycle Flow

```text
FundSeat on-chain
  → BlockchainMonitor poll → DepositMonitor.poll
  → RealTonDepositBlockchainSource.pollWatch
  → processObservation (VALIDATED)
  → persist observation
  → emit DEPOSIT_SEAT_FUNDED
  → [R18-S16] applyFunding → persist DepositSession
  → 3rd seat: DEPOSIT_FULL + emit DEPOSIT_FULL_ONCHAIN (idempotent)
```

Before this change, step `applyFunding` ran only after `DEPOSIT_FULL_ONCHAIN`.

---

## 5. Ownership Boundaries

Unchanged. DepositMonitor still does not mutate sessions. Coordinator remains the only applyFunding caller. Page4, GameEscrow, Telegram, RoomManager anti-bot untouched.

---

## 6. Risks

- **Medium** — sZqc ZIP contained no `deposit_observation` files (`DepositObservation.toRecord()` sets `roomId: null`, so forensic `findByRoom` omits them). Whether poll processed Bob/Lena before destroy remains **NOT PROVEN**. The session-state bug is proven even if poll succeeded.
- **Low** — If Railway sets `SETUP_DURATION_MS=300000`, the source default 480000 will not apply until that env is unset or updated. This task does not write Railway variables.
- **Low** — Duplicate same-tx observation persist still throws immutable-record (pre-existing). Seat apply is idempotent.

---

## 7. Recommendations

Deploy this commit. Do not treat 8-minute setup as a FundSeat fix. A later real TESTNET session is required for Page5. Optional follow-up: stamp `roomId`/`gameId` on observation records so forensic ZIPs include them.

---

## 8. Changes Made

- `server/deposit/DepositOnChainVerificationCoordinator.js` — apply each validated `DEPOSIT_SEAT_FUNDED` to the matching DepositSession and persist via existing `applyFunding`.
- `server/config/rooms.js` — `DEFAULT_SETUP_DURATION_MS` 5 min → 8 min.
- `server/gameplay/SetupSessionLifecycle.js` — fallback constant aligned to 8 min.
- Tests: `server/tests/depositFundSeatPersistence.r18s16.test.js`, updates to `depositOnChainVerification.r179l8.test.js` Test2 and `setupTimer.r770c19.test.js`.
- This report.

---

# Investigation sections (required)

## 1. Executive Summary

On-chain FundSeat for Bob and Lena in `sZqc` succeeded. The archived DepositSession still had `funded=false` / `receivedAmount=0` because the production coordinator applied funding **only when all three seats were observed**. Two of three never emitted `DEPOSIT_FULL_ONCHAIN`, so `applyFunding` never ran.

The fix applies `applyFunding` on each validated `DEPOSIT_SEAT_FUNDED` (same coordinator, same persist path). Setup default timeout is now 8 minutes. Focused tests prove PARTIALLY_FUNDED after 1–2 seats, DEPOSIT_FULL after 3, reload, and idempotency. Page5 is **NOT YET PROVEN**.

## 2. Real TESTNET Session Evidence

| Item | Value |
|---|---|
| Room | `sZqc` |
| Game | `game_32676636-56fe-4ed5-acfe-c77958522716` |
| Deposit | `dep_7fc340f9-4bcd-4c29-9a22-c54458062915` |
| Address | `EQA80SoX-wCnr3r0UjCcORE9qKCv2cX0ExaTEKzyqZJAcSDI` |
| Deploy | PROVEN 10000000 from Olga at 16:10:19Z |
| Activation | PROVEN `VERIFIED` at 16:10:27.920Z |
| Room destroy | 16:11:34.902Z, duration 300001 ms |

## 3. FundSeat Blockchain Evidence

ON-CHAIN SUCCESS (not in ZIP; prior live tonapi read):

| Time UTC | Player | Amount | Result |
|---|---|---|---|
| 16:10:44 | Bob `EQAtggW7…` | 11000000 FUND | ok |
| 16:10:57 | Lena `EQDeWBnz…` | 11000000 FUND | ok |
| later retries | Bob/Lena | 11000000 | failed bounce |
| — | Olga | — | no successful FundSeat before destroy |

## 4. DepositSession Evidence

SERVER SESSION STATE at archive (`updatedAt = 1788192627920` = VERIFIED time):

```text
state = AWAITING_FUNDS
bindings[].funded = false
bindings[].receivedAmount = 0
depositFullAt = null
```

Do not infer persistence from chain. The ZIP DepositSession does not reflect Bob/Lena.

## 5. FundSeat Detection Path

```text
BlockchainMonitor._pollGlobal
  → DepositMonitor.poll()
  → RealTonDepositBlockchainSource.pollWatch
  → decode FUND 0x46554E44
  → DepositMonitor.processObservation
  → persist deposit_observation
  → emit DEPOSIT_SEAT_FUNDED
  → emit DEPOSIT_FULL_ONCHAIN only if fundedWallets.size >= bindings.length
```

Detection success for sZqc: **NOT PROVEN** (no observation files in ZIP). Watch is authorized only after VERIFIED (`requireActivationVerification: true`).

## 6. DepositSession Mutation Path

Before: `DepositOnChainVerificationCoordinator._handleDepositFullOnChain` → `_applyAllFunding` → `DepositSessionCoordinator.applyFunding` → `DepositSession.applyFunding` sets `funded`, `receivedAmount`, `fundingEventId`, `PARTIALLY_FUNDED` / `DEPOSIT_FULL`.

After: same `applyFunding` also runs from `_handleDepositSeatFunded` for each VALIDATED monitor observation.

In-memory + persist: `_run` persists then commits. Correct session is selected by `payload.depositId`. Untrusted sources rejected.

## 7. Persistence Path

```text
applyFunding
  → coordinator._run
  → session.applyFunding
  → _persist → TonFinancialPersistence.saveDepositSession
  → subsequent restoreFromPersistence / loadDepositSession
```

sZqc `updatedAt` equals `verifiedAt`, not FundSeat times. Persistence of seats **did not occur**. Not a silent save failure of a later write — the write was never requested.

Observation records use `roomId: null`, so forensic collection by room/game would omit them even if saved.

## 8. Exact Root Cause

**FACT from source.** `DEPOSIT_SEAT_FUNDED` had no production subscriber that mutates DepositSession. `RoomLobbyBridge` re-projects the **unmutated** session. `applyFunding` waited for 3/3 `DEPOSIT_FULL_ONCHAIN`.

sZqc had 2/3 on-chain FundSeats. Session stayed unfunded.

This is not a stale-object race and not a wrong-session-id swap. It is a missing incremental apply.

## 9. Last Proven Step

On-chain FundSeat SUCCESS (Bob, Lena). Server activation VERIFIED. Package `deployValueNanotons=10000000`.

## 10. First Failed/Unproven Step

**FAILED (source):** DepositSession mutation after individual FundSeat.

**NOT PROVEN (sZqc runtime):** whether `processObservation` ran before `ROOM_DESTROYED`.

## 11. Exact Code Change

`DepositOnChainVerificationCoordinator`:

- Subscribe to `DEPOSIT_SEAT_FUNDED` from `EVENT_SOURCES.DEPOSIT_MONITOR`.
- Require `observationStatus === VALIDATED`.
- `applyFunding({ wallet, amount, fundingEventId: observationId })`.
- Skip already-funded / already-full; treat duplicate funding errors as already applied.
- Keep `DEPOSIT_FULL_ONCHAIN` path (skips funded bindings).

Setup: `DEFAULT_SETUP_DURATION_MS = 8 * 60 * 1000` in `rooms.js` and the lifecycle fallback only.

## 12. Exact Files Changed

- `server/deposit/DepositOnChainVerificationCoordinator.js`
- `server/config/rooms.js`
- `server/gameplay/SetupSessionLifecycle.js`
- `server/tests/depositFundSeatPersistence.r18s16.test.js` (new)
- `server/tests/depositOnChainVerification.r179l8.test.js`
- `server/tests/setupTimer.r770c19.test.js`
- `AI_CONTEXT/CLINE_REPORTS/2026-08-31_r18_s16_deposit_fundseat_persistence_and_room_timeout.md`

## 13. Room Timeout Before

`DEFAULT_SETUP_DURATION_MS = 5 * 60 * 1000` (300000). sZqc lived 300001 ms.

## 14. Room Timeout After

`DEFAULT_SETUP_DURATION_MS = 8 * 60 * 1000` (480000).

Unchanged: `DEFAULT_PAYMENT_SESSION_DURATION_MS`, `DEFAULT_WALLET_CONNECTION_DURATION_MS`, `DEFAULT_RESULT_SESSION_DURATION_MS` (still 5 min), deploy timeout 2 min, game-start auth 60 s.

## 15. Why the Timeout Change Is Separate from the Persistence Fix

Eight minutes would have delayed `sZqc` destroy. It would not have written `funded=true` without incremental `applyFunding`. Persistence is correctness. Timeout is operational slack.

## 16. Focused Tests

`node --test tests/depositFundSeatPersistence.r18s16.test.js tests/depositOnChainVerification.r179l8.test.js tests/setupTimer.r770c19.test.js`

Covers detection (VALIDATED observation), correct session/seat, funded, receivedAmount, paidMask bitmask, totalCredited sum, DEPOSIT_FULL after 3, reload, no double-count, duplicate idempotency, 480s setup, other timers unchanged.

## 17. Test Results

25/25 passed (6 R18-S16 + 18 R17.9L.8 + setupTimer file).

## 18. Financial Constants Verification

```text
DEPOSIT_CONTRACT_DEPLOY_VALUE_NANOTONS = "10000000"   UNCHANGED
TON_DEPOSIT_CREATION_FEE_PER_SEAT_NANO               UNCHANGED (env)
1:1 stake map                                        UNCHANGED
FundSeat expectedAmount tests use 11000000           test-only
```

## 19. Security/Anti-Bot Verification

No Telegram, Room ID, RoomManager, or anti-bot edits. Untrusted `DEPOSIT_SEAT_FUNDED` (non-monitor source) is rejected. Tested.

## 20. Railway Status

No Railway variable change. Production will pick up the code after this commit deploys. If `SETUP_DURATION_MS` is set to 300000 in Railway, setup will stay 5 minutes until that env is changed — **not done in this task**.

## 21. Git Status

See commit below. Only task files staged.

## 22. Commit Hash

`53f05d9` — `fix(deposit): persist FundSeat confirmations`

## 23. Push Result

`53f05d9` pushed to `origin/main` (`bfbcb2d..53f05d9`).

## 24. FACT

- sZqc on-chain deploy 10000000 and two FundSeat 11000000 ok; DepositSession archive unfunded.
- Coordinator applied funding only on 3/3 FULL before this change.
- Incremental apply + 8-minute setup default implemented.
- Focused tests pass. No live post-fix TESTNET session.

## 25. INFERENCE

- If sZqc poll had processed Bob/Lena, the old code still would not persist seats.
- 8-minute setup would have given ~3 extra minutes after 16:11:34.

## 26. NOT PROVEN

- sZqc `processObservation` execution.
- Olga FundSeat.
- Page5, GameEscrow, INIT_GAME, OPEN_PAYMENTS, STAKE, SETTLE.
- Post-fix real Mini App session.
- Railway env `SETUP_DURATION_MS` current value.

## 27. Final Verdict

1. **Why FundSeat did not appear in DepositSession:** production code mutated the session only on `DEPOSIT_FULL_ONCHAIN` (all seats). Two successful chain FundSeats never reached that event.

2. **Minimal correction:** `DepositOnChainVerificationCoordinator` applies each validated `DEPOSIT_SEAT_FUNDED` via existing `applyFunding` + persist.

3. **Timeout 5 → 8 minutes:** yes, `DEFAULT_SETUP_DURATION_MS` only.

4. **STATUS_FULL proven?** In focused fake-observation tests, yes. On a real post-fix TESTNET session, **NOT YET PROVEN**.

5. **Page5 reached?** **NOT YET PROVEN**.

```text
STEP                                      STATUS
---------------------------------------------------------
FundSeat blockchain transaction           PROVEN (sZqc Bob/Lena)
FundSeat detection                        NOT PROVEN (sZqc poll). PROVEN in tests.
Correct DepositSession selected           PROVEN (tests; source uses depositId)
DepositSession mutation                   PROVEN (tests; was FAILED in sZqc archive)
Persistence write                         PROVEN (tests)
Persistence reload                        PROVEN (tests)
funded = true                             PROVEN (tests)
receivedAmount updated                    PROVEN (tests)
paidMask updated                          PROVEN (tests; server bitmask from bindings)
totalCredited updated                     PROVEN (tests; sum of receivedAmount)
STATUS_FULL after all seats               PROVEN (tests only)
Room/setup timeout = 8 minutes            PROVEN (source default + tests)
Other unrelated timers unchanged          PROVEN (tests)
Page5                                     NOT YET PROVEN
```
