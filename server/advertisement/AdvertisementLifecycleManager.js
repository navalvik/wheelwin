/**
 * R14.7 — AdvertisementLifecycleManager.
 * Transitions ACTIVE → WAITING_OWNER_RENEWAL when expiresAt is reached.
 * Does not delete campaigns or assets. No TON / billing.
 *
 * Timer: reuses AdvertisementScheduler ticks when wired; optional interval for tests.
 */

import {
    ADVERTISEMENT_STATUS,
    isAdvertisementExpired
} from "./advertisementTypes.js";

export class AdvertisementLifecycleManager {

    constructor({
        logger = null,
        advertisementManager = null,
        nowFn = () => new Date(),
        setIntervalFn = setInterval,
        clearIntervalFn = clearInterval,
        pollIntervalMs = 0
    } = {}) {

        this._logger = logger;
        this._advertisementManager = advertisementManager;
        this._nowFn = nowFn;
        this._setIntervalFn = setIntervalFn;
        this._clearIntervalFn = clearIntervalFn;
        this._pollIntervalMs = Number(pollIntervalMs) > 0
            ? Number(pollIntervalMs)
            : 0;

        this._initialized = false;
        this._running = false;
        this._timer = null;

    }

    initialize() {

        this._initialized = true;
        this._logger?.info?.("AdvertisementLifecycleManager ready");

        return { pollIntervalMs: this._pollIntervalMs };

    }

    /**
     * Optional standalone poller. Prefer scheduler-driven processExpirations().
     */
    start() {

        this._assertReady();

        if (this._running) {

            return;

        }

        this._running = true;
        this.processExpirations();

        if (this._pollIntervalMs > 0) {

            this._timer = this._setIntervalFn(() => {

                try {

                    this.processExpirations();

                } catch (error) {

                    this._logger?.error?.(
                        `AdvertisementLifecycleManager tick failed: ${error.message}`
                    );

                }

            }, this._pollIntervalMs);

        }

    }

    stop() {

        if (this._timer != null) {

            this._clearIntervalFn(this._timer);
            this._timer = null;

        }

        this._running = false;

    }

    shutdown() {

        this.stop();
        this._initialized = false;

    }

    /**
     * Scan campaigns and expire ACTIVE ones past expiresAt.
     * Failures are isolated — advertising must not break the server.
     */
    processExpirations(now = this._nowFn()) {

        if (!this._initialized || !this._advertisementManager) {

            return [];

        }

        try {

            const campaigns = this._advertisementManager
                .listCampaignsForScheduler?.() ?? [];

            const expired = [];

            for (const campaign of campaigns) {

                if (campaign?.status !== ADVERTISEMENT_STATUS.ACTIVE) {

                    continue;

                }

                if (!isAdvertisementExpired(campaign.expiresAt, now)) {

                    continue;

                }

                const result = this._advertisementManager.markCampaignExpired(
                    campaign.id,
                    { now }
                );

                if (result) {

                    expired.push(result);

                }

            }

            if (expired.length > 0) {

                this._logger?.info?.(
                    `AdvertisementLifecycleManager expired=${expired.length}`
                );

            }

            return expired;

        } catch (error) {

            this._logger?.error?.(
                `AdvertisementLifecycleManager processExpirations failed: ${error.message}`
            );

            return [];

        }

    }

    _assertReady() {

        if (!this._initialized) {

            throw new Error("AdvertisementLifecycleManager is not initialized");

        }

    }

}
