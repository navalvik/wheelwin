/**
 * R14.2 — AdvertisementManager (business layer).
 * Campaign CRUD + asset write. No scheduling / websocket / gameplay.
 */

import {
    canAccessDeveloperConsole,
    canPerformAdministratorActions
} from "../console/auth/developerRoles.js";
import { ADVERTISEMENT_STATUS } from "./advertisementTypes.js";
import { AdvertisementStorage } from "./AdvertisementStorage.js";
import {
    AdvertisementValidationError,
    AdvertisementValidator
} from "./AdvertisementValidator.js";

function nowIso() {

    return new Date().toISOString();

}

function assertAdministrator(role) {

    if (!canPerformAdministratorActions(role)) {

        throw new AdvertisementValidationError(
            "FORBIDDEN",
            "Administrator role required for advertisement mutations"
        );

    }

}

function assertReader(role) {

    if (!canAccessDeveloperConsole(role)) {

        throw new AdvertisementValidationError(
            "FORBIDDEN",
            "Developer console role required to read advertisements"
        );

    }

}

function allocateCampaignId(existing) {

    let max = 0;

    for (const campaign of existing) {

        const match = String(campaign.id ?? "").match(/^ad_(\d+)$/i);

        if (match) {

            max = Math.max(max, Number.parseInt(match[1], 10));

        }

    }

    return `ad_${String(max + 1).padStart(3, "0")}`;

}

function buildCampaignRecord({
    id,
    filename,
    priority,
    advertiserName = "",
    destinationUrl = "",
    status = ADVERTISEMENT_STATUS.ACTIVE,
    createdBy = "Administrator",
    expiresAt = null,
    sizeBytes = 0,
    extras = {}
}) {

    return {
        id,
        filename,
        priority,
        advertiserName: String(advertiserName ?? ""),
        destinationUrl: String(destinationUrl ?? ""),
        status,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        expiresAt: expiresAt || null,
        createdBy,
        sizeBytes,
        // Future fields (unused in R14.2).
        bid: extras.bid ?? null,
        clickCount: extras.clickCount ?? 0,
        impressionCount: extras.impressionCount ?? 0,
        renewalStatus: extras.renewalStatus ?? null
    };

}

export class AdvertisementManager {

    constructor({
        logger = null,
        storage = null,
        validator = null,
        dataDir = null
    } = {}) {

        this._logger = logger;
        this._storage = storage
            ?? new AdvertisementStorage({ logger, dataDir });
        this._validator = validator ?? new AdvertisementValidator();
        this._initialized = false;

    }

    initialize({ dataDir = null } = {}) {

        this._storage.initialize({ dataDir });
        this._initialized = true;

        this._logger?.info?.("AdvertisementManager ready");

        return {
            dataDir: this._storage.dataDir
        };

    }

    _assertReady() {

        if (!this._initialized) {

            throw new Error("AdvertisementManager is not initialized");

        }

    }

    getCampaigns({ role = "Viewer" } = {}) {

        this._assertReady();
        assertReader(role);

        return this._storage.listCampaigns();

    }

    getCampaignById(campaignId, { role = "Viewer" } = {}) {

        this._assertReady();
        assertReader(role);

        return this._storage.loadCampaign(campaignId);

    }

    /**
     * Create campaign + store asset bytes.
     *
     * @param {object} input
     * @param {string} input.filename — client-supplied name (sanitized)
     * @param {Buffer} input.bytes
     * @param {string} [input.advertiserName]
     * @param {string} [input.destinationUrl]
     * @param {string} [input.expiresAt]
     * @param {string} [input.status]
     * @param {string} [input.createdBy]
     * @param {string} [input.role] — caller role (Administrator required)
     */
    createCampaign(input = {}) {

        this._assertReady();

        const role = input.role ?? "Administrator";

        assertAdministrator(role);

        const currentTotalBytes = this._storage.measureAssetsBytes();

        const fileInfo = this._validator.validateFile({
            filename: input.filename,
            bytes: input.bytes,
            currentTotalBytes
        });

        if (this._storage.assetExists(fileInfo.filename)) {

            throw new AdvertisementValidationError(
                "ASSET_EXISTS",
                `Asset already exists: ${fileInfo.filename}`
            );

        }

        const destinationUrl = this._validator.validateDestinationUrl(
            input.destinationUrl
        );

        const existing = this._storage.listCampaigns();
        const id = allocateCampaignId(existing);

        const campaign = buildCampaignRecord({
            id,
            filename: fileInfo.filename,
            priority: fileInfo.priority,
            advertiserName: input.advertiserName,
            destinationUrl,
            status: input.status ?? ADVERTISEMENT_STATUS.ACTIVE,
            createdBy: input.createdBy ?? "Administrator",
            expiresAt: input.expiresAt ?? null,
            sizeBytes: fileInfo.sizeBytes
        });

        this._storage.writeAsset(fileInfo.filename, input.bytes);
        this._storage.saveCampaign(campaign);

        this._logger?.info?.(
            `Advertisement campaign created | id=${id} | file=${fileInfo.filename}`
        );

        return campaign;

    }

    updateCampaign(campaignId, patch = {}, { role = "Administrator" } = {}) {

        this._assertReady();
        assertAdministrator(role);

        const existing = this._storage.loadCampaign(campaignId);

        if (!existing) {

            throw new AdvertisementValidationError(
                "NOT_FOUND",
                `Campaign not found: ${campaignId}`
            );

        }

        const next = { ...existing };

        if (Object.prototype.hasOwnProperty.call(patch, "advertiserName")) {

            next.advertiserName = String(patch.advertiserName ?? "");

        }

        if (Object.prototype.hasOwnProperty.call(patch, "destinationUrl")) {

            next.destinationUrl = this._validator.validateDestinationUrl(
                patch.destinationUrl
            );

        }

        if (Object.prototype.hasOwnProperty.call(patch, "priority")) {

            const priority = Number.parseInt(patch.priority, 10);

            if (!Number.isFinite(priority) || priority < 0) {

                throw new AdvertisementValidationError(
                    "INVALID_PRIORITY",
                    "priority must be a non-negative integer"
                );

            }

            next.priority = priority;

        }

        if (Object.prototype.hasOwnProperty.call(patch, "status")) {

            const allowed = Object.values(ADVERTISEMENT_STATUS);

            if (!allowed.includes(patch.status)) {

                throw new AdvertisementValidationError(
                    "INVALID_STATUS",
                    `Unsupported status: ${patch.status}`
                );

            }

            next.status = patch.status;

        }

        if (Object.prototype.hasOwnProperty.call(patch, "expiresAt")) {

            next.expiresAt = patch.expiresAt || null;

        }

        if (Object.prototype.hasOwnProperty.call(patch, "bid")) {

            next.bid = patch.bid ?? null;

        }

        if (Object.prototype.hasOwnProperty.call(patch, "renewalStatus")) {

            next.renewalStatus = patch.renewalStatus ?? null;

        }

        next.updatedAt = nowIso();

        return this._storage.saveCampaign(next);

    }

    disableCampaign(campaignId, { role = "Administrator" } = {}) {

        return this.updateCampaign(
            campaignId,
            { status: ADVERTISEMENT_STATUS.DISABLED },
            { role }
        );

    }

    /**
     * Remove campaign metadata and asset file.
     */
    deleteCampaign(campaignId, { role = "Administrator" } = {}) {

        this._assertReady();
        assertAdministrator(role);

        const existing = this._storage.loadCampaign(campaignId);

        if (!existing) {

            throw new AdvertisementValidationError(
                "NOT_FOUND",
                `Campaign not found: ${campaignId}`
            );

        }

        this._storage.deleteCampaign(campaignId);

        if (existing.filename) {

            this._storage.deleteAsset(existing.filename);

        }

        this._logger?.info?.(
            `Advertisement campaign deleted | id=${campaignId}`
        );

        return { deleted: true, id: campaignId };

    }

    getStorageUsage({ role = "Viewer" } = {}) {

        this._assertReady();
        assertReader(role);

        return {
            usedBytes: this._storage.measureAssetsBytes(),
            assetsDir: this._storage.assetsDir,
            campaignsDir: this._storage.campaignsDir,
            historyDir: this._storage.historyDir
        };

    }

}

export {
    AdvertisementValidationError,
    AdvertisementValidator,
    AdvertisementStorage
};
