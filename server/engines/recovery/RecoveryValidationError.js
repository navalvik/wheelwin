export class RecoveryValidationError extends Error {

    constructor({ gameId, reason }) {

        super(reason);

        this.name = "RecoveryValidationError";

        this.gameId = gameId;

        this.reason = reason;

    }

}
