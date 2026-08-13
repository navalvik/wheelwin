/**
 * R16.8 — Synchronous R2 bridge + in-memory cache for advertisement storage.
 * Invokes advertisementR2Cli.js in a child process so AdvertisementManager stays sync.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveAdvertisementR2Config } from "./advertisementR2Config.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const R2_CLI_PATH = join(MODULE_DIR, "advertisementR2Cli.js");

const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

function sortCampaigns(campaigns) {

    return campaigns.slice().sort((left, right) => {

        const priorityDelta = (left.priority ?? 0) - (right.priority ?? 0);

        if (priorityDelta !== 0) {

            return priorityDelta;

        }

        return String(left.id).localeCompare(String(right.id));

    });

}

export class AdvertisementR2Storage {

    constructor({
        logger = null,
        config = null
    } = {}) {

        this._logger = logger;
        this._config = config ?? resolveAdvertisementR2Config();
        this._initialized = false;
        this._campaigns = new Map();
        this._assetSizes = new Map();
        this._assetCache = new Map();
        this._usedBytes = 0;

    }

    isConfigured() {

        return this._config.useR2 === true;

    }

    get storageLabel() {

        return `r2://${this._config.bucket}/${this._config.prefix}`;

    }

    get campaignsDir() {

        return `${this.storageLabel}/campaigns`;

    }

    get assetsDir() {

        return `${this.storageLabel}/assets`;

    }

    initialize() {

        if (!this.isConfigured()) {

            throw new Error("AdvertisementR2Storage is not configured");

        }

        const hydrated = this._invoke("hydrate", {});

        this._campaigns.clear();
        this._assetSizes.clear();
        this._assetCache.clear();

        for (const campaign of hydrated.campaigns ?? []) {

            if (campaign?.id) {

                this._campaigns.set(campaign.id, campaign);

            }

        }

        for (const filename of hydrated.assetFilenames ?? []) {

            this._assetSizes.set(filename, 0);

        }

        this._usedBytes = Number(hydrated.usedBytes) || 0;
        this._initialized = true;

        this._logger?.info?.(
            `AdvertisementR2Storage ready | bucket=${this._config.bucket}`
            + ` | prefix=${this._config.prefix}`
            + ` | campaigns=${this._campaigns.size}`
            + ` | assets=${this._assetSizes.size}`
        );

        return {
            backend: "r2",
            bucket: this._config.bucket,
            prefix: this._config.prefix,
            campaignsDir: this.campaignsDir,
            assetsDir: this.assetsDir
        };

    }

    _assertReady() {

        if (!this._initialized) {

            throw new Error("AdvertisementR2Storage is not initialized");

        }

    }

    _invoke(command, input) {

        const child = spawnSync(
            process.execPath,
            [R2_CLI_PATH, command, JSON.stringify(input)],
            {
                env: process.env,
                encoding: "utf8",
                maxBuffer: MAX_BUFFER_BYTES
            }
        );

        if (child.error) {

            throw child.error;

        }

        const stdout = String(child.stdout || "").trim();

        if (!stdout) {

            throw new Error(
                `Advertisement R2 command failed (${command}): empty response`
            );

        }

        let payload;

        try {

            payload = JSON.parse(stdout);

        } catch (error) {

            throw new Error(
                `Advertisement R2 command failed (${command}): invalid JSON`
                + ` | stderr=${String(child.stderr || "").trim()}`
            );

        }

        if (!payload.ok) {

            throw new Error(
                payload.error
                    || `Advertisement R2 command failed (${command})`
            );

        }

        if (payload.resultBase64 != null) {

            return Buffer.from(payload.resultBase64, "base64");

        }

        return payload.result;

    }

    measureAssetsBytes() {

        this._assertReady();

        return this._usedBytes;

    }

    assetExists(filename) {

        this._assertReady();

        if (this._assetSizes.has(filename) || this._assetCache.has(filename)) {

            return true;

        }

        const head = this._invoke("headAsset", { filename });

        if (head) {

            this._assetSizes.set(filename, head.sizeBytes ?? 0);

            return true;

        }

        return false;

    }

    writeAsset(filename, bytes) {

        this._assertReady();

        if (!Buffer.isBuffer(bytes)) {

            throw new Error("Asset bytes must be a Buffer");

        }

        this._invoke("putAsset", {
            filename,
            bytesBase64: bytes.toString("base64")
        });

        this._assetSizes.set(filename, bytes.byteLength);
        this._assetCache.set(filename, Buffer.from(bytes));
        this._recomputeUsedBytes();

        return {
            filename,
            absolutePath: `${this.assetsDir}/${filename}`,
            sizeBytes: bytes.byteLength
        };

    }

    deleteAsset(filename) {

        this._assertReady();

        this._invoke("deleteAsset", { filename });
        this._assetSizes.delete(filename);
        this._assetCache.delete(filename);
        this._recomputeUsedBytes();

    }

    readAsset(filename) {

        this._assertReady();

        if (this._assetCache.has(filename)) {

            return this._assetCache.get(filename);

        }

        const bytes = this._invoke("getAsset", { filename });

        if (!bytes) {

            return null;

        }

        const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);

        this._assetCache.set(filename, buffer);
        this._assetSizes.set(filename, buffer.byteLength);

        return buffer;

    }

    saveCampaign(campaign) {

        this._assertReady();

        if (!campaign?.id) {

            throw new Error("Campaign id is required");

        }

        this._invoke("putCampaign", { campaign });
        this._campaigns.set(campaign.id, campaign);

        return campaign;

    }

    loadCampaign(campaignId) {

        this._assertReady();

        if (this._campaigns.has(campaignId)) {

            return this._campaigns.get(campaignId);

        }

        const campaign = this._invoke("getCampaign", { campaignId });

        if (campaign) {

            this._campaigns.set(campaignId, campaign);

        }

        return campaign ?? null;

    }

    listCampaigns() {

        this._assertReady();

        return sortCampaigns([...this._campaigns.values()]);

    }

    deleteCampaign(campaignId) {

        this._assertReady();

        if (!this._campaigns.has(campaignId)) {

            const existing = this.loadCampaign(campaignId);

            if (!existing) {

                return false;

            }

        }

        this._invoke("deleteCampaign", { campaignId });
        this._campaigns.delete(campaignId);

        return true;

    }

    _recomputeUsedBytes() {

        let total = 0;

        for (const size of this._assetSizes.values()) {

            total += Number(size) || 0;

        }

        this._usedBytes = total;

    }

}
