# Room Wallet Secret Hardening Report

Date: 2026-09-04

Task: Classify `ROOM_WALLETS_JSON` as a secret, redact it from diagnostics, and validate Room Wallet identity consistency and Room 01–64 catalog rules locally. No wallets generated. No Railway or fund changes.


## Baseline

| Item | Value |
|------|--------|
| Branch | `payment/room-wallet-integration` |
| Baseline commit | `b279a97f5cdb5ce7a24b1ca03663fcf6bd84b5b3` |
| Production wallets | not created (unchanged) |
| Railway variables | not modified |

Work is additive hardening on the existing `ROOM_WALLETS_JSON` loader. RoomManager was not changed.


## Secret Handling Audit

Before this change:

- `SECRET_ENV_KEYS` listed mnemonics, API key, and auth secrets. **`ROOM_WALLETS_JSON` was absent.**
- `isSecretKey` also matches `/password|secret|mnemonic|api[_-]?key|private/i`. The name `ROOM_WALLETS_JSON` does **not** match that regex, so the raw env blob would not redact.
- `ConfigurationError` redacts `received` via `sanitizeReceivedValue(entry.key, …)`.
- Nested field `secretKey` would redact if an object were walked; the env **string** would not.

After this change: `ROOM_WALLETS_JSON` is in `SECRET_ENV_KEYS`. `isSecretKey("ROOM_WALLETS_JSON")` is true. Configuration errors that pass the raw value as `received` become `[redacted]`.


## ROOM_WALLETS_JSON Secret Classification

**VERIFIED**

- Added to `SECRET_ENV_KEYS` (and therefore `SECRET_CONFIG_KEYS`).
- Declared optional in `ENVIRONMENT_SCHEMA` (type string, category TON).
- `validateEnvironment` type-checks it when present; missing remains valid.
- `validateSecrets` uses the raw value only as `received`, which is redacted.
- Parser JSON errors no longer append `JSON.parse` inner text.
- `.env.example` documents the variable as a Railway secret without embedding a catalog.

Parser errors name `roomNumber` and failure class only. They do not print `secretKey`, `publicKey`, or the env blob.


## Configuration Validation

Intake remains optional.

| Intake mode | `ROOM_WALLETS_JSON` |
|-------------|---------------------|
| unset / not `ROOM_WALLET` | may be absent or empty (**VERIFIED**, preserved) |
| present but invalid | rejected at parse / `validateSecrets` even if intake is off |
| `ROOM_WALLET` | required, valid JSON, **exactly 64** entries, `roomNumber` 1..64 once each |

Settlement still uses the existing fail-closed path (`size() > 0`) and may use a partial catalog in tests. Production intake is not weakened.


## Address/PublicKey/SecretKey Consistency

**VERIFIED** — local, no blockchain.

Uses existing `@ton/crypto` `keyPairFromSeed` and `@ton/ton` `WalletContractV4` plus `@ton/core` `Address.parse` (same derivation as `RoomWalletAdapter`).

For each entry:

1. `secretKey` (64 bytes) seed prefix must derive `publicKey` (32 bytes).
2. Derived nacl `secretKey` must equal the configured 64-byte key.
3. `WalletContractV4.create({ workchain: 0, publicKey })` bounceable url-safe address must equal the configured `address`.

Mismatched address / publicKey / secretKey combinations are rejected before the registry is built.


## Room 01-64 Mapping Validation

**VERIFIED**

- `roomNumber` integer 1..64 (existing).
- Duplicate `roomNumber` rejected in the parser (stronger than registry same-address overwrite).
- Duplicate canonical addresses rejected.
- When intake is enabled: length must be 64 and every `roomNumber` 1..64 present once.
- Mapping remains `roomNumber` N → Wallet N. RoomManager unchanged. No dynamic allocation.


## Network and Workchain Validation

**VERIFIED** against existing adapter/`TON_NETWORK` values. No new networks invented.

- `workchain` must be `0` (WalletContractV4). Default remains 0.
- Optional `network` must be `testnet` or `mainnet` when set.
- A catalog cannot mix those two values.
- If `TON_NETWORK` is set, an entry `network` must match it.

No transactions sent.


## Tests

New: `server/tests/roomWalletSecretHardening.test.js` (A–L plus intake-missing and network/workchain).

Fixtures: `server/tests/helpers/dummyRoomWallet.js` — deterministic SHA-256 test seeds, not production identities. No real mnemonics.

Updated existing JSON fixtures in resolver / composition / service tests to the dummy helper so identity checks pass.

Ran:

- Room Wallet hardening, resolver, composition, service, incoming observer, game readiness, room-number mapping: **64 passed, 0 failed**
- `configurationValidation.test.js`, `deploymentReimbursement.stageO.test.js`, runtime configuration tests: **passed**

No test output contained `DUMMY_ROOM_WALLET_SECRET_DO_NOT_LEAK` or raw `ROOM_WALLETS_JSON` values.


## Diff Review

Intended files only (unrelated dirty banners/reports not included in the commit):

- `server/config/secrets.js`
- `server/config/schemas/environmentSchema.js`
- `server/config/validators/validateEnvironment.js`
- `server/config/validators/validateSecrets.js`
- `server/payment/roomWallet/RoomWalletRuntimeResolver.js`
- `server/payment/roomWallet/ROOM_WALLET_RUNTIME.md`
- `server/.env.example`
- tests listed above

Confirmed:

- no production wallet generation
- no secret values committed
- no Railway changes
- no RoomManager / intake pipeline redesign
- no debug logging of `ROOM_WALLETS_JSON`


## Commit

Created after tests passed. Not pushed.

Message: `security: harden Room Wallet secret configuration`


## Final Verdict

**SECURITY HARDENING COMPLETE**

- `ROOM_WALLETS_JSON` is explicitly treated as a secret: **yes**
- Redaction verified by tests: **yes**
- Wallet identity consistency validation (local SDK): **yes**
- Room 01–64 mapping validation when intake is enabled: **yes**
- Tests pass: **yes**
- Commit created: **yes** (this report records the SHA after commit)
- Do **not** generate the 64 Production wallets yet; apply this commit, then provision secrets with an offline backup


## Next Step

1. Push this commit only when the operator requests it.
2. Deploy the hardening **before** placing real `ROOM_WALLETS_JSON` in Railway.
3. Then, in a separate authorized task, generate 64 TESTNET WalletContractV4 identities, back them up offline, and apply Railway variables.

No wallets were created. No funds were sent.
