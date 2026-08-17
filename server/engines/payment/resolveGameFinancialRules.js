/**
 * R17.9J.2I.1 — Read-only per-game payment rules resolver.
 *
 * Priority: contract snapshot → frozen economy → live catalog (pre-freeze/tests only).
 * Never throws. Never mutates inputs or PaymentRules.
 */

/**
 * @param {object|null|undefined} gameCatalog
 * @returns {object|null}
 */
function getCatalogRules(gameCatalog) {

    if (!gameCatalog?.getPaymentRules) {

        return null;

    }

    const rules = gameCatalog.getPaymentRules();

    if (!rules || typeof rules !== "object") {

        return null;

    }

    return rules;

}

/**
 * @param {object|null} catalogRules
 * @param {number} platformFeeRate
 * @returns {object}
 */
function buildPaymentRules(catalogRules, platformFeeRate) {

    const rate = Number(platformFeeRate);

    const contribution = catalogRules?.contributionByStake;

    return Object.freeze({
        platformFeeRate: Number.isFinite(rate) ? rate : 0,
        currency: catalogRules?.currency ?? null,
        contributionByStake: contribution && typeof contribution === "object"
            ? Object.freeze({ ...contribution })
            : Object.freeze({}),
        secondSectorMultiplier: catalogRules?.secondSectorMultiplier ?? null
    });

}

/**
 * @param {object} snapshot
 * @returns {object|undefined}
 */
function buildAmountsFromSnapshot(snapshot) {

    const amounts = {};
    const totalPot = Number(snapshot.totalPot);

    if (Number.isFinite(totalPot)) {

        amounts.totalPot = totalPot;

    }

    const organizerFee = Number(snapshot.organizerFee);

    if (Number.isFinite(organizerFee)) {

        amounts.organizerFee = organizerFee;

    }

    const payoutAmount = Number(snapshot.payoutAmount);

    if (Number.isFinite(payoutAmount)) {

        amounts.payoutAmount = payoutAmount;

    }

    const organizerFeeRate = Number(snapshot.organizerFeeRate);

    if (Number.isFinite(organizerFeeRate)) {

        amounts.organizerFeeRate = organizerFeeRate;

    }

    const winnerPercentage = Number(snapshot.winnerPercentage);

    if (Number.isFinite(winnerPercentage)) {

        amounts.winnerPercentage = winnerPercentage;

    }

    if (Object.keys(amounts).length === 0) {

        return undefined;

    }

    return Object.freeze(amounts);

}

/**
 * @param {object} economy
 * @returns {object|undefined}
 */
function buildAmountsFromEconomy(economy) {

    const amounts = {};
    const organizerFeeRate = Number(economy.organizerFeeRate);

    if (Number.isFinite(organizerFeeRate)) {

        amounts.organizerFeeRate = organizerFeeRate;

    }

    const winnerPercentage = Number(economy.winnerPercentage);

    if (Number.isFinite(winnerPercentage)) {

        amounts.winnerPercentage = winnerPercentage;

    }

    const ownerFeePercent = Number(economy.ownerFeePercent);

    if (Number.isFinite(ownerFeePercent)) {

        amounts.ownerFeePercent = ownerFeePercent;

    }

    if (Object.keys(amounts).length === 0) {

        return undefined;

    }

    return Object.freeze(amounts);

}

/**
 * @param {object|null|undefined} gameCatalog
 * @returns {object}
 */
function resolveFromCatalog(gameCatalog) {

    const catalogRules = getCatalogRules(gameCatalog);
    const rate = Number(catalogRules?.platformFeeRate);

    return Object.freeze({
        source: "catalog",
        paymentRules: buildPaymentRules(
            catalogRules,
            Number.isFinite(rate) ? rate : 0
        ),
        amounts: undefined
    });

}

/**
 * Resolve immutable payment rules for one game.
 *
 * @param {string} gameId
 * @param {{
 *   gameContractManager?: { getContractByGameId?: Function }|null,
 *   configurationEngine?: { getEconomy?: Function }|null,
 *   gameCatalog?: { getPaymentRules?: Function }|null
 * }} dependencies
 * @returns {{
 *   source: "contract"|"economy"|"catalog",
 *   paymentRules: {
 *     platformFeeRate: number,
 *     currency: string|null,
 *     contributionByStake: object,
 *     secondSectorMultiplier: number|null
 *   },
 *   amounts?: object
 * }}
 */
export function resolveGameFinancialRules(gameId, {
    gameContractManager = null,
    configurationEngine = null,
    gameCatalog = null
} = {}) {

    try {

        const key = String(gameId ?? "").trim();

        if (!key) {

            return resolveFromCatalog(gameCatalog);

        }

        const contract = gameContractManager?.getContractByGameId?.(key) ?? null;
        const snapshot = contract?.snapshot ?? null;

        if (snapshot && typeof snapshot === "object") {

            const organizerFeeRate = Number(snapshot.organizerFeeRate);

            if (Number.isFinite(organizerFeeRate)) {

                const catalogRules = getCatalogRules(gameCatalog);

                return Object.freeze({
                    source: "contract",
                    paymentRules: buildPaymentRules(catalogRules, organizerFeeRate),
                    amounts: buildAmountsFromSnapshot(snapshot)
                });

            }

        }

        const economy = configurationEngine?.getEconomy?.(key) ?? null;

        if (economy && typeof economy === "object") {

            let organizerFeeRate = Number(economy.organizerFeeRate);

            if (!Number.isFinite(organizerFeeRate)) {

                const ownerFeePercent = Number(economy.ownerFeePercent);

                if (Number.isFinite(ownerFeePercent)) {

                    organizerFeeRate = ownerFeePercent / 100;

                }

            }

            if (Number.isFinite(organizerFeeRate)) {

                const catalogRules = getCatalogRules(gameCatalog);

                return Object.freeze({
                    source: "economy",
                    paymentRules: buildPaymentRules(catalogRules, organizerFeeRate),
                    amounts: buildAmountsFromEconomy(economy)
                });

            }

        }

        return resolveFromCatalog(gameCatalog);

    } catch {

        return resolveFromCatalog(gameCatalog);

    }

}
