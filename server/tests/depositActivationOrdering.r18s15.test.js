/**
 * R18-S15 — E2E runner must FundSeat only after DEPOSIT_ACTIVATION_VERIFIED.
 * Does not change production assertInitialMutableState / verifyActivation.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { assertInitialMutableState } from "../payment/ton/readDepositGetters.js";
import {
    assertFundSeatAllowedAfterVerified,
    createProductionLogScanner,
    DEPOSIT_ACTIVATION_VERIFIED,
    DEPOSIT_ACTIVATION_WAITING,
    isPersistedActivationVerified,
    logContainsEventBusType,
    matchesDepositActivationIdentity
} from "./testnet/r18s15/depositActivationOrdering.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DRIVER_SOURCE = readFileSync(
    join(HERE, "../scripts/_r18s15_production_page5.mjs"),
    "utf8"
);
const APP_SOURCE = readFileSync(join(HERE, "../app.js"), "utf8");
const GETTERS_SOURCE = readFileSync(
    join(HERE, "../payment/ton/readDepositGetters.js"),
    "utf8"
);

const EXPECTED = Object.freeze({
    roomId: "room-live",
    gameId: "game-live",
    depositId: "dep_live"
});

test("R18-S15: FundSeat is forbidden before matching DEPOSIT_ACTIVATION_VERIFIED", () => {

    assert.equal(
        matchesDepositActivationIdentity(
            { ...EXPECTED, depositId: "dep_other" },
            EXPECTED
        ),
        false
    );

    assert.throws(
        () => assertFundSeatAllowedAfterVerified({
            expected: EXPECTED,
            verifiedPayload: null
        }),
        /FundSeat is forbidden/
    );

    assert.throws(
        () => assertFundSeatAllowedAfterVerified({
            expected: EXPECTED,
            verifiedPayload: { ...EXPECTED, depositId: "dep_other" }
        }),
        /FundSeat is forbidden/
    );

    assert.throws(
        () => assertFundSeatAllowedAfterVerified({
            expected: EXPECTED,
            verifiedPayload: EXPECTED,
            fundSeatStarted: true
        }),
        /already started/
    );

});

test("R18-S15: matching DEPOSIT_ACTIVATION_VERIFIED allows FundSeat", () => {

    assert.equal(
        assertFundSeatAllowedAfterVerified({
            expected: EXPECTED,
            verifiedPayload: EXPECTED
        }),
        true
    );

    assert.equal(
        isPersistedActivationVerified(
            {
                payload: {
                    ...EXPECTED,
                    metadata: { activationVerification: { status: "VERIFIED" } }
                }
            },
            EXPECTED
        ),
        true
    );

    assert.equal(
        isPersistedActivationVerified(
            {
                payload: {
                    ...EXPECTED,
                    metadata: { activationVerification: { status: "REJECTED" } }
                }
            },
            EXPECTED
        ),
        false
    );

});

test("R18-S15: production EventBus type can be observed in app logs", () => {

    const scanner = createProductionLogScanner();

    scanner.push("Type:\n");
    scanner.push("2026-08-28T20:34:40.163Z INFO [wheelwin-server] trace=abc DEPOSIT_ACTIVATION_WAITING\n");

    assert.equal(scanner.hasEventBusType(DEPOSIT_ACTIVATION_WAITING), true);
    assert.equal(scanner.hasEventBusType(DEPOSIT_ACTIVATION_VERIFIED), false);

    scanner.push("2026-08-28T20:34:49.000Z INFO [wheelwin-server] trace=def DEPOSIT_ACTIVATION_VERIFIED\n");

    assert.equal(scanner.hasEventBusType(DEPOSIT_ACTIVATION_VERIFIED), true);
    assert.equal(
        logContainsEventBusType(scanner.snapshot(), DEPOSIT_ACTIVATION_VERIFIED),
        true
    );

});

test("R18-S15: driver awaits DEPOSIT_ACTIVATION_VERIFIED before fundSeatAsPlayer", () => {

    const waitVerified = DRIVER_SOURCE.indexOf("WAIT_ACTIVATION_VERIFIED");
    const fundSeatCall = DRIVER_SOURCE.indexOf("await fundSeatAsPlayer");
    const fundPhase = DRIVER_SOURCE.indexOf("phase\", \"FUNDSEAT\"");

    assert.notEqual(waitVerified, -1);
    assert.notEqual(fundSeatCall, -1);
    assert.ok(
        waitVerified < fundSeatCall,
        "driver must wait for VERIFIED before calling fundSeatAsPlayer"
    );
    assert.ok(
        waitVerified < fundPhase,
        "driver must wait for VERIFIED before FUNDSEAT phase"
    );
    assert.match(DRIVER_SOURCE, /assertFundSeatAllowedAfterVerified/);

});

test("R18-S15: assertInitialMutableState still rejects a funded Deposit", () => {

    assert.match(GETTERS_SOURCE, /Number\(getters\.status\) !== 1/);
    assert.match(GETTERS_SOURCE, /Number\(getters\.paidMask\) !== 0/);

    assert.throws(
        () => assertInitialMutableState({
            status: 3,
            paidMask: 7,
            creditedAmount0: 11_000_000n,
            creditedAmount1: 11_000_000n,
            creditedAmount2: 11_000_000n,
            surplusNano: 0n,
            refundMask: 0,
            totalCredited: 33_000_000n,
            releasedTo: null
        }),
        /status=3|paidMask=7|totalCredited/
    );

});

test("R18-S15: BlockchainMonitor.start() remains after setDepositMonitor", () => {

    const attach = APP_SOURCE.indexOf("setDepositMonitor");
    const start = APP_SOURCE.indexOf("this._blockchainMonitor.start(");

    assert.notEqual(attach, -1);
    assert.notEqual(start, -1);
    assert.ok(attach < start);

});
