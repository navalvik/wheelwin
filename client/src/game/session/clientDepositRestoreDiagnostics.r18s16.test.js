/**
 * R18-S16 — Page4 Deposit restore client logging only.
 * Does not change reducer behaviour or canFundSeat.
 */

import {
    AUTHORITATIVE_SESSION_ACTIONS,
    AUTHORITATIVE_SESSION_INITIAL_STATE,
    authoritativeSessionReducer
} from "./authoritativeSessionModel.js";
import { formatClientDepositRestoreLog } from "./clientDepositRestoreDiagnostics.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

{
    const received = formatClientDepositRestoreLog("DEPOSIT_PACKAGE_RECEIVED", {
        roomId: "csU9",
        depositAddress: "EQD_TEST",
        state: "PARTIALLY_FUNDED",
        confirmedSeats: 2,
        mySeatStatus: "FUNDED",
        deployValueNanotons: "10000000"
    });

    assert(
        received.includes("[R18-S16 ClientDepositRestore] event=DEPOSIT_PACKAGE_RECEIVED"),
        "received event name"
    );
    assert(received.includes("roomId=csU9"), "roomId present");
    assert(received.includes("depositAddress=EQD_TEST"), "depositAddress present");
    assert(received.includes("state=PARTIALLY_FUNDED"), "state present");
    assert(received.includes("confirmedSeats=2"), "confirmedSeats present");
    assert(received.includes("mySeatStatus=FUNDED"), "mySeatStatus present");
    assert(received.includes("deployValueNanotons=10000000"), "deploy value only when present");

    console.log("  format DEPOSIT_PACKAGE_RECEIVED passed");
}

{
    const applied = formatClientDepositRestoreLog("DEPOSIT_STATE_APPLIED", {
        confirmedSeats: 2,
        mySeatStatus: "FUNDED",
        depositId: "dep_1"
    });

    assert(
        applied.includes("[R18-S16 ClientDepositRestore] event=DEPOSIT_STATE_APPLIED"),
        "applied event name"
    );
    assert(applied.includes("confirmedSeats=2"), "applied confirmedSeats");
    assert(applied.includes("mySeatStatus=FUNDED"), "applied mySeatStatus");
    assert(applied.includes("depositId=dep_1"), "applied depositId when present");
    assert(!applied.includes("deployValueNanotons="), "must not invent deploy value");

    console.log("  format DEPOSIT_STATE_APPLIED passed");
}

{
    const originalInfo = console.info;
    const lines = [];

    console.info = (message) => {

        lines.push(String(message ?? ""));

    };

    try {

        const started = authoritativeSessionReducer(
            AUTHORITATIVE_SESSION_INITIAL_STATE,
            {
                type: AUTHORITATIVE_SESSION_ACTIONS.GAME_START,
                payload: {
                    roomId: "csU9",
                    gameId: "game_test",
                    players: []
                }
            }
        );

        const next = authoritativeSessionReducer(started, {
            type: AUTHORITATIVE_SESSION_ACTIONS.DEPOSIT_PACKAGE_PUBLISHED,
            payload: {
                deposit: {
                    phase: "PARTIALLY_FUNDED",
                    depositId: "dep_live",
                    depositAddress: "EQD_LIVE",
                    network: "testnet",
                    package: { deployValueNanotons: "10000000" },
                    mySeatIndex: 2,
                    isCreator: false,
                    mySeatStatus: "FUNDED",
                    myExpectedAmountNanotons: 11000000,
                    confirmedSeats: 2
                }
            }
        });

        const received = lines.find((line) =>
            line.includes("event=DEPOSIT_PACKAGE_RECEIVED")
        );
        const applied = lines.find((line) =>
            line.includes("event=DEPOSIT_STATE_APPLIED")
        );

        assert(Boolean(received), "reducer must log DEPOSIT_PACKAGE_RECEIVED");
        assert(received.includes("roomId=csU9"), "received roomId");
        assert(received.includes("depositAddress=EQD_LIVE"), "received address");
        assert(received.includes("state=PARTIALLY_FUNDED"), "received state");
        assert(received.includes("confirmedSeats=2"), "received confirmedSeats");
        assert(received.includes("mySeatStatus=FUNDED"), "received mySeatStatus");
        assert(received.includes("deployValueNanotons=10000000"), "received deploy value from payload");

        assert(Boolean(applied), "reducer must log DEPOSIT_STATE_APPLIED");
        assert(applied.includes("confirmedSeats=2"), "applied confirmedSeats");
        assert(applied.includes("mySeatStatus=FUNDED"), "applied mySeatStatus");
        assert(applied.includes("depositAddress=EQD_LIVE"), "applied address");
        assert(next.deposit.confirmedSeats === 2, "state actually applied");
        assert(next.deposit.mySeatStatus === "FUNDED", "seat status actually applied");

        console.log("  reducer DEPOSIT_PACKAGE_RECEIVED / DEPOSIT_STATE_APPLIED passed");

    } finally {

        console.info = originalInfo;

    }

}

{
    const originalInfo = console.info;
    const lines = [];

    console.info = (message) => {

        lines.push(String(message ?? ""));

    };

    try {

        const next = authoritativeSessionReducer(
            AUTHORITATIVE_SESSION_INITIAL_STATE,
            {
                type: AUTHORITATIVE_SESSION_ACTIONS.DEPOSIT_PACKAGE_PUBLISHED,
                payload: { deposit: null }
            }
        );

        assert(next.deposit === null, "invalid payload still fail-closed");
        assert(lines.length === 0, "fail-closed must not log restore events");

        console.log("  fail-closed payload does not log passed");

    } finally {

        console.info = originalInfo;

    }

}

console.log("clientDepositRestoreDiagnostics.r18s16.test.js: all assertions passed");
