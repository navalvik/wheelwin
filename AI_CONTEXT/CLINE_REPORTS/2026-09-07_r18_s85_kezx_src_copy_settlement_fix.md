# kezX `src.copy is not a function` Room Wallet settlement fix

Date: 2026-09-07

Task: Find and minimally fix the Production kezX settlement failure (`game_1dc0e170-0e3a-457d-a3a2-589c96977918`, winner Bob) where the adapter threw `src.copy is not a function`, the session stayed `READY`, and no winner/owner payout executed. Do not redesign settlement, do not pay from this workstation, do not touch UhqU, do not call operator-recovery.


## 1. Scope

Inspected the forensic archive, traced the throw to Room Wallet signing (`WalletContractV4` + `@ton/core` Buffer.copy), traced why CSM persisted `READY` without completing, applied the smallest signing/resume fix, ran focused tests, and deployed via git push to `payment/room-wallet-integration`.

Did **not**: send TON from this environment; call `/console/settlements/operator-recovery`; mutate kezX or UhqU financial records; recreate games.


## 2. Files Inspected

Forensic archive (extracted locally, not committed):

- `C:\Users\DAAT\Downloads\forensic-archives_2026-09-07_ROOM_kezX_GAME_game_1dc0e170-0e3a-457d-a3a2-589c96977918_COMPLETED.zip`
- `ton-financial/active/settlement/game_1dc0e170-0e3a-457d-a3a2-589c96977918.json`
- `ton-financial/active/game_contract/contract_0fdbb2d2-4548-40fa-ba38-d3016014bdf9.json`
- `ton-financial/active/payment_session/pay_51f436c8-d6fd-484b-ace8-7ab93e1b8c28.json`
- `ton-financial/active/recovery_data/game_1dc0e170-0e3a-457d-a3a2-589c96977918.json`
- `diagnostic-logs/2026-09-07_10-52-42_ROOM_kezX_GAME_COMPLETED.log`

Source:

- `server/payment/roomWallet/RoomWalletAdapter.js`
- `server/payment/roomWallet/RoomWalletRuntimeResolver.js`
- `server/payment/roomWallet/RoomWalletSettlementAdapter.js`
- `server/payment/roomWallet/roomWalletTerminalRecoveryChain.js`
- `server/payment/ContractSettlementManager.js`
- `server/payment/SettlementSessionStates.js`
- `server/models/TonWalletAddress.js`

Read-only chain: TonAPI testnet account + transactions for Room Wallet #1 `EQDGQjwaP0OSExa9MfZih61De5TQuUITQPYiYZyfqAFzpvQB`.


## 3. Architecture Findings

### Forensic facts (kezX)

| Field | Value |
| --- | --- |
| Game | `game_1dc0e170-0e3a-457d-a3a2-589c96977918` |
| Room | `kezX`, `roomNumber` **1** |
| Winner | Bob `EQAtggW7l5wfQcPyy38Y7mVuXnh0wRHcpFKPIdtCbcRHb8wM` |
| Owner | `EQBaklBYMdMsuq7a2eTYhMkz1OF7ZSHaO1mnFd1MZd3YjMgi` |
| Authoritative amounts | winner **2.85**, owner gross **0.15** (payout **0.14** after 0.01 retain) |
| Settlement status | **`READY`** |
| Reason | `adapter_threw:src.copy is not a function` |
| Session | `settle_48ca25db-8797-43b4-adb7-57c555637738` |
| createdAt / updatedAt | `1788778560781` / `1788778576336` |
| `settlementTransactionHash` | `null` |
| Game contract | `SETTLEMENT_PREPARING`, `contractAddress: null` |
| Room Wallet | `EQDGQjwaP0OSExa9MfZih61De5TQuUITQPYiYZyfqAFzpvQB` (same #1 wallet as UhqU) |
| `SETTLEMENT_CONFIRMED` | **did not occur** |
| Residual Sweep | **did not occur** (gated on confirmation) |
| Cleanup | gameplay `SESSION_FINISHED`; settlement record left non-terminal `READY` |

Room diagnostic log has no settlement stack (client/gameplay only). Financial record is the authoritative error.

Pre-fix TonAPI (read-only): Room Wallet balance **6489398741** nano (~6.489 TON), `last_activity` **1788778502** (player inbound, before settlement start). Latest tx is inbound 1.0 TON from Bob’s wallet. **No outbound winner 2.85 or owner 0.14.** No duplicate settlement outs.

### Exact `src.copy` source

Not inspect/history parsing. `inspectSettlement` swallows inspect throws as `CHAIN_INSPECT_UNKNOWN`.

Call path:

1. `WINNER_DETERMINED` → CSM `_advanceSettlementAfterHandoff` → `PREPARING` → `READY`
2. `_submitSettlementAdapter` → `RoomWalletSettlementAdapter.settleContract`
3. `inspectSettlement` (read-only) then `RoomWalletAdapter.sendTransfer`
4. `WalletContractV4.create({ publicKey })` + `createTransfer({ secretKey })`
5. `@ton/core` serialization calls `Buffer.prototype.copy` (`src.copy`)
6. Production `decodeKey()` returned **`Uint8Array.from(bytes)`**, not `Buffer`
7. `Uint8Array` has no `.copy` → `TypeError: src.copy is not a function`
8. Throw escapes the adapter; CSM maps it to `adapter_threw:src.copy is not a function`

Exact functions: `RoomWalletRuntimeResolver.decodeKey` (key type) and `RoomWalletAdapter.sendTransfer` (signing).

### Why status stayed `READY`

s83 `_deferRoomWalletRetry` is working as designed for operational throws:

- not a safety code (`WALLET_REUSED` / `DUPLICATE_PAYOUT` / amount disagreement)
- no winner `txHash` (throw was **before broadcast**)
- session stays **`READY`**, reason updated, persist, `_scheduleRoomWalletRetry` (2s)
- retry → `_resumeRestoredSettlement` → inspect → `NOT_SETTLED` → `settleContract` → **same throw**

So READY is the retryable parked state, not a new terminal. The loop never completed because **every send threw before chain write**. After `SESSION_FINISHED`, in-progress `READY` is preserved; resume still needed a live GameContract **or** the persisted `request.snapshot`. Missing live contract previously returned `context incomplete` and **did not reschedule**.

UhqU remains `SETTLEMENT_FAILED` and is still skipped by restore.


## 4. Lifecycle Flow

`SETTLEMENT_PREPARING` → `READY` → adapter `sendTransfer` → **throw** → `_deferRoomWalletRetry` → persist `READY` + `adapter_threw:src.copy is not a function` → timer resume → same throw.

After fix: same path, keys coerced to `Buffer`, inspect-before-send still runs, missing legs only, `SETTLEMENT_CONFIRMED` still required for Residual Sweep.


## 5. Ownership Boundaries

- CSM owns session state and retry.
- `RoomWalletSettlementAdapter` owns inspect/idempotency/send-missing-legs.
- `RoomWalletAdapter` owns signing/broadcast.
- Runtime resolver owns decoding `ROOM_WALLETS_JSON`.
- Residual Sweep still only listens for `SETTLEMENT_CONFIRMED`.
- s82 operator-recovery unused.


## 6. Risks

- **Critical (fixed):** Uint8Array keys made every Room Wallet payout throw before broadcast.
- **High:** Deploying this fix to a process that restores kezX `READY` will let **ordinary** settlement send real TON. That is the intended product path, not operator-recovery. This task did not broadcast from the workstation.
- **Medium:** kezX and UhqU share Room Wallet #1. Inspect cutoff is settlement `timestamp`; older UhqU/kezX inbounds must not count as reuse. If cutoff were lost, `WALLET_REUSED` would fail closed.
- **Low:** Synthetic contract from `request.snapshot` is Room-Wallet-only.


## 7. Recommendations

Ordinary Room Wallet settlement can recover from this exact `src.copy` throw. Historical kezX payout, if still unpaid after deploy, is a separate authorized run of the **ordinary** resume path (or wait for the deployed process restore). Do not use operator-recovery for this `READY` record. Do not auto-pay UhqU (`SETTLEMENT_FAILED`).


## 8. Changes Made

- `server/payment/roomWallet/RoomWalletAdapter.js` — coerce `publicKey`/`secretKey` to `Buffer` before `WalletContractV4.create` / `createTransfer`.
- `server/payment/roomWallet/RoomWalletRuntimeResolver.js` — `decodeKey` returns `Buffer`, not `Uint8Array`.
- `server/payment/ContractSettlementManager.js` — Room Wallet resume may rebuild contract from persisted `session.request.snapshot`; incomplete context still reschedules Room Wallet retry.
- `server/tests/roomWalletAdapter.signingBuffer.r18s85.test.js` — Uint8Array keys sign without `src.copy`.
- `server/tests/roomWalletSettlement.r18s83.retryable.test.js` — `src.copy` throw stays `READY` then confirms; resume without live GameContract; existing idempotency tests unchanged.

### Focused tests (all pass)

```
node tests/roomWalletAdapter.signingBuffer.r18s85.test.js
  2 pass
node tests/roomWalletSettlement.r18s83.retryable.test.js
  10 pass (includes src.copy READY retry + snapshot resume + adopt/duplicate/reuse)
node tests/roomWalletSettlementAdapter.test.js
  14 pass
node tests/roomWalletRuntimeResolver.test.js
  4 pass
node tests/roomWalletSettlement.r18s80.uhquHandoff.test.js
  2 pass
node tests/roomWalletSettlement.r18s75.test.js
  7 pass
node tests/roomWalletSecretHardening.test.js
  14 pass
node tests/roomWalletTerminalSettlementRecovery.r18s82.test.js
  17 pass
```

### Production financial statement (pre-deploy, read-only)

- kezX **unpaid** on-chain (no winner/owner settlement outbound).
- UhqU **untouched** (same Room Wallet #1; no new outbound from this task).
- No operator-recovery call.
- No TON sent from this workstation.

### Deployment

Git push of this commit to `payment/room-wallet-integration` is the established Railway Production mechanism. Post-push verification of `/health`, `/ready`, GitHub `railway-app[bot]`, and a second read-only TonAPI pass is recorded after the push in this same report (section updated at deploy time).

**kezX payout after deploy:** if Production restores this `READY` session, ordinary machinery may send winner 2.85 + owner 0.14. That event is **not** claimed here until an on-chain outbound proves it. This report does not treat deploy itself as financial completion.
