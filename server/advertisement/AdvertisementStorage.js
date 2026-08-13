/**
 * R14.2 / R16.8 — AdvertisementStorage.
 * Campaign metadata + banner assets (local FS or Cloudflare R2).
 * Admin audit history remains on local filesystem.
 */

import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ADVERTISEMENT_SCHEMA_VERSION } from "./advertisementTypes.js";
import { resolveAdvertisementR2Config } from "./advertisementR2Config.js";
import { AdvertisementR2Storage } from "./AdvertisementR2Storage.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export function resolveDefaultAdvertisementDataDir() {

    return join(MODULE_DIR, "..", "data", "advertisements");

}

function atomicWriteJson(filePath, payload) {

    mkdirSync(dirname(filePath), { recursive: true });

    const temp = `${filePath}.tmp`;

    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    renameSync(temp, filePath);

}

function sortCampaigns(campaigns) {

    return campaigns.slice().sort((left, right) => {

        const priorityDelta = (left.priority ?? 0) - (right.priority ?? 0);

        if (priorityDelta !== 0) {

            return priorityDelta;

        }

        return String(left.id).localeCompare(String(right.id));

    });

}

export class AdvertisementStorage {

    constructor({
        logger = null,
        dataDir = null,
        r2Config = null,
        r2Storage = null
    } = {}) {

        this._logger = logger;
        this._dataDir = dataDir || resolveDefaultAdvertisementDataDir();
        this._r2Config = r2Config ?? resolveAdvertisementR2Config();
        this._r2Storage = r2Storage;
        this._useR2 = false;
        this._initialized = false;

    }

    get dataDir() {

        return this._dataDir;

    }

    get backend() {

        return this._useR2 ? "r2" : "local";

    }

    get campaignsDir() {

        if (this._useR2 && this._r2Storage) {

            return this._r2Storage.campaignsDir;

        }

        return join(this._dataDir, "campaigns");

    }

    get assetsDir() {

        if (this._useR2 && this._r2Storage) {

            return this._r2Storage.assetsDir;

        }

        return join(this._dataDir, "assets");

    }

    get historyDir() {

        return join(this._dataDir, "history");

    }

    initialize({ dataDir = null } = {}) {

        if (dataDir) {

            this._dataDir = dataDir;

        }

        mkdirSync(this.historyDir, { recursive: true });

        this._useR2 = this._r2Config.useR2 === true;

        if (this._useR2) {

            this._r2Storage = this._r2Storage
                ?? new AdvertisementR2Storage({
                    logger: this._logger,
                    config: this._r2Config
                });

            const r2Info = this._r2Storage.initialize();

            this._initialized = true;

            this._logger?.info?.(
                `AdvertisementStorage ready | backend=r2`
                + ` | bucket=${r2Info.bucket}`
                + ` | prefix=${r2Info.prefix}`
                + ` | historyDir=${this.historyDir}`
            );

            return {
                backend: "r2",
                dataDir: this._dataDir,
                campaignsDir: this.campaignsDir,
                assetsDir: this.assetsDir,
                historyDir: this.historyDir,
                ...r2Info
            };

        }

        mkdirSync(this.campaignsDir, { recursive: true });
        mkdirSync(this.assetsDir, { recursive: true });

        this._initialized = true;

        this._logger?.info?.(
            `AdvertisementStorage ready | backend=local | dataDir=${this._dataDir}`
        );

        return {
            backend: "local",
            dataDir: this._dataDir,
            campaignsDir: this.campaignsDir,
            assetsDir: this.assetsDir,
            historyDir: this.historyDir
        };

    }

    _assertReady() {

        if (!this._initialized) {

            throw new Error("AdvertisementStorage is not initialized");

        }

    }

    _campaignPath(campaignId) {

        return join(this._dataDir, "campaigns", `${campaignId}.json`);

    }

    _assetPath(filename) {

        return join(this._dataDir, "assets", filename);

    }

    measureAssetsBytes() {

        this._assertReady();

        if (this._useR2) {

            return this._r2Storage.measureAssetsBytes();

        }

        const assetsDir = join(this._dataDir, "assets");

        if (!existsSync(assetsDir)) {

            return 0;

        }

        let total = 0;

        for (const name of readdirSync(assetsDir)) {

            const absolute = join(assetsDir, name);

            try {

                const stats = statSync(absolute);

                if (stats.isFile()) {

                    total += stats.size;

                }

            } catch {

                // Ignore unreadable entries.

            }

        }

        return total;

    }

    assetExists(filename) {

        this._assertReady();

        if (this._useR2) {

            return this._r2Storage.assetExists(filename);

        }

        return existsSync(this._assetPath(filename));

    }

    writeAsset(filename, bytes) {

        this._assertReady();

        if (!Buffer.isBuffer(bytes)) {

            throw new Error("Asset bytes must be a Buffer");

        }

        if (this._useR2) {

            return this._r2Storage.writeAsset(filename, bytes);

        }

        const absolute = this._assetPath(filename);
        const temp = `${absolute}.tmp`;

        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(temp, bytes);
        renameSync(temp, absolute);

        return {
            filename,
            absolutePath: absolute,
            sizeBytes: bytes.byteLength
        };

    }

    deleteAsset(filename) {

        this._assertReady();

        if (this._useR2) {

            this._r2Storage.deleteAsset(filename);

            return;

        }

        const absolute = this._assetPath(filename);

        if (existsSync(absolute)) {

            unlinkSync(absolute);

        }

    }

    readAsset(filename) {

        this._assertReady();

        if (this._useR2) {

            return this._r2Storage.readAsset(filename);

        }

        const absolute = this._assetPath(filename);

        if (!existsSync(absolute)) {

            return null;

        }

        return readFileSync(absolute);

    }

    saveCampaign(campaign) {

        this._assertReady();

        if (!campaign?.id) {

            throw new Error("Campaign id is required");

        }

        const payload = {
            schemaVersion: ADVERTISEMENT_SCHEMA_VERSION,
            ...campaign
        };

        if (this._useR2) {

            return this._r2Storage.saveCampaign(payload);

        }

        atomicWriteJson(this._campaignPath(campaign.id), payload);

        return payload;

    }

    loadCampaign(campaignId) {

        this._assertReady();

        if (this._useR2) {

            return this._r2Storage.loadCampaign(campaignId);

        }

        const absolute = this._campaignPath(campaignId);

        if (!existsSync(absolute)) {

            return null;

        }

        return JSON.parse(readFileSync(absolute, "utf8"));

    }

    listCampaigns() {

        this._assertReady();

        if (this._useR2) {

            return this._r2Storage.listCampaigns();

        }

        const campaignsDir = join(this._dataDir, "campaigns");

        if (!existsSync(campaignsDir)) {

            return [];

        }

        return sortCampaigns(
            readdirSync(campaignsDir)
                .filter((name) => name.endsWith(".json"))
                .map((name) => {

                    try {

                        return JSON.parse(
                            readFileSync(join(campaignsDir, name), "utf8")
                        );

                    } catch {

                        return null;

                    }

                })
                .filter(Boolean)
        );

    }

    deleteCampaign(campaignId) {

        this._assertReady();

        if (this._useR2) {

            return this._r2Storage.deleteCampaign(campaignId);

        }

        const absolute = this._campaignPath(campaignId);

        if (existsSync(absolute)) {

            unlinkSync(absolute);

            return true;

        }

        return false;

    }

    /**
     * Append-only history record (R14.3+). Never overwritten by campaign delete.
     * R16.8 — always local filesystem (delivery JSONL uses AdvertisementHistoryService).
     */
    appendHistory(event) {

        this._assertReady();

        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const id = String(event?.advertisementId || event?.id || "unknown");
        const type = String(event?.type || "EVENT");
        const filename = `${stamp}_${type}_${id}.json`;
        const absolute = join(this.historyDir, filename);

        atomicWriteJson(absolute, {
            ...event,
            recordedAt: event?.recordedAt || new Date().toISOString()
        });

        return {
            filename,
            absolutePath: absolute
        };

    }

    listHistory() {

        this._assertReady();

        if (!existsSync(this.historyDir)) {

            return [];

        }

        return readdirSync(this.historyDir)
            .filter((name) => name.endsWith(".json"))
            .map((name) => {

                try {

                    return {
                        filename: name,
                        ...JSON.parse(
                            readFileSync(join(this.historyDir, name), "utf8")
                        )
                    };

                } catch {

                    return null;

                }

            })
            .filter(Boolean);

    }

}
