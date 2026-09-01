import assert from "node:assert/strict";
import { test } from "node:test";

import { formatDepositChainLog } from "../diagnostics/depositChainDiagnostics.js";

test("CHAIN_OBSERVED includes accountState and optional lt/hash without inventing them", () => {

    const uninit = formatDepositChainLog({
        event: "CHAIN_OBSERVED",
        roomId: "ROOM1",
        depositId: "dep_1",
        depositAddress: "EQD_TEST",
        accountState: "uninit",
        lastLt: null,
        lastHash: null,
        activationStatus: "WAITING_FOR_PLAYER_DEPLOYMENT"
    });

    assert.match(uninit, /\[R18-S16 DepositChain\] event=CHAIN_OBSERVED/);
    assert.match(uninit, /accountState=uninit/);
    assert.match(uninit, /activationStatus=WAITING_FOR_PLAYER_DEPLOYMENT/);
    assert.doesNotMatch(uninit, /txHash=/);

    const omitted = formatDepositChainLog({
        event: "CHAIN_OBSERVED",
        roomId: "ROOM1",
        depositId: "dep_1",
        depositAddress: "EQD_TEST",
        accountState: "active"
    });

    assert.match(omitted, /accountState=active/);
    assert.doesNotMatch(omitted, /lastLt=/);
    assert.doesNotMatch(omitted, /lastHash=/);

});

test("DEPOSIT_ACTIVE is a separate event from CHAIN_OBSERVED", () => {

    const line = formatDepositChainLog({
        event: "DEPOSIT_ACTIVE",
        roomId: "ROOM1",
        depositId: "dep_1",
        depositAddress: "EQD_TEST",
        accountState: "active",
        activationStatus: "VERIFIED"
    });

    assert.match(line, /event=DEPOSIT_ACTIVE/);
    assert.match(line, /activationStatus=VERIFIED/);
    assert.doesNotMatch(line, /BROADCAST_SUCCESS/);

});
