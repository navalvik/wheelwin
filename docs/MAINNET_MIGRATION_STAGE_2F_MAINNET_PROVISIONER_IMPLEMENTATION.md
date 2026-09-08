# WheelWin Mainnet Migration — Stage 2F Mainnet Provisioner Implementation

**Timestamp:** 2026-09-08 (UTC+3)  
**Branch:** `payment/room-wallet-integration` @ `fb97882dd6367e89739fe37b8dd066f41e90648b`  
**Type:** Provisioner + tests + documentation only. No operator Mainnet catalog. No commit. No push.

Pre-existing working tree was already dirty (localization, audio, `AI_CONTEXT` reports, earlier Mainnet stage docs). This stage did not stage, commit, or discard those files.

---

## 1. Existing Testnet provisioner behavior

Before this change the generator was Testnet-locked:

- CLI: `node scripts/provision-room-wallets.mjs --output-dir <absolute-path>`
- Library: `generateRoomWalletIdentities` threw if `network !== "testnet"`
- Filenames: `room-wallets-testnet-master-backup.json`, `room-wallets-testnet-ROOM_WALLETS_JSON.json`
- 64 WalletContractV4 / V4R2 identities, workchain 0, `roomNumber` 1..64
- One `randomBytes(32)` seed per wallet → `keyPairFromSeed` (no HD mnemonic)
- Runtime schema: `roomNumber`, `address`, `publicKey`, `secretKey`, `workchain`, `network: "testnet"`
- Output dir must be absolute and outside Git; exclusive create (`wx`)
- Post-write parse used `TON_NETWORK=testnet`

That Testnet path remains the default when `--network` is omitted.

---

## 2. Mainnet extension design

Controlled dual-network support in the **same** provisioner library. Network is never inferred from the output directory name.

| Invocation | Network |
| ---------- | ------- |
| `--output-dir <abs>` (legacy) | `testnet` |
| `--network testnet --output-dir <abs>` | `testnet` |
| `--network mainnet --output-dir <abs>` | `mainnet` |
| missing `--output-dir`, unknown network, `--network` without a value | rejected |

Mainnet artifacts use distinct filenames. Writes into the historical Testnet secrets directory basename `2026-09-04-room-wallets-testnet` are refused. Testnet and Mainnet files cannot share one output directory.

`network` is a catalog tag for `loadRoomWalletRuntimeConfig` / `TON_NETWORK`. WalletContractV4 bounceable addresses are derived from workchain + public key. The same public key can produce the **same address string** on both chains; keys must still never be reused.

Runtime payment/settlement architecture was **not** redesigned. `RoomWalletRuntimeResolver` was not weakened.

---

## 3. Files changed

| File | Role |
| ---- | ---- |
| `server/scripts/lib/provisionRoomWallets.js` | Dual-network generation, filenames, path guards, public summary formatter |
| `server/scripts/provision-room-wallets.mjs` | `--network` CLI; Testnet default if omitted |
| `server/tests/provisionRoomWallets.test.js` | Coverage for both networks, CLI, paths, cross-network parse |
| `server/payment/roomWallet/ROOM_WALLET_RUNTIME.md` | Pointer to provisioner docs and address semantics |
| `docs/MAINNET_ROOM_WALLET_PROVISIONER.md` | Operator documentation (new) |
| `docs/MAINNET_MIGRATION_STAGE_2F_MAINNET_PROVISIONER_IMPLEMENTATION.md` | This report (new) |

`.env` / `.env.example` were not modified. Railway, Vercel, and Telegram were not modified.

---

## 4. CLI behavior

From `server/`:

```text
node scripts/provision-room-wallets.mjs --output-dir <absolute-path>
node scripts/provision-room-wallets.mjs --network testnet --output-dir <absolute-path>
node scripts/provision-room-wallets.mjs --network mainnet --output-dir <absolute-path>
```

**Future Mainnet operator command (not executed in this stage):**

```text
node scripts/provision-room-wallets.mjs --network mainnet --output-dir <SECURE_MAINNET_WALLET_OUTPUT>
```

---

## 5. Security guarantees

- Absolute output path required; repository paths rejected.
- Historical Testnet output directory rejected.
- Exclusive file creation (`wx`); no overwrite.
- Network-specific filenames; no mixed-network directory.
- Stdout: counts, network, addresses, artifact paths, SHA-256 hashes. No `secretKey=` values, no mnemonic, no full JSON entries, no public-key hex.
- Generated catalogs are not written into the Git tree by the tool.
- Tests use temporary directories under the OS temp folder and delete them.

---

## 6. Validation performed

In-process generation (ephemeral keys, not an operator catalog) then:

- 64 entries, rooms 1..64, unique addresses / public keys / secret keys, workchain 0
- `network` field matches the requested network
- `secretKey` derives `publicKey`; address matches WalletContractV4 bounceable form
- `loadRoomWalletRuntimeConfig` with `ROOM_WALLET_PAYMENT_INTAKE_MODE=ROOM_WALLET` and matching `TON_NETWORK`
- Cross-network rejection: Mainnet JSON + `TON_NETWORK=testnet`; Testnet JSON + `TON_NETWORK=mainnet`; mixed tags

---

## 7. Tests added/updated

`server/tests/provisionRoomWallets.test.js`:

- Legacy omit `--network` → testnet
- Explicit testnet and mainnet generation
- Invalid / missing network CLI
- Relative output dir (spawned CLI)
- Repo path and reserved Testnet dir
- Existing-file protection and mixed-filename directory protection
- Runtime resolver acceptance
- Cross-network parser rejection
- Address-string identity across networks with isolated `network` tags
- Stdout does not leak hex secrets

---

## 8. Test results

```text
node --test tests/provisionRoomWallets.test.js
ℹ tests 16
ℹ pass 16
ℹ fail 0
duration_ms ~18664
```

Run from `G:\WheelWin\server` on 2026-09-08. No RPC, no funded wallets, no transactions.

---

## 9–14. Confirmations

| Item | Status |
| ---- | ------ |
| 9. No real Mainnet wallets generated for deployment | **Confirmed.** No operator `--network mainnet --output-dir <SECURE_MAINNET_WALLET_OUTPUT>` run. Tests only created ephemeral keys in OS temp dirs and deleted them. |
| 10. No Mainnet mnemonics / deployment private keys produced as operator artifacts | **Confirmed.** Generator still uses per-wallet random seeds (no mnemonic). No Mainnet master-backup file left on disk for operators. |
| 11. No TON transactions | **Confirmed.** Provisioner does not send or fund. |
| 12. Railway / Vercel / Telegram untouched | **Confirmed.** |
| 13. No Git commit | **Confirmed.** HEAD remains `fb97882`. |
| 14. Nothing pushed | **Confirmed.** |

---

## Implementation status

- **Done:** Mainnet-capable provisioner, tests, docs.
- **Testnet CLI:** Compatible (`--output-dir` only still means testnet, same filenames/schema).
- **Future Mainnet command:** Ready to run later against `<SECURE_MAINNET_WALLET_OUTPUT>`; **not** executed now.
