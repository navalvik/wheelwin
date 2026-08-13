/**
 * R14.6 — AdvertisementRedirectService.
 * Click → record CLICK (deduped) → 302 to advertiser destination.
 * No personal data. No direct client exposure of advertiser URL required.
 */

import {
    AdvertisementValidationError,
    validateDestinationUrl
} from "./AdvertisementValidator.js";

export const ADVERTISEMENT_CLICK_DEBOUNCE_MS = 3_000;

export class AdvertisementRedirectService {

    constructor({
        logger = null,
        advertisementManager = null,
        historyService = null,
        debounceMs = ADVERTISEMENT_CLICK_DEBOUNCE_MS,
        nowFn = () => Date.now()
    } = {}) {

        this._logger = logger;
        this._advertisementManager = advertisementManager;
        this._historyService = historyService;
        this._debounceMs = Number(debounceMs) > 0
            ? Number(debounceMs)
            : ADVERTISEMENT_CLICK_DEBOUNCE_MS;
        this._nowFn = nowFn;
        this._lastClickAt = new Map();
        this._initialized = false;

    }

    initialize() {

        this._initialized = true;
        this._logger?.info?.("AdvertisementRedirectService ready");

        return { debounceMs: this._debounceMs };

    }

    shutdown() {

        this._lastClickAt.clear();
        this._initialized = false;

    }

    /**
     * @returns {{
     *   status: number,
     *   location?: string,
     *   recorded: boolean,
     *   duplicate: boolean,
     *   error?: string,
     *   code?: string
     * }}
     */
    handleClick(advertisementId) {

        this._assertReady();

        const id = String(advertisementId || "").trim();

        if (!id) {

            return {
                status: 400,
                recorded: false,
                duplicate: false,
                error: "Advertisement id is required",
                code: "INVALID_ID"
            };

        }

        const campaign = this._loadCampaign(id);

        if (!campaign) {

            return {
                status: 404,
                recorded: false,
                duplicate: false,
                error: "Advertisement not found",
                code: "NOT_FOUND"
            };

        }

        const destinationUrl = String(campaign.destinationUrl || "").trim();

        if (!destinationUrl) {

            return {
                status: 400,
                recorded: false,
                duplicate: false,
                error: "Advertisement has no destination URL",
                code: "MISSING_DESTINATION"
            };

        }

        // Validate URL through existing validator.
        try {

            validateDestinationUrl(destinationUrl);

        } catch (error) {

            if (error instanceof AdvertisementValidationError) {

                return {
                    status: 400,
                    recorded: false,
                    duplicate: false,
                    error: error.message,
                    code: error.code
                };

            }

        }

        const now = this._nowFn();
        const last = this._lastClickAt.get(id) ?? 0;
        const duplicate = (now - last) < this._debounceMs;

        let recorded = false;

        if (!duplicate) {

            this._lastClickAt.set(id, now);

            try {

                this._historyService?.recordClick?.({
                    advertisementId: id,
                    filename: campaign.filename ?? null,
                    timestamp: now
                });

                recorded = true;

            } catch (error) {

                this._logger?.error?.(
                    `Advertisement click history failed: ${error.message}`
                );

            }

        }

        return {
            status: 302,
            location: destinationUrl,
            recorded,
            duplicate
        };

    }

    _loadCampaign(advertisementId) {

        // Public path — no console role gate.
        const campaigns = this._advertisementManager
            ?.listCampaignsForScheduler?.() ?? [];

        return campaigns.find((campaign) => campaign?.id === advertisementId)
            ?? null;

    }

    _assertReady() {

        if (!this._initialized) {

            throw new Error("AdvertisementRedirectService is not initialized");

        }

    }

}
