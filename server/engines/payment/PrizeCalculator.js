import { PaymentValidationError } from "./PaymentValidationError.js";

function roundMoney(value) {

    return Math.round(value * 100) / 100;

}

export class PrizeCalculator {

    constructor({ paymentRules }) {

        this._paymentRules = paymentRules;

    }

    calculate({ configuration, gameResult }) {

        const stake = configuration.stake;

        const baseContribution = this._paymentRules.contributionByStake[stake];

        if (!Number.isFinite(baseContribution) || baseContribution <= 0) {

            throw new PaymentValidationError({
                gameId: gameResult.gameId,
                reason: "Prize pool contribution is not configured for stake"
            });

        }

        const players = configuration.players;

        if (!Array.isArray(players) || players.length <= 0) {

            throw new PaymentValidationError({
                gameId: gameResult.gameId,
                reason: "Player contributions are invalid"
            });

        }

        const twoSectorMultiplier = this._paymentRules.twoSectorMultiplier ?? 2.5;

        const playerContributions = players.map((player) => {

            const sectorCount = Number(player.sectorCount) === 2 ? 2 : 1;

            const contribution = sectorCount === 2
                ? baseContribution * twoSectorMultiplier
                : baseContribution;

            if (!Number.isFinite(contribution) || contribution <= 0) {

                throw new PaymentValidationError({
                    gameId: gameResult.gameId,
                    reason: "Player contributions are invalid"
                });

            }

            return {
                playerId: player.playerId,
                contribution: roundMoney(contribution)
            };

        });

        const totalPrize = roundMoney(
            playerContributions.reduce(
                (sum, entry) => sum + entry.contribution,
                0
            )
        );

        const platformFee = roundMoney(
            totalPrize * this._paymentRules.platformFeeRate
        );

        const winnerAmount = roundMoney(totalPrize - platformFee);

        if (!Number.isFinite(winnerAmount) || winnerAmount <= 0) {

            throw new PaymentValidationError({
                gameId: gameResult.gameId,
                reason: "Winner amount is invalid"
            });

        }

        return {
            totalPrize,
            platformFee,
            winnerAmount,
            currency: this._paymentRules.currency,
            playerContributions
        };

    }

}
