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
     * Create campaign metadata.
     * Provide either `bytes` (new asset) or an already-uploaded `filename`.
     */
    createCampaign(input = {}) {

        this._assertReady();

        const role = input.role ?? "Administrator";

        assertAdministrator(role);

        let fileInfo;
        let bytes = input.bytes ?? null;

        if (Buffer.isBuffer(bytes)) {

            const currentTotalBytes = this._storage.measureAssetsBytes();

            fileInfo = this._validator.validateFile({
                filename: input.filename,
                bytes,
                currentTotalBytes
            });

            if (this._storage.assetExists(fileInfo.filename)) {

                throw new AdvertisementValidationError(
                    "ASSET_EXISTS",
                    `Asset already exists: ${fileInfo.filename}`
                );

            }

            this._storage.writeAsset(fileInfo.filename, bytes);

        } else {

            fileInfo = this._validator.sanitizeFilename(input.filename);

            if (!this._storage.assetExists(fileInfo.filename)) {

                throw new AdvertisementValidationError(
                    "ASSET_MISSING",
                    `Upload asset before creating campaign: ${fileInfo.filename}`
                );

            }

            const assetBytes = this._storage.readAsset(fileInfo.filename);

            fileInfo = {
                ...fileInfo,
                sizeBytes: assetBytes?.byteLength ?? 0
            };

        }

        const destinationUrl = this._validator.validateDestinationUrl(
            input.destinationUrl
        );

        let priority = fileInfo.priority;

        if (input.priority != null && input.priority !== "") {

            priority = Number.parseInt(input.priority, 10);

            if (!Number.isFinite(priority) || priority < 0) {

                throw new AdvertisementValidationError(
                    "INVALID_PRIORITY",
                    "priority must be a non-negative integer"
                );

            }

        }

        const existing = this._storage.listCampaigns();
        const id = allocateCampaignId(existing);
        const actor = input.createdBy
            ?? input.username
            ?? "Administrator";

        const campaign = buildCampaignRecord({
            id,
            filename: fileInfo.filename,
            priority,
            advertiserName: input.advertiserName,
            destinationUrl,
            status: input.status ?? ADVERTISEMENT_STATUS.ACTIVE,
            createdBy: actor,
            expiresAt: input.expiresAt ?? null,
            sizeBytes: fileInfo.sizeBytes
        });

        this._storage.saveCampaign(campaign);

        this._logAction("ADVERTISEMENT_CREATED", {
            advertisementId: id,
            administrator: actor,
            filename: fileInfo.filename
        });

        return campaign;

    }

    /**
     * Upload banner bytes to assets/ (Administrator only).
     */
    uploadAsset(input = {}) {

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

        this._storage.writeAsset(fileInfo.filename, input.bytes);

        const actor = input.username ?? "Administrator";

        this._logAction("ADVERTISEMENT_UPLOADED", {
            advertisementId: null,
            administrator: actor,
            filename: fileInfo.filename,
            sizeBytes: fileInfo.sizeBytes
        });

        return {
            filename: fileInfo.filename,
            priority: fileInfo.priority,
            extension: fileInfo.extension,
            sizeBytes: fileInfo.sizeBytes
        };

    }

    updateCampaign(campaignId, patch = {}, { role = "Administrator", username = null } = {}) {

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

        const saved = this._storage.saveCampaign(next);

        this._logAction("ADVERTISEMENT_UPDATED", {
            advertisementId: campaignId,
            administrator: username ?? "Administrator"
        });

        return saved;

    }

    disableCampaign(campaignId, { role = "Administrator", username = null } = {}) {

        const saved = this.updateCampaign(
            campaignId,
            { status: ADVERTISEMENT_STATUS.DISABLED },
            { role, username }
        );

        this._logAction("ADVERTISEMENT_DISABLED", {
            advertisementId: campaignId,
            administrator: username ?? "Administrator"
        });

        return saved;

    }

    renewCampaign(campaignId, {
        role = "Administrator",
        username = null,
        expiresAt = null
    } = {}) {

        const patch = {
            status: ADVERTISEMENT_STATUS.ACTIVE,
            renewalStatus: null
        };

        if (expiresAt != null) {

            patch.expiresAt = expiresAt;

        }

        return this.updateCampaign(campaignId, patch, { role, username });

    }

    /**
     * Remove campaign metadata + asset, but archive a history snapshot first.
     */
    deleteCampaign(campaignId, { role = "Administrator", username = null } = {}) {

        this._assertReady();
        assertAdministrator(role);

        const existing = this._storage.loadCampaign(campaignId);

        if (!existing) {

            throw new AdvertisementValidationError(
                "NOT_FOUND",
                `Campaign not found: ${campaignId}`
            );

        }

        this._storage.appendHistory({
            type: "CAMPAIGN_DELETED",
            advertisementId: campaignId,
            campaignSnapshot: existing,
            administrator: username ?? "Administrator",
            timestamp: nowIso()
        });

        this._storage.deleteCampaign(campaignId);

        if (existing.filename) {

            this._storage.deleteAsset(existing.filename);

        }

        this._logAction("ADVERTISEMENT_DELETED", {
            advertisementId: campaignId,
            administrator: username ?? "Administrator"
        });

        return { deleted: true, id: campaignId, historyPreserved: true };

    }

    getStorageUsage({ role = "Viewer" } = {}) {

        this._assertReady();
        assertReader(role);

        return {
            usedBytes: this._storage.measureAssetsBytes(),
            assetsDir: this._storage.assetsDir,
            campaignsDir: this._storage.campaignsDir,
            historyDir: this._storage.historyDir,
            historyCount: this._storage.listHistory().length
        };

    }

    listHistory({ role = "Viewer" } = {}) {

        this._assertReady();
        assertReader(role);

        return this._storage.listHistory();

    }

    _logAction(eventName, payload = {}) {

        const timestamp = nowIso();

        this._logger?.info?.(
            `${eventName} | advertisementId=${payload.advertisementId ?? "null"}`
            + ` | administrator=${payload.administrator ?? "unknown"}`
            + ` | timestamp=${timestamp}`
            + (payload.filename ? ` | filename=${payload.filename}` : "")
        );

    }

}

export {
    AdvertisementValidationError,
    AdvertisementValidator,
    AdvertisementStorage
};
