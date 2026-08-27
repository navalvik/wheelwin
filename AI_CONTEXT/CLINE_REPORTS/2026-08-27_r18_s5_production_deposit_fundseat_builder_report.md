# R18-S5 — Production DepositContract FundSeat Transaction Builder

## 1. Status

**R18_S5_VERIFIED**

Commit: `30ee96e3767f9c770a266450478ad9f0dda3a451`

Commit message: `R18-S5 production Deposit FundSeat transaction builder`

Present on:
- HEAD ✓
- main ✓
- origin/main ✓

---

## 2. Objective

R18-S5 implemented an isolated production client-side transaction builder for the existing `DepositContract.FundSeat` operation.

The task was intentionally limited to **transaction construction only** — it does NOT:
- integrate with Page4;
- connect to React;
- send any blockchain transaction;
- change the server DepositSession state machine;
- replace the existing PaymentSession/GameContract flow.

The builder converts authoritative Deposit projection values into a TonConnect-ready `sendTransaction` request object.

---

## 3. Existing protocol/reference discovered

**Authoritative server encoder:**
- File: `server/deposit/RealTonDepositBlockchainSource.js`
- Constant: `FUND_SEAT_OPCODE = 0x46554E44` (line 32)
- Function: `encodeFundSeatBody(seatIndex)` (line 201+)

**Payload structure:**
```
opcode:  uint32  — 0x46554E44 (FUND_SEAT)
seat:    uint8  — 0..2
```

No `query_id` field in the authoritative encoder.

**Relationship to client builder:**
The client `buildFundSeatPayload(seatIndex)` in `buildFundDepositTransaction.js` mirrors the server encoding exactly — `beginCell().storeUint(0x46554E44, 32).storeUint(seatIndex, 8).endCell().toBoc().toString("base64")`.

---

## 4. Production helper created

**File:** `client/src/payment/buildFundDepositTransaction.js`

**Responsibility:** Construct a TonConnect `sendTransaction` request for `DepositContract.FundSeat` using only server-authoritative values.

**Accepted inputs:**
- `depositAddress` (string) — authoritative DepositContract destination
- `mySeatIndex` (number) — authoritative seat index (0..2)
- `myExpectedAmountNanotons` (number|string|bigint) — authoritative expected amount in nanotons
- `network` (string, optional) — authoritative network tag
- `validUntilSeconds` (number, default 600)
- `nowMs` (number, default `Date.now()`)

**Key functions:**
- `buildFundSeatPayload(seatIndex)` — encodes the FundSeat body as base64 BOC
- `expectedAmountNanotonsToString(myExpectedAmountNanotons)` — converts to exact decimal string via BigInt (no precision loss, no fee addition)
- `buildFundDepositTransaction(params)` — assembles the full TonConnect transaction request

**Fail-closed behavior:**
- Rejects missing/non-string/non-valid `depositAddress`
- Rejects missing/non-integer/out-of-range `mySeatIndex` (must be 0..2)
- Rejects missing/non-positive `myExpectedAmountNanotons`
- Rejects unsupported `network` tag when supplied
- Rejects malformed input (boolean, NaN, etc.)
- No defaults, no local calculations, no amount derivation

**Transaction structure produced:**
```js
{
  validUntil: <unix_seconds>,
  messages: [
    {
      address: "<depositAddress>",           // authoritative, unchanged
      amount: "<myExpectedAmountNanotons>",  // exact string of nanotons
      payload: "<base64 BOC>"                 // opcode 0x46554E44 + seatIndex
    }
  ]
}
```

---

## 5. Exact transaction structure

The builder returns:
```js
{
  validUntil: Math.floor(nowMs / 1000) + validUntilSeconds,
  messages: [{
    address: depositAddress.trim(),
    amount: expectedAmountNanotonsToString(myExpectedAmountNanotons),
    payload: buildFundSeatPayload(mySeatIndex)
  }]
}
```

- **destination** is the authoritative `depositAddress` — never derived or reconstructed
- **amount** is the authoritative `myExpectedAmountNanotons` as an exact decimal string — no fees/stake/sector costs added
- **payload** contains the FundSeat opcode (0x46554E44) and the authoritative `mySeatIndex`

---

## 6. Protocol parity verification

A parity probe (`server/_probe_r18s5_parity.mjs`, throwaway) verified byte-identical BOC output between:
- Client: `buildFundSeatPayload(seat)`
- Server: `encodeFundSeatBody(seat).toBoc().toString("base64")`

**Seats tested:** 0, 1, 2
**Result:** All three produced identical base64 strings. Probe removed after verification.

---

## 7. Validation and fail-closed behavior

Implemented validations:
1. `depositAddress` — must be a non-empty string and pass `isValidTelegramWallet()` check
2. `mySeatIndex` — must be an integer in range 0..2
3. `myExpectedAmountNanotons` — must be a positive integer (number, string, or bigint form)
4. `network` — when supplied, must be `"testnet"` or `"mainnet"`
5. `validUntilSeconds` — must be a positive finite number
6. Malformed input (boolean, NaN, null, undefined, empty string) — rejected with descriptive error

No silent defaults. No local financial calculations. No fallback values.

---

## 8. Tests

**File:** `client/src/payment/buildFundDepositTransaction.test.js`

**Execution command:**
```
cd client; node --import "file:///G:/WheelWin/client/scripts/register.js" src/payment/buildFundDepositTransaction.test.js
```

**Assertions (all passed):**
1. valid transaction (address/amount/opcode/seat) ✓
2. amount authority (exact, no local calculation) ✓
3. seat authority (0/1/2) ✓
4. missing/invalid depositAddress fail-closed ✓
5. missing/invalid seat fail-closed ✓
6. missing/invalid amount fail-closed ✓
7. malformed input + supported network validation ✓
8. no side effects (no wallet/network/socket calls) ✓

**Regression tests run:**
- `buildTonConnectPaymentTransaction.test.js` — all passed
- `authoritativeSessionModel.test.js` — all passed (including S4 deposit tests)

---

## 9. Side-effect boundary

R18-S5 does **NOT**:
- call TonConnect
- call `sendTransaction()`
- open Telegram Wallet
- perform blockchain RPC
- send a blockchain transaction
- modify server financial state
- modify AuthoritativeSession state
- emit socket events
- mark a player FUNDED
- trigger Page5

The builder is a pure function: input → TonConnect transaction request object.

---

## 10. Page4 boundary

`client/src/pages/Page4Payment.jsx` was **NOT modified** by R18-S5.

- "CONFIRM IN TELEGRAM WALLET" remains unchanged
- "NEXT" button remains unchanged
- Existing payment flow remains unchanged
- Page4 integration is a later task

---

## 11. Server boundary

R18-S5 did **NOT** modify any server modules. The following remain unchanged:
- `server/deposit/DepositMonitor`
- `server/deposit/DepositOnChainVerificationCoordinator`
- `server/deposit/DepositSessionCoordinator`
- `server/deposit/DepositOrchestrator`
- `server/payment/*`
- `server/socket/RoomLobbyBridge.js`

---

## 12. Files changed

Commit `30ee96e`:
- `client/src/payment/buildFundDepositTransaction.js` (203 lines added)
- `client/src/payment/buildFundDepositTransaction.test.js` (400 lines added)

Total: 2 files changed, 603 insertions, 0 deletions.

---

## 13. Git state

```
30ee96e (HEAD -> main, origin/main, origin/HEAD) R18-S5 production Deposit FundSeat transaction builder
f6964cc R18-S4 client authoritative deposit transport + reconnect restoration
a644b9a Bridge Deposit package events to clients
```

Branch `main` is in sync with `origin/main`. No unpushed commits.

---

## 14. Remaining Deposit gaps

- Page4 Deposit UI integration — **not implemented** (later task)
- CONFIRM IN TELEGRAM WALLET button wiring — **not implemented** (later task)
- Deposit funding status display — **not implemented** (later task)
- Post-funding Page5 transition — **not implemented** (later task)

The transaction builder is ready for integration but is not yet connected to any UI.
