/**
 * R7.69C — verifyGameEscrowRefunds pure unit tests.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import { verifyGameEscrowRefunds } from "../payment/ton/verifyGameEscrowRefunds.js";

function friendlyAddress(seedLabel) {

    const seed = createHash("sha256").update(seedLabel).digest();

    const keyPair = keyPairFromSeed(seed);

    return WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey
    }).address.toString({
        bounceable: true,
        urlSafe: true
    });

}

function main() {

    const player0 = friendlyAddress("vr-p0");
    const player1 = friendlyAddress("vr-p1");
    const player2 = friendlyAddress("vr-p2");

    {
        const result = verifyGameEscrowRefunds({
            contractStatus: 9,
            refunds: [],
            expectedRefundMask: 0
        });

        assert.equal(result.ok, true);
        assert.equal(result.status, "CONFIRMED");
        console.log("  empty refunds when cancelled: OK");
    }

    {
        const result = verifyGameEscrowRefunds({
            contractStatus: 5,
            refunds: [
                { playerIndex: 0, wallet: player0, amount: 10 }
            ]
        });

        assert.equal(result.ok, false);
        assert.equal(result.reason, "contract_not_cancelled");
        console.log("  reject when not cancelled: OK");
    }

    {
        const result = verifyGameEscrowRefunds({
            contractStatus: 9,
            cancelTxHash: "canc-1",
            expectedRefundMask: 0b011,
            refunds: [
                { playerIndex: 0, wallet: player0, amount: 10 },
                { playerIndex: 1, wallet: player1, amount: 15 }
            ],
            transactions: [
                {
                    transaction_id: { hash: "canc-1" },
                    out_msgs: [
                        { destination: player0, value: String(10 * 1e9) },
                        { destination: player1, value: String(15 * 1e9) }
                    ]
                }
            ]
        });

        assert.equal(result.ok, true);
        assert.equal(result.confirmedMask, 0b011);
        assert.equal(result.refundTxs.length, 2);
        console.log("  partial two-player refunds confirmed: OK");
    }

    {
        const result = verifyGameEscrowRefunds({
            contractStatus: 9,
            refunds: [
                { playerIndex: 0, wallet: player0, amount: 10 },
                { playerIndex: 1, wallet: player1, amount: 10 },
                { playerIndex: 2, wallet: player2, amount: 10 }
            ],
            expectedRefundMask: 0b111,
            transactions: [
                {
                    transaction_id: { hash: "canc-all" },
                    out_msgs: [
                        { destination: player0, value: String(10 * 1e9) },
                        { destination: player1, value: String(10 * 1e9) },
                        { destination: player2, value: String(10 * 1e9) }
                    ]
                }
            ]
        });

        assert.equal(result.ok, true);
        assert.equal(result.confirmedMask, 0b111);
        console.log("  three-player refunds confirmed: OK");
    }

    {
        const result = verifyGameEscrowRefunds({
            contractStatus: 9,
            refunds: [
                { playerIndex: 0, wallet: player0, amount: 10 }
            ],
            transactions: [
                {
                    transaction_id: { hash: "bad-amt" },
                    out_msgs: [
                        { destination: player0, value: String(9 * 1e9) }
                    ]
                }
            ]
        });

        assert.equal(result.ok, false);
        assert.equal(result.reason, "amount_mismatch");
        console.log("  amount mismatch rejected: OK");
    }

    {
        const result = verifyGameEscrowRefunds({
            contractStatus: 9,
            refunds: [
                { playerIndex: 0, wallet: player0, amount: 10 }
            ],
            transactions: []
        });

        assert.equal(result.ok, false);
        assert.equal(result.status, "PENDING");
        console.log("  pending until refund txs appear: OK");
    }

    console.log("verifyGameEscrowRefunds.test.js: all assertions passed");

}

main();
