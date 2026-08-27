/**
 * R18-S5 — Production DepositContract FundSeat transaction builder unit checks.
 *
 * Following the repository's runnable-node test convention (no framework).
 * The builder constructs a TonConnect request ONLY and must never call
 * wallet/network APIs, never derive local financial values, and fail closed.
 */

import assert from "node:assert/strict";
import { Address, Cell } from "@ton/core";

import {
    FUND_SEAT_OPCODE,
    buildFundDepositTransaction,
    buildFundSeatPayload,
    expectedAmountNanotonsToString
} from "./buildFundDepositTransaction.js";

function decodeFundSeatPayload(payloadBase64) {

    const slice = Cell.fromBase64(payloadBase64).beginParse();

    const opcode = slice.loadUint(32);

    const seatIndex = slice.loadUint(8);

    return { opcode, seatIndex };

}

// A structurally valid TON friendly address generated via the official parser.
const DEPOSIT_ADDRESS = Address.parseRaw(`0:${"11".repeat(32)}`).toString({
    bounceable: true,
    urlSafe: true
});
const SEAT = 1;
const AMOUNT_NANOTONS = 123450000000;

// ---------------------------------------------------------------------------
// Valid transaction: exact destination, exact amount, valid payload with the
// authoritative FundSeat opcode + seat index.
// ---------------------------------------------------------------------------

{
    const tx = buildFundDepositTransaction({
        depositAddress: DEPOSIT_ADDRESS,
        mySeatIndex: SEAT,
        myExpectedAmountNanotons: AMOUNT_NANOTONS,
        nowMs: 1_700_000_000_000
    });

    assert.equal(tx.messages.length, 1, "single message expected");

    assert.equal(
        tx.messages[0].address,
        DEPOSIT_ADDRESS,
        "destination must equal depositAddress exactly"
    );

    assert.equal(
        tx.messages[0].amount,
        String(AMOUNT_NANOTONS),
        "amount must equal myExpectedAmountNanotons exactly"
    );

    assert.equal(typeof tx.messages[0].payload, "string");
    assert.ok(tx.messages[0].payload.length > 0, "payload BOC must be present");

    const decoded = decodeFundSeatPayload(tx.messages[0].payload);

    assert.equal(decoded.opcode, FUND_SEAT_OPCODE, "payload must carry FundSeat opcode 0x46554E44");
    assert.equal(decoded.seatIndex, SEAT, "payload must carry the authoritative seat index");

    console.log("  valid transaction (address/amount/opcode/seat) passed");
}

// ---------------------------------------------------------------------------
// Amount authority: the amount equals the authoritative value exactly — no
// fee / stake / sector calculation is added by the client.
// ---------------------------------------------------------------------------

{
    const authoritativeAmount = 98765000000;

    const tx = buildFundDepositTransaction({
        depositAddress: DEPOSIT_ADDRESS,
        mySeatIndex: 2,
        myExpectedAmountNanotons: authoritativeAmount
    });

    assert.equal(tx.messages[0].amount, "98765000000");

    // BigInt and string forms must resolve to the same exact amount.
    assert.equal(
        expectedAmountNanotonsToString(98765000000n),
        "98765000000"
    );

    assert.equal(
        expectedAmountNanotonsToString("98765000000"),
        "98765000000"
    );

    console.log("  amount authority (exact, no local calculation) passed");
}

// ---------------------------------------------------------------------------
// Seat authority: given mySeatIndex N the payload contains N (for N in 0..2).
// ---------------------------------------------------------------------------

{
    for (const seat of [0, 1, 2]) {

        const tx = buildFundDepositTransaction({
            depositAddress: DEPOSIT_ADDRESS,
            mySeatIndex: seat,
            myExpectedAmountNanotons: 5000000000
        });

        const decoded = decodeFundSeatPayload(tx.messages[0].payload);

        assert.equal(decoded.opcode, FUND_SEAT_OPCODE);
        assert.equal(decoded.seatIndex, seat);

    }

    console.log("  seat authority (0/1/2) passed");
}

// ---------------------------------------------------------------------------
// Missing / invalid address fails closed.
// ---------------------------------------------------------------------------

{
    assert.throws(
        () => buildFundDepositTransaction({
            mySeatIndex: 0,
            myExpectedAmountNanotons: 1000000000
        }),
        /depositAddress/
    );

    assert.throws(
        () => buildFundDepositTransaction({
            depositAddress: "",
            mySeatIndex: 0,
            myExpectedAmountNanotons: 1000000000
        }),
        /depositAddress/
    );

    assert.throws(
        () => buildFundDepositTransaction({
            depositAddress: "not-a-ton-address",
            mySeatIndex: 0,
            myExpectedAmountNanotons: 1000000000
        }),
        /valid TON address/
    );

    console.log("  missing/invalid depositAddress fail-closed passed");
}

// ---------------------------------------------------------------------------
// Missing / invalid seat fails closed.
// ---------------------------------------------------------------------------

{
    assert.throws(
        () => buildFundDepositTransaction({
            depositAddress: DEPOSIT_ADDRESS,
            myExpectedAmountNanotons: 1000000000
        }),
        /mySeatIndex/
    );

    assert.throws(
        () => buildFundDepositTransaction({
            depositAddress: DEPOSIT_ADDRESS,
            mySeatIndex: "",
            myExpectedAmountNanotons: 1000000000
        }),
        /mySeatIndex/
    );

    assert.throws(
        () => buildFundDepositTransaction({
            depositAddress: DEPOSIT_ADDRESS,
            mySeatIndex: 1.5,
            myExpectedAmountNanotons: 1000000000
        }),
        /mySeatIndex/
    );

    assert.throws(
        () => buildFundDepositTransaction({
            depositAddress: DEPOSIT_ADDRESS,
            mySeatIndex: 3,
            myExpectedAmountNanotons: 1000000000
        }),
        /mySeatIndex/
    );

    assert.throws(
        () => buildFundDepositTransaction({
            depositAddress: DEPOSIT_ADDRESS,
            mySeatIndex: -1,
            myExpectedAmountNanotons: 1000000000
        }),
        /mySeatIndex/
    );

    console.log("  missing/invalid seat fail-closed passed");
}

// ---------------------------------------------------------------------------
// Missing / invalid amount fails closed.
// ---------------------------------------------------------------------------

{
    assert.throws(
        () => buildFundDepositTransaction({
            depositAddress: DEPOSIT_ADDRESS,
            mySeatIndex: 0
        }),
        /myExpectedAmountNanotons/
    );

    assert.throws(
        () => buildFundDepositTransaction({
            depositAddress: DEPOSIT_ADDRESS,
            mySeatIndex: 0,
            myExpectedAmountNanotons: 0
        }),
        /positive/
    );

    assert.throws(
        () => buildFundDepositTransaction({
            depositAddress: DEPOSIT_ADDRESS,
            mySeatIndex: 0,
            myExpectedAmountNanotons: -5
        }),
        /positive/
    );

    assert.throws(
        () => buildFundDepositTransaction({
            depositAddress: DEPOSIT_ADDRESS,
            mySeatIndex: 0,
            myExpectedAmountNanotons: 1.5
        }),
        /positive integer/
    );

    assert.throws(
        () => buildFundDepositTransaction({
            depositAddress: DEPOSIT_ADDRESS,
            mySeatIndex: 0,
            myExpectedAmountNanotons: "not-a-number"
        }),
        /positive integer/
    );

    console.log("  missing/invalid amount fail-closed passed");
}

// ---------------------------------------------------------------------------
// Malformed input (unsupported network) fails closed; valid network tags pass.
// ---------------------------------------------------------------------------

{
    assert.throws(
        () => buildFundDepositTransaction({
            depositAddress: DEPOSIT_ADDRESS,
            mySeatIndex: 0,
            myExpectedAmountNanotons: 1000000000,
            network: "arbitrum"
        }),
        /network/
    );

    {
        const tx = buildFundDepositTransaction({
            depositAddress: DEPOSIT_ADDRESS,
            mySeatIndex: 0,
            myExpectedAmountNanotons: 1000000000,
            network: "testnet"
        });

        assert.equal(tx.messages[0].address, DEPOSIT_ADDRESS);

        const mainnetTx = buildFundDepositTransaction({
            depositAddress: DEPOSIT_ADDRESS,
            mySeatIndex: 0,
            myExpectedAmountNanotons: 1000000000,
            network: "mainnet"
        });

        assert.equal(mainnetTx.messages[0].amount, "1000000000");
    }

    console.log("  malformed input + supported network validation passed");
}

// ---------------------------------------------------------------------------
// No side effects: the builder performs no wallet / network / socket / server
// calls and does not emit any funding event. Spies remain untouched.
// ---------------------------------------------------------------------------

{
    const spies = {
        sendTransactionCalls: 0,
        tonConnectUiCalls: 0,
        fetchCalls: 0,
        webSocketCalls: 0,
        socketEmitCalls: 0
    };

    const originals = {
        sendTransaction: globalThis.sendTransaction,
        tonConnectUI: globalThis.tonConnectUI,
        fetch: globalThis.fetch,
        WebSocket: globalThis.WebSocket,
        socketEmit: globalThis.socketEmit
    };

    globalThis.sendTransaction = function sendTransactionSpy() {

        spies.sendTransactionCalls += 1;

    };

    globalThis.tonConnectUI = {
        sendTransaction() {

            spies.tonConnectUiCalls += 1;

        }
    };

    globalThis.fetch = function fetchSpy() {

        spies.fetchCalls += 1;

        return Promise.reject(new Error("fetch must not be called"));

    };

    globalThis.WebSocket = function WebSocketSpy() {

        spies.webSocketCalls += 1;

    };

    globalThis.socketEmit = function socketEmitSpy() {

        spies.socketEmitCalls += 1;

    };

    try {

        const tx = buildFundDepositTransaction({
            depositAddress: DEPOSIT_ADDRESS,
            mySeatIndex: 1,
            myExpectedAmountNanotons: 77700000000,
            network: "mainnet"
        });

        assert.equal(tx.messages[0].payload, buildFundSeatPayload(1));

    } finally {

        for (const key of Object.keys(originals)) {

            if (originals[key] === undefined) {

                delete globalThis[key];

            } else {

                globalThis[key] = originals[key];

            }

        }

    }

    assert.equal(spies.sendTransactionCalls, 0, "sendTransaction must not be called");
    assert.equal(spies.tonConnectUiCalls, 0, "TonConnect UI must not be called");
    assert.equal(spies.fetchCalls, 0, "fetch must not be called");
    assert.equal(spies.webSocketCalls, 0, "WebSocket must not be created");
    assert.equal(spies.socketEmitCalls, 0, "no socket event may be emitted");

    console.log("  no side effects (no wallet/network/socket calls) passed");
}

console.log("buildFundDepositTransaction.test.js: all assertions passed");