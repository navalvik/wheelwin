export class PaymentValidationError extends Error {

    constructor({ gameId, reason }) {

        super(reason);

        this.name = "PaymentValidationError";

        this.gameId = gameId;

        this.reason = reason;

    }

}
