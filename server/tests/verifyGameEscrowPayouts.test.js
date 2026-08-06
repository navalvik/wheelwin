/**
 * R7.66G — GameEscrow payout verification tests.
 */
import assert from "node:assert/strict";

import { verifyGameEscrowPayouts } from "../payment/ton/verifyGameEscrowPayouts.js";

const WINNER = "EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j";
const OWNER = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
const SETTLE_HASH = "settleTxHashAbc123";

function nano(tons) {

    return String(Math.round(Number(tons) * 1e9));

}

function makePayoutTx({
    hash = SETTLE_HASH,
    winnerAmount = 2.85,
    ownerAmount = 0.15,
    includeWinner = true,
    includeOwner = true
} = {}) {

    const out_msgs = [];

    if (includeWinner) {

        out_msgs.push({
            destination: WINNER,
            value: nano(winnerAmount)
        });

    }

    if (includeOwner) {

        out_msgs.push({
            destination: OWNER,
            value: nano(ownerAmount)
        });

    }

    return {
        transaction_id: { hash, lt: "1" },
        out_msgs
    };

}

function main() {

    // --- submit without payout != completed ---

    {
        const result = verifyGameEscrowPayouts({
            transactions: [
                {
                    transaction_id: { hash: SETTLE_HASH, lt: "1" },
                    out_msgs: []
                }
            ],
            winnerAddress: WINNER,
            ownerAddress: OWNER,
            winnerAmount: 2.85,
            ownerAmount: 0.15,
            settleTxHash: SETTLE_HASH,
            contractStatus: 8
        });

        assert.equal(result.ok, false);
        assert.equal(result.status, "PENDING");
        assert.equal(result.reason, "payouts_not_found");

        console.log("  submit without payout != completed: OK");
    }

    // --- valid payouts = completed ---

    {
        const result = verifyGameEscrowPayouts({
            transactions: [
                makePayoutTx()
            ],
            winnerAddress: WINNER,
            ownerAddress: OWNER,
            winnerAmount: 2.85,
            ownerAmount: 0.15,
            settleTxHash: SETTLE_HASH,
            contractStatus: 8
        });

        assert.equal(result.ok, true);
        assert.equal(result.status, "CONFIRMED");
        assert.equal(result.settleTxHash, SETTLE_HASH);
        assert.equal(result.winnerPayoutTx, SETTLE_HASH);
        assert.equal(result.ownerPayoutTx, SETTLE_HASH);

        console.log("  valid payouts = completed: OK");
    }

    // --- wrong amount rejected ---

    {
        const result = verifyGameEscrowPayouts({
            transactions: [
                makePayoutTx({ winnerAmount: 1.0, ownerAmount: 0.15 })
            ],
            winnerAddress: WINNER,
            ownerAddress: OWNER,
            winnerAmount: 2.85,
            ownerAmount: 0.15,
            contractStatus: 8
        });

        assert.equal(result.ok, false);
        assert.equal(result.reason, "amount_mismatch");
        assert.equal(result.status, "REJECTED");

        console.log("  wrong amount rejected: OK");
    }

    // --- missing owner payout rejected ---

    {
        const result = verifyGameEscrowPayouts({
            transactions: [
                makePayoutTx({ includeOwner: false })
            ],
            winnerAddress: WINNER,
            ownerAddress: OWNER,
            winnerAmount: 2.85,
            ownerAmount: 0.15,
            contractStatus: 8
        });

        assert.equal(result.ok, false);
        assert.equal(result.reason, "missing_owner_payout");
        assert.equal(result.status, "REJECTED");
        assert.equal(result.winnerPayoutTx, SETTLE_HASH);
        assert.equal(result.ownerPayoutTx, null);

        console.log("  missing owner payout rejected: OK");
    }

    // --- contract not settled rejected ---

    {
        const result = verifyGameEscrowPayouts({
            transactions: [
                makePayoutTx()
            ],
            winnerAddress: WINNER,
            ownerAddress: OWNER,
            winnerAmount: 2.85,
            ownerAmount: 0.15,
            contractStatus: 1
        });

        assert.equal(result.ok, false);
        assert.equal(result.reason, "contract_not_settled");

        console.log("  contract not settled rejected: OK");
    }

    console.log("verifyGameEscrowPayouts.test.js: all assertions passed");

}

main();
