# R18-S6 — Production DepositContract Deployment Transaction Builder

## 1. Status

**R18_S6_VERIFIED**

**Commit:** `46b3970`

**Message:** `R18-S6 production DepositContract deployment transaction builder`

**Branch state:** committed to `main`, pushed to `origin/main`.

---

## 2. Objective

R18-S6 implemented a production client-side transaction builder for the
DepositContract deployment operation. The builder constructs a TonConnect-ready
`sendTransaction` request from the authoritative Deposit package received from
the server.

The task was intentionally limited to transaction construction only. It does
NOT integrate Page4, send blockchain transactions, or modify server financial
state.

---

## 3. Repository Audit — Existing Implementation Discovered

The audit found:

- **No existing production client deployment builder** for DepositContract.
- **Existing testnet reference**: `server/tests/testnet/r179l25/l25PlayerDepositDeploy.js`
  — a verified E2E reference that deploys a DepositContract using raw wallet
  transfer + external message encoding. This reference uses:
  - `contractAddress(0, { code, data })` to derive the deterministic address.
  - `internal({ to: reconstructed.address, value: toNano(...), init: { code, data }, bounce: false })`
    as the deployment message.
  - The player's wallet as the sender.
- **Server-side StateInit generation**: `server/deposit/projectDepositForPlayer.js`
  exposes `package.stateInit.{codeBoc, dataBoc}` and `deployValueNanotons` in the
  authoritative Deposit projection.

The testnet reference constructs the raw external message for broadcast via RPC.
For production TonConnect, the builder adapts this pattern: instead of encoding
the full wallet transfer + external message, it provides the deployment message
parameters (destination, amount, stateInit) in the TonConnect schema, letting
the TonConnect SDK / wallet handle the wallet-side encoding.

---

## 4. Production Helper Created

**File:** `client/src/payment/buildDepositDeploymentTransaction.js`

### Responsibility

Convert an authoritative Deposit package into a TonConnect-ready deployment
transaction request.

### Authoritative Inputs

- `depositPackage` — the authoritative package from the server, containing:
  - `stateInit.codeBoc` (base64 BOC)
  - `stateInit.dataBoc` (base64 BOC)
  - `deployValueNanotons` (string/number/bigint)
- `depositAddress` — the authoritative DepositContract address.
- `isCreator` — must be `true`; only the creator may deploy.
- `network` — optional authoritative network tag.

### Transaction Structure

```js
{
  validUntil: <unix_seconds>,
  messages: [
    {
      address: "<StateInit-derived DepositContract address>",
      amount: "<deployValueNanotons as string>",
      stateInit: {
        code: "<codeBoc base64>",
        data: "<dataBoc base64>"
      }
    }
  ]
}
```

### Key Design Decisions

---

## 5. Validation and Fail-Closed Behavior

Implemented validations:

1. **Creator authorization** — `isCreator` must be exactly `true`.
2. **Package existence** — `depositPackage` must be a non-null object.
3. **StateInit completeness** — both `codeBoc` and `dataBoc` must be present.
4. **StateInit validity** — BOCs must decode into valid `Cell` objects.
5. **Deposit address existence** — `depositAddress` must be present in the package.
6. **Address parity** — StateInit-derived address must match `depositAddress`.
7. **Deployment amount** — `deployValueNanotons` must be a positive integer.
8. **Network validation** — if supplied, must be `"testnet"` or `"mainnet"`.
9. **TTL validation** — `validUntilSeconds` must be a positive finite number.

No defaults are substituted. No local values are fabricated.

---

## 6. Tests

**File:** `client/src/payment/buildDepositDeploymentTransaction.test.js`

**Results:** all assertions passed.

### Test Coverage

| Test | Description | Result |
|------|-------------|--------|
| A | Valid authoritative deployment package | ✅ |
| B | Deterministic address verification | ✅ |
| C | Address mismatch fails closed | ✅ |
| D | Creator authorization (rejects non-creator) | ✅ |
| E | Missing StateInit fails closed | ✅ |
| F | Malformed StateInit fails closed | ✅ |
| G | Missing depositAddress fails closed | ✅ |
| H | Invalid deployment amount fails closed | ✅ |
| I | Unsupported network fails closed | ✅ |
| J | No side effects (synchronous, no mutation) | ✅ |
| K | Malformed input fails closed | ✅ |
| L | Exact amount authority | ✅ |

### Regression Tests

- `buildFundDepositTransaction.test.js` (R18-S5) — all pass.
- `authoritativeSessionModel.test.js` — all pass.

---

## 7. Side-Effect Boundary

R18-S6 does **NOT**: call TonConnect, `sendTransaction()`, open Telegram Wallet,
perform blockchain RPC, send transactions, modify server/client state, emit events,
mark contracts ACTIVE, mark players FUNDED, trigger Page5, or deploy GameContract.

---

## 8. Page4 Boundary

`client/src/pages/Page4Payment.jsx` was **NOT modified**.

---

## 9. Server Boundary

No server files were modified.

---

## 10. Files Changed

Commit `46b3970`:
- `client/src/payment/buildDepositDeploymentTransaction.js` (new)
- `client/src/payment/buildDepositDeploymentTransaction.test.js` (new)

---

## 11. Git State

```
46b3970 (HEAD -> main, origin/main) R18-S6 production DepositContract deployment transaction builder
d9747d2 docs: add R18-S5 implementation report
30ee96e R18-S5 production Deposit FundSeat transaction builder
```

R18-S5 (`30ee96e`) remains untouched. No history rewritten.

---

## 12. R18-S5 Protection

`client/src/payment/buildFundDepositTransaction.js` was **NOT modified**.

---

## 13. Remaining Gaps

Not implemented (deferred to later tasks):
- Page4 integration
- Actual TonConnect submission
- DepositContract deployment status monitoring
- Post-deployment authorization flow (GAP-B)
- GameContract deployment trigger

1. **StateInit reconstruction**: The builder decodes `codeBoc`/`dataBoc` into
   `Cell` objects and uses `contractAddress(0, {code, data})` to derive the
   address. This mirrors the server-side deterministic address computation.

2. **Address parity verification**: The builder verifies that the derived
   address exactly matches the authoritative `depositAddress`. A mismatch
   fails closed — this is a critical safety check ensuring the client deploys
   the exact contract approved by the server.

3. **Deployment amount authority**: The builder uses `depositPackage.deployValueNanotons`
   exactly — no local calculation, no fee addition, no normalization that changes
   the value.

4. **Creator authorization**: The builder enforces `isCreator === true`.
   Non-creators cannot construct a deployment transaction.

5. **No query_id**: Unlike the FundSeat operation (R18-S5), the deployment
   message does not carry a query_id — it is a simple contract deployment
   with StateInit.