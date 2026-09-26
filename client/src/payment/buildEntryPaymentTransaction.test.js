import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    buildEntryPaymentTransaction,
    nanotonsToTonDisplay,
    sumAuthoritativeEntryNanotons
} from "./buildEntryPaymentTransaction.js";

const nowMs = 1_700_000_000_000;
const destination = "EQDROOMWALLET";

describe("Room Wallet entry payment transaction", () => {

    it("builds exactly one direct TON transfer from the authoritative Room Wallet destination", () => {

        const tx = buildEntryPaymentTransaction({
            includeStake: true,
            paymentDestination: destination,
            requiredGram: 1,
            playerIndex: 0,
            nowMs
        });

        assert.equal(tx.messages.length, 1);
        assert.equal(tx.messages[0].address, destination);
        assert.equal(tx.messages[0].amount, "1000000000");
        assert.equal("stateInit" in tx.messages[0], false);
        assert.equal("payload" in tx.messages[0], false);
        assert.equal(tx.totalNanotons, "1000000000");
        assert.equal(
            nanotonsToTonDisplay(tx.totalNanotons),
            "1"
        );

    });

    it("rejects retired deploy and fund components", () => {

        assert.throws(
            () => buildEntryPaymentTransaction({
                includeDeploy: true,
                includeStake: true,
                paymentDestination: destination,
                requiredGram: 1
            }),
            /stake component only/
        );

        assert.throws(
            () => buildEntryPaymentTransaction({
                includeFund: true,
                includeStake: true,
                paymentDestination: destination,
                requiredGram: 1
            }),
            /stake component only/
        );

    });

    it("requires the Room Wallet destination", () => {

        assert.throws(
            () => buildEntryPaymentTransaction({
                includeStake: true,
                requiredGram: 1
            }),
            /payment destination/
        );

    });

    it("sums positive authoritative nanotons", () => {

        assert.equal(
            sumAuthoritativeEntryNanotons({
                stakeNanotons: "1000000000"
            }),
            "1000000000"
        );

        assert.throws(
            () => sumAuthoritativeEntryNanotons({
                stakeNanotons: "0"
            }),
            /positive/
        );

    });

});
