# R7.69A — TON GameEscrow with on-chain STAKE

Contract: `INIT_GAME` + `OPEN_PAYMENTS` + `STAKE` + `SETTLE`.

**Testnet default:** `GAME_ESCROW_MODE=game`  
**Rollback / mainnet default:** `GAME_ESCROW_MODE=v4`

Player deposits go to GameEscrow via STAKE (not backend custody).

## Commands

```bash
cd contracts
npm install
npm run compile-contracts
npm test
```

Artifact:

`server/payment/ton/artifacts/GameEscrow.code.boc`
