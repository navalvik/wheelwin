# Room 96YF Room Wallet — Manual Owner Recovery Transfer

Date: 2026-09-22 (transaction confirmed at utime 1790095080)

Task: One-time manual recovery transfer of the Room 96YF Room Wallet balance
(roomNumber 1) to the Owner wallet. Operational transaction only; no source
code, configuration, or game records modified.

## Operational Result

| Field | Value |
|---|---|
| Date/time (UTC) | 2026-09-22, tx utime 1790095080 |
| Source wallet | EQDGQjwaP0OSExa9MfZih61De5TQuUITQPYiYZyfqAFzpvQB |
| Destination owner wallet | 0QBaklBYMdMsuq7a2eTYhMkz1OF7ZSHaO1mnFd1MZd3YjC5t |
| Balance before | 10.042013398 GRAM (10042013398 nano) |
| Amount transferred | 10.029735770 GRAM (10029735770 nano) |
| Actual transaction fee | 0.000414679 GRAM (414679 nano, source-paid) |
| Balance after | 0.011886749 GRAM (11886749 nano) |
| Transaction hash (hex) | 9977e4f73656152cbb203c1b3b27548a5a73a625fce8ed3f4895a639771cd236 |
| Transaction hash (base64) | mXfk9zZWFSy7IDwbOydUilpzpiX86O0/SJWmOXcc0jY= |
| Status | CONFIRMED (on-chain, outbound transaction observed + balance updated) |

Post-transfer balance is 0.011886749 GRAM — above the required 0.01 GRAM
retention floor. Nothing was sent to Bob's, Olga's, or Lena's wallets.

## Execution Notes

- Source wallet identity was taken from the existing local catalog
  (roomNumber 1) and verified: key pair derives exactly the provided source
  address (WalletContractV4, workchain 0).
- Destination was verified to canonicalize byte-exactly to the provided
  0Q... string and to match the existing config/owner.json ownerWallet pin.
- Send mechanics mirrored the project's RoomWalletAdapter:
  SendMode.PAY_GAS_SEPARATELY, seqno 18, TonCenter testnet JSON-RPC with the
  local TON_API_KEY.
- Amount was computed as balance − 0.01 GRAM floor − fee budget (2× the
  maximum outbound fee observed in this wallet's own confirmed history,
  388,814 nano × 2 = 777,628 nano) − 0.0015 GRAM safety margin.
  The actual fee came in far below the budget, leaving 0.011886749 GRAM.
- No mnemonics, private keys, or secrets were printed or persisted.

## Changes Made

- No application source, configuration, environment, or game-record files
  modified. One temporary operational script was used and deleted;
  this report is the only artifact.