# R18-S16 — Clear Stale Deposit Projection at GAME_START

Date: 2026-08-31

Task: Stop Page4 from FundSeat-ing a previous game’s DepositContract by clearing game-scoped Deposit client state on `GAME_START`. No TESTNET E2E. No financial-constant, timeout, Telegram, or persistence-path changes.

Classification: **GAME_START NOW CLEARS `deposit` AND `depositActivationVerified`. GAME A → GAME B REGRESSION COVERED BY TESTS. PAGE5 NOT YET PROVEN.**

---

## Scope

Client `authoritativeSessionReducer` `GAME_START` only, plus focused tests. Server FundSeat persistence, DepositContract, Page4 builders, and setup timeout are unchanged.

---

## Files Inspected

- `client/src/game/session/authoritativeSessionModel.js` (`GAME_START`, `DEPOSIT_PACKAGE_PUBLISHED`, `DEPOSIT_ACTIVATION_VERIFIED`)
- `client/src/game/session/page4PaymentPhase.js` (`canFundSeat`, `isDepositActivationVerified`)
- `client/src/pages/Page4Payment.jsx` (reads `authoritative.deposit` only)
- `client/src/context/AuthoritativeSessionContext.jsx`
- `AI_CONTEXT/CLINE_REPORTS/2026-08-31_r18_s16_fundseat_011ton_return_forensic.md`
- Persistence tests: `server/tests/depositFundSeatPersistence.r18s16.test.js`, `depositOnChainVerification.r179l8.test.js`
- Timeout: `server/config/rooms.js`, `server/tests/setupTimer.r770c19.test.js`
- Telegram: `server/tests/socketTelegramAuth.r179t6b.test.js`

---

## Architecture Findings

`GAME_START` already nulls `paymentSession` and `gameContract` but spread `...state`, so `deposit` and `lifecycle.depositActivationVerified` survived a new room. Page4 `canFundSeat` then used the old `depositAddress`. Deposit is not in `localStorage`. Projection has no `roomId`/`gameId`; clearing at `GAME_START` is sufficient (tests did not require a new protocol field).

---

## Lifecycle Flow

```text
GAME_START (new game)
  → deposit = null
  → depositActivationVerified = false
  → canFundSeat === false
  → DEPOSIT_PACKAGE_PUBLISHED (server, current game)
  → deployValueNanotons from package (10000000)
  → DEPOSIT_ACTIVATION_VERIFIED
  → canFundSeat may become true for the NEW address only
```

---

## Ownership Boundaries

Unchanged. Server still publishes the package. Client still mirrors it. `GAME_START` is the existing game-scope wipe for payment/escrow; Deposit now matches that wipe.

---

## Risks

- **Low** — If a client never receives `GAME_START` for the new room, stale deposit could still remain. Production rooms emit `GAME_START` / `startGame` as today.
- **Low** — `GAME_START_AUTHORIZED` does not clear deposit; it is a later lifecycle stamp, not a new-room boundary.

---

## Recommendations

Deploy this commit. Next real TESTNET session should prove a **new** DepositContract address on FundSeat. Do not treat this as Page5 proof.

---

## Changes Made

- `client/src/game/session/authoritativeSessionModel.js` — `GAME_START` sets `deposit: null` and `depositActivationVerified: false`
- `client/src/game/session/authoritativeSessionModel.test.js` — GAME_START empty-state assertions
- `client/src/game/session/staleDepositGameStart.r18s16.test.js` — Game A → Game B regression
- this report

---

## 1. Executive Summary

The 0.011 TON bounce in `dvgw` was FundSeat to the previous game’s (`sZqc`) DepositContract because client Deposit state survived `GAME_START`. The reducer now clears that state the same way it already cleared `paymentSession` and `gameContract`. Focused tests prove Game B cannot FundSeat Game A’s address until a new authoritative package + activation. No real post-fix TESTNET session was run. Page5 is **NOT YET PROVEN**.

---

## 2. Previous Real TESTNET Failure

```text
room dvgw / game_ad21aa84-1645-423e-9035-9e1622c03fac
FundSeat 11000000 opcode 0x46554E44
destination = sZqc EQA80SoX…
exit_code 43927 bounce
```

Wallet confirmation and chain submission were real. Amount and payload were correct. Destination was stale.

---

## 3. Exact Stale-State Root Cause

`authoritativeSessionReducer` `GAME_START` used `...state` and only overwrote payment/escrow mirrors. `deposit` and `lifecycle.depositActivationVerified` remained. `isDepositActivationVerified` is true if **either** the projection `activationStatus` is VERIFIED **or** the lifecycle flag is true. Both had to be cleared.

---

## 4. GAME_START State Transition

Before:

```text
paymentSession = null
gameContract = null
deposit = (preserved)
depositActivationVerified = (preserved via ...state.lifecycle)
```

After:

```text
paymentSession = null
gameContract = null
deposit = null
depositActivationVerified = false
```

`entryPayment` and `walletConnection` were already nulled; left unchanged.

---

## 5. Deposit State Fields Examined

| Field | Game-scoped? | Survived GAME_START before? | Change |
|---|---|---|---|
| `state.deposit` | yes | yes | now null |
| `lifecycle.depositActivationVerified` | yes | yes | now false |
| `paymentSession` | yes | no (already null) | unchanged |
| `gameContract` | yes | no (already null) | unchanged |
| Page4 `depositSubmitting` | ephemeral UI | n/a | untouched |
| localStorage deposit | none | n/a | none |
| projection `roomId`/`gameId` | not present | n/a | not invented |

---

## 6. Exact Code Change

`GAME_START` return value adds `deposit: null` and `depositActivationVerified: false` on the existing lifecycle object.

No Page4 hardcoded `10000000`. No client-synthesized DepositContract address.

---

## 7. Exact Files Changed

```text
client/src/game/session/authoritativeSessionModel.js
client/src/game/session/authoritativeSessionModel.test.js
client/src/game/session/staleDepositGameStart.r18s16.test.js
AI_CONTEXT/CLINE_REPORTS/2026-08-31_r18_s16_stale_deposit_game_start_fix.md
```

---

## 8. canFundSeat Safety Verification

After `GAME_START`, `canFundSeat(state.deposit, state.lifecycle) === false` (deposit null, flag false). After new `DEPOSIT_PACKAGE_PUBLISHED` without VERIFIED, still false. After `DEPOSIT_ACTIVATION_VERIFIED` on the **new** projection, true. Other checks (seat index, amount, funded status) unchanged.

---

## 9. Game/Room Correlation

Deposit projection still has no `roomId`/`gameId`. Reset at `GAME_START` was sufficient in focused tests. No new protocol field.

---

## 10. Regression Test for Game A → Game B

`staleDepositGameStart.r18s16.test.js`:

```text
sZqc VERIFIED deposit + canFundSeat true
  → GAME_START dvgw
  → deposit null, flag false, canFundSeat false
  → DEPOSIT_PACKAGE_PUBLISHED new address, deployValueNanotons 10000000
  → canFundSeat still false
  → DEPOSIT_ACTIVATION_VERIFIED
  → canFundSeat true, address ≠ sZqc
```

---

## 11. FundSeat Persistence Regression Tests

`depositFundSeatPersistence.r18s16.test.js` and `depositOnChainVerification.r179l8.test.js` passed (partial, multi-seat, FULL, reload, idempotency, untrusted source). Coordinator code not edited.

---

## 12. Financial Constants Verification

```text
DEPOSIT_CONTRACT_DEPLOY_VALUE_NANOTONS = "10000000"  UNCHANGED
TON_DEPOSIT_CREATION_FEE_PER_SEAT_NANO               UNCHANGED
1:1 stake / FundSeat 11000000                        UNCHANGED in tests
Page4 has no hardcoded 10000000
```

---

## 13. Security/Anti-Bot Verification

No Telegram, Room ID, RoomManager, or anti-bot edits. `socketTelegramAuth.r179t6b.test.js` passed (7 cases).

---

## 14. 8-Minute Timeout Verification

`DEFAULT_SETUP_DURATION_MS = 8 * 60 * 1000` unchanged. Persistence test and `setupTimer.r770c19.test.js` passed.

---

## 15. Focused Tests Executed

```text
client: staleDepositGameStart.r18s16.test.js
client: authoritativeSessionModel.test.js
client: page4PaymentPhase.test.js
client: gameAuthority.test.js
client: page4DepositActivationHandoff.test.js
server: depositFundSeatPersistence.r18s16.test.js
server: depositOnChainVerification.r179l8.test.js
server: setupTimer.r770c19.test.js
server: socketTelegramAuth.r179t6b.test.js
```

---

## 16. Test Results

All of the above passed (client 4+existing GAME_START/Page4/authority/handoff; server 32 including persistence, timeout, Telegram).

---

## 17. Railway Status

No Railway variable change. Production picks up the client/server commit via the normal GitHub→Railway (and Vercel frontend) deploy of this push.

---

## 18. Git Status

See commit. Only task files staged.

---

## 19. Commit Hash

`5561f4f` — `fix(page4): clear stale deposit state on game start`

---

## 20. Push Result

Pending `git push origin main` of `5561f4f`.

---

## 21. FACT

- `GAME_START` previously preserved deposit + verified flag.
- After this change it nulls both.
- Tests: Game B cannot use Game A’s `depositAddress` before a new package.
- Persistence, 8-minute setup, Telegram auth tests still pass.
- No new TESTNET game.

---

## 22. INFERENCE

A real Mini App that receives `GAME_START` for the next room will no longer offer FundSeat against the previous contract.

---

## 23. NOT PROVEN

- Live post-fix TESTNET deploy + FundSeat on a **new** DepositContract.
- Page5, Deposit FULL, GameEscrow.
- Clients that skip `GAME_START`.

---

## 24. Final Verdict

**PROVEN:** The previous 0.011 TON FundSeat failure was caused by the Page4 client using stale Deposit state from the previous game.

**IMPLEMENTED:** The stale game-specific Deposit state is cleared at `GAME_START`.

**PROVEN BY TESTS:** A new game cannot use the previous game's Deposit state before receiving a new authoritative Deposit package.

**NOT YET PROVEN:** A real post-fix TESTNET player session successfully deploys the new DepositContract and completes FundSeat.

**NOT YET PROVEN:** Page5 has been reached.
