# Canonical TON wallet identity and Residues role labels (r18-s88)

Date: 2026-09-07

Task: Implement the s87 audit remediations: fail-closed TON account-identity comparison (workchain + hash) instead of raw friendly-string equality on the PaymentSessionManager / registry / parseDepositCandidate paths; align operator-facing wallet role names to Residues / Deployment / Owner. No wallet identity replacement, no chain writes, no deploy.


## 1. Scope

Corrected identity comparison and operator display only. Did not change ROOM_WALLETS_JSON identities, keys, mnemonics, room mapping, payout policy, Residual Sweep policy, network fail-closed checks, or settlement destinations. Did not restore Game Escrow / Deposit / FundSeat player payment. Did not push or deploy.


## 2. Files Inspected

Authoritative findings: `AI_CONTEXT/CLINE_REPORTS/2026-09-07_r18_s87_room_wallet_address_identity_security_audit.md`.

Implementation / callers:

- `server/models/TonWalletAddress.js`
- `server/diagnostics/TonWalletIdentityDebug.js`
- `server/gameplay/PaymentSessionManager.js`
- `server/payment/BlockchainMonitor.js` (`parseDepositCandidate`)
- `server/payment/roomWallet/RoomWalletRegistry.js`
- `server/console/wallet/WalletBalanceMonitor.js`
- `client/src/console/panels/WalletMonitoringPanel.jsx`
- `server/tests/tonWalletIdentityCanonical.r18s88.test.js`
- `server/tests/walletBalanceMonitor.r179h.test.js`

Left unchanged (compatibility env / retired send path): `TON_REIMBURSEMENT_*` env aliases, reimbursement transfer modules.


## 3. Architecture Findings

Identity remains WalletContractV4 workchain-0 account hash. Canonical **representation** is bounceable URL-safe friendly (`EQ…`) after `@ton/core` parse. Application network is `TON_NETWORK` / RPC, not the friendly `testOnly` bit.

`tonWalletAccountsEqual` / `canonicalizeTonWalletAddress` now unwrap `{ address: string }` then parse. Invalid objects are not `String(object)`.

Operator snapshot `walletType` values: `OWNER_WALLET`, `DEPLOYMENT_WALLET`, `RESIDUES_WALLET`. Historical constant aliases map to those same strings. Residues remains the same physical account previously labeled reimbursement.


## 4. Lifecycle Flow

Incoming payment confirmation: observer still canonicalizes dest/sender; `PaymentSessionManager._validateIncomingPayment` now uses `tonWalletAccountsEqual` so `EQ`/`0Q`/`UQ`/`kQ` of the same account do not false-reject. Amount, deadline, participant, duplicate, and network checks are unchanged.

`parseDepositCandidate` still fail-closes missing dest/sender when unwrap/parse fails.

`getByAddress` matches by account identity for any future caller.

Console monitoring displays canonical friendly address, application network, and `Address.toRawString()` account id. RPC `getBalance` uses the canonical friendly when parse succeeds.


## 5. Ownership Boundaries

- Account identity helpers: `server/models/TonWalletAddress.js`.
- Financial dest authority unchanged: `roomNumber` → `ROOM_WALLETS_JSON`; settlement snapshot / owner config / Residues pin.
- Operator labels: WalletBalanceMonitor + WalletMonitoringPanel. Not financially authoritative.
- Env aliases `TON_REIMBURSEMENT_*` still resolve the Residues pin; not renamed.


## 6. Risks

- **Low — split deploy:** Old Vercel UI looked up `DEPLOY_WALLET` / `REIMBURSEMENT_WALLET`. New client maps those aliases to current labels. New backend emits `DEPLOYMENT_WALLET` / `RESIDUES_WALLET`. Old client without this commit would show placeholder UNAVAILABLE cards until frontend ships. Mitigated in source by alias lookup.
- **Low — registry register():** still stores trim-string; uniqueness is string, not identity. Production load path already canonicalizes. Not changed.
- **Informational:** Wallet Monitoring still does not list `ROOM WALLET #N` (never did). Residues / Owner / Deployment only.
- **Informational:** Production Vercel/Railway were not updated in this task. UI claim is source-correct, not production-verified.


## 7. Recommendations

Deploy Railway (identity compare) and Vercel (labels + alias lookup) together. Do not treat remaining reimbursement env names as a second wallet. Optionally canonicalize `RoomWalletRegistry.register` uniqueness later.


## 8. Changes Made

### Identity comparison

- `extractTonWalletAddressInput` — string or `{ address: string }` only.
- `canonicalizeTonWalletAddress` — unwrap then parse; non-strings without `.address` string → `null`.
- `tonWalletAccountsEqual` — both sides must canonicalize; then string-equal canonical `EQ…` (same account).
- `describeTonWalletIdentity` — canonical friendly + explicit network + raw `workchain:hash` via `toRawString()`.
- `tonAddressesEqual` — now fail-closed via `canonicalizeTonWalletAddress` (no parse-fail string fallback).
- `PaymentSessionManager._validateIncomingPayment` — dest and sender use `tonWalletAccountsEqual`; invalid addresses fail closed; amount/session checks unchanged.
- `parseDepositCandidate` — benefits from unwrap inside canonicalize; comment documents object shape.
- `RoomWalletRegistry.getByAddress` — identity compare; invalid query → `null`.

### Wallet-role naming (operator-facing)

| Before | After |
| --- | --- |
| `REIMBURSEMENT_WALLET` snapshot type | `RESIDUES_WALLET` |
| `DEPLOY_WALLET` snapshot type | `DEPLOYMENT_WALLET` |
| Console subtitle “Reimbursement wallets” | Owner, Deployment, and Residues wallets |
| Label “Deploy Wallet” | `DEPLOYMENT WALLET` |
| Label already “Residues Wallet” | `RESIDUES WALLET` |

`WALLET_BALANCE_TYPES.REIMBURSEMENT_WALLET` / `DEPLOY_WALLET` remain aliases equal to the new type strings so old constant names do not emit the obsolete role string.

Env keys `TON_REIMBURSEMENT_EXPECTED_ADDRESS` / mnemonic aliases were **not** renamed.

### Tests executed and results

All passed (exit 0):

- `server/tests/tonWalletIdentityCanonical.r18s88.test.js` (7)
- `server/tests/walletBalanceMonitor.r179h.test.js` (2)
- `server/tests/tonWalletIdentityDebug.test.js`
- `server/tests/blockchainMonitor.test.js`
- `server/tests/paymentSession.manager.test.js`
- Room Wallet suite: runtime resolver, incoming observer, settlement adapter, roomNumber mapping, residues reuse, residual sweep, only-player-payment, game readiness, service, financial policy, settlement plan/router, app composition, secret hardening, r18s75 settlement, r18s85 signing buffer, r18s83 retryable

No secret material in snapshots/payloads (asserted). No TON sent.

### Confirmations

- No wallet identities, keys, mnemonics, room numbers, or payout policy changed.
- No blockchain writes, operator-recovery, or production settlement tests.
- No push, no Railway/Vercel deploy.
- No Game Escrow / Deposit / FundSeat payment path restored.

### Remaining issues that could prevent production deployment

1. Frontend and backend should ship together so Wallet Monitoring types and labels match production. Source includes alias mapping; **production Vercel was not rebuilt in this task**.
2. s86 historical FAILED re-entry commit may still be undeployed; unrelated to this identity fix.
3. Console does not display per-room `ROOM WALLET #N` balances (out of this panel’s previous scope).

Commit hash: filled after git commit.


## Required statements

**Payout destination substitution:** unchanged from s87 — still not possible via client/address format. This change does not alter settlement dest construction.

**Room redirect to another Room Wallet:** unchanged — still `roomNumber` → `ROOM_WALLETS_JSON`. `getByAddress` is identity-safe but still unused on the live path.

**False identity mismatch from EQ/0Q/UQ/kQ:** the `_validateIncomingPayment` and `getByAddress` holes from s87 are closed on these paths.

**Misdirected funds from address format:** still no; comparison fail-closed does not retarget sends.
