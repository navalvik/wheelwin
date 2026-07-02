import { PaymentValidationError } from "./PaymentValidationError.js";

export class PrizeCalculator {

    constructor({ paymentRules }) {

        this._paymentRules = paymentRules;

    }

    calculate({ configuration, gameResult }) {

        const stake = configuration.stake;

        const contributionPerPlayer = this._paymentRules.contributionByStake[stake];

        if (!Number.isFinite(contributionPerPlayer) || contributionPerPlayer <= 0) {

            throw new PaymentValidationError({
                gameId: gameResult.gameId,
                reason: "Prize pool contribution is not configured for stake"
            });

        }

        const playerCount = configuration.players.length;

        if (!Number.isInteger(playerCount) || playerCount <= 0) {

            throw new PaymentValidationError({
                gameId: gameResult.gameId,
                reason: "Player contributions are invalid"
            });

        }

        const totalPrize = contributionPerPlayer * playerCount;

        const platformFee = totalPrize * this._paymentRules.platformFeeRate;

        const winnerAmount = totalPrize - platformFee;

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
            playerContributions: configuration.players.map((player) => ({
                playerId: player.playerId,
                contribution: contributionPerPlayer
            }))
        };

    }

}
