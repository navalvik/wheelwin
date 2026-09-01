/**
 * R18-S16 — GAME_START must drop the previous game's Deposit projection.
 *
 * Mirrors the dvgw forensic: Game A (sZqc) VERIFIED deposit survived into
 * Game B and Page4 FundSeat targeted the stale DepositContract.
 *
 * No TonConnect, no blockchain, no server.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    AUTHORITATIVE_SESSION_ACTIONS,
    AUTHORITATIVE_SESSION_INITIAL_STATE,
    authoritativeSessionReducer
} from "./authoritativeSessionModel.js";
import {
    canFundSeat,
    isDepositActivationVerified
} from "./page4PaymentPhase.js";

const OLD_DEPOSIT_ADDRESS = "EQA80SoX-wCnr3r0UjCcORE9qKCv2cX0ExaTEKzyqZJAcSDI";
const NEW_DEPOSIT_ADDRESS = "EQBdvgwCurrentDepositAddressNotTheOldOne_____";
const DEPLOY_VALUE_NANOTONS = "10000000";
const FUNDSEAT_AMOUNT_NANOTONS = 11000000;

function seedGameAVerified() {

    let state = authoritativeSessionReducer(
        AUTHORITATIVE_SESSION_INITIAL_STATE,
        {
            type: AUTHORITATIVE_SESSION_ACTIONS.GAME_START,
            payload: {
                roomId: "sZqc",
                gameId: "game_32676636-56fe-4ed5-acfe-c77958522716",
                players: [
                    { playerId: "olga" },
                    { playerId: "lena" },
                    { playerId: "bob" }
                ]
            }
        }
    );

    state = authoritativeSessionReducer(state, {
        type: AUTHORITATIVE_SESSION_ACTIONS.PAYMENT_SESSION_UPDATED,
        payload: {
            paymentSessionId: "pay_old",
            roomId: "sZqc",
            gameId: "game_32676636-56fe-4ed5-acfe-c77958522716",
            status: "WAITING_FOR_PAYMENTS",
            participants: []
        }
    });

    state = authoritativeSessionReducer(state, {
        type: AUTHORITATIVE_SESSION_ACTIONS.GAME_CONTRACT_UPDATED,
        payload: {
            contractId: "escrow_old",
            gameId: "game_32676636-56fe-4ed5-acfe-c77958522716",
            roomId: "sZqc",
            status: "AWAITING_PAYMENTS"
        }
    });

    state = authoritativeSessionReducer(state, {
        type: AUTHORITATIVE_SESSION_ACTIONS.DEPOSIT_PACKAGE_PUBLISHED,
        payload: {
            deposit: {
                phase: "AWAITING_FUNDS",
                depositId: "dep_7fc340f9-4bcd-4c29-9a22-c54458062915",
                depositAddress: OLD_DEPOSIT_ADDRESS,
                network: "testnet",
                package: {
                    stateInit: { codeBoc: "old-code", dataBoc: "old-data" },
                    deployValueNanotons: DEPLOY_VALUE_NANOTONS
                },
                mySeatIndex: 2,
                isCreator: false,
                mySeatStatus: "PENDING",
                myExpectedAmountNanotons: FUNDSEAT_AMOUNT_NANOTONS,
                confirmedSeats: 2,
                activationStatus: "VERIFIED"
            }
        }
    });

    return state;

}

test("R18-S16: Game A verified Deposit is present before GAME_START for Game B", () => {

    const gameA = seedGameAVerified();

    assert.equal(gameA.roomId, "sZqc");
    assert.equal(gameA.deposit?.depositAddress, OLD_DEPOSIT_ADDRESS);
    assert.equal(gameA.lifecycle.depositActivationVerified, true);
    assert.equal(gameA.paymentSession?.paymentSessionId, "pay_old");
    assert.equal(gameA.gameContract?.contractId, "escrow_old");
    assert.equal(canFundSeat(gameA.deposit, gameA.lifecycle), true);

});

test("R18-S16: GAME_START Game B clears deposit, verified flag, paymentSession, gameContract", () => {

    const gameB = authoritativeSessionReducer(seedGameAVerified(), {
        type: AUTHORITATIVE_SESSION_ACTIONS.GAME_START,
        payload: {
            roomId: "dvgw",
            gameId: "game_ad21aa84-1645-423e-9035-9e1622c03fac",
            players: [
                { playerId: "olga" },
                { playerId: "lena" },
                { playerId: "bob" }
            ]
        }
    });

    assert.equal(gameB.roomId, "dvgw");
    assert.equal(gameB.gameId, "game_ad21aa84-1645-423e-9035-9e1622c03fac");
    assert.equal(gameB.deposit, null);
    assert.equal(gameB.lifecycle.depositActivationVerified, false);
    assert.equal(gameB.paymentSession, null);
    assert.equal(gameB.gameContract, null);
    assert.equal(isDepositActivationVerified(gameB.deposit, gameB.lifecycle), false);
    assert.equal(canFundSeat(gameB.deposit, gameB.lifecycle), false);
    assert.equal(canFundSeat(null, gameB.lifecycle), false);

});

test("R18-S16: Game A → Game B cannot FundSeat the stale DepositContract", () => {

    const afterStart = authoritativeSessionReducer(seedGameAVerified(), {
        type: AUTHORITATIVE_SESSION_ACTIONS.GAME_START,
        payload: {
            roomId: "dvgw",
            gameId: "game_ad21aa84-1645-423e-9035-9e1622c03fac",
            players: [{ playerId: "olga" }, { playerId: "lena" }, { playerId: "bob" }]
        }
    });

    assert.notEqual(afterStart.deposit?.depositAddress, OLD_DEPOSIT_ADDRESS);
    assert.equal(afterStart.deposit, null);
    assert.equal(canFundSeat(afterStart.deposit, afterStart.lifecycle), false);

});

test("R18-S16: new DEPOSIT_PACKAGE_PUBLISHED becomes authoritative after GAME_START", () => {

    let state = authoritativeSessionReducer(seedGameAVerified(), {
        type: AUTHORITATIVE_SESSION_ACTIONS.GAME_START,
        payload: {
            roomId: "dvgw",
            gameId: "game_ad21aa84-1645-423e-9035-9e1622c03fac",
            players: [{ playerId: "olga" }, { playerId: "lena" }, { playerId: "bob" }]
        }
    });

    assert.equal(canFundSeat(state.deposit, state.lifecycle), false);

    state = authoritativeSessionReducer(state, {
        type: AUTHORITATIVE_SESSION_ACTIONS.DEPOSIT_PACKAGE_PUBLISHED,
        payload: {
            deposit: {
                phase: "AWAITING_FUNDS",
                depositId: "dep_dvgw_new",
                depositAddress: NEW_DEPOSIT_ADDRESS,
                network: "testnet",
                package: {
                    stateInit: { codeBoc: "new-code", dataBoc: "new-data" },
                    deployValueNanotons: DEPLOY_VALUE_NANOTONS
                },
                mySeatIndex: 2,
                isCreator: false,
                mySeatStatus: "PENDING",
                myExpectedAmountNanotons: FUNDSEAT_AMOUNT_NANOTONS,
                confirmedSeats: 0,
                activationStatus: "WAITING_FOR_PLAYER_DEPLOYMENT"
            }
        }
    });

    assert.equal(state.deposit?.depositId, "dep_dvgw_new");
    assert.equal(state.deposit?.depositAddress, NEW_DEPOSIT_ADDRESS);
    assert.notEqual(state.deposit?.depositAddress, OLD_DEPOSIT_ADDRESS);
    assert.equal(state.deposit?.package?.deployValueNanotons, "10000000");
    assert.equal(state.lifecycle.depositActivationVerified, false);
    assert.equal(canFundSeat(state.deposit, state.lifecycle), false);

    state = authoritativeSessionReducer(state, {
        type: AUTHORITATIVE_SESSION_ACTIONS.DEPOSIT_ACTIVATION_VERIFIED,
        payload: {
            status: "VERIFIED",
            depositId: "dep_dvgw_new",
            roomId: "dvgw"
        }
    });

    assert.equal(state.lifecycle.depositActivationVerified, true);
    assert.equal(state.deposit?.depositAddress, NEW_DEPOSIT_ADDRESS);
    assert.notEqual(state.deposit?.depositAddress, OLD_DEPOSIT_ADDRESS);
    assert.equal(canFundSeat(state.deposit, state.lifecycle), true);

});

test("R18-S16: GAME_START still clears deposit; live 2/3 rehydrate disables FundSeat", () => {

    let state = seedGameAVerified();

    assert.equal(state.deposit?.depositAddress, OLD_DEPOSIT_ADDRESS);

    state = authoritativeSessionReducer(state, {
        type: AUTHORITATIVE_SESSION_ACTIONS.GAME_START,
        payload: {
            roomId: "Keah",
            gameId: "game_3f076a0f-76b2-402e-b402-fcc062b8d421",
            players: [
                { playerId: "olga" },
                { playerId: "bob" },
                { playerId: "lena" }
            ]
        }
    });

    assert.equal(state.deposit, null);
    assert.equal(state.lifecycle.depositActivationVerified, false);
    assert.equal(canFundSeat(state.deposit, state.lifecycle), false);

    state = authoritativeSessionReducer(state, {
        type: AUTHORITATIVE_SESSION_ACTIONS.DEPOSIT_PACKAGE_PUBLISHED,
        payload: {
            deposit: {
                phase: "AWAITING_FUNDS",
                depositId: "dep_keah_initial",
                depositAddress: NEW_DEPOSIT_ADDRESS,
                network: "testnet",
                mySeatIndex: 2,
                isCreator: false,
                mySeatStatus: "PENDING",
                myExpectedAmountNanotons: FUNDSEAT_AMOUNT_NANOTONS,
                confirmedSeats: 0,
                activationStatus: "VERIFIED"
            }
        }
    });

    assert.equal(canFundSeat(state.deposit, state.lifecycle), true);
    assert.equal(state.deposit.confirmedSeats, 0);

    state = authoritativeSessionReducer(state, {
        type: AUTHORITATIVE_SESSION_ACTIONS.DEPOSIT_PACKAGE_PUBLISHED,
        payload: {
            deposit: {
                phase: "PARTIALLY_FUNDED",
                depositId: "dep_keah_initial",
                depositAddress: NEW_DEPOSIT_ADDRESS,
                network: "testnet",
                mySeatIndex: 2,
                isCreator: false,
                mySeatStatus: "FUNDED",
                myExpectedAmountNanotons: FUNDSEAT_AMOUNT_NANOTONS,
                confirmedSeats: 2,
                activationStatus: "VERIFIED"
            }
        }
    });

    assert.equal(state.deposit.confirmedSeats, 2);
    assert.equal(state.deposit.mySeatStatus, "FUNDED");
    assert.equal(state.deposit.depositAddress, NEW_DEPOSIT_ADDRESS);
    assert.notEqual(state.deposit.depositAddress, OLD_DEPOSIT_ADDRESS);
    assert.equal(canFundSeat(state.deposit, state.lifecycle), false);

});

