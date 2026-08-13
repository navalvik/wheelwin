/**
 * R14.4 — AdvertisementSelectionEngine.
 * Filters ACTIVE campaigns and orders them for the authoritative scheduler.
 * Does not own timers, sockets, or display history.
 */

import { ADVERTISEMENT_STATUS } from "./advertisementTypes.js";

function compareCampaigns(left, right) {

    const priorityDelta = (left.priority ?? 0) - (right.priority ?? 0);

    if (priorityDelta !== 0) {

        return priorityDelta;

    }

    // Extension point: higher bid wins when both present (payments later).
    const leftBid = left.bid == null ? null : Number(left.bid);
    const rightBid = right.bid == null ? null : Number(right.bid);

    if (leftBid != null && rightBid != null && leftBid !== rightBid) {

        return rightBid - leftBid;

    }

    if (leftBid != null && rightBid == null) {

        return -1;

    }

    if (leftBid == null && rightBid != null) {

        return 1;

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
