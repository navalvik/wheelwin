export class ConfigurationValidationError extends Error {

    constructor({ gameId, reason, traceSeed = null }) {

        super(reason);

        this.name = "ConfigurationValidationError";

        this.gameId = gameId;

        this.reason = reason;

        this.traceSeed = traceSeed;

    }

}
