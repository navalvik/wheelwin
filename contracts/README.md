# R7.66C / R7.67A — TON GameEscrow v1

Contract: `INIT_GAME` + `SETTLE` (pays winner/owner). No STAKE yet.

**Testnet default (R7.67A):** `GAME_ESCROW_MODE=game`  
**Rollback:** `GAME_ESCROW_MODE=v4` (legacy WalletContractV4; mainnet default unchanged)

See [docs/architecture/R7.67A-Testnet-GameEscrow-Default.md](../docs/architecture/R7.67A-Testnet-GameEscrow-Default.md).

## Commands

```bash
cd contracts
npm install
npm run compile-contracts
npm test
```

Artifact:

`server/payment/ton/artifacts/GameEscrow.code.boc`
