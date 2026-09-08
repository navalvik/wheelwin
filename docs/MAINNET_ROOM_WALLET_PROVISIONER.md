# Mainnet Room Wallet provisioner

This document describes the **offline Room Wallet identity generator** after Stage 2F. It can produce a Testnet catalog (existing behavior) or a Mainnet catalog (new, explicit path).

**This repository must never contain generated wallet files.** Do not run the Mainnet command until a later, operator-approved step. The command syntax below is documented only.

## CLI syntax

From the `server/` directory:

```text
node scripts/provision-room-wallets.mjs --network <testnet|mainnet> --output-dir <absolute-path>
```

### Legacy Testnet compatibility

```text
node scripts/provision-room-wallets.mjs --output-dir <absolute-path>
```

Omitting `--network` is **Testnet-only compatibility**. It is equivalent to `--network testnet`. It does **not** infer Mainnet. It never infers network from the output directory name.

### Mainnet (future operator run — do not execute now)

```text
node scripts/provision-room-wallets.mjs --network mainnet --output-dir <SECURE_MAINNET_WALLET_OUTPUT>
```

`<SECURE_MAINNET_WALLET_OUTPUT>` must be an absolute directory **outside** the Git repository. Mainnet generation **requires** `--network mainnet`. Unknown values (`prod`, `staging`, empty) are rejected.

## Supported networks

| Value | Meaning |
| ----- | ------- |
| `testnet` | Catalog tagged `network: "testnet"`. Default when `--network` is omitted. |
| `mainnet` | Catalog tagged `network: "mainnet"`. Only when `--network mainnet` is passed. |

The generator does not contact TON RPC and does not deploy or fund wallets. `network` is a **credential isolation tag** consumed by `loadRoomWalletRuntimeConfig` together with `TON_NETWORK`.

## Address / network semantics

WalletContractV4 bounceable url-safe addresses are derived from **workchain + public key**, not from the `network` string. The **same public key** can produce the **same textual address** on Testnet and Mainnet.

Therefore:

- Changing `network` on an existing catalog does **not** create a new on-chain identity.
- Testnet and Mainnet catalogs must use **independent random seeds**.
- Reusing Testnet key material on Mainnet is forbidden even if the address string looks identical.

## Output directory rules

`--output-dir` must be:

- an **absolute** path;
- **outside** the Git work tree;
- **not** the historical Testnet secrets directory basename `2026-09-04-room-wallets-testnet`;
- empty of the target filenames (exclusive create, `wx`).

A directory that already contains Testnet artifact files cannot receive Mainnet files (and the reverse).

## Output filenames

| Network | Master backup | Runtime JSON (`ROOM_WALLETS_JSON`) |
| ------- | ------------- | ---------------------------------- |
| Testnet | `room-wallets-testnet-master-backup.json` | `room-wallets-testnet-ROOM_WALLETS_JSON.json` |
| Mainnet | `room-wallets-mainnet-master-backup.json` | `room-wallets-mainnet-ROOM_WALLETS_JSON.json` |

Testnet filenames are unchanged.

## 64-wallet invariant

Exactly **64** independent WalletContractV4 (V4R2) wallets:

- workchain `0`;
- `roomNumber` `1..64` in generation order;
- one `randomBytes(32)` seed per wallet → `keyPairFromSeed`;
- **no** HD mnemonic, **no** shared master mnemonic, **no** derivation from a single seed.

## Wallet schema (runtime JSON)

Each entry:

- `roomNumber`
- `address` (bounceable, url-safe)
- `publicKey` (32-byte hex)
- `secretKey` (64-byte hex NaCl pair)
- `workchain` (`0`)
- `network` (`"testnet"` or `"mainnet"`)

The Testnet output schema is unchanged. Mainnet entries use `network: "mainnet"`.

Master backup additionally records `walletContractType`, `walletId`, `schemaVersion`, `generatedAt`.

## Validation

After write, the provisioner:

1. Re-reads both JSON files.
2. Verifies SHA-256 hashes.
3. Runs `validateProvisionedCatalog` (64 rooms, uniqueness, key/address match).
4. Loads the catalog with `loadRoomWalletRuntimeConfig` using:
   - `ROOM_WALLET_PAYMENT_INTAKE_MODE=ROOM_WALLET`
   - `TON_NETWORK` equal to the requested network.

A Mainnet catalog is rejected when `TON_NETWORK=testnet`. A Testnet catalog is rejected when `TON_NETWORK=mainnet`. Mixed `network` values in one JSON array are rejected.

The runtime validator was **not** weakened for this work.

## Stdout

May contain:

- network, wallet count, workchain, contract type;
- uniqueness counts (not the keys themselves);
- room numbers and public addresses;
- output paths and SHA-256 hashes of the artifacts;
- ACL status.

Never contains:

- `secretKey`;
- seed bytes;
- mnemonic material;
- complete JSON entries;
- public keys (the existing Testnet CLI did not print them; Mainnet follows that).

## Security rules

- Never commit generated files.
- Never print secrets.
- Never overwrite existing catalogs.
- Never write into the Git repository.
- Never reuse Testnet keys for Mainnet.
- Do not generate a real Mainnet catalog until a later approved operator step.

## Implementation files

- `server/scripts/provision-room-wallets.mjs`
- `server/scripts/lib/provisionRoomWallets.js`
- Tests: `server/tests/provisionRoomWallets.test.js`
