/**
 * R18.S125 — Pure row mapper for the display-only operator Explorer
 * verification block (`operatorExplorerVerification` on the
 * `/console/history/:sessionId` response).
 *
 * Verifies the History panel mapping contract: only https explorer links are
 * surfaced, invalid entries are dropped, and absent blocks produce no rows.
 * DISPLAY-ONLY by construction — no network access, no authorization input.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildExplorerVerificationRows } from "./explorerVerificationRows.js";

const HASH = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

test("maps a populated operator verification block into display rows", () => {

    const rows = buildExplorerVerificationRows({
        displayOnly: true,
        manualOnly: true,
        network: "mainnet",
        transactions: [
            {
                kind: "STAKE_PAYMENT",
                label: "Stake payment",
                transactionHash: HASH,
                explorerTransactionUrl: `https://tonviewer.com/transaction/${HASH}`,
                source: "EQAtggW7l5wfQcPyy38Y7mVuXnh0wRHcpFKPIdtCbcRHb8wM",
                destination: null,
                amount: "1"
            }
        ]
    });

    assert.equal(rows.length, 1);

    assert.equal(rows[0].kind, "STAKE_PAYMENT");
    assert.equal(rows[0].hash, HASH);
    assert.equal(rows[0].url, `https://tonviewer.com/transaction/${HASH}`);
    assert.match(rows[0].source, /^EQAtggW7/);

});

test("drops entries without hashes and non-https URLs", () => {

    const rows = buildExplorerVerificationRows({
        transactions: [
            { kind: "REFUND", transactionHash: "" },
            { kind: "REFUND", transactionHash: null },
            { kind: "REFUND", transactionHash: HASH, explorerTransactionUrl: "http://insecure.example/" },
            { kind: "REFUND", transactionHash: HASH, explorerTransactionUrl: null },
            "garbage",
            null
        ]
    });

    assert.equal(rows.length, 2);

    for (const row of rows) {

        assert.equal(row.url, null);

    }

});

test("absent or malformed blocks produce no rows", () => {

    assert.deepEqual(buildExplorerVerificationRows(null), []);
    assert.deepEqual(buildExplorerVerificationRows(undefined), []);
    assert.deepEqual(buildExplorerVerificationRows("nope"), []);
    assert.deepEqual(buildExplorerVerificationRows({}), []);
    assert.deepEqual(
        buildExplorerVerificationRows({ transactions: "not-an-array" }),
        []
    );

});

test("rows never contain executable or non-https link data", () => {

    const rows = buildExplorerVerificationRows({
        transactions: [
            {
                kind: "SETTLEMENT",
                transactionHash: HASH,
                explorerTransactionUrl: "javascript:alert(1)",
                source: " x ",
                destination: " y "
            }
        ]
    });

    assert.equal(rows.length, 1);

    assert.equal(rows[0].url, null);
    assert.equal(rows[0].source, "x");
    assert.equal(rows[0].destination, "y");

});
