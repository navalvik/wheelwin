import { TonClient } from "@ton/ton";

import { TonCenterTransport } from "../payment/ton/TonCenterTransport.js";

/**
 * P6.6 — TON network service.
 * Owns TonClient / TonCenter transport for adapters and monitors.
 */
export class TonService {

    constructor({ logger, tonConfig }) {

        this._logger = logger;

        this._tonConfig = tonConfig;

        this._transport = null;

        this._client = null;

        this._initialized = false;

    }

    initialize() {

        this._transport = new TonCenterTransport({
            endpoint: this._tonConfig.endpoint,
            apiKey: this._tonConfig.apiKey
        });

        this._client = new TonClient({
            endpoint: this._tonConfig.endpoint,
            apiKey: this._tonConfig.apiKey || undefined
        });

        this._initialized = true;

    }

    getConfig() {

        return this._tonConfig;

    }

    getTransport() {

        return this._transport;

    }

    getClient() {

        return this._client;

    }

    shutdown() {

        this._transport = null;

        this._client = null;

        this._initialized = false;

    }

}
