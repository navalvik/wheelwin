export class AuditValidationError extends Error {

    constructor({ gameId, reason }) {

        super(reason);

        this.name = "AuditValidationError";

        this.gameId = gameId;

        this.reason = reason;

    }

}
