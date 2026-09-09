# WheelWin Mainnet Migration — Stage 5 Deployer Identity Verification

**Timestamp:** 2026-09-09 (UTC+3)  
**Checkout:** `payment/room-wallet-integration` @ `d4c3f1a4067cec940f141969ddc599cff996ecf5`  
**Type:** Offline verifier for a **future** Mainnet Deployer/Oracle identity. No operator Mainnet wallet. No Railway. No commit.

---

## 1. Executive Summary

WheelWin already derives Deployer identity with `deriveDeployerWalletIdentity`: `mnemonicToPrivateKey` + `WalletContractV4.create({ workchain: 0, publicKey })` (V4R2, default `walletId` **698983191**). Pins compare via `tonAddressesEqual` (bounceable and non-bounceable friendly forms). Mainnet Oracle must equal the Deployer pin.

`server/scripts/check-mainnet-readiness.js` is **not** a safe pre-Railway identity-only tool: it **loads `.env` files** and **constructs `TonService` / probes RPC**. Identity can still be computed if RPC fails, but the script is the wrong operator surface.

A **minimum offline verifier** was therefore added:

- `server/scripts/verify-deployer-identity.mjs`
- `server/scripts/lib/verifyDeployerIdentity.js`

It calls the **same** `deriveDeployerWalletIdentity` function. It does **not** load `.env`, does **not** use RPC, does **not** accept a mnemonic on the command line, and prints only public fields. Tests use the published BIP39 **abandon/about** vector, not an operator wallet.

**Do not run the verifier with a real Mainnet mnemonic in this stage.** The command is documented for a later operator step.

---

## 2. Existing Deployer Derivation Algorithm

`server/payment/ton/deriveDeployerWalletIdentity.js`:

1. Split `TON_DEPLOYER_MNEMONIC` on whitespace.
2. `await mnemonicToPrivateKey(words)` from `@ton/crypto` (no password argument; no HD path; **not** the 12-word V5 deposit path).
3. `WalletContractV4.create({ workchain: 0, publicKey })` — comment and constant: **WalletContractV4R2**.
4. Return bounceable url-safe `address`, non-bounceable `addressNonBounceable`, `walletId` from the contract object, `workchain` from `wallet.address.workChain`.
5. Does **not** return mnemonic, `secretKey`, or `publicKey` hex.

Signing (`TonGameContractAdapter._sendOracleMessage`) repeats the same `mnemonicToPrivateKey` + `WalletContractV4.create({ workchain: 0, publicKey })`.

---

## 3. Exact Wallet Parameters

| Parameter | Value (from source) |
| --------- | ------------------- |
| Mnemonic conversion | `@ton/crypto` `mnemonicToPrivateKey` |
| Contract class | `@ton/ton` `WalletContractV4` |
| Version label | `WalletContractV4R2` (`DEPLOYER_WALLET_CONTRACT_TYPE`) |
| Workchain | `0` (`DEPLOYER_WALLET_WORKCHAIN`) |
| `walletId` | Library default when `create` is not given `walletId`: **698983191** (FACT from `WalletContractV4` + existing tests) |
| Preferred address | bounceable, url-safe, **not** `testOnly` → `EQ…` |
| Also derived | non-bounceable url-safe → `UQ…` |
| Comparison | `tonAddressesEqual` → `canonicalizeTonWalletAddress` → bounceable url-safe string equality (`TonWalletIdentityDebug.js` / `TonWalletAddress.js`) |
| Oracle pin | `TON_MAINNET_ORACLE_ADDRESS` must `tonAddressesEqual` `TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS` |

Same public key yields the same bounceable string on Testnet and Mainnet; isolation is **key material + env pins**, not a different address encoding.

---

## 4. Existing Verification Capabilities

### `check-mainnet-readiness.js`

| Property | Fact |
| -------- | ---- |
| Derives identity | Yes, via `deriveDeployerWalletIdentity` |
| Offline-only | **No** — instantiates `TonService` and calls `getBalance` / `getSeqno` (errors swallowed) |
| Loads `.env` | **Yes** — `server/.env`, repo `.env`, cwd `.env`, `.env.local` |
| Requires full Mainnet profile | Yes — artifact, oracle pin, escrow `v4`, etc. for overall PASS |
| Prints secrets | Does not print mnemonic (identity address/type/walletId only) |
| Suitable for pre-Railway pin check | **No** (`.env` load + RPC + unrelated readiness gates) |

**Not executed** with real secrets in this stage.

### Production startup

`App._runTonMainnetReadinessDiagnostics` derives identity and fail-fast matches pins. That is **after** Railway env is set — too late as the first local check.

### Tests already present

`server/tests/tonWalletIdentityDebug.test.js` — V4R2 derive + bounceable vs non-bounceable `tonAddressesEqual`.  
`server/tests/mainnetReadiness.test.js` — pin / oracle equality / walletId in fixtures.

---

## 5. Proposed Safe Verification Procedure

**Not executed now.**

A. Create a **new** Mainnet wallet in trusted software that uses **TON standard mnemonic + Wallet V4R2 / workchain 0** (not W5, not 12-word multichain deposit).  
B. Keep the mnemonic offline. Do not paste it into Cursor.  
C. Copy the public address (bounceable `EQ…` preferred).  
D. In a local shell **that will not keep history**, from `server/`, with **session env only** (never `.env`, never argv):

```text
TON_DEPLOYER_MNEMONIC=<session-only>
TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS=<public-EQ-address>
TON_MAINNET_ORACLE_ADDRESS=<same-public-EQ-address>
node scripts/verify-deployer-identity.mjs
```

E. Require stdout `PASS`, `walletContractType=WalletContractV4R2`, `workchain=0`, `walletId=698983191`, `identityMatch=true`, `oracleMatch=true`. Exit code 0.  
F. Unset `TON_DEPLOYER_MNEMONIC` immediately.  
G. Later Railway stage: same mnemonic as `TON_DEPLOYER_MNEMONIC`; same address for both Mainnet pins. Never Git, never Vercel, never client env.

The verifier **canonicalizes** the expected pin through `tonAddressesEqual`; output `address=` is always WheelWin bounceable url-safe.

---

## 6. Secret Handling Rules

- Mnemonic: process environment for one command only.
- Never: argv, committed files, Cursor chat, reports, `.env`, Vercel, `ROOM_WALLETS_JSON`.
- Script refuses extra CLI arguments so a pasted mnemonic on the command line is rejected.
- Script does **not** load `.env` (unlike `check-mainnet-readiness.js`).
- Stdout: public address, type, workchain, walletId, match flags. No `secretKey` / mnemonic / public-key hex.
- Linux `ps` / `/proc/.../environ` can still show env — use a private session and unset after.

---

## 7. Mainnet vs Testnet Identity Isolation

| Risk | Safeguard |
| ---- | --------- |
| Testnet Deployer mnemonic | New mnemonic; verifier vs **new** expected address; do not use Testnet pin |
| Testnet address as Mainnet pin | Pins are `TON_MAINNET_*` only; Testnet `TON_DEPLOYER_EXPECTED_ADDRESS` is not read |
| V5 / 12-word HD | Verifier uses V4R2 only; deposit V5 path is a different module |
| Non-zero workchain | Fail if `workchain !== 0` |
| Custom subwallet / walletId | Fail if `walletId !== 698983191` |
| Oracle ≠ Deployer | Optional `TON_MAINNET_ORACLE_ADDRESS` must equal derived address; production fail-fast also requires equality |
| Same address string on both chains | Still **forbidden** to reuse Testnet **keys** |

---

## 8. Railway Configuration Prerequisites

Not this stage. Later, after local PASS:

- `TON_DEPLOYER_MNEMONIC` (secret)
- `TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS` (public, bounceable preferred)
- `TON_MAINNET_ORACLE_ADDRESS` (same account)
- Rest of Mainnet boot matrix (Stage 4): `TON_NETWORK=mainnet`, owner, artifact, escrow `v4`, etc.

`check-mainnet-readiness.js` remains for **full** profile/artifact dry-run **without** putting the mnemonic in repo files; still avoid sourcing Testnet `.env`.

---

## 9. Whether Code Changes Were Necessary

**Yes, a small verifier only** — justified because no existing script is offline, `.env`-free, and identity-only while still using production derivation.

Unchanged: payment/runtime, Room Wallet provisioner, readiness fail-fast, env names.

---

## 10. Tests Performed

`node --test tests/verifyDeployerIdentity.test.js` (from `server/`):

```text
ℹ tests 7
ℹ pass 7
ℹ fail 0
```

Coverage: CLI argv rejection; V4R2 / workchain 0 / walletId; bounceable vs non-bounceable pin; mismatch fail; stdout has no mnemonic; spawn with env only.

Fixture: BIP39 abandon/about **test vector** (already used in `deployerWalletObservability.test.js`). Not an operator Mainnet wallet. No RPC.

---

## 11. Remaining Risks / Unresolved Questions

- Wallet software that uses a **passphrase** or **W5** will not match this verifier.
- Word count is still not enforced in `deriveDeployerWalletIdentity` (24-word TON mnemonic is **INFERRED** operational practice).
- Operator must still not paste secrets into Cursor or commit `.env`.
- Verifier was **not** run with a real Mainnet mnemonic.

---

## 12. Exact Files Inspected / Changed

**Inspected:**  
`deriveDeployerWalletIdentity.js`, `tonNetworkProfiles.js`, `validateMainnetConfiguration.js`, `TonMainnetReadiness.js`, `TonWalletIdentityDebug.js`, `TonWalletAddress.js`, `check-mainnet-readiness.js`, `check-testnet-wallet-readiness.js`, `TonGameContractAdapter.js` (send path), `tonWalletIdentityDebug.test.js`, `mainnetReadiness.test.js`, Stage 3/4/2F reports.

**Added (uncommitted):**  
- `server/scripts/lib/verifyDeployerIdentity.js`  
- `server/scripts/verify-deployer-identity.mjs`  
- `server/tests/verifyDeployerIdentity.test.js`  
- `docs/MAINNET_MIGRATION_STAGE_5_DEPLOYER_IDENTITY_VERIFICATION.md`

Unrelated dirty client files were not modified.

---

## Final confirmations

- real Mainnet wallet generated: **NO**
- real Mainnet mnemonic generated: **NO**
- real private key generated: **NO**
- 64 Mainnet Room Wallets generated: **NO**
- TON RPC used: **NO**
- TON transaction: **NO**
- Railway changed: **NO**
- Vercel changed: **NO**
- Telegram changed: **NO**
- `.env` changed: **NO**
- deployment: **NO**
- commit: **NO**
- push: **NO**
- unrelated working-tree changes preserved: **YES**
