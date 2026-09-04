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
- Residual sweep transfers exactly 0.49 Gram to the Residues destination when the Room Wallet chain balance reaches 0.50 Gram. The source Room Wallet retains a 0.01 Gram envelope (0.006 Gram source-paid fee budget + 0.004 Gram safety margin). Recipient value is never reduced to pay fees.
- Residual sweep is off unless `ROOM_WALLET_RESIDUAL_SWEEP_ENABLED` is explicitly true.
- Residues destination prefers `TON_RESIDUES_EXPECTED_ADDRESS`. Compatibility fallback: `TON_REIMBURSEMENT_EXPECTED_ADDRESS` (same physical wallet; role migration only). Dual pins must match. Source Room Wallet must not equal Residues destination.
- Missing Residues destination prevents sweep sends; the process still starts.
- Room Wallet balance is not the source of truth for an individual game's accounting; the game financial ledger is.

## Activation rule

`ROOM_WALLET` settlement must be explicitly selected by configuration. Missing or invalid runtime wallet configuration must fail closed and leave the legacy settlement path available.
