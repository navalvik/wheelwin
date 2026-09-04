# Reimbursement Wallet → Residues Wallet Role Migration Implementation

Date: 2026-09-05

Task: Implement the approved role migration of the existing Reimbursement Wallet into the Residues Wallet without changing blockchain identity, mnemonic, address, or balance. Permanently neutralize old reimbursement spending. Wire Residues destination + self-transfer protection. Software only.


## 1. Scope

Implemented the application-level role change:

EXISTING REIMBURSEMENT WALLET = FUTURE RESIDUES WALLET

Same mnemonic, same WalletContractV4 / workchain 0 derivation, same public address, same on-chain balance.

Did not create a wallet, generate a mnemonic, deploy a contract, transfer TON, edit Railway, edit `.env`, edit `ROOM_WALLETS_JSON`, or enable residual sweep / payment intake.


## 2. Files Inspected

Primary audit: `AI_CONTEXT/CLINE_REPORTS/2026-09-05_r18_s37_reimbursement_wallet_residues_reuse_audit.md`

Sweep implementation: `7c1bd3e`

Touched implementation and tests listed in Changes Made.


## 3. Architecture Findings / Implementation Summary

One physical V4 identity. Canonical Residues env is preferred. Temporary compatibility reads the old reimbursement env only when Residues keys are unset, and only if both pins/mnemonics resolve to the **same** address.

Reimbursement send is permanently retired in worker, transfer service, and adapter. Historical `deployment_reimbursement` records remain readable and are never paid.

Residual Sweep destination uses the Residues pin (with reimbursement-address fallback). Sweep source remains a Room Wallet. Source must not equal destination. Sweep remains OFF by default.


## 4. Lifecycle Flow

**Reimbursement (retired):**

```
SETTLEMENT_COMPLETED / snapshot freeze
  → DeploymentReimbursementService may still enqueue if master flag is on
  → DeploymentReimbursementWorker.initialize() never starts a timer
  → processQueue() always skipped = send_permanently_retired
  → ReimbursementTransferService.sendReimbursement → SEND_RETIRED
  → ReimbursementWalletAdapter.sendTransfer → SEND_RETIRED (no broadcast)
```

Flags `DEPLOYMENT_REIMBURSEMENT_ENABLED` and `REIMBURSEMENT_ENABLED` cannot authorize a send. Restart cannot revive spend. Pending / FAILED_RETRY records are not claimed.

**Residues destination / future sweep (still OFF):**

```
TON_RESIDUES_EXPECTED_ADDRESS (preferred)
  else TON_REIMBURSEMENT_EXPECTED_ADDRESS
  → resolveResiduesWalletDestination
  → verifyResiduesWalletIdentity if mnemonic present
  → assertSweepSourceDiffersFromDestination
  → RoomWalletAdapter.sendTransfer from Room Wallet only
```


## 5. Ownership Boundaries

| Identity | Role after this change |
|----------|------------------------|
| Former Reimbursement Wallet | Residues Wallet (receive pin; no application send) |
| Room Wallets | Only sweep / settlement sources |
| Deployer Wallet | Unchanged; no longer reimbursed from this wallet |
| Confirmation scanner | Observe-only; no sign / broadcast |


## 6. Risks

**High (ops, not this commit):** Production still needs `TON_RESIDUES_EXPECTED_ADDRESS` set to the existing public pin. Until then, sweep cannot send (correct). Dual pins that disagree fail closed (`RESIDUES_ADDRESS_CONFLICT`).

**Medium:** Compatibility fallback from `TON_REIMBURSEMENT_*` is temporary. Leaving both env names indefinitely is allowed only while they match.

**Low:** `financialPersistence.wiring.r810.test.js` failed with a pre-existing deploy-vs-payment-session race (`status=DEPLOYING`). Not on the reimbursement send path. All targeted reimbursement / Residues / Room Wallet / sweep tests passed.

**Critical residual spend:** None in the current tree. Adapter no longer contains `broadcastTransaction` / `createTransfer`. Worker no longer contains `setInterval` or `sendReimbursement`.


## 7. Recommendations

Production configuration migration (not performed):

1. Set `TON_RESIDUES_EXPECTED_ADDRESS` to the current Reimbursement public address (canonical bounceable form).
2. Optionally set `TON_RESIDUES_MNEMONIC` to the **same** existing secret value (copy, do not generate). Prefer Residues names; keep old names only while they match.
3. Keep `DEPLOYMENT_REIMBURSEMENT_ENABLED` and `REIMBURSEMENT_ENABLED` unset/false (they cannot send anyway).
4. Keep `ROOM_WALLET_RESIDUAL_SWEEP_ENABLED` unset.
5. Keep `ROOM_WALLET_PAYMENT_INTAKE_MODE` unchanged.
6. Confirm Wallet Monitoring still shows the same address and ~1.926595854 TON.
7. Enable sweep only in a later authorized task.

Do not create a new wallet. Do not move the balance.


## 8. Changes Made

### Wallet identity preservation

- `deriveResiduesWalletIdentity` uses `mnemonicToPrivateKey` + `WalletContractV4.create({ workchain: 0, publicKey })` + bounceable url-safe address — the same algorithm previously used for reimbursement.
- `deriveReimbursementWalletIdentity` now delegates to that function so both names cannot drift.
- No new mnemonic. No new contract type. Workchain remains 0.

### Configuration migration design

Canonical:

- `TON_RESIDUES_MNEMONIC` (secret)
- `TON_RESIDUES_EXPECTED_ADDRESS` (public pin)

Staged compatibility (explicit, prefer Residues):

- `TON_REIMBURSEMENT_MNEMONIC`
- `TON_REIMBURSEMENT_EXPECTED_ADDRESS`

Rules:

- Prefer Residues keys when present.
- Dual expected addresses must canonicalize equal or `RESIDUES_ADDRESS_CONFLICT`.
- Dual mnemonics must derive equal or `RESIDUES_MNEMONIC_CONFLICT` / `MNEMONIC_INVALID`.
- Derived address must match expected pin or `ADDRESS_MISMATCH` (fail closed; no send).
- Secrets never logged. `TON_RESIDUES_MNEMONIC` added to `SECRET_ENV_KEYS`.

This commit does **not** rename Railway or `.env` variables.

### Old reimbursement spending neutralized

| Component | Behavior |
|-----------|----------|
| `isReimbursementSendAllowed` | Always `false` |
| `isReimbursementSendPermanentlyRetired` | Always `true` |
| `DeploymentReimbursementWorker.initialize` | No timer |
| `processQueue` | `skipped: send_permanently_retired`; no claim; no send |
| `ReimbursementTransferService.sendReimbursement` | `SEND_RETIRED` |
| `ReimbursementWalletAdapter.sendTransfer` | `SEND_RETIRED`; broadcast implementation removed |
| Adapter `initialize` | May resolve address; does **not** retain secret keys |

### Worker / startup / recovery

`app.js` still constructs the historical reimbursement service, confirmation scanner, and worker so records remain loadable. Worker startup log: send permanently retired. Confirmation recovery remains observe-only (no sign). Restart cannot start a send loop.

### Persistence

No reimbursement records deleted or rewritten. Pending / FAILED_RETRY rows stay as-is and cannot trigger a transfer.

### Residues Wallet integration

`resolveResiduesWalletDestination` accepts the former Reimbursement public address as Residues destination without changing 0.49 Gram sweep semantics. Sweep still spends **from Room Wallets**.

### Self-transfer protection

`assertSweepSourceDiffersFromDestination` is enforced in `RoomWalletResidualSweepWorker` before create and before submit. Code: `SOURCE_EQUALS_DESTINATION`. No broadcast.

### Financial model

Unchanged:

- trigger 0.50 Gram
- transfer 0.49 Gram
- retained floor 0.01 Gram
- gas 0.006 Gram
- safety 0.004 Gram
- 0.006 + 0.004 = 0.01
- recipient amount not reduced by gas

### Tests added/updated

Added `server/tests/residuesWalletReuse.test.js`.

Updated reimbursement stages M/O/Q/S to assert send retirement instead of live send. Updated residual sweep destination fallback. Updated secret hardening. Updated Wallet Monitoring label to Residues Wallet.

### Tests executed

Passed: residues reuse; residual sweep; Room Wallet composition / policy / service / registry / incoming / settlement adapter / router / secret hardening / settlement plan; reimbursement stages M/N/O/P/Q/S; `tonFinancialPersistence`; `tonFinancialRecovery`; `contractSettlement.manager`; `walletBalanceMonitor`; `provisionRoomWallets`.

Unrelated fail: `financialPersistence.wiring.r810.test.js` — payment session created while stub deploy still `DEPLOYING`. Not on the reimbursement send path.

### Static verification

1. One intended physical wallet identity: **YES**
2. Address derivation unchanged: **YES** (V4R2, workchain 0)
3. No new wallet generated: **YES**
4. No old reimbursement send path can spend: **YES**
5. No startup/recovery send: **YES**
6. Sweep destination can be the former Reimbursement address: **YES**
7. Room Wallets remain the only sweep sources: **YES**
8. Source and destination cannot be identical: **YES**
9. Sweep OFF by default: **YES**
10. Payment intake unchanged: **YES**
11. No production secrets exposed: **YES**
12. No blockchain transaction sent: **YES**

### Git commit hash

`553e3468a465f19a3146f32ea924658a3733ca42`

Message: `refactor: repurpose reimbursement wallet as residues wallet`

### Production-safety verification

NO blockchain transaction occurred.
NO existing wallet address or blockchain identity was changed.
NO existing wallet balance was moved.
NO Railway variables were modified.
NO `.env` values were modified.
NO wallet was created, funded, or deployed.
NO payment intake activation.
NO Residual Sweep activation.

### Remaining Production configuration steps

See Recommendations. Software is ready; ops must copy the existing public address into `TON_RESIDUES_EXPECTED_ADDRESS` (and optionally the same mnemonic into `TON_RESIDUES_MNEMONIC`) without changing the value.


## Files Changed

- `server/payment/roomWallet/ResiduesWalletConfig.js` (added)
- `server/payment/roomWallet/roomWalletConfig.js`
- `server/payment/roomWallet/RoomWalletResidualSweepWorker.js`
- `server/payment/roomWallet/ROOM_WALLET_RUNTIME.md`
- `server/payment/reimbursement/ReimbursementWalletConfig.js`
- `server/payment/reimbursement/DeploymentReimbursementWorker.js`
- `server/payment/reimbursement/ReimbursementTransferService.js`
- `server/payment/reimbursement/ReimbursementWalletAdapter.js`
- `server/config/secrets.js`
- `server/config/schemas/environmentSchema.js`
- `server/config/validators/validateEnvironment.js`
- `server/console/wallet/WalletBalanceMonitor.js`
- `server/console/configuration/buildRuntimeConfigurationSnapshot.js`
- `server/app.js`
- `client/src/console/panels/WalletMonitoringPanel.jsx`
- `server/tests/residuesWalletReuse.test.js` (added)
- `server/tests/deploymentReimbursement.stageM.test.js`
- `server/tests/deploymentReimbursement.stageO.test.js`
- `server/tests/deploymentReimbursement.stageQ.test.js`
- `server/tests/deploymentReimbursement.stageS.test.js`
- `server/tests/roomWalletResidualSweep.test.js`
- `server/tests/roomWalletSecretHardening.test.js`

NO source secrets were added. NO tests contain Production mnemonics (BIP39 abandon/about fixture only).
