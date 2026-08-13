/**
 * R14.7 — Campaign lifecycle, renewal, and auction preparation tests.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AdvertisementLifecycleManager } from "../advertisement/AdvertisementLifecycleManager.js";
import { AdvertisementManager } from "../advertisement/AdvertisementManager.js";
import { AdvertisementSelectionEngine } from "../advertisement/AdvertisementSelectionEngine.js";
import {
    ADVERTISEMENT_AUCTION_DEFAULTS,
    ADVERTISEMENT_STATUS,
    isAdvertisementExpired
} from "../advertisement/advertisementTypes.js";

function tinyJpeg() {

    return Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x01, 0x02, 0x03]);

}

function createStack() {

    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-ads-r147-"));
    const manager = new AdvertisementManager({ dataDir });

    manager.initialize();

    const selection = new AdvertisementSelectionEngine({
        advertisementManager: manager
    });

    const lifecycle = new AdvertisementLifecycleManager({
        advertisementManager: manager,
        nowFn: () => new Date("2026-08-15T12:00:00.000Z")
    });

    lifecycle.initialize();

    return {
        dataDir,
        manager,
        selection,
        lifecycle,
        create(filename, extras = {}) {

            return manager.createCampaign({
                filename,
                bytes: tinyJpeg(),
                advertiserName: extras.advertiserName ?? "Adv",
                destinationUrl: extras.destinationUrl ?? "https://example.com",
                priority: extras.priority,
                expiresAt: extras.expiresAt ?? null,
                advertiserBid: extras.advertiserBid,
                bidCurrency: extras.bidCurrency,
                role: "Administrator",
                createdBy: "Administrator"
            });

        },
        cleanup() {

            lifecycle.shutdown();
            rmSync(dataDir, { recursive: true, force: true });

        }
    };

}

{
    const stack = createStack();

    try {

        const campaign = stack.create("1_live.jpg", {
            expiresAt: "2099-01-01T00:00:00.000Z"
        });

        const eligible = stack.selection.listEligibleCampaigns();

        assert.equal(eligible.length, 1);
        assert.equal(eligible[0].id, campaign.id);
        assert.equal(eligible[0].status, ADVERTISEMENT_STATUS.ACTIVE);
        console.log("  1. Active campaign remains selectable");

    } finally {

        stack.cleanup();

    }

}

{
    const stack = createStack();

    try {

        const campaign = stack.create("1_old.jpg", {
            expiresAt: "2026-08-01T00:00:00.000Z"
        });

        assert.equal(
            isAdvertisementExpired(
                campaign.expiresAt,
                new Date("2026-08-15T12:00:00.000Z")
            ),
            true
        );

        const expired = stack.lifecycle.processExpirations();

        assert.equal(expired.length, 1);
        assert.equal(expired[0].id, campaign.id);
        assert.equal(
            expired[0].status,
            ADVERTISEMENT_STATUS.WAITING_OWNER_RENEWAL
        );

        const loaded = stack.manager.getCampaignById(campaign.id, {
            role: "Viewer"
        });

        assert.equal(
            loaded.status,
            ADVERTISEMENT_STATUS.WAITING_OWNER_RENEWAL
        );
        console.log("  2. Expired campaign changes to WAITING_OWNER_RENEWAL");

    } finally {

        stack.cleanup();

    }

}

{
    const stack = createStack();

    try {

        const campaign = stack.create("1_keep.jpg", {
            expiresAt: "2020-01-01T00:00:00.000Z"
        });

        stack.lifecycle.processExpirations();

        const loaded = stack.manager.getCampaignById(campaign.id, {
            role: "Viewer"
        });

        assert.ok(loaded);
        assert.equal(loaded.id, campaign.id);
        assert.equal(loaded.filename, "1_keep.jpg");
        console.log("  3. Expired campaign is not deleted");

    } finally {

        stack.cleanup();

    }

}

{
    const stack = createStack();

    try {

        const campaign = stack.create("1_asset.jpg", {
            expiresAt: "2020-01-01T00:00:00.000Z"
        });

        const assetPath = join(stack.dataDir, "assets", campaign.filename);

        assert.equal(existsSync(assetPath), true);

        stack.lifecycle.processExpirations();

        assert.equal(existsSync(assetPath), true);

        const asset = stack.manager.readPublicAsset(campaign.filename);

        assert.ok(asset);
        assert.equal(asset.filename, campaign.filename);
        console.log("  4. Asset file remains after expiration");

    } finally {

        stack.cleanup();

    }

}

{
    const stack = createStack();

    try {

        const campaign = stack.create("1_renew.jpg", {
            expiresAt: "2020-01-01T00:00:00.000Z"
        });

        stack.lifecycle.processExpirations();

        assert.equal(
            stack.manager.getCampaignById(campaign.id, { role: "Viewer" }).status,
            ADVERTISEMENT_STATUS.WAITING_OWNER_RENEWAL
        );

        const renewed = stack.manager.renewCampaign(campaign.id, {
            role: "Administrator",
            username: "admin",
            expiresAt: "2026-09-01T00:00:00.000Z"
        });

        assert.equal(renewed.status, ADVERTISEMENT_STATUS.ACTIVE);
        assert.equal(renewed.expiresAt, "2026-09-01T00:00:00.000Z");
        console.log("  5. Renewal changes status back to ACTIVE");

    } finally {

        stack.cleanup();

    }

}

{
    const stack = createStack();

    try {

        const campaign = stack.create("1_again.jpg", {
            expiresAt: "2020-01-01T00:00:00.000Z"
        });

        stack.lifecycle.processExpirations();
        assert.equal(stack.selection.listEligibleCampaigns().length, 0);

        stack.manager.renewCampaign(campaign.id, {
            role: "Administrator",
            expiresAt: "2099-06-01T00:00:00.000Z"
        });

        const eligible = stack.selection.listEligibleCampaigns();

        assert.equal(eligible.length, 1);
        assert.equal(eligible[0].id, campaign.id);
        assert.equal(eligible[0].status, ADVERTISEMENT_STATUS.ACTIVE);
        console.log("  6. Renewed campaign becomes selectable again");

    } finally {

        stack.cleanup();

    }

}

{
    const stack = createStack();

    try {

        const active = stack.create("1_on.jpg", {
            expiresAt: "2099-01-01T00:00:00.000Z"
        });
        const disabled = stack.create("2_off.jpg", {
            expiresAt: "2099-01-01T00:00:00.000Z"
        });

        stack.manager.disableCampaign(disabled.id, { role: "Administrator" });

        const waiting = stack.create("3_wait.jpg", {
            expiresAt: "2020-01-01T00:00:00.000Z"
        });

        stack.lifecycle.processExpirations();

        const eligible = stack.selection.listEligibleCampaigns();

        assert.equal(eligible.length, 1);
        assert.equal(eligible[0].id, active.id);
        assert.equal(
            eligible.some((c) => c.id === disabled.id),
            false
        );
        assert.equal(
            eligible.some((c) => c.id === waiting.id),
            false
        );
        console.log("  7. Disabled campaigns remain excluded");

    } finally {

        stack.cleanup();

    }

}

{
    const stack = createStack();

    try {

        const campaign = stack.create("1_bid.jpg", {
            expiresAt: "2099-01-01T00:00:00.000Z",
            advertiserBid: 42,
            bidCurrency: "MANUAL"
        });

        assert.equal(campaign.advertiserBid, 42);
        assert.equal(campaign.bidCurrency, "MANUAL");
        assert.equal(campaign.bid, 42);

        const defaults = stack.create("2_default.jpg", {
            expiresAt: "2099-01-01T00:00:00.000Z"
        });

        assert.equal(
            defaults.advertiserBid,
            ADVERTISEMENT_AUCTION_DEFAULTS.advertiserBid
        );
        assert.equal(
            defaults.bidCurrency,
            ADVERTISEMENT_AUCTION_DEFAULTS.bidCurrency
        );

        // Same priority: higher advertiserBid ranks first.
        stack.manager.updateCampaign(
            defaults.id,
            { priority: 1, advertiserBid: 10 },
            { role: "Administrator" }
        );
        stack.manager.updateCampaign(
            campaign.id,
            { priority: 1, advertiserBid: 50 },
            { role: "Administrator" }
        );

        const ordered = stack.selection.listEligibleCampaigns();

        assert.equal(ordered[0].id, campaign.id);
        assert.equal(ordered[1].id, defaults.id);

        const history = stack.manager.listHistory({ role: "Viewer" });

        // Expire + renew leaves history entries without deleting campaigns.
        stack.manager.updateCampaign(
            campaign.id,
            { expiresAt: "2020-01-01T00:00:00.000Z" },
            { role: "Administrator" }
        );
        stack.lifecycle.processExpirations();
        stack.manager.renewCampaign(campaign.id, {
            role: "Administrator",
            username: "admin",
            expiresAt: "2099-12-01T00:00:00.000Z"
        });

        const after = stack.manager.listHistory({ role: "Viewer" });

        assert.ok(after.length >= history.length + 2);
        assert.ok(after.some((entry) => entry.type === "CAMPAIGN_EXPIRED"));
        assert.ok(after.some((entry) => entry.type === "CAMPAIGN_RENEWED"));

        console.log("  8. Auction fields are stored correctly");

    } finally {

        stack.cleanup();

    }

}

console.log("advertisement.r147.test.js: all assertions passed");
