/**
 * R14.4 / R14.7 — AdvertisementSelectionEngine.
 * Filters ACTIVE campaigns and orders them for the authoritative scheduler.
 * Auction ranking uses priority + advertiserBid (metadata only; no payments).
 */

import { ADVERTISEMENT_STATUS } from "./advertisementTypes.js";

function resolveAdvertiserBid(campaign) {

    if (campaign?.advertiserBid != null && campaign.advertiserBid !== "") {

        const bid = Number(campaign.advertiserBid);

        return Number.isFinite(bid) ? bid : 0;

    }

    if (campaign?.bid != null && campaign.bid !== "") {

        const bid = Number(campaign.bid);

        return Number.isFinite(bid) ? bid : 0;

    }

    return 0;

}

function compareCampaigns(left, right) {

    const priorityDelta = (left.priority ?? 0) - (right.priority ?? 0);

    if (priorityDelta !== 0) {

        return priorityDelta;

    }

    // Higher advertiserBid ranks first (future auction extension point).
    const bidDelta = resolveAdvertiserBid(right) - resolveAdvertiserBid(left);

    if (bidDelta !== 0) {

        return bidDelta;

    }

    return String(left.id ?? "").localeCompare(String(right.id ?? ""));

}

export class AdvertisementSelectionEngine {

    constructor({ advertisementManager = null } = {}) {

        this._advertisementManager = advertisementManager;

    }

    /**
     * @returns {object[]} ACTIVE campaigns only, sorted for rotation.
     */
    listEligibleCampaigns() {

        const campaigns = this._advertisementManager?.listCampaignsForScheduler?.()
            ?? [];

        return campaigns
            .filter((campaign) => campaign?.status === ADVERTISEMENT_STATUS.ACTIVE)
            .slice()
            .sort(compareCampaigns);

    }

    /**
     * Pick the next campaign after `previousId` (round-robin through sorted list).
     * Returns null when nothing is eligible.
     */
    selectNext({ previousId = null } = {}) {

        const eligible = this.listEligibleCampaigns();

        if (eligible.length === 0) {

            return null;

        }

        if (!previousId) {

            return eligible[0];

        }

        const index = eligible.findIndex((campaign) => campaign.id === previousId);

        if (index < 0) {

            return eligible[0];

        }

        return eligible[(index + 1) % eligible.length];

    }

}

export { resolveAdvertiserBid };
