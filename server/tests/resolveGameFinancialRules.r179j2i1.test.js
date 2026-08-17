/**
 * R17.9J.2I.1 — resolveGameFinancialRules unit tests.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PAYMENT_RULES } from "../catalog/PaymentRules.js";
import { resolveGameFinancialRules } from "../engines/payment/resolveGameFinancialRules.js";

function mockCatalog(platformFeeRate = 0.06) {

    const rules = Object.freeze({
        ...PAYMENT_RULES,
        platformFeeRate,
        contributionByStake: Object.freeze({
            ...PAYMENT_RULES.contributionByStake
        })
    });

    return {
        getPaymentRules() {

            return rules;

        }
    };

}

test("R17.9J.2I.1 contract snapshot has priority over live catalog", () => {

    const snapshot = Object.freeze({
        organizerFeeRate: 0.05,
        winnerPercentage: 0.95,
        organizerFee: 5,
        payoutAmount: 95,
        totalPot: 100
    });

    const snapshotBefore = JSON.stringify(snapshot);

    const gameContractManager = {
        getContractByGameId(gameId) {

            if (gameId === "game_a") {

                return { snapshot };

            }

            return null;

        }
    };

    const gameCatalog = mockCatalog(0.06);
    const catalogBefore = JSON.stringify(gameCatalog.getPaymentRules());

    const resolved = resolveGameFinancialRules("game_a", {
        gameContractManager,
        configurationEngine: { getEconomy: () => null },
        gameCatalog
    });

    assert.equal(resolved.source, "contract");
    assert.equal(resolved.paymentRules.platformFeeRate, 0.05);
    assert.equal(resolved.amounts.organizerFeeRate, 0.05);
    assert.equal(resolved.amounts.winnerPercentage, 0.95);
    assert.equal(resolved.amounts.organizerFee, 5);
    assert.equal(resolved.amounts.payoutAmount, 95);
    assert.equal(resolved.amounts.totalPot, 100);

    assert.equal(JSON.stringify(snapshot), snapshotBefore);
    assert.equal(JSON.stringify(gameCatalog.getPaymentRules()), catalogBefore);

});

test("R17.9J.2I.1 frozen economy fallback when no contract", () => {

    const economy = Object.freeze({
        ownerFeePercent: 5,
        organizerFeeRate: 0.05,
        winnerPercentage: 0.95
    });

    const economyBefore = JSON.stringify(economy);

    const gameCatalog = mockCatalog(0.06);
    const catalogBefore = JSON.stringify(gameCatalog.getPaymentRules());

    const resolved = resolveGameFinancialRules("game_debug", {
        gameContractManager: {
            getContractByGameId: () => null
        },
        configurationEngine: {
            getEconomy(gameId) {

                return gameId === "game_debug" ? economy : null;

            }
        },
        gameCatalog
    });

    assert.equal(resolved.source, "economy");
    assert.equal(resolved.paymentRules.platformFeeRate, 0.05);
    assert.equal(resolved.amounts.organizerFeeRate, 0.05);
    assert.equal(resolved.amounts.winnerPercentage, 0.95);
    assert.equal(resolved.amounts.ownerFeePercent, 5);

    assert.equal(JSON.stringify(economy), economyBefore);
    assert.equal(JSON.stringify(gameCatalog.getPaymentRules()), catalogBefore);

});

test("R17.9J.2I.1 catalog fallback when no contract and no economy", () => {

    const gameCatalog = mockCatalog(0.06);
    const catalogBefore = JSON.stringify(gameCatalog.getPaymentRules());

    const resolved = resolveGameFinancialRules("game_new", {
        gameContractManager: {
            getContractByGameId: () => null
        },
        configurationEngine: {
            getEconomy: () => null
        },
        gameCatalog
    });

    assert.equal(resolved.source, "catalog");
    assert.equal(resolved.paymentRules.platformFeeRate, 0.06);
    assert.equal(resolved.amounts, undefined);

    assert.equal(JSON.stringify(gameCatalog.getPaymentRules()), catalogBefore);

});

test("R17.9J.2I.1 resolver does not mutate contract snapshot or catalog", () => {

    const snapshot = Object.freeze({
        organizerFeeRate: 0.05,
        winnerPercentage: 0.95,
        totalPot: 30,
        organizerFee: 1.5,
        payoutAmount: 28.5
    });

    const gameCatalog = mockCatalog(0.06);

    const gameContractManager = {
        getContractByGameId: () => ({ snapshot })
    };

    resolveGameFinancialRules("game_x", {
        gameContractManager,
        configurationEngine: { getEconomy: () => null },
        gameCatalog
    });

    assert.equal(snapshot.organizerFeeRate, 0.05);
    assert.equal(snapshot.winnerPercentage, 0.95);
    assert.equal(gameCatalog.getPaymentRules().platformFeeRate, 0.06);

});

console.log("resolveGameFinancialRules.r179j2i1.test.js: all assertions passed");
