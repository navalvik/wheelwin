export class WinnerResolutionError extends Error {

    constructor({ gameId, reason }) {

        super(reason);

        this.name = "WinnerResolutionError";

        this.gameId = gameId;

        this.reason = reason;

    }

}
