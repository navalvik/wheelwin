# Mainnet Launch Checklist

**Status:** R7.68 — readiness only. Mainnet is **not** enabled.  
**Escrow:** Mainnet remains `GAME_ESCROW_MODE=v4` until an explicit launch stage.

## Before launch

- [ ] `TON_NETWORK` still `testnet` in Railway until go-live
- [ ] Mainnet profile env filled (no secrets in git):
  - [ ] `TON_MAINNET_ENDPOINT`
  - [ ] `TON_MAINNET_ORACLE_ADDRESS`
  - [ ] `TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS`
  - [ ] `TON_MAINNET_GAME_ESCROW_MODE=v4` (rollback-safe default)
  - [ ] `TON_GAME_ESCROW_ARTIFACT_SHA256` matches `GameEscrow.code.boc`
- [ ] Deploy / oracle wallet funded on **mainnet**
- [ ] Oracle wallet verified (address matches `TON_MAINNET_ORACLE_ADDRESS`)
- [ ] Artifact hash verified:

  ```bash
  node server/scripts/check-mainnet-readiness.js
  ```

  Expect `PASS`
- [ ] TonCenter mainnet endpoint verified (HTTP JSON-RPC reachable with API key if required)
- [ ] Deployer balance verified (enough TON for deploy + INIT_GAME + SETTLE gas)
- [ ] Rollback mode verified (`v4` available; see Emergency rollback below)
- [ ] Startup prints `TON_MAINNET_READINESS` with `status: PASS` when probing mainnet profile
- [ ] Wallet identity diagnostics (`TON_WALLET_IDENTITY_DEBUG`) match expected deployer address

## Launch (separate change window — not part of R7.68)

1. Enable Mainnet: set `TON_NETWORK=mainnet` (and `APP_ENVIRONMENT=MAINNET` if used)
2. Keep `TON_MAINNET_GAME_ESCROW_MODE=v4` / active `GAME_ESCROW_MODE=v4` until GameEscrow mainnet cutover is approved
3. When cutover is approved: set escrow mode to `game` in a dedicated release (not R7.68)
4. Deploy first GameEscrow
5. Verify `INIT_GAME`
6. Verify `SETTLE`
7. Verify winner + owner payouts on-chain

## After launch

- [ ] BlockchainMonitor watching escrow payouts
- [ ] Settlement reaches `SETTLEMENT_COMPLETED` only after payout proofs
- [ ] Balances: deployer, escrow (post-settle), winner, owner
- [ ] Confirm `TON_MAINNET_READINESS` / identity logs on each restart
- [ ] Incident contacts and rollback owner assigned

## Emergency rollback

See [Mainnet-Architecture.md](../architecture/Mainnet-Architecture.md#emergency-rollback).

```text
Mainnet issue
    ↓
GAME_ESCROW_MODE=v4   (and/or TON_MAINNET_GAME_ESCROW_MODE=v4)
    ↓
restart backend
    ↓
new games use WalletContractV4
existing GameEscrow contracts continue normally
```

No payment session data loss. In-flight GameEscrow games finish on their deployed contracts.
