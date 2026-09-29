/**
 * R18.S125 — Operator Explorer verification projection (DISPLAY-ONLY).
 *
 * Verifies that `buildOperatorExplorerVerification` extracts ONLY the
 * transaction hashes already present in a session history archive record,
 * pairs them with operator-facing explorer references for the given network,
 * and always reports the static flags that keep the Explorer step a FINAL
 * MANUAL operator verification — never an authorization mechanism.
 *
 * Synthetic record fixtures only. No archive files, no live TON access.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildOperatorExplorerVerification } from "../console/projectionBuilders/buildOperatorExplorerVerification.js";

const STAKE_HASH = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const DEPLOY_HASH = "b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const SETTLE_HASH = "c1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const REFUND_HASH = "d1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

const PLAYER_WALLET = "EQAtggW7l5wfQcPyy38Y7mVuXnh0wRHcpFKPIdtCbcRHb8wM";
const ROOM_WALLET = "EQAh7qNgZDv2F3p13B_5BTk5CiqQxrRn1TluPfq3A4vOJpOS";

function buildLifecycle() {

    return {
        deploy: {
            status: "SUCCESS",
            transactionHash: DEPLOY_HASH,
            contractAddress: "EQDep1oyment111111111111111111111111111111111"
        },
        settlement: {
            status: "CONFIRMED",
            transactionHash: SETTLE_HASH,
            winnerWallet: PLAYER_WALLET,
            winnerAmount: "3"
        },
        paymentConfirmation: {
            paidMask: 1,
            events: [
                {
                    type: "PAYMENT_TRANSACTION_CONFIRMED",
                    at: 1759100000000,
                    transactionHash: STAKE_HASH,
                    sender: PLAYER_WALLET,
                    contractAddress: ROOM_WALLET,
                    amount: "1"
                }
            ]
        }
    };

}

test("extracts stake, deploy, settlement hashes with explorer URLs for mainnet", () => {

    const block = buildOperatorExplorerVerification(
        { blockchainLifecycle: buildLifecycle() },
        { applicationNetwork: "mainnet" }
    );

    assert.equal(block.displayOnly, true);
    assert.equal(block.manualOnly, true);
    assert.equal(block.automatic, false);
    assert.equal(block.replacesTonCenterConfirmation, false);
    assert.equal(block.authorizesTransfers, false);
    assert.equal(block.network, "mainnet");
    assert.equal(block.explorerBaseUrl, "https://tonviewer.com");
    assert.equal(block.verificationRequired, true);

    assert.equal(block.transactions.length, 3);

    const byKind = new Map(
        block.transactions.map((entry) => [entry.kind, entry])
    );

    assert.equal(byKind.get("STAKE_PAYMENT").transactionHash, STAKE_HASH);
    assert.equal(
        byKind.get("STAKE_PAYMENT").explorerTransactionUrl,
        `https://tonviewer.com/transaction/${STAKE_HASH}`
    );
    assert.equal(byKind.get("STAKE_PAYMENT").source, PLAYER_WALLET);
    assert.equal(byKind.get("STAKE_PAYMENT").destination, ROOM_WALLET);

    assert.equal(byKind.get("DEPLOY").transactionHash, DEPLOY_HASH);
    assert.equal(
        byKind.get("DEPLOY").explorerTransactionUrl,
        `https://tonviewer.com/transaction/${DEPLOY_HASH}`
    );

    assert.equal(byKind.get("SETTLEMENT").transactionHash, SETTLE_HASH);
    assert.equal(byKind.get("SETTLEMENT").destination, PLAYER_WALLET);

});

test("deduplicates the finalSnapshot copy of the same lifecycle data", () => {

    const lifecycle = buildLifecycle();

    const block = buildOperatorExplorerVerification(
        {
            blockchainLifecycle: lifecycle,
            finalSnapshot: { blockchainLifecycle: lifecycle }
        },
        { applicationNetwork: "mainnet" }
    );

    assert.equal(block.transactions.length, 3);

});


test("collects refund reconciliation entries and participant refund hashes", () => {

    const block = buildOperatorExplorerVerification(
        {
            payment: {
                roomWalletAddress: ROOM_WALLET,
                participants: [
                    {
                        playerId: "p1",
                        status: "REFUNDED",
                        refunded: true,
                        refundTxHash: REFUND_HASH,
                        wallet: PLAYER_WALLET
                    }
                ],
                recoveryMetadata: {
                    refundReconciliations: [
                        {
                            playerId: "p1",
                            wallet: PLAYER_WALLET,
                            transactionHash: "e1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
                            reconciledAt: 1759100001000
                        }
                    ]
                }
            }
        },
        { applicationNetwork: "testnet" }
    );

    assert.equal(block.network, "testnet");
    assert.equal(block.explorerBaseUrl, "https://testnet.tonviewer.com");

    const kinds = block.transactions.map((entry) => entry.kind);

    assert.ok(kinds.includes("REFUND"));
    assert.ok(kinds.includes("REFUND_RECONCILIATION"));

    const refund = block.transactions.find(
        (entry) => entry.kind === "REFUND"
    );

    assert.equal(refund.transactionHash, REFUND_HASH);
    assert.equal(refund.source, ROOM_WALLET);
    assert.equal(refund.destination, PLAYER_WALLET);
    assert.equal(
        refund.explorerTransactionUrl,
        `https://testnet.tonviewer.com/transaction/${REFUND_HASH}`
    );

});

test("unknown application network keeps hashes but drops explorer URLs", () => {

    const block = buildOperatorExplorerVerification(
        { blockchainLifecycle: buildLifecycle() },
        { applicationNetwork: "stagenet" }
    );

    assert.equal(block.network, null);
    assert.equal(block.explorerBaseUrl, null);
    assert.equal(block.verificationRequired, true);
    assert.equal(block.transactions.length, 3);

    for (const entry of block.transactions) {

        assert.equal(entry.explorerTransactionUrl, null);

    }

});

test("omitted application network behaves the same as unknown (fail-safe)", () => {

    const block = buildOperatorExplorerVerification(
        { blockchainLifecycle: buildLifecycle() }
    );

    assert.equal(block.network, null);
    assert.equal(block.explorerBaseUrl, null);
    assert.equal(block.transactions.length, 3);

});

test("sanitized payment projection (no hashes) yields an empty, valid block", () => {

    const block = buildOperatorExplorerVerification(
        {
            payment: {
                paymentSessionId: "pay_x",
                participants: [
                    { playerId: "p1", status: "PAYMENT_CONFIRMED", requiredGram: "1" }
                ]
            }
        },
        { applicationNetwork: "mainnet" }
    );

    assert.equal(block.displayOnly, true);
    assert.equal(block.verificationRequired, false);
    assert.deepEqual(block.transactions, []);
    assert.match(block.note, /MANUAL operator step/);
    assert.match(block.note, /does not replace TON Center verification/i);

});

test("malformed records never throw", () => {

    assert.equal(buildOperatorExplorerVerification(null), null);
    assert.equal(buildOperatorExplorerVerification(undefined), null);
    assert.equal(buildOperatorExplorerVerification("nope"), null);

    const weird = buildOperatorExplorerVerification(
        {
            blockchainLifecycle: { paymentConfirmation: { events: [null, "x", 7] } },
            payment: { participants: "not-an-array", recoveryMetadata: null }
        },
        { applicationNetwork: "mainnet" }
    );

    assert.deepEqual(weird.transactions, []);
    assert.equal(weird.verificationRequired, false);

});

test("caps the transaction list defensively", () => {

    const events = [];

    for (let index = 0; index < 80; index += 1) {

        events.push({
            transactionHash: STAKE_HASH.slice(0, 62)
                + String(index).padStart(2, "0")
        });

    }

    const block = buildOperatorExplorerVerification(
        { blockchainLifecycle: { paymentConfirmation: { events } } },
        { applicationNetwork: "mainnet" }
    );

    assert.equal(block.transactions.length, 50);

});
