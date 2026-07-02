export class TimerService {

    constructor({ logger }) {

        this._logger = logger;

        this._initialized = false;

    }

    initialize() {

        this._initialized = true;

    }

    shutdown() {

        this._initialized = false;

    }

}
