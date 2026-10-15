/**
 * Durable, immutable manifests for resumable room-payment preparation.
 *
 * A manifest records the complete normalized preparation descriptor before
 * any payment intent, wallet reservation snapshot, or stake entry is written.
 * Room files are installed with an exclusive hard link so concurrent
 * create-if-absent calls cannot replace the first descriptor.
 */

import { createHash, randomBytes } from "node:crypto";
import {
    closeSync,
    existsSync,
    fsyncSync,
    linkSync,
    mkdirSync,
    openSync,
    readFileSync,
    unlinkSync,
    writeFileSync
} from "node:fs";
import { join } from "node:path";

const SCHEMA_VERSION = 1;
const DESCRIPTOR_KEYS = Object.freeze([
    "roomId",
    "roomCreatedAt",
    "roomDeadlineMs",
    "network",
    "asset",
    "denomination",
    "stakeLedgerRelation",
    "requiredPlayers"
]);
const DENOMINATION_KEYS = Object.freeze([
    "asset",
    "symbol",
    "network",
    "atomicUnitsPerUnit"
]);
const PAYMENT_KEYS = Object.freeze([
    "roomId",
    "paymentReference",
    "playerId",
    "expectedSender",
    "amountAtomic"
]);

export class RoomPreparationManifestError extends Error {

    constructor(message, details = {}) {
        super(message);
        this.name = "RoomPreparationManifestError";
        this.code = "ROOM_PREPARATION_MANIFEST_INVALID";
        this.details = Object.freeze({ ...details });
    }

}

function requireRecord(value, label, keys) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new RoomPreparationManifestError(`${label} must be an object`);
    }
    const actual = Reflect.ownKeys(value);
    if (actual.length !== keys.length
        || actual.some((key) => typeof key !== "string" || !keys.includes(key))) {
        throw new RoomPreparationManifestError(`${label} has missing or unsupported fields`);
    }
    return value;
}

function requireText(value, label) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new RoomPreparationManifestError(`${label} must be a non-empty string`);
    }
    return value;
}

function freezeManifest(record) {
    for (const payment of record.descriptor.requiredPlayers) {
        Object.freeze(payment);
    }
    Object.freeze(record.descriptor.requiredPlayers);
    Object.freeze(record.descriptor.denomination);
    Object.freeze(record.descriptor);
    return Object.freeze(record);
}

function buildRecord(roomId, descriptor, preparationStartedAtMs) {
    requireText(roomId, "roomId");
    if (!Number.isSafeInteger(preparationStartedAtMs) || preparationStartedAtMs <= 0) {
        throw new RoomPreparationManifestError("preparationStartedAtMs must be a positive safe integer", {
            roomId
        });
    }
    requireRecord(descriptor, "descriptor", DESCRIPTOR_KEYS);
    if (descriptor.roomId !== roomId
        || !Number.isSafeInteger(descriptor.roomCreatedAt)
        || descriptor.roomCreatedAt <= 0
        || !Number.isSafeInteger(descriptor.roomDeadlineMs)
        || descriptor.roomDeadlineMs <= descriptor.roomCreatedAt) {
        throw new RoomPreparationManifestError("descriptor room identity or deadline is invalid", {
            roomId
        });
    }
    requireText(descriptor.network, "network");
    requireText(descriptor.asset, "asset");
    requireText(descriptor.stakeLedgerRelation, "stakeLedgerRelation");
    const denomination = requireRecord(
        descriptor.denomination,
        "descriptor.denomination",
        DENOMINATION_KEYS
    );
    requireText(denomination.asset, "denomination.asset");
    requireText(denomination.symbol, "denomination.symbol");
    requireText(denomination.network, "denomination.network");
    if (!Number.isSafeInteger(denomination.atomicUnitsPerUnit)
        || denomination.atomicUnitsPerUnit <= 0
        || denomination.asset !== descriptor.asset
        || denomination.network !== descriptor.network) {
        throw new RoomPreparationManifestError("descriptor denomination is invalid", { roomId });
    }
    if (!Array.isArray(descriptor.requiredPlayers)
        || descriptor.requiredPlayers.length === 0) {
        throw new RoomPreparationManifestError("descriptor requiredPlayers must be non-empty", {
            roomId
        });
    }

    const requiredPlayers = descriptor.requiredPlayers.map((payment, index) => {
        requireRecord(payment, `descriptor.requiredPlayers[${index}]`, PAYMENT_KEYS);
        if (payment.roomId !== roomId
            || !Number.isSafeInteger(payment.amountAtomic)
            || payment.amountAtomic <= 0) {
            throw new RoomPreparationManifestError("descriptor payment identity is invalid", {
                roomId,
                index
            });
        }
        return {
            roomId,
            paymentReference: requireText(payment.paymentReference, "paymentReference"),
            playerId: requireText(payment.playerId, "playerId"),
            expectedSender: requireText(payment.expectedSender, "expectedSender"),
            amountAtomic: payment.amountAtomic
        };
    });

    return freezeManifest({
        schemaVersion: SCHEMA_VERSION,
        roomId,
        preparationStartedAtMs,
        descriptor: {
            roomId,
            roomCreatedAt: descriptor.roomCreatedAt,
            roomDeadlineMs: descriptor.roomDeadlineMs,
            network: descriptor.network,
            asset: descriptor.asset,
            denomination: {
                asset: denomination.asset,
                symbol: denomination.symbol,
                network: denomination.network,
                atomicUnitsPerUnit: denomination.atomicUnitsPerUnit
            },
            stakeLedgerRelation: descriptor.stakeLedgerRelation,
            requiredPlayers
        }
    });
}

function canonicalJson(value) {
    return JSON.stringify(value);
}

export class RoomPreparationManifestStore {

    constructor({ dataDir } = {}) {
        if (typeof dataDir !== "string" || dataDir.trim() === "") {
            throw new RoomPreparationManifestError("dataDir must be a non-empty string");
        }
        this._dataDir = dataDir;
        this._initialized = false;
    }

    initialize() {
        mkdirSync(this._dataDir, { recursive: true });
        this._initialized = true;
    }

    get(roomId) {
        this._assertInitialized();
        requireText(roomId, "roomId");
        const filePath = this._manifestPath(roomId);
        if (!existsSync(filePath)) {
            return null;
        }
        return this._read(filePath, roomId);
    }

    /**
     * Create a room manifest exactly once, or return the equivalent existing
     * record. A conflicting or corrupted existing file is never overwritten.
     */
    createIfAbsent(roomId, descriptor, preparationStartedAtMs) {
        this._assertInitialized();
        const requested = buildRecord(roomId, descriptor, preparationStartedAtMs);
        const filePath = this._manifestPath(roomId);
        if (existsSync(filePath)) {
            return this._requireEquivalent(this._read(filePath, roomId), requested);
        }

        const tempPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
        let fd = null;
        try {
            fd = openSync(tempPath, "wx");
            writeFileSync(fd, `${JSON.stringify(requested, null, 2)}\n`, "utf8");
            fsyncSync(fd);
            closeSync(fd);
            fd = null;
            try {
                linkSync(tempPath, filePath);
                return requested;
            } catch (error) {
                if (error?.code !== "EEXIST") {
                    throw error;
                }
                return this._requireEquivalent(this._read(filePath, roomId), requested);
            }
        } catch (error) {
            if (error instanceof RoomPreparationManifestError) {
                throw error;
            }
            throw new RoomPreparationManifestError(
                `failed to persist room preparation manifest: ${error?.message ?? error}`,
                { roomId }
            );
        } finally {
            if (fd !== null) {
                try { closeSync(fd); } catch { /* preserve the original failure */ }
            }
            try { unlinkSync(tempPath); } catch { /* absent after cleanup or crash */ }
        }
    }

    _read(filePath, roomId) {
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(filePath, "utf8"));
        } catch (error) {
            throw new RoomPreparationManifestError(
                `room preparation manifest is unreadable: ${error?.message ?? error}`,
                { roomId }
            );
        }
        requireRecord(parsed, "manifest", [
            "schemaVersion",
            "roomId",
            "preparationStartedAtMs",
            "descriptor"
        ]);
        if (parsed.schemaVersion !== SCHEMA_VERSION || parsed.roomId !== roomId) {
            throw new RoomPreparationManifestError("manifest schema or room identity is invalid", {
                roomId
            });
        }
        const record = buildRecord(roomId, parsed.descriptor, parsed.preparationStartedAtMs);
        if (canonicalJson(parsed) !== canonicalJson(record)) {
            throw new RoomPreparationManifestError("manifest is not in canonical form", { roomId });
        }
        return record;
    }

    _requireEquivalent(existing, requested) {
        if (existing.schemaVersion !== requested.schemaVersion
            || existing.roomId !== requested.roomId
            || canonicalJson(existing.descriptor) !== canonicalJson(requested.descriptor)) {
            throw new RoomPreparationManifestError(
                "room already has a conflicting immutable preparation manifest",
                { roomId: requested.roomId }
            );
        }
        return existing;
    }

    _manifestPath(roomId) {
        const id = createHash("sha256").update(roomId, "utf8").digest("hex");
        return join(this._dataDir, `${id}.json`);
    }

    _assertInitialized() {
        if (!this._initialized) {
            throw new RoomPreparationManifestError("manifest store is not initialized");
        }
    }

}
