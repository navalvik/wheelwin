/**
 * R16.8 — Advertisement R2 storage configuration + backend selection tests.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AdvertisementManager } from "../advertisement/AdvertisementManager.js";
import { AdvertisementStorage } from "../advertisement/AdvertisementStorage.js";
import { resolveAdvertisementR2Config } from "../advertisement/advertisementR2Config.js";

function tinyJpeg() {

    return Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x01, 0x02, 0x03]);

}

{
    const config = resolveAdvertisementR2Config({
        R2_BUCKET_NAME: "wheelwin-bucket",
        R2_ACCOUNT_ID: "acct",
        R2_ACCESS_KEY_ID: "key",
        R2_SECRET_ACCESS_KEY: "secret",
        ADVERTISEMENT_R2_PREFIX: "advertising"
    });

    assert.equal(config.useR2, true);
    assert.equal(config.bucket, "wheelwin-bucket");
    assert.equal(config.prefix, "advertising");
    assert.equal(config.campaignsPrefix, "advertising/campaigns");
    assert.equal(config.assetsPrefix, "advertising/assets");
    console.log("  1. R2 config resolves advertising prefix");

}

{
    const config = resolveAdvertisementR2Config({
        R2_BUCKET_NAME: "wheelwin-bucket",
        R2_ACCOUNT_ID: "acct",
        R2_ACCESS_KEY_ID: "key",
        R2_SECRET_ACCESS_KEY: "secret",
        ADVERTISEMENT_STORAGE_LOCAL: "true"
    });

    assert.equal(config.r2Configured, true);
    assert.equal(config.useR2, false);
    console.log("  2. ADVERTISEMENT_STORAGE_LOCAL forces local backend");

}

{
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-ads-r148-"));

    try {

        const mockR2 = {
            campaignsDir: "r2://bucket/advertising/campaigns",
            assetsDir: "r2://bucket/advertising/assets",
            _campaigns: new Map(),
            _assets: new Map(),
            initialize() {

                return {
                    backend: "r2",
                    bucket: "bucket",
                    prefix: "advertising"
                };

            },
            measureAssetsBytes() {

                let total = 0;

                for (const bytes of this._assets.values()) {

                    total += bytes.byteLength;

                }

                return total;

            },
            assetExists(filename) {

                return this._assets.has(filename);

            },
            writeAsset(filename, bytes) {

                this._assets.set(filename, Buffer.from(bytes));

                return {
                    filename,
                    absolutePath: `${this.assetsDir}/${filename}`,
                    sizeBytes: bytes.byteLength
                };

            },
            readAsset(filename) {

                return this._assets.get(filename) ?? null;

            },
            deleteAsset(filename) {

                this._assets.delete(filename);

            },
            saveCampaign(campaign) {

                this._campaigns.set(campaign.id, campaign);

                return campaign;

            },
            loadCampaign(id) {

                return this._campaigns.get(id) ?? null;

            },
            listCampaigns() {

                return [...this._campaigns.values()].sort(
                    (left, right) => (left.priority ?? 0) - (right.priority ?? 0)
                );

            },
            deleteCampaign(campaignId) {

                return this._campaigns.delete(campaignId);

            }
        };

        const storage = new AdvertisementStorage({
            dataDir,
            r2Config: {
                useR2: true,
                bucket: "bucket",
                prefix: "advertising"
            },
            r2Storage: mockR2
        });

        const info = storage.initialize();

        assert.equal(info.backend, "r2");
        assert.equal(storage.backend, "r2");

        const campaign = storage.saveCampaign({
            id: "ad_001",
            filename: "1_banner.jpg",
            priority: 1,
            status: "ACTIVE"
        });

        assert.equal(campaign.id, "ad_001");
        assert.equal(storage.listCampaigns().length, 1);
        assert.equal(storage.assetExists("1_banner.jpg"), false);

        storage.writeAsset("1_banner.jpg", tinyJpeg());
        assert.equal(storage.measureAssetsBytes(), tinyJpeg().byteLength);
        assert.ok(Buffer.isBuffer(storage.readAsset("1_banner.jpg")));

        const history = storage.appendHistory({
            type: "CAMPAIGN_CREATED",
            advertisementId: "ad_001"
        });

        assert.ok(history.absolutePath.includes("history"));
        assert.equal(storage.listHistory().length, 1);

        const manager = new AdvertisementManager({
            storage,
            dataDir
        });

        manager.initialize();

        const created = manager.createCampaign({
            filename: "2_offer.webp",
            bytes: tinyJpeg(),
            advertiserName: "Acme",
            destinationUrl: "https://example.com",
            role: "Administrator"
        });

        assert.equal(created.status, "ACTIVE");
        assert.equal(manager.getCampaigns({ role: "Administrator" }).length, 2);

    } finally {

        rmSync(dataDir, { recursive: true, force: true });

    }

    console.log("  3. R2 storage delegate preserves AdvertisementManager API");

}

console.log("advertisement.r148.test.js: all assertions passed");
