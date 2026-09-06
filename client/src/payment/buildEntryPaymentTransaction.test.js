/**
 * R18-S16 — One TonConnect entry transaction builder tests.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { beginCell, Cell, contractAddress, storeStateInit } from "@ton/core";

import { buildDepositDeploymentTransaction } from "./buildDepositDeploymentTransaction.js";
import { buildFundDepositTransaction, FUND_SEAT_OPCODE } from "./buildFundDepositTransaction.js";
import {
    buildGameEscrowStakePayload,
    GAME_ESCROW_STAKE_OPCODE,
    requiredGramToNanotonString
} from "./buildTonConnectPaymentTransaction.js";
import {
    buildEntryPaymentTransaction,
    nanotonsToTonDisplay,
    sumAuthoritativeEntryNanotons
} from "./buildEntryPaymentTransaction.js";

const testCode = beginCell().storeUint(0x46554E44, 32).storeUint(0, 8).endCell();
const testData = beginCell().storeUint(1, 64).endCell();
const stateInit = { code: testCode, data: testData };
const VALID_DEPOSIT_ADDRESS = contractAddress(0, stateInit).toString({
    bounceable: true,
    urlSafe: true
});
const VALID_CODE_BOC = testCode.toBoc().toString("base64");
const VALID_DATA_BOC = testData.toBoc().toString("base64");
const DEPLOY_VALUE = "10000000";
const FUND_VALUE = "11000000";
const ESCROW_ADDRESS = "EQCescrowaddressfortestsXXXXXXXXXXXX";
const nowMs = 1_700_000_000_000;

function depositPackage() {

    return {
        stateInit: {
            codeBoc: VALID_CODE_BOC,
            dataBoc: VALID_DATA_BOC
        },
        depositAddress: VALID_DEPOSIT_ADDRESS,
        deployValueNanotons: DEPLOY_VALUE
    };

}

describe("R18-S16 buildEntryPaymentTransaction", () => {

    it("creator gets exactly one TonConnect transaction with deploy + FundSeat + STAKE", () => {

        const tx = buildEntryPaymentTransaction({
            isCreator: true,
            includeDeploy: true,
            includeFund: true,
            includeStake: true,
            depositPackage: depositPackage(),
            depositAddress: VALID_DEPOSIT_ADDRESS,
            mySeatIndex: 0,
            myExpectedAmountNanotons: FUND_VALUE,
            network: "testnet",
            gameEscrowAddress: ESCROW_ADDRESS,
            requiredGram: 0.01,
            playerIndex: 0,
            nowMs
        });

        assert.equal(tx.messages.length, 3);
        assert.ok(tx.messages[0].stateInit);
        assert.equal(tx.messages[0].amount, DEPLOY_VALUE);
        assert.equal(tx.messages[0].address, VALID_DEPOSIT_ADDRESS);
        assert.equal(tx.messages[1].amount, FUND_VALUE);
        assert.equal(tx.messages[1].address, VALID_DEPOSIT_ADDRESS);
        assert.equal(tx.messages[2].address, ESCROW_ADDRESS);
        assert.equal(tx.messages[2].amount, requiredGramToNanotonString(0.01));
        assert.equal(tx.messages[2].payload, buildGameEscrowStakePayload(0));
        assert.equal(
            tx.totalNanotons,
            sumAuthoritativeEntryNanotons({
                deployValueNanotons: DEPLOY_VALUE,
                fundSeatNanotons: FUND_VALUE,
                stakeNanotons: requiredGramToNanotonString(0.01)
            })
        );

        const fundSlice = Cell.fromBase64(tx.messages[1].payload).beginParse();
        assert.equal(fundSlice.loadUint(32), FUND_SEAT_OPCODE);
        assert.equal(fundSlice.loadUint(8), 0);

        const stakeSlice = Cell.fromBase64(tx.messages[2].payload).beginParse();
        assert.equal(stakeSlice.loadUint(32), GAME_ESCROW_STAKE_OPCODE);
        assert.equal(stakeSlice.loadUint(8), 0);

        const deployOnly = buildDepositDeploymentTransaction({
            depositPackage: depositPackage(),
            depositAddress: VALID_DEPOSIT_ADDRESS,
            isCreator: true,
            nowMs
        });
        assert.equal(deployOnly.messages.length, 1);

        const fundOnly = buildFundDepositTransaction({
            depositAddress: VALID_DEPOSIT_ADDRESS,
            mySeatIndex: 0,
            myExpectedAmountNanotons: FUND_VALUE,
            nowMs
        });
        assert.equal(fundOnly.messages.length, 1);

    });

    it("player 2 gets exactly one TonConnect transaction with FundSeat + STAKE", () => {

        const tx = buildEntryPaymentTransaction({
            isCreator: false,
            includeFund: true,
            includeStake: true,
            depositAddress: VALID_DEPOSIT_ADDRESS,
            mySeatIndex: 1,
            myExpectedAmountNanotons: FUND_VALUE,
            network: "testnet",
            gameEscrowAddress: ESCROW_ADDRESS,
            requiredGram: 0.01,
            playerIndex: 1,
            nowMs
        });

        assert.equal(tx.messages.length, 2);
        assert.equal(tx.messages[0].stateInit, undefined);
        assert.equal(tx.messages[0].amount, FUND_VALUE);
        const fundParsed = Cell.fromBase64(tx.messages[0].payload).beginParse();
        assert.equal(fundParsed.loadUint(32), FUND_SEAT_OPCODE);
        assert.equal(fundParsed.loadUint(8), 1);
        assert.equal(tx.messages[1].payload, buildGameEscrowStakePayload(1));
        assert.equal(tx.messages[1].amount, requiredGramToNanotonString(0.01));

    });

    it("player 3 gets exactly one TonConnect transaction with FundSeat + STAKE", () => {

        const tx = buildEntryPaymentTransaction({
            isCreator: false,
            includeFund: true,
            includeStake: true,
            depositAddress: VALID_DEPOSIT_ADDRESS,
            mySeatIndex: 2,
            myExpectedAmountNanotons: FUND_VALUE,
            gameEscrowAddress: ESCROW_ADDRESS,
            requiredGram: 0.01,
            playerIndex: 2,
            nowMs
        });

        assert.equal(tx.messages.length, 2);
        const fundParsed = Cell.fromBase64(tx.messages[0].payload).beginParse();
        assert.equal(fundParsed.loadUint(32), FUND_SEAT_OPCODE);
        assert.equal(fundParsed.loadUint(8), 2);
        assert.equal(tx.messages[1].payload, buildGameEscrowStakePayload(2));

    });

    it("additional sector uses authoritative requiredGram in the same wallet payment", () => {

        const base = buildEntryPaymentTransaction({
            isCreator: false,
            includeFund: true,
            includeStake: true,
            depositAddress: VALID_DEPOSIT_ADDRESS,
            mySeatIndex: 1,
            myExpectedAmountNanotons: FUND_VALUE,
            gameEscrowAddress: ESCROW_ADDRESS,
            requiredGram: 0.01,
            playerIndex: 1,
            nowMs
        });

        const extra = buildEntryPaymentTransaction({
            isCreator: false,
            includeFund: true,
            includeStake: true,
            depositAddress: VALID_DEPOSIT_ADDRESS,
            mySeatIndex: 1,
            myExpectedAmountNanotons: "26000000",
            gameEscrowAddress: ESCROW_ADDRESS,
            requiredGram: 0.025,
            playerIndex: 1,
            nowMs
        });

        assert.equal(extra.messages.length, 1 + 1);
        assert.equal(extra.messages[0].amount, "26000000");
        assert.equal(extra.messages[1].amount, requiredGramToNanotonString(0.025));
        assert.ok(BigInt(extra.totalNanotons) > BigInt(base.totalNanotons));
        assert.equal(
            nanotonsToTonDisplay(extra.messages[1].amount),
            "0.025"
        );

    });

    it("player index cannot be omitted or fabricated for STAKE", () => {

        assert.throws(
            () => buildEntryPaymentTransaction({
                includeStake: true,
                gameEscrowAddress: ESCROW_ADDRESS,
                requiredGram: 0.01,
                nowMs
            }),
            /playerIndex/
        );

        assert.throws(
            () => buildEntryPaymentTransaction({
                includeFund: true,
                depositAddress: VALID_DEPOSIT_ADDRESS,
                mySeatIndex: 3,
                myExpectedAmountNanotons: FUND_VALUE,
                nowMs
            }),
            /mySeatIndex/
        );

    });

    it("payment amount cannot be client-invented", () => {

        assert.throws(
            () => buildEntryPaymentTransaction({
                isCreator: true,
                includeDeploy: true,
                depositPackage: {
                    stateInit: {
                        codeBoc: VALID_CODE_BOC,
                        dataBoc: VALID_DATA_BOC
                    },
                    depositAddress: VALID_DEPOSIT_ADDRESS
                },
                depositAddress: VALID_DEPOSIT_ADDRESS,
                nowMs
            }),
            /deployValueNanotons/
        );

        assert.throws(
            () => buildEntryPaymentTransaction({
                includeFund: true,
                depositAddress: VALID_DEPOSIT_ADDRESS,
                mySeatIndex: 1,
                nowMs
            }),
            /myExpectedAmountNanotons/
        );

        assert.throws(
            () => sumAuthoritativeEntryNanotons({
                deployValueNanotons: "0"
            }),
            /positive/
        );

    });

    it("strips totalNanotons before TonConnect sendTransaction and keeps 1.021 TON creator total", () => {

        const STAKE_VALUE = "1000000000";
        const builtTransaction = buildEntryPaymentTransaction({
            isCreator: true,
            includeDeploy: true,
            includeFund: true,
            includeStake: true,
            depositPackage: depositPackage(),
            depositAddress: VALID_DEPOSIT_ADDRESS,
            mySeatIndex: 0,
            myExpectedAmountNanotons: FUND_VALUE,
            network: "testnet",
            gameEscrowAddress: ESCROW_ADDRESS,
            requiredGram: 1,
            playerIndex: 0,
            nowMs
        });

        const { totalNanotons, ...sentTransaction } = builtTransaction;

        assert.equal(sentTransaction.totalNanotons, undefined);
        assert.equal(sentTransaction.validUntil, builtTransaction.validUntil);
        assert.equal(sentTransaction.messages, builtTransaction.messages);
        assert.deepEqual(Object.keys(sentTransaction).sort(), ["messages", "validUntil"]);

        assert.equal(builtTransaction.messages.length, 3);
        assert.ok(builtTransaction.messages[0].stateInit);
        assert.equal(builtTransaction.messages[0].amount, DEPLOY_VALUE);
        assert.equal(builtTransaction.messages[1].amount, FUND_VALUE);
        assert.equal(builtTransaction.messages[2].amount, STAKE_VALUE);
        assert.equal(builtTransaction.messages[2].payload, buildGameEscrowStakePayload(0));

        assert.equal(totalNanotons, "1021000000");
        assert.equal(nanotonsToTonDisplay(totalNanotons), "1.021");
        assert.equal(
            nanotonsToTonDisplay(builtTransaction.totalNanotons),
            "1.021"
        );

    });

    it("wallet confirmation success is not encoded as blockchain payment complete", () => {

        const tx = buildEntryPaymentTransaction({
            includeStake: true,
            gameEscrowAddress: ESCROW_ADDRESS,
            requiredGram: 0.01,
            playerIndex: 0,
            nowMs
        });

        assert.equal("paid" in tx, false);
        assert.equal("status" in tx, false);
        assert.equal("confirmed" in tx, false);
        assert.equal(tx.messages.length, 1);

    });

    it("GameEscrow-only player payment is STAKE only at the sector total", () => {

        const lena = buildEntryPaymentTransaction({
            isCreator: true,
            includeDeploy: false,
            includeFund: false,
            includeStake: true,
            gameEscrowAddress: ESCROW_ADDRESS,
            requiredGram: 1,
            playerIndex: 0,
            nowMs
        });

        const bob = buildEntryPaymentTransaction({
            isCreator: false,
            includeDeploy: false,
            includeFund: false,
            includeStake: true,
            gameEscrowAddress: ESCROW_ADDRESS,
            requiredGram: 1,
            playerIndex: 1,
            nowMs
        });

        const olga = buildEntryPaymentTransaction({
            isCreator: false,
            includeDeploy: false,
            includeFund: false,
            includeStake: true,
            gameEscrowAddress: ESCROW_ADDRESS,
            requiredGram: 2.5,
            playerIndex: 2,
            nowMs
        });

        for (const tx of [lena, bob, olga]) {

            assert.equal(tx.messages.length, 1);
            const parsed = Cell.fromBase64(tx.messages[0].payload).beginParse();
            assert.equal(parsed.loadUint(32), GAME_ESCROW_STAKE_OPCODE);
            assert.notEqual(tx.messages[0].amount, "11000000");
            assert.notEqual(tx.messages[0].amount, "10000000");
            assert.notEqual(tx.messages[0].amount, "1000000");

        }

        assert.equal(lena.messages[0].amount, requiredGramToNanotonString(1));
        assert.equal(bob.messages[0].amount, requiredGramToNanotonString(1));
        assert.equal(olga.messages[0].amount, requiredGramToNanotonString(2.5));
        assert.equal(lena.messages[0].payload, buildGameEscrowStakePayload(0));
        assert.equal(bob.messages[0].payload, buildGameEscrowStakePayload(1));
        assert.equal(olga.messages[0].payload, buildGameEscrowStakePayload(2));

    });

});
