/**
 * R18-S16 — Page4 Deposit activation handoff (package → deploy request).
 *
 * Proves DEPOSIT_PACKAGE_PUBLISHED is accepted into AuthoritativeSession,
 * then either:
 *   - fail-closed when production projection omits deployValueNanotons, or
 *   - buildDepositDeploymentTransaction uses package depositAddress / stateInit / amount.
 *
 * Does not call TonConnect, wallets, or the server.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    beginCell,
    Cell,
    contractAddress,
    loadStateInit
} from "@ton/core";

import {
    AUTHORITATIVE_SESSION_ACTIONS,
    AUTHORITATIVE_SESSION_INITIAL_STATE,
    authoritativeSessionReducer
} from "../game/session/authoritativeSessionModel.js";
import {
    canDeployDeposit,
    PAGE4_PAYMENT_PHASE,
    resolvePage4PaymentPhase,
    shouldShowDepositAction
} from "../game/session/page4PaymentPhase.js";
import { buildDepositDeploymentTransaction } from "./buildDepositDeploymentTransaction.js";

const testCode = beginCell().storeUint(0x46554E44, 32).storeUint(0, 8).endCell();
const testData = beginCell().storeUint(1, 64).endCell();
const stateInit = { code: testCode, data: testData };
const derivedAddress = contractAddress(0, stateInit);
const DEPOSIT_ADDRESS = derivedAddress.toString({
    bounceable: true,
    urlSafe: true
});
const CODE_BOC = testCode.toBoc().toString("base64");
const DATA_BOC = testData.toBoc().toString("base64");
const DEPLOY_VALUE_NANOTONS = "50000000";

function publishDeposit(packageOverrides = {}) {

    return authoritativeSessionReducer(
        AUTHORITATIVE_SESSION_INITIAL_STATE,
        {
            type: AUTHORITATIVE_SESSION_ACTIONS.DEPOSIT_PACKAGE_PUBLISHED,
            payload: {
                deposit: {
                    phase: "AWAITING_FUNDS",
                    depositId: "dep_bab7b321-249d-45ed-83e3-1fed75084d44",
                    depositAddress: DEPOSIT_ADDRESS,
                    network: "testnet",
                    package: {
                        stateInit: {
                            codeBoc: CODE_BOC,
                            dataBoc: DATA_BOC
                        },
                        deployValueNanotons: null,
                        ...packageOverrides
                    },
                    mySeatIndex: 0,
                    isCreator: true,
                    mySeatStatus: "PENDING",
                    myExpectedAmountNanotons: 11000000,
                    confirmedSeats: 0,
                    activationStatus: "WAITING_FOR_PLAYER_DEPLOYMENT"
                }
            }
        }
    );

}

describe("R18-S16 Page4 deposit activation wallet handoff", () => {

    it("accepts DEPOSIT_PACKAGE_PUBLISHED into AuthoritativeSession", () => {

        const state = publishDeposit();

        assert.equal(state.deposit?.depositId, "dep_bab7b321-249d-45ed-83e3-1fed75084d44");
        assert.equal(state.deposit?.depositAddress, DEPOSIT_ADDRESS);
        assert.equal(state.deposit?.isCreator, true);
        assert.equal(state.deposit?.package?.stateInit?.codeBoc, CODE_BOC);
        assert.equal(state.deposit?.package?.stateInit?.dataBoc, DATA_BOC);
        assert.equal(state.deposit?.package?.deployValueNanotons, null);
        assert.equal(state.deposit?.myExpectedAmountNanotons, 11000000);

    });

    it("tSPj-shaped package (no deployValueNanotons) does not start wallet activation", () => {

        const state = publishDeposit();

        assert.equal(canDeployDeposit(state.deposit), false);

        const phase = resolvePage4PaymentPhase({
            deposit: state.deposit,
            paymentConnectionReady: true
        });

        assert.equal(phase, PAGE4_PAYMENT_PHASE.DEPOSIT_ACTIVATION);
        assert.equal(shouldShowDepositAction(phase), false);

        assert.throws(
            () => buildDepositDeploymentTransaction({
                depositPackage: {
                    stateInit: state.deposit.package.stateInit,
                    deployValueNanotons: state.deposit.package.deployValueNanotons,
                    depositAddress: state.deposit.depositAddress
                },
                depositAddress: state.deposit.depositAddress,
                isCreator: true,
                network: state.deposit.network
            }),
            /deployValueNanotons is required/i
        );

    });

    it("generates activation request from authoritative package fields only", () => {

        const state = publishDeposit({ deployValueNanotons: DEPLOY_VALUE_NANOTONS });

        assert.equal(canDeployDeposit(state.deposit), true);
        assert.equal(
            resolvePage4PaymentPhase({ deposit: state.deposit }),
            PAGE4_PAYMENT_PHASE.DEPOSIT_DEPLOY
        );

        const tx = buildDepositDeploymentTransaction({
            depositPackage: {
                stateInit: {
                    codeBoc: state.deposit.package.stateInit.codeBoc,
                    dataBoc: state.deposit.package.stateInit.dataBoc
                },
                deployValueNanotons: state.deposit.package.deployValueNanotons,
                depositAddress: state.deposit.depositAddress
            },
            depositAddress: state.deposit.depositAddress,
            isCreator: true,
            network: state.deposit.network,
            nowMs: 1_700_000_000_000
        });

        const msg = tx.messages[0];

        assert.equal(msg.address, DEPOSIT_ADDRESS);
        assert.equal(msg.amount, DEPLOY_VALUE_NANOTONS);
        assert.equal(typeof msg.stateInit, "string");

        const loaded = loadStateInit(
            Cell.fromBoc(Buffer.from(msg.stateInit, "base64"))[0].beginParse()
        );

        assert.equal(loaded.code.toBoc().toString("base64"), CODE_BOC);
        assert.equal(loaded.data.toBoc().toString("base64"), DATA_BOC);
        assert.notEqual(
            msg.amount,
            String(state.deposit.myExpectedAmountNanotons),
            "deploy amount must not be reconstructed from FundSeat expectedAmount"
        );

    });

});
