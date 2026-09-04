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

assert.equal(ROOM_WALLET_POLICY.residualTriggerNano, 500_000_000n);
assert.equal(ROOM_WALLET_POLICY.residualSweepNano, 490_000_000n);
assert.equal(ROOM_WALLET_POLICY.residualRetainedFloorNano, 10_000_000n);
assert.equal(ROOM_WALLET_POLICY.residualSweepGasNano, 6_000_000n);
assert.equal(ROOM_WALLET_POLICY.residualSafetyMarginNano, 4_000_000n);
assert.equal(
    ROOM_WALLET_POLICY.residualSweepGasNano
        + ROOM_WALLET_POLICY.residualSafetyMarginNano,
    ROOM_WALLET_POLICY.residualRetainedFloorNano
);
assert.equal(
    ROOM_WALLET_POLICY.ownerRetainedNano,
    ROOM_WALLET_POLICY.residualRetainedFloorNano
);
assert.notEqual(
    ROOM_WALLET_POLICY.initialRoomReserveNano,
    ROOM_WALLET_POLICY.residualSweepGasNano
);

// 0.49 Gram is below the 0.50 Gram trigger.
{
    const result = buildResidualSweep({ balanceNano: 490_000_000n });
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "BELOW_RESIDUAL_TRIGGER");
    assert.equal(result.transferNano, 0n);
    assert.equal(result.recipientCreditNano, 0n);
}

// 0.499999999 Gram is still below the trigger.
{
    const result = buildResidualSweep({ balanceNano: 499_999_999n });
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "BELOW_RESIDUAL_TRIGGER");
    assert.equal(result.transferNano, 0n);
}

// Exactly 0.50 Gram is eligible: destination 0.49, source retains 0.01 envelope.
{
    const result = buildResidualSweep({ balanceNano: 500_000_000n });

    assert.equal(result.eligible, true);
    assert.equal(result.reason, "ELIGIBLE");
    assert.equal(result.transferNano, 490_000_000n);
    assert.equal(result.recipientCreditNano, 490_000_000n);
    assert.equal(result.remainingAfterTransferNano, 10_000_000n);
    assert.equal(result.sweepGasNano, 6_000_000n);
    assert.equal(result.safetyMarginNano, 4_000_000n);
    assert.equal(result.sourceFeeBudgetNano, 6_000_000n);
    assert.equal(result.remainingAfterFeeBudgetNano, 4_000_000n);
    assert.equal(
        result.remainingAfterTransferNano,
        result.sweepGasNano + result.safetyMarginNano
    );
}

// Above 0.50 Gram is eligible but still sends exactly 0.49 Gram.
{
    const result = buildResidualSweep({ balanceNano: 800_000_000n });

    assert.equal(result.eligible, true);
    assert.equal(result.transferNano, 490_000_000n);
    assert.equal(result.recipientCreditNano, 490_000_000n);
    assert.equal(result.remainingAfterTransferNano, 310_000_000n);
}

// Passing a leftover gasNano field must not add an extra debit on the 0.01 floor.
{
    const result = buildResidualSweep({
        balanceNano: 500_000_000n,
        gasNano: 6_000_000n
    });

    assert.equal(result.eligible, true);
    assert.equal(result.transferNano, 490_000_000n);
    assert.equal(result.remainingAfterTransferNano, 10_000_000n);
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
    assert.equal(
        ledger.getEntries().some((entry) => entry.type === ROOM_LEDGER_ENTRY_TYPES.RESIDUAL_SWEEP),
        false
    );
}

console.log("roomWalletFinancialPolicy.test.js: OK");
