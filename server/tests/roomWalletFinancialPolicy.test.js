import assert from "node:assert/strict";

import {
    ROOM_WALLET_POLICY,
    buildOwnerPayout,
    buildResidualSweep,
    buildSourceWalletTransfer
} from "../payment/roomWallet/RoomWalletFinancialPolicy.js";

import {
    ROOM_LEDGER_ENTRY_TYPES,
    RoomWalletLedger
} from "../payment/roomWallet/RoomWalletLedger.js";

// Owner accounting: 0.14 Gram reaches Owner Wallet and 0.01 Gram is retained.
{
    const result = buildOwnerPayout({ ownerGrossNano: 150_000_000n });

    assert.equal(result.ownerPayoutNano, 140_000_000n);
    assert.equal(result.retainedNano, 10_000_000n);
    assert.equal(result.minimumEconomicShareNano, 150_000_000n);
}

// Gas is a source-wallet debit and never reduces the recipient amount.
{
    const result = buildSourceWalletTransfer({
        amountNano: 140_000_000n,
        gasNano: 2_000_000n
    });

    assert.equal(result.recipientCreditNano, 140_000_000n);
    assert.equal(result.sourceDebitNano, 142_000_000n);
}

// Residual sweep: 0.49 Gram is transferred and gas is charged separately.
{
    const result = buildResidualSweep({
        balanceNano: 500_000_000n,
        gasNano: 2_000_000n
    });

    assert.equal(result.eligible, true);
    assert.equal(result.transferNano, ROOM_WALLET_POLICY.residualSweepNano);
    assert.equal(result.sourceDebitNano, 492_000_000n);
    assert.equal(result.remainingNano, 8_000_000n);
}

// Below the threshold no sweep is allowed.
{
    const result = buildResidualSweep({
        balanceNano: 499_999_999n,
        gasNano: 2_000_000n
    });

    assert.equal(result.eligible, false);
    assert.equal(result.reason, "BELOW_RESIDUAL_TRIGGER");
}

// The source wallet must have enough to cover both the 0.49 Gram transfer and gas.
{
    const result = buildResidualSweep({
        balanceNano: 491_000_000n,
        gasNano: 2_000_000n
    });

    assert.equal(result.eligible, false);
    assert.equal(result.reason, "INSUFFICIENT_BALANCE_FOR_SWEEP_AND_GAS");
}

// Ledger records transfer amount and gas separately, preserving auditability.
{
    const ledger = new RoomWalletLedger({
        roomId: "room-01",
        gameId: "game-01",
        clock: () => 123
    });

    ledger.record({
        entryId: "payment-1",
        type: ROOM_LEDGER_ENTRY_TYPES.PLAYER_PAYMENT,
        direction: "CREDIT",
        amountNano: 25_000_000_000n,
        counterparty: "PLAYER_1"
    });

    const transfer = ledger.recordTransfer({
        entryId: "owner-payout-1",
        type: ROOM_LEDGER_ENTRY_TYPES.OWNER_PAYOUT,
        amountNano: 140_000_000n,
        gasNano: 2_000_000n,
        counterparty: "OWNER"
    });

    assert.equal(transfer.sourceDebitNano, 142_000_000n);
    assert.equal(transfer.recipientCreditNano, 140_000_000n);
    assert.equal(ledger.getCreditsNano(), 25_000_000_000n);
    assert.equal(ledger.getDebitsNano(), 142_000_000n);
    assert.equal(ledger.getEntries().length, 3);
}

console.log("roomWalletFinancialPolicy.test.js: OK");
