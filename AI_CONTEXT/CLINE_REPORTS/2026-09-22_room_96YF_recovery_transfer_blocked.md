# Room 96YF Manual Recovery Transfer — BLOCKED

Date: 2026-09-22

Task: One-time manual recovery transfer from the existing Room Wallet for game 96YF to the Owner wallet, leaving exactly 0.01 GRAM residual. No architecture/source changes.

## 1. Scope

- Local WheelWin working copy only (G:\WheelWin, branch payment/room-wallet-integration).
- Identify the Room Wallet identity for game 96YF from existing local configuration.
- Do not create/derive new wallets, do not expose secrets, do not modify code or records.

## 2. Files Inspected

- AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md, ARCHITECTURE_RULES.md, CURRENT_STATE.md, AI_WORKING_RULES.md
- AI_CONTEXT/CLINE_REPORTS/2026-09-21_room_wallet_local_file_config.md
- AI_CONTEXT/CLINE_REPORTS/2026-09-20_page4_room_wallet_rebuild.md
- server/.env, server/.env.example, config/owner.json
- server/payment/roomWallet/* (Registry, RuntimeResolver, Service, Config, ROOM_WALLET_RUNTIME.md)
- server/managers/RoomManager.js, server/managers/room/roomIdAlphabet.js
- server/data/ton-financial/** (manifest, active/*, immutable/audit/**)
- server/data/session-history/index.json, server/logs/games/*.log
- Full-tree + git-history searches for "96YF"

## 3. Findings

- Room Wallet identities live in the local catalog
  server/config/room-wallets-testnet-ROOM_WALLETS_JSON.json (64 WalletContractV4
  identities, roomNumber 1..64), loaded via ROOM_WALLETS_TESTNET_JSON_PATH.
  The catalog is present locally and valid.
- Destination 0QBaklBYMdMsuq7a2eTYhMkz1OF7ZSHaO1mnFd1MZd3YjC5t matches the
  existing config/owner.json ownerWallet pin. Verified.
- Room code → roomNumber mapping is runtime-only: RoomManager allocates
  roomNumber (1..64) at createRoom() and releases it at destroy(). Room codes
  (4-char, alphabet ACDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789)
  are random; there is no deterministic code→roomNumber derivation.

## 4. Blocking Reason

The identifier "96YF" appears NOWHERE in the local project:

- Full-tree search (all files, case-insensitive, excluding node_modules/.git/.kilo): 0 hits.
- server/data/ton-financial/** (all payment/settlement/recovery records): 0 hits.
- server/data/session-history/**: 0 hits (latest recorded rooms: pyzv, PNyS, wMCC, Smsp, KQrX, mZRb, CapZ, vkof, iDFC, LWKd).
- server/logs/**: 0 hits.
- Git history (all commits, pickaxe -S 96YF): 0 hits.

Consequently the roomNumber (1..64) that was allocated to room 96YF cannot be
determined locally, and therefore the corresponding Room Wallet identity in the
64-wallet catalog cannot be identified. Selecting a roomNumber by guessing would
risk sweeping the funds of a different live/stale room — prohibited by
financial-safety rules (never assume wallet state, fail closed).

## 5. What Would Be Needed to Unblock

Any authoritative record linking 96YF to its roomNumber, e.g.:
- The runtime log of the server instance that hosted room 96YF
  (RoomManager logs room creation with roomId + roomNumber).
- A payment/settlement record from that game (contains roomNumber and the
  Room Wallet address).
- Confirmation of which deployment (local vs Railway) hosted game 96YF.
  If it was hosted on Railway, the mapping and any remaining balance records
  live there, not in the local working copy.

## 6. Changes Made

No application files modified. No environment variables changed. No secrets
printed. No transaction sent. No game records altered. Temporary search-output
files were created and deleted under _audit_tmp; this report is the only
artifact.