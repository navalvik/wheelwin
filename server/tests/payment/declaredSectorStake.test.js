import assert from "node:assert/strict";
import { test } from "node:test";

import {
    calculateDeclaredSectorStakeAtomic
} from "../../payment/runtime/DeclaredSectorStake.js";
import { NANOTONS_PER_TON } from "../../payment/ledger/index.js";

test("one sector costs exactly one base stake", () => {
    assert.equal(
        calculateDeclaredSectorStakeAtomic({ baseStake: 1, sectorCount: 1 }),
        NANOTONS_PER_TON
    );
    assert.equal(
        calculateDeclaredSectorStakeAtomic({ baseStake: 10, sectorCount: 1 }),
        10 * NANOTONS_PER_TON
    );
});

test("two sectors cost base stake plus 1.5 times base stake", () => {
    assert.equal(
        calculateDeclaredSectorStakeAtomic({ baseStake: 1, sectorCount: 2 }),
        2_500_000_000
    );
    assert.equal(
        calculateDeclaredSectorStakeAtomic({ baseStake: 10, sectorCount: 2 }),
        25_000_000_000
    );
});

test("accepts string profile values but rejects unsupported stake tiers", () => {
    assert.equal(
        calculateDeclaredSectorStakeAtomic({ baseStake: "10", sectorCount: "2" }),
        25_000_000_000
    );
    assert.throws(
        () => calculateDeclaredSectorStakeAtomic({ baseStake: 5, sectorCount: 1 }),
        /baseStake/
    );
});

test("rejects invalid sector counts and unsafe atomic-unit mappings", () => {
    assert.throws(
        () => calculateDeclaredSectorStakeAtomic({ baseStake: 1, sectorCount: 0 }),
        /sectorCount/
    );
    assert.throws(
        () => calculateDeclaredSectorStakeAtomic({
            baseStake: 1,
            sectorCount: 2,
            atomicUnitsPerUnit: Number.MAX_SAFE_INTEGER
        }),
        /represented exactly|safe atomic-unit/
    );
});
