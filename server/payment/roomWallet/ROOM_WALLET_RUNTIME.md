# Room Wallet Runtime Integration

The Room Wallet subsystem is intentionally inert unless runtime wallet configuration is supplied.

## Runtime configuration

Provide `ROOM_WALLETS_JSON` as a JSON array containing one entry per configured room wallet. Private signing material is runtime-only and must never be committed to GitHub. The variable is a secret (`SECRET_ENV_KEYS`): logs and configuration errors must redact it.

When `ROOM_WALLET_PAYMENT_INTAKE_MODE=ROOM_WALLET`, the catalog must contain exactly 64 entries with `roomNumber` 1..64 once each. Each entry's `secretKey` must derive `publicKey`, and `address` must be the WalletContractV4 address for that key on workchain 0.

The application composition root should create the Room Wallet service once and expose it to the settlement layer. Creating the service does not enable Room Wallet settlement by itself.

## Financial invariants

- Existing WheelWin game rules remain unchanged.
- Existing Winner/Owner calculations remain the source of settlement amounts.
- Owner payout preserves the existing gross Owner share while retaining the configured room reserve.
- Gas is paid by the source wallet and is not deducted from the recipient's intended amount.
- Residual sweep transfers the configured residue amount and pays its gas from the source Room Wallet.
- Room Wallet balance is not the source of truth for an individual game's accounting; the game financial ledger is.

## Activation rule

`ROOM_WALLET` settlement must be explicitly selected by configuration. Missing or invalid runtime wallet configuration must fail closed and leave the legacy settlement path available.
