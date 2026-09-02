/**
 * R18-S16 — Page4 Deposit deploy diagnostic formatter.
 * Logging only. Does not call TonConnect or invent deployValueNanotons.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    classifyDepositWalletError,
    describeTonConnectResult,
    describeTonConnectSendRequestDiagnostics,
    formatPage4DepositDeployLog
} from "./page4DepositDeployDiagnostics.js";

test("GATE logs canDeploy and package deployValueNanotons without inventing a fallback", () => {

    const line = formatPage4DepositDeployLog("GATE", {
        canDeploy: true,
        canFund: false,
        action: "deploy",
        deployValueNanotons: "10000000",
        depositAddress: "EQD_TEST"
    });

    assert.match(line, /\[R18-S16 Page4DepositDeploy\] event=GATE/);
    assert.match(line, /canDeploy=true/);
    assert.match(line, /action=deploy/);
    assert.match(line, /deployValueNanotons=10000000/);
    assert.doesNotMatch(line, /\?\?/);
    assert.doesNotMatch(line, /11000000/);

    const missing = formatPage4DepositDeployLog("GATE", {
        canDeploy: false,
        action: "blocked"
    });

    assert.match(missing, /canDeploy=false/);
    assert.doesNotMatch(missing, /deployValueNanotons=/);

});

test("BUILD logs constructed amount separately from package deployValueNanotons", () => {

    const line = formatPage4DepositDeployLog("BUILD", {
        action: "deploy",
        amount: "10000000",
        packageDeployValueNanotons: "10000000",
        hasStateInit: true
    });

    assert.match(line, /event=BUILD/);
    assert.match(line, /amount=10000000/);
    assert.match(line, /packageDeployValueNanotons=10000000/);
    assert.match(line, /hasStateInit=true/);

});

test("WALLET_RESULT distinguishes USER_CONFIRMED from rejection without inventing a tx hash", () => {

    const confirmed = formatPage4DepositDeployLog("WALLET_RESULT", {
        action: "deploy",
        outcome: "USER_CONFIRMED",
        hasBoc: true,
        bocLength: 128,
        resultType: "object"
    });

    assert.match(confirmed, /outcome=USER_CONFIRMED/);
    assert.match(confirmed, /hasBoc=true/);
    assert.doesNotMatch(confirmed, /txHash=/);
    assert.doesNotMatch(confirmed, /BROADCAST_SUCCESS/);

    const rejected = formatPage4DepositDeployLog("WALLET_RESULT", {
        action: "deploy",
        outcome: "WALLET_REJECTION",
        errorName: "UserRejectsError",
        errorCode: 300
    });

    assert.match(rejected, /outcome=WALLET_REJECTION/);
    assert.match(rejected, /errorCode=300/);

});

test("classifyDepositWalletError maps user reject vs send failure", () => {

    assert.equal(
        classifyDepositWalletError({ name: "UserRejectsError", code: 300 }),
        "WALLET_REJECTION"
    );
    assert.equal(
        classifyDepositWalletError({ message: "Request rejected by user" }),
        "WALLET_REJECTION"
    );
    assert.equal(
        classifyDepositWalletError({ message: "bridge timeout" }),
        "TONCONNECT_SEND_FAILURE"
    );

});

test("describeTonConnectSendRequestDiagnostics records keys without mutating the request", () => {

    const sentTransaction = {
        validUntil: 1_700_000_600,
        messages: [
            { address: "EQD1", amount: "10000000", stateInit: "te6c" },
            { address: "EQD1", amount: "11000000", payload: "te6c" }
        ]
    };
    const before = JSON.stringify(sentTransaction);
    const diag = describeTonConnectSendRequestDiagnostics(sentTransaction);

    assert.equal(before, JSON.stringify(sentTransaction));
    assert.deepEqual(diag.requestTopLevelKeys, ["validUntil", "messages"]);
    assert.equal(diag.hasTotalNanotons, false);
    assert.equal(diag.messageCount, 2);
    assert.deepEqual(diag.messageTopLevelKeys.sort(), [
        "address",
        "amount",
        "payload",
        "stateInit"
    ]);
    assert.equal("totalNanotons" in sentTransaction, false);

    const built = {
        validUntil: 1,
        messages: [{ address: "EQ", amount: "1" }],
        totalNanotons: "1021000000"
    };
    const { totalNanotons, ...tonConnectTransaction } = built;
    const stripped = describeTonConnectSendRequestDiagnostics(
        tonConnectTransaction
    );

    assert.equal(totalNanotons, "1021000000");
    assert.equal(stripped.hasTotalNanotons, false);
    assert.deepEqual(stripped.requestTopLevelKeys.sort(), [
        "messages",
        "validUntil"
    ]);
    assert.equal(tonConnectTransaction.totalNanotons, undefined);

    const logLine = formatPage4DepositDeployLog("SEND", {
        requestTopLevelKeys: stripped.requestTopLevelKeys.join(","),
        hasTotalNanotons: stripped.hasTotalNanotons
    });
    assert.match(logLine, /requestTopLevelKeys=messages,validUntil|requestTopLevelKeys=validUntil,messages/);
    assert.match(logLine, /hasTotalNanotons=false/);
    assert.doesNotMatch(logLine, /1021000000/);

});

test("describeTonConnectResult records boc presence without decoding a hash", () => {

    assert.deepEqual(describeTonConnectResult(null), {
        resultType: "null",
        hasBoc: false
    });

    const described = describeTonConnectResult({ boc: "te6ccgEBAQEAAgAAAA==" });

    assert.equal(described.hasBoc, true);
    assert.equal(described.resultType, "object");
    assert.equal(typeof described.bocLength, "number");
    assert.equal(Object.hasOwn(described, "txHash"), false);

});
