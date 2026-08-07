# R7.69C — TON GameEscrow with on-chain STAKE + EMERGENCY_CANCEL refunds

Contract: `INIT_GAME` + `OPEN_PAYMENTS` + `STAKE` + `SETTLE` + `EMERGENCY_CANCEL`.

Lifecycle:
- Happy path: Deploy → INIT → OPEN_PAYMENTS → STAKE → READY → SETTLE
- Cancel path: after payments open → `EMERGENCY_CANCEL` → refunds → `CANCELLED`

**Testnet default:** `GAME_ESCROW_MODE=game`  
**Rollback / mainnet default:** `GAME_ESCROW_MODE=v4`

Player deposits go to GameEscrow via STAKE (not backend custody).
Cancel refunds exact paid stakes (no commission / winner payout).

## Commands

```bash
cd contracts
npm install
npm run compile-contracts
npm test
```

Artifact:

`server/payment/ton/artifacts/GameEscrow.code.boc`
