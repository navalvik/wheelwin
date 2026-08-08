/**
 * R7.70B — Testnet wallet readiness diagnostics tests.
 */
import assert from "node:assert/strict";

import { calculateRequiredGram } from "../payment/calculateRequiredGram.js";
import {
    evaluateTonTestnetWalletReadiness,
    resetTonTestnetWalletReadinessForTests,
    setTonTestnetWalletReadiness,
    getTonTestnetWalletReadiness
} from "../diagnostics/TonTestnetWalletReadiness.js";
import { STAKES } from "../catalog/Stakes.js";

function main() {

    resetTonTestnetWalletReadinessForTests();

    {
        assert.ok(STAKES.includes(1), "catalog must allow 1 Gram stake");
        assert.equal(calculateRequiredGram(1, 1), 1);
        assert.equal(calculateRequiredGram(1, 2), 2.5);
        console.log("  1 Gram stake catalog: OK");
    }

    {
        const blocked = evaluateTonTestnetWalletReadiness({
            network: "testnet",
            gameEscrowMode: "game"
        });
        assert.equal(blocked.status, "BLOCKED");
        assert.ok(blocked.reasons.length >= 1);

        const ready = evaluateTonTestnetWalletReadiness({
            network: "testnet",
            gameEscrowMode: "game",
            deployAddress: "EQB83s9XMOMseDFxyXxj4hrC0sS4FB4xhdNiUPkl_3zx3PDQ",
            deployWalletId: 698983191,
            deployBalanceTon: 4.7,
            oracleAddress: "EQB83s9XMOMseDFxyXxj4hrC0sS4FB4xhdNiUPkl_3zx3PDQ",
            oracleSource: "TON_TESTNET_ORACLE_ADDRESS",
            ownerAddress: "EQBaklBYMdMsuq7a2eTYhMkz1OF7ZSHaO1mnFd1MZd3YjMgi",
            ownerBalanceTon: 20
        });
        assert.equal(ready.status, "READY");
        assert.equal(ready.stakeGram, 1);
        assert.equal(ready.expectedTotalGram, 3);
        assert.equal(ready.mode, "GameEscrow");
        assert.equal(ready.playerSeatCount, 3);

        // Lena (player) must never be treated as owner.
        const lena = "0QDeWBnzASv1uz8OUCqjoGb_yrW_TVLc84S5szqFfjkHyMqm";
        assert.notEqual(ready.ownerAddress, lena);
        assert.ok(ready.ownerAddress.startsWith("EQBakl") || ready.ownerAddress.startsWith("0QBakl"));

        setTonTestnetWalletReadiness(ready);
        assert.equal(getTonTestnetWalletReadiness().status, "READY");
        console.log("  wallet readiness evaluate: OK");
    }

    {
        // On-chain READY mask for 3 seats: bits 0|1|2 => 7 (binary 111).
        const allBits = (1 << 3) - 1;
        assert.equal(allBits, 7);
        assert.equal(allBits.toString(2), "111");
        console.log("  paidMask 111 expectation: OK");
    }

    console.log("tonTestnetWalletReadiness.test.js: all assertions passed");

}

main();
