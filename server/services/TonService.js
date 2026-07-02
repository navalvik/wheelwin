export class TonService {

    constructor({ logger, tonConfig }) {

        this._logger = logger;

        this._tonConfig = tonConfig;

        this._initialized = false;

    }

    initialize() {

        this._initialized = true;

    }

    shutdown() {

        this._initialized = false;

    }

}
