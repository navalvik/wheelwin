import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    buildEntryPaymentTransaction,
    nanotonsToTonDisplay,
    sumAuthoritativeEntryNanotons,
    toTonConnectSendTransactionRequest
} from "./buildEntryPaymentTransaction.js";

const ROOM_WALLET = "EQDroomWalletPayToXXXXXXXXXXXXXXXXXX";
const LEGACY_CONTRACT = "EQBlegacyContractMustNeverReceivePlayerPayment";
const nowMs = 1_700_000_000_000;

describe("buildEntryPaymentTransaction — Room Wallet only", () => {
    it("creates exactly one plain TON transfer to the Room Wallet", () => {
        const tx = buildEntryPaymentTransaction({
            isCreator: true,
            includeDeploy: true,
            includeFund: true,
            includeStake: true,
            depositAddress: "EQDlegacyDeposit",
            gameEscrowAddress: LEGACY_CONTRACT,
            paymentDestination: ROOM_WALLET,
            roomWalletAddress: ROOM_WALLET,
            requiredGram: 1,
            playerIndex: 2,
            nowMs
        });

        assert.equal(tx.messages.length, 1);
        assert.equal(tx.messages[0].address, ROOM_WALLET);
        assert.equal(tx.messages[0].amount, "1000000000");
        assert.equal(tx.messages[0].payload, undefined);
        assert.equal(tx.messages[0].stateInit, undefined);
        assert.equal(tx.totalNanotons, "1000000000");
    });

    it("never uses GameEscrow or DepositContract addresses", () => {
        const tx = buildEntryPaymentTransaction({
            includeDeploy: true,
            includeFund: true,
            includeStake: true,
            depositAddress: "EQDlegacyDeposit",
            gameEscrowAddress: LEGACY_CONTRACT,
            paymentDestination: ROOM_WALLET,
            requiredGram: 2.5,
            playerIndex: 0,
            nowMs
        });

        assert.equal(tx.messages.length, 1);
        assert.equal(tx.messages[0].address, ROOM_WALLET);
        assert.notEqual(tx.messages[0].address, LEGACY_CONTRACT);
        assert.notEqual(tx.messages[0].address, "EQDlegacyDeposit");
    });

    it("fails closed when the Room Wallet destination is missing", () => {
        assert.throws(
            () => buildEntryPaymentTransaction({
                includeStake: true,
                gameEscrowAddress: LEGACY_CONTRACT,
                requiredGram: 1,
                playerIndex: 0,
                nowMs
            }),
            /Room Wallet address is required/
        );
    });

    it("ignores legacy deploy/fund inputs instead of constructing contract messages", () => {
        const tx = buildEntryPaymentTransaction({
            includeDeploy: true,
            includeFund: true,
            includeStake: true,
            depositPackage: {
                stateInit: { codeBoc: "legacy", dataBoc: "legacy" },
                deployValueNanotons: "10000000"
            },
            depositAddress: "EQDlegacyDeposit",
            mySeatIndex: 0,
            myExpectedAmountNanotons: "11000000",
            paymentDestination: ROOM_WALLET,
            requiredGram: 0.01,
            playerIndex: 0,
            nowMs
        });

        assert.equal(tx.messages.length, 1);
        assert.equal(tx.messages[0].address, ROOM_WALLET);
        assert.equal(tx.messages[0].amount, "10000000");
        assert.equal(tx.messages[0].stateInit, undefined);
        assert.equal(tx.messages[0].payload, undefined);
    });

    it("TonConnect payload contains only SDK transaction fields", () => {
        const tx = buildEntryPaymentTransaction({
            includeStake: true,
            roomWalletAddress: ROOM_WALLET,
            requiredGram: 1,
            nowMs
        });

        const sent = toTonConnectSendTransactionRequest(tx);

        assert.deepEqual(Object.keys(sent).sort(), ["messages", "validUntil"]);
        assert.deepEqual(
            Object.keys(sent.messages[0]).sort(),
            ["address", "amount"]
        );
    });

    it("keeps authoritative amount helpers independent of payment routing", () => {
        assert.equal(nanotonsToTonDisplay("1000000000"), "1");
        assert.equal(
            sumAuthoritativeEntryNanotons({
                stakeNanotons: "1000000000"
            }),
            "1000000000"
        );
    });
});
