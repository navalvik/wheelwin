/**
 * R14.2 — AdvertisementStorage.
 * File persistence for campaign metadata and banner assets only.
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

export class AdvertisementStorage {

    constructor({
        logger = null,
        dataDir = null
    } = {}) {

        this._logger = logger;
        this._dataDir = dataDir || resolveDefaultAdvertisementDataDir();
        this._initialized = false;

    }

    get dataDir() {

        return this._dataDir;

    }

    get campaignsDir() {

        return join(this._dataDir, "campaigns");

    }

    get assetsDir() {

        return join(this._dataDir, "assets");

    }

    get historyDir() {

        return join(this._dataDir, "history");

    }

    initialize({ dataDir = null } = {}) {

        if (dataDir) {

            this._dataDir = dataDir;

        }

        mkdirSync(this.campaignsDir, { recursive: true });
        mkdirSync(this.assetsDir, { recursive: true });
        mkdirSync(this.historyDir, { recursive: true });

        this._initialized = true;

        this._logger?.info?.(
            `AdvertisementStorage ready | dataDir=${this._dataDir}`
        );

        return {
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

        return join(this.campaignsDir, `${campaignId}.json`);

    }

    _assetPath(filename) {

        return join(this.assetsDir, filename);

    }

    measureAssetsBytes() {

        this._assertReady();

        if (!existsSync(this.assetsDir)) {

            return 0;

        }

        let total = 0;

        for (const name of readdirSync(this.assetsDir)) {

            const absolute = join(this.assetsDir, name);

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

        return existsSync(this._assetPath(filename));

    }

    writeAsset(filename, bytes) {

        this._assertReady();

        if (!Buffer.isBuffer(bytes)) {

            throw new Error("Asset bytes must be a Buffer");

        }

        const absolute = this._assetPath(filename);
        const temp = `${absolute}.tmp`;

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

        const absolute = this._assetPath(filename);

        if (existsSync(absolute)) {

            unlinkSync(absolute);

        }

    }

    readAsset(filename) {

        this._assertReady();

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

        atomicWriteJson(this._campaignPath(campaign.id), payload);

        return payload;

    }

    loadCampaign(campaignId) {

        this._assertReady();

        const absolute = this._campaignPath(campaignId);

        if (!existsSync(absolute)) {

            return null;

        }

        return JSON.parse(readFileSync(absolute, "utf8"));

    }

    listCampaigns() {

        this._assertReady();

        if (!existsSync(this.campaignsDir)) {

            return [];

        }

        return readdirSync(this.campaignsDir)
            .filter((name) => name.endsWith(".json"))
            .map((name) => {

                try {

                    return JSON.parse(
                        readFileSync(join(this.campaignsDir, name), "utf8")
                    );

                } catch {

                    return null;

                }

            })
            .filter(Boolean)
            .sort((left, right) => {

                const priorityDelta = (left.priority ?? 0) - (right.priority ?? 0);

                if (priorityDelta !== 0) {

                    return priorityDelta;

                }

                return String(left.id).localeCompare(String(right.id));

            });

    }

    deleteCampaign(campaignId) {

        this._assertReady();

        const absolute = this._campaignPath(campaignId);

        if (existsSync(absolute)) {

            unlinkSync(absolute);

            return true;

        }

        return false;

    }

    /**
     * Append-only history record (R14.3+). Never overwritten by campaign delete.
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
