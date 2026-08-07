/**
 * R7.69A — GameEscrow STAKE / OPEN_PAYMENTS serializer tests.
 */
import assert from "node:assert/strict";
import { Address, toNano } from "@ton/core";

import { GAME_CONTRACT_OPCODES } from "../payment/ton/gameContract/GameContractOpcodes.js";
import {
    serializeGameEscrowOpenPaymentsBody,
    serializeGameEscrowStakeBody
} from "../payment/ton/gameContract/GameContractSerializer.js";

const P0 = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
const P1 = "EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j";
const P2 = "EQACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAsoi";

{
    const body = serializeGameEscrowStakeBody({ playerIndex: 2 });
    const slice = body.beginParse();
    assert.equal(slice.loadUint(32), GAME_CONTRACT_OPCODES.STAKE);
    assert.equal(slice.loadUint(8), 2);
    console.log("  STAKE body: OK");
}

{
    const body = serializeGameEscrowOpenPaymentsBody({
        player0: P0,
        stake0: 1,
        player1: P1,
        stake1: 1,
        player2: P2,
        stake2: 1
    });
    const slice = body.beginParse();
    assert.equal(slice.loadUint(32), GAME_CONTRACT_OPCODES.OPEN_PAYMENTS);
    assert.ok(slice.loadAddress().equals(Address.parse(P0)));
    assert.equal(slice.loadCoins(), toNano("1"));
    assert.ok(slice.loadAddress().equals(Address.parse(P1)));
    assert.equal(slice.loadCoins(), toNano("1"));
    assert.ok(slice.loadAddress().equals(Address.parse(P2)));
    assert.equal(slice.loadCoins(), toNano("1"));
    console.log("  OPEN_PAYMENTS body: OK");
}

console.log("gameEscrowStake.test.js: all assertions passed");
