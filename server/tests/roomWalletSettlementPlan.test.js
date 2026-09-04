import assert from "node:assert/strict";
import {
    buildOwnerPayoutPlan,
    buildResidualSweepPlan
} from "../payment/roomWallet/RoomWalletSettlementPlan.js";

const ownerPlan = buildOwnerPayoutPlan({
    gameId: "game-1",
    roomId: "12",
    ownerWallet: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c"
});

assert.equal(ownerPlan.ok, true);
assert.equal(ownerPlan.kind, "OWNER_PAYOUT");
assert.equal(ownerPlan.amountNano, 140000000n);
assert.equal(ownerPlan.retainedNano, 10000000n);
assert.equal(ownerPlan.gasSource, "ROOM_WALLET");

const residualPlan = buildResidualSweepPlan({
    roomId: "12",
    residuesWallet: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c"
});

assert.equal(residualPlan.ok, true);
assert.equal(residualPlan.kind, "RESIDUAL_SWEEP");
assert.equal(residualPlan.amountNano, 490000000n);
assert.equal(residualPlan.triggerNano, 500000000n);
assert.equal(residualPlan.gasSource, "ROOM_WALLET");

assert.equal(buildOwnerPayoutPlan({ gameId: "", roomId: "12", ownerWallet: "x" }).ok, false);
assert.equal(buildResidualSweepPlan({ roomId: "12", residuesWallet: "" }).ok, false);

process.stdout.write("roomWalletSettlementPlan.test.js passed\n");
