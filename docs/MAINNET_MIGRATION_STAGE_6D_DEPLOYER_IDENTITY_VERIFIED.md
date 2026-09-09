# WheelWin Mainnet Migration — Stage 6D Deployer/Oracle Identity Verified

**Timestamp:** 2026-09-09 (UTC+3)  
**Type:** Public/non-secret audit record of a successful offline identity verification. No mnemonic in this document. No application-code change. No `.env` change. No RPC. No Railway / Vercel / Telegram. No funding. No deploy.  
**Checkout at record time:** `payment/room-wallet-integration`  
**HEAD at record time:** `949cc79db4a735eec3302fb89b180569ee234a73`  
**Remote Mainnet branch:** `origin/mainnet/production`

This record is the **only** identity result being archived in this commit. It does not reopen V4R2 vs W5 address policy (Stage 6C). The Stage 5 verifier was **not** modified and was **not** rerun in this stage.

---

## 1. Verification command

Operator-run in a normal Windows PowerShell session (not Cursor), working directory `server/`:

```text
node scripts/verify-deployer-identity.mjs
```

Mnemonic was supplied only as process environment `TON_DEPLOYER_MNEMONIC` via the documented SecureString procedure. Pins were:

- `TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS` = WheelWin-derived V4R2 address below
- `TON_MAINNET_ORACLE_ADDRESS` = the same address

The mnemonic was removed from the PowerShell environment after verification. This stage did **not** receive, read, print, or store that mnemonic.

---

## 2. Verification result

```text
Deployer identity verification PASS
network=mainnet
walletContractType=WalletContractV4R2
workchain=0
walletId=698983191
address=EQBry-bfWJTLfPBHmft1_Rtt-WUvQhI4tpf2aX96G-FYKe5a
expectedAddress=EQBry-bfWJTLfPBHmft1_Rtt-WUvQhI4tpf2aX96G-FYKe5a
identityMatch=true
oracleAddress=EQBry-bfWJTLfPBHmft1_Rtt-WUvQhI4tpf2aX96G-FYKe5a
oracleMatch=true
EXIT_CODE=0
```

| Field | Value |
| ----- | ----- |
| Result | **PASS** |
| `network` | `mainnet` |
| `walletContractType` | `WalletContractV4R2` |
| `workchain` | `0` |
| `walletId` | `698983191` |
| Authoritative WheelWin Deployer address | `EQBry-bfWJTLfPBHmft1_Rtt-WUvQhI4tpf2aX96G-FYKe5a` |
| `identityMatch` | `true` |
| Authoritative WheelWin Oracle address | `EQBry-bfWJTLfPBHmft1_Rtt-WUvQhI4tpf2aX96G-FYKe5a` |
| `oracleMatch` | `true` |
| Process exit code | `0` |

Deployer and Oracle are **one** WheelWin V4R2 identity: the address produced by `deriveDeployerWalletIdentity`.

---

## 3. Authoritative identity rule (unchanged)

WheelWin’s authoritative Mainnet Deployer/Oracle public address is:

`EQBry-bfWJTLfPBHmft1_Rtt-WUvQhI4tpf2aX96G-FYKe5a`

Future configuration pins, when a later stage writes them, must use this address for:

- `TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS`
- `TON_MAINNET_ORACLE_ADDRESS`

External wallet application W5 and V4R2 **displayed** addresses are **not** WheelWin configuration pins. This report does not record those display strings.

The Stage 5 verifier remains the identity tool. It was not changed.

---

## 4. Security confirmations

- Mnemonic / private key / `secretKey` / public-key hex: **not** recorded, not accessed in this stage.
- No TON RPC. No blockchain transaction. No funding.
- No Railway, Vercel, Telegram, `.env`, or deployment action.
- Testnet was not modified.
- No application code change. No Stage 5 file change.
- This stage does **not** configure Railway or proceed to funding/deploy.

---

## 5. What remains later

Railway Mainnet env, wallet funding, GameEscrow/Room Wallet Mainnet steps, Vercel/Telegram, and any further migration stages are **out of scope** for this commit.
