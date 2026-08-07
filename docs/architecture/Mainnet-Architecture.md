# Mainnet Architecture

**R7.68 — readiness documentation.** Mainnet is prepared in configuration and ops docs only; production switch is a later stage.

## Flow

```text
Railway Backend
       ↓
 Oracle / Deployer Wallet (WalletContractV4R2)
       ↓
 GameEscrow (StateInit deploy)     [when GAME_ESCROW_MODE=game]
       ↓
 INIT_GAME
       ↓
 SETTLE
       ↓
 Winner payout  +  Owner payout
       ↓
 BlockchainMonitor (payout proofs)
       ↓
 SETTLEMENT_COMPLETED
```

Legacy path when `GAME_ESCROW_MODE=v4`:

```text
Railway Backend → Deployer Wallet → WalletContractV4 escrow → settle → monitor
```

## Configuration separation

| Profile | Env prefix / keys | Default escrow mode |
|---------|-------------------|---------------------|
| Testnet | `TON_NETWORK=testnet`, `TON_TESTNET_*`, `GAME_ESCROW_MODE` | `game` |
| Mainnet | `TON_MAINNET_*`, artifact SHA via `TON_GAME_ESCROW_ARTIFACT_SHA256` | `v4` (R7.68) |

Required Mainnet profile fields (all from env — no hardcoded wallets):

- network (`mainnet`)
- rpc endpoint (`TON_MAINNET_ENDPOINT`)
- oracle wallet (`TON_MAINNET_ORACLE_ADDRESS`)
- expected deployer address (`TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS`)
- escrow mode (`TON_MAINNET_GAME_ESCROW_MODE`, default `v4`)
- contract artifact hash (`TON_GAME_ESCROW_ARTIFACT_SHA256` or artifact meta)

## Deploy flow

1. Backend loads immutable config (`ConfigurationManager`)
2. Startup prints `TON_WALLET_IDENTITY_DEBUG` and `TON_MAINNET_READINESS`
3. On payments-complete, adapter builds StateInit (GameEscrow or V4 per mode)
4. Deployer broadcasts deploy (live mode + mnemonic)

## INIT_GAME

Oracle/deployer sends `INIT_GAME` with oracle, owner, contractIdHash, snapshotHash. Escrow moves from uninitialized → ready for settlement.

## SETTLE

After winner determination, adapter sends `SETTLE` with snapshotHash, winner, amounts. Session enters `SETTLEMENT_PENDING_CONFIRMATION` in GameEscrow mode.

## Confirmation

`BlockchainMonitor` verifies winner and owner payout proofs, then settlement completes. No Page6 gate changes.

## Recovery

Pending settlements restore from financial persistence after restart. GameEscrow payout watches re-register using persisted `request.contractAddress`.

## Emergency rollback

```text
Mainnet issue
    ↓
switch GAME_ESCROW_MODE=v4
    ↓
restart backend
    ↓
new games use V4
existing GameEscrow contracts continue normally
```

- No data loss for payment sessions or completed settlements
- Already-deployed GameEscrow addresses remain valid; finish or abandon in-flight games intentionally
- Mainnet must not default to `game` under R7.68

## Readiness tooling

```bash
node server/scripts/check-mainnet-readiness.js
```

Outputs `PASS` or `FAIL` with reasons (wallet identity, balance, artifact, config, rollback availability).

## Related

- [Mainnet-Launch-Checklist.md](../operations/Mainnet-Launch-Checklist.md)
- [R7.67A-Testnet-GameEscrow-Default.md](./R7.67A-Testnet-GameEscrow-Default.md)
