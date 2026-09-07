# UhqU historical FAILED re-entry into ordinary Room Wallet settlement

Date: 2026-09-07

Task: Determine and implement the smallest safe production-code change so the known historical UhqU `SETTLEMENT_FAILED` (old `prizeAmount` adapter field mismatch) can re-enter the ordinary inspect-before-send Room Wallet lifecycle, without operator-recovery, without sending TON, and without making all FAILED sessions retryable.


## 1. Scope

Read-only investigation of the UhqU restore/resume blockage, then a narrow restore-time re-entry classifier. Focused tests only. **No deploy. No blockchain write. No operator-recovery call.**


## 2. Files Inspected

- `server/payment/SettlementSessionStates.js`
- `server/payment/SettlementSession.js`
- `server/payment/ContractSettlementManager.js`
- `server/payment/roomWallet/RoomWalletSettlementAdapter.js`
- `server/payment/roomWallet/RoomWalletAdapter.js`
- `server/payment/roomWallet/roomWalletTerminalRecoveryChain.js`
- `server/payment/roomWallet/RoomWalletTerminalSettlementRecovery.js`
- `server/payment/roomWallet/sealedTerminalSettlementEvidence.js`
- `server/recovery/TonFinancialRecovery.js`
- `server/gameplay/GameContractManager.js`
- `server/tests/roomWalletSettlement.r18s83.retryable.test.js`
- `AI_CONTEXT/CLINE_REPORTS/2026-09-07_r18_s79_uhqu_settlement_payout_forensic.md`
- `AI_CONTEXT/CLINE_REPORTS/2026-09-07_r18_s80_uhqu_settlement_interface_fix.md`
- `AI_CONTEXT/CLINE_REPORTS/2026-09-07_r18_s81_uhqu_financial_recovery.md`
- `AI_CONTEXT/CLINE_REPORTS/2026-09-07_r18_s82_uhqu_terminal_settlement_operator_recovery.md`
- `AI_CONTEXT/CLINE_REPORTS/2026-09-07_r18_s85_kezx_src_copy_settlement_fix.md`

Production HTTP (read-only): `/health`, `/ready`. TonAPI Room Wallet #1 transactions (read-only).


## 3. Architecture Findings

### A. Why UhqU cannot resume today (before this change)

1. Original fail: CSM sent `winnerAmount`; adapter required `prizeAmount` → `adapter_threw:prizeAmount or prizeAmountNano is required`.
2. `_failSettlement` persisted `SETTLEMENT_FAILED`, then cleared in-memory `session.request` (disk payload still includes `request` if persist ran first).
3. `SETTLEMENT_FAILED` has **empty outgoing transitions**.
4. `restoreSettlementSessions` **skips** `session.isTerminal()`.
5. `_canResumeRestoredSettlement` rejects terminal sessions.
6. `TonFinancialRecovery` treats contract `SETTLEMENT_FAILED` as terminal.
7. s82 operator-recovery can reopen it, but this task must not use that path.

The s80 field alias is already fixed. The remaining blockage is **restore skip of terminal FAILED**, not the adapter request shape.

### B. Persisted / sealed evidence is sufficient

Authoritative intended settlement (archive + sealed evidence, not operator input):

| Field | Value |
| --- | --- |
| gameId | `game_3618b43e-f127-4f8f-93ca-84eaa90f1345` |
| room | `UhqU` / roomNumber **1** |
| winner | Olga `EQC9qwKAy72kX1oPtryX-g5y44B2mYZEB2HVdJAeJprla_Le` |
| owner | `0QBaklBYMdMsuq7a2eTYhMkz1OF7ZSHaO1mnFd1MZd3YjC5t` |
| winnerAmount | **2.85** |
| organizerAmount | **0.15** (owner payout **0.14** after retain) |
| original reason | `adapter_threw:prizeAmount or prizeAmountNano is required` |

Reconstruction uses persisted `request` / session fields, and sealed archive facts only when they **agree** with persisted identity. No user-supplied amount or destination overrides.

### C. Can s85 ordinary settlement process UhqU after re-entry?

The ordinary path can **accept** the reconstructed request (`winnerAmount` aliases work; inspect-before-send; Buffer keys).

On current chain, Room Wallet #1 already has **later** kezX inbounds, Bob 2.85, owner 0.14, and residual 0.49. `inspectRoomWalletHistory` will classify that as **`WALLET_REUSED`** (non-matching later activity). Ordinary settle then fail-closes **without send**. That is correct safety, not a payout.

Therefore: after re-entry, UhqU becomes **routable** through ordinary settlement; it is **not** currently payable on this shared wallet without violating reuse protection.

### D. Minimal mechanism

On restore only, if Room Wallet settlement is enabled and the FAILED reason is **exactly** the historical adapter-interface signature, reconstruct the request and set status **`READY` directly** (not via the FAILED transition table). Then existing `resumeRestoredSettlements` → inspect → send-missing-legs → confirm.

### E. Safety boundary

| Reason | Restore |
| --- | --- |
| `adapter_threw:prizeAmount or prizeAmountNano is required` + complete evidence | re-enter `READY` |
| `WALLET_REUSED` / `DUPLICATE_PAYOUT` / amount disagreement | remain terminal, skipped |
| other `adapter_threw:*` | remain terminal, skipped |
| incomplete payload and no agreeing sealed evidence | skipped |

`SETTLEMENT_FAILED` transition map stays empty. Genuine safety failures stay terminal. s82 operator path unchanged and unused.


## 4. Lifecycle Flow

`restoreSettlementSessions` → classify historical interface FAILED → reconstruct request → in-memory `READY` + persist recoveryMetadata → `resumeRestoredSettlements` → `inspectSettlement` → adopt / send missing / `WALLET_REUSED` fail-closed → `SETTLEMENT_CONFIRMED` only if both legs confirmed → Residual Sweep still only on that event.


## 5. Ownership Boundaries

- Classifier/reconstruct: `historicalRoomWalletSettlementReentry.js`
- Restore gate: CSM only
- Payout/inspect/idempotency: existing `RoomWalletSettlementAdapter`
- Signing: existing `RoomWalletAdapter` (s85 Buffer fix unchanged)
- Operator recovery: unused


## 6. Risks

- **High:** Deploying this later onto Production would re-enter UhqU and then likely persist a new `WALLET_REUSED` failure after inspect. No TON send expected. **This task does not deploy.**
- **Medium:** Shared Room Wallet #1 already settled kezX; UhqU winner payout is still missing and cannot pass reuse inspect on that wallet.
- **Low:** Sealed evidence fill is gameId-keyed and must agree with persisted fields.


## 7. Recommendations

Do not deploy this commit until an authorized decision accepts that UhqU ordinary re-entry will almost certainly fail-close `WALLET_REUSED` on the current chain. Do not use operator-recovery to bypass reuse. Do not send TON to “complete” UhqU while kezX activity sits on the same wallet.


## 8. Changes Made

- `server/payment/roomWallet/historicalRoomWalletSettlementReentry.js` — exact-reason classifier + evidence reconstruction
- `server/payment/ContractSettlementManager.js` — restore-time `_reenterHistoricalRoomWalletFailure`
- `server/tests/roomWalletSettlement.r18s86.historicalReentry.test.js`
- `server/tests/roomWalletSettlement.r18s83.retryable.test.js` — unclassified FAILED still skipped

### Tests

```
node tests/roomWalletSettlement.r18s86.historicalReentry.test.js
  4 pass
node tests/roomWalletSettlement.r18s83.retryable.test.js
  10 pass (src.copy READY retry + idempotency + unclassified FAILED skip)
node tests/roomWalletAdapter.signingBuffer.r18s85.test.js
  2 pass
node tests/roomWalletSettlementAdapter.test.js
  14 pass
node tests/roomWalletSettlement.r18s80.uhquHandoff.test.js
  2 pass
node tests/roomWalletTerminalSettlementRecovery.r18s82.test.js
  17 pass
```

### Production status (read-only, this task)

- `/ready` `ready=true`
- `/health` `ok`, settlements `0`, activeGames `0`
- Room Wallet #1 latest outs remain kezX: Bob 2.85, owner 0.14, sweep 0.49
- **No 2.85 outbound to Olga**
- **UhqU is not paid**
- **No TON sent from this workstation**
- **`/console/settlements/operator-recovery` was not called**
- **This change is not deployed**

Final: UhqU is now **merely recoverable into the ordinary Room Wallet path in code**. It is **not** paid. Ordinary inspect on the current shared wallet is expected to fail-close as reuse if this were deployed.
