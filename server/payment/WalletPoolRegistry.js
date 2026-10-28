import { durableWriteJson } from './DurableJson.js';
/**
 * Phase 1 — Room wallet pool registry.
 *
 * R2 — 64 server-controlled game wallets.
 * R3 — at most one wallet assigned to each active room.
 * R8 — a wallet is never recycled while its previous room still has unresolved
 *      payment or refund obligations.
 *
 * Secret material policy: wallet secrets (private keys / mnemonics) are NEVER
 * loaded, retained, exposed, moved, rewritten, or deleted by this module. The
 * source file is parsed with a reviver that drops secret fields before any
 * record enters memory, and the durable snapshot contains only public
 * identity fields (wallet id, address, network, room number, reservation
 * status, owner room).
 */

import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    DEFAULT_ROOM_WALLET_NETWORK,
    ROOM_WALLET_POOL_SIZE,
    WALLET_POOL_SCHEMA_VERSION
} from "./RoomPaymentConstants.js";

import {
    PaymentConfigurationError,
    PaymentStorageError,
    PaymentValidationError,
    WalletAssignmentConflictError,
    WalletPoolExhaustedError,
    WalletRecyclingBlockedError
} from "./PaymentErrors.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** Resolved location of the 64-wallet testnet pool catalog. */
export function resolveDefaultRoomWalletCatalogPath() {
    if (process.env.ROOM_WALLETS_TESTNET_JSON_PATH) return process.env.ROOM_WALLETS_TESTNET_JSON_PATH;

    return join(
        MODULE_DIR,
        "..",
        "config",
        "room-wallets-testnet-ROOM_WALLETS_JSON.json"
    );

}

/** Key names whose values must never be parsed into memory. */
const SECRET_KEY_NAMES = Object.freeze([
    "secretKey",
    "secret",
    "privateKey",
    "mnemonic",
    "seed",
    "passphrase"
]);

/**
 * JSON.parse reviver that drops every secret-bearing property. The wallet
 * catalog on disk is never modified.
 *
 * @param {string} key
 * @param {unknown} value
 * @returns {unknown}
 */
function stripSecretsReviver(key, value) {

    if (SECRET_KEY_NAMES.includes(key)) {

        return undefined;

    }

    return value;

}

/**
 * Single room wallet entry (public identity only — no secret material).
 */
export class RoomWallet {

    constructor({
        walletId,
        roomNumber,
        address,
        publicKey = null,
        workchain = 0,
        network = DEFAULT_ROOM_WALLET_NETWORK,
        reservedByRoomId = null,
        reservedAt = null
    }) {

        if (typeof walletId !== "string" || walletId.trim() === "") {

            throw new PaymentValidationError("walletId must be a non-empty string");

        }

        if (typeof address !== "string" || address.trim() === "") {

            throw new PaymentValidationError("wallet address must be a non-empty string");

        }

        if (!Number.isInteger(roomNumber) || roomNumber < 1) {

            throw new PaymentValidationError(
                "roomNumber must be a positive integer",
                { roomNumber }
            );

        }

        this.walletId = walletId;

        this.roomNumber = roomNumber;

        this.address = address;

        this.publicKey = publicKey ?? null;

        this.workchain = Number.isInteger(workchain) ? workchain : 0;

        this.network = network ?? DEFAULT_ROOM_WALLET_NETWORK;

        this.reservedByRoomId = reservedByRoomId ?? null;

        this.reservedAt = reservedAt ?? null;

        Object.freeze(this);

    }

    isAvailable() {

        return this.reservedByRoomId === null;

    }

    /**
     * Public identity only — never secret material.
     */
    toRecord() {

        return Object.freeze({
            walletId: this.walletId,
            roomNumber: this.roomNumber,
            address: this.address,
            publicKey: this.publicKey,
            workchain: this.workchain,
            network: this.network,
            reservedByRoomId: this.reservedByRoomId,
            reservedAt: this.reservedAt
        });

    }

    static fromRecord(record) {

        if (!record || typeof record !== "object") {

            throw new PaymentValidationError(
                "room wallet record must be a non-null object"
            );

        }

        return new RoomWallet(record);

    }

}

export class WalletPoolRegistry {

    constructor({
        catalogPath = null,
        network = DEFAULT_ROOM_WALLET_NETWORK,
        logger = null
    } = {}) {

        this._logger = logger;

        this._catalogPath = catalogPath ?? resolveDefaultRoomWalletCatalogPath();

        this._network = network;

        /** @type {Map<string, RoomWallet>} keyed by walletId */
        this._wallets = new Map();

        /** @type {Map<string, string>} roomId -> walletId (active reservations) */
        this._roomToWallet = new Map();

        this._initialized = false;

    }

    /**
     * R2 — fixed pool size.
     */
    get size() {

        return ROOM_WALLET_POOL_SIZE;

    }

    get network() {

        return this._network;

    }

    get catalogPath() {

        return this._catalogPath;

    }

    /**
     * Load the wallet catalog (public identity only) and restore any durable
     * reservation snapshot.
     *
     * @param {{ snapshotDir?: string }} [options]
     */
    initialize(options = {}) {

        if (this._initialized) {

            return;

        }

        this._loadCatalog();

        const snapshotDir = options.snapshotDir ?? null;

        if (snapshotDir) {

            this._loadSnapshot(snapshotDir);

        }

        this._initialized = true;

        this._logInfo(
            `WalletPoolRegistry ready | wallets=${this._wallets.size}`
                + ` | reservations=${this._roomToWallet.size}`
        );

    }

    _loadCatalog() {

        // Railway keeps the 64-wallet Testnet catalog in Variables, not in
        // Git. Prefer the existing local catalog for compatibility; otherwise
        // read the variable directly without writing wallet secrets to disk.
        const hasCatalogFile = existsSync(this._catalogPath);
        const configuredCatalog = process.env.ROOM_WALLETS_TESTNET_JSON
            || process.env.ROOM_WALLETS_JSON;

        if (!hasCatalogFile && !configuredCatalog) {

            throw new PaymentConfigurationError(
                "room wallet catalog not found",
                { catalogPath: this._catalogPath }
            );

        }

        let parsed;

        try {

            const raw = configuredCatalog || readFileSync(this._catalogPath, "utf8");

            // Secrets are dropped during parsing — they never enter memory.
            parsed = JSON.parse(raw, stripSecretsReviver);

        } catch (error) {

            throw new PaymentConfigurationError(
                `failed to parse room wallet catalog: ${error?.message ?? error}`,
                { catalogPath: this._catalogPath }
            );

        }

        if (!Array.isArray(parsed) || parsed.length === 0) {

            throw new PaymentConfigurationError(
                "room wallet catalog must be a non-empty array",
                { catalogPath: this._catalogPath }
            );

        }

        if (parsed.length !== ROOM_WALLET_POOL_SIZE) {

            throw new PaymentConfigurationError(
                `room wallet catalog must contain exactly ${ROOM_WALLET_POOL_SIZE} wallets`,
                { catalogPath: this._catalogPath, count: parsed.length }
            );

        }

        const byId = new Map();

        const byAddress = new Set();

        const byRoomNumber = new Set();

        for (const entry of parsed) {

            const wallet = RoomWallet.fromRecord({
                walletId: entry.walletId ?? `room-wallet-${entry.roomNumber}`,
                roomNumber: entry.roomNumber,
                address: entry.address,
                publicKey: entry.publicKey ?? null,
                workchain: entry.workchain ?? 0,
                network: entry.network ?? this._network
            });

            if (byId.has(wallet.walletId)) {

                throw new PaymentConfigurationError(
                    `duplicate walletId in room wallet catalog: ${wallet.walletId}`
                );

            }

            if (byAddress.has(wallet.address)) {

                throw new PaymentConfigurationError(
                    `duplicate wallet address in room wallet catalog: ${wallet.address}`
                );

            }

            if (byRoomNumber.has(wallet.roomNumber)) {

                throw new PaymentConfigurationError(
                    `duplicate room number in room wallet catalog: ${wallet.roomNumber}`
                );

            }

            byId.set(wallet.walletId, wallet);

            byAddress.add(wallet.address);

            byRoomNumber.add(wallet.roomNumber);

        }

        this._wallets = byId;

    }

    // -------------------------------------------------------------------------
    // Queries
    // -------------------------------------------------------------------------

    /**
     * @returns {Array<object>} public identity snapshots (no secrets).
     */
    listWallets() {

        return [...this._wallets.values()].map((wallet) => wallet.toRecord());

    }

    /**
     * @param {string} walletId
     * @returns {object|null}
     */
    getWallet(walletId) {

        return this._wallets.get(walletId)?.toRecord() ?? null;

    }

    /**
     * @param {string} walletId
     * @returns {boolean}
     */
    hasWallet(walletId) {

        return this._wallets.has(walletId);

    }

    /**
     * R3 — the single wallet currently assigned to a room, if any.
     *
     * @param {string} roomId
     * @returns {object|null}
     */
    getReservationForRoom(roomId) {

        const walletId = this._roomToWallet.get(roomId);

        if (!walletId) {

            return null;

        }

        return this._wallets.get(walletId)?.toRecord() ?? null;

    }

    /**
     * @param {string} roomId
     * @returns {boolean}
     */
    hasReservationForRoom(roomId) {

        return this._roomToWallet.has(roomId);

    }

    /**
     * @returns {number} count of wallets currently reserved by an active room.
     */
    getReservedCount() {

        return this._roomToWallet.size;

    }

    /**
     * @returns {number} count of wallets free to be reserved.
     */
    getAvailableCount() {

        return [...this._wallets.values()].filter(wallet => wallet.isAvailable() && !this._isQuarantined(wallet)).length;

    }

    /**
     * @returns {Array<object>} wallets with no active reservation.
     */
    listAvailableWallets() {

        return this.listWallets().filter((wallet) => wallet.reservedByRoomId === null && !this._isQuarantined(wallet));

    }

    // -------------------------------------------------------------------------
    // Reservation / release rules
    // -------------------------------------------------------------------------

    /**
     * Reserve exactly one wallet for a room.
     *
     * R3 — a room can hold at most one reservation: reserving again is a
     * duplicate wallet assignment and is rejected.
     *
     * @param {{
     *   roomId: string,
     *   network?: string,
     *   walletId?: string,
     *   now?: number
     * }} request
     * @returns {{ wallet: object, replaced: boolean }}
     */
    reserve({ roomId, network = null, walletId = null, now = Date.now() }) {

        this._assertInitialized();

        if (typeof roomId !== "string" || roomId.trim() === "") {

            throw new PaymentValidationError("roomId must be a non-empty string");

        }

        // R3 — duplicate wallet assignment.
        if (this._roomToWallet.has(roomId)) {

            throw new WalletAssignmentConflictError(
                "room already has a wallet assigned",
                {
                    roomId,
                    walletId: this._roomToWallet.get(roomId),
                    requestedWalletId: walletId
                }
            );

        }

        const target = walletId === null
            ? this._selectAvailableWallet(network)
            : this._selectRequestedWallet(walletId, network, roomId);

        if (!target) {

            throw new WalletPoolExhaustedError(network ?? this._network, { roomId });

        }

        this._applyReservation(target, roomId, now);

        this._logInfo(
            `Wallet reserved | walletId=${target.walletId} | roomId=${roomId}`
        );

        return {
            wallet: this._wallets.get(target.walletId).toRecord(),
            replaced: false
        };

    }

    /**
     * Release the wallet held by a room.
     *
     * R8 — release is refused while the room still has unresolved payment or
     * refund obligations (unless the caller explicitly attests none remain).
     *
     * @param {{
     *   roomId: string,
     *   unresolvedObligations?: number,
     *   now?: number
     * }} request
     * @returns {{ released: boolean, walletId: string|null, unresolvedObligations: number }}
     */
    release({ roomId, unresolvedObligations = 0, now = Date.now() }) {

        this._assertInitialized();

        const walletId = this._roomToWallet.get(roomId);

        if (!walletId) {

            return {
                released: false,
                walletId: null,
                unresolvedObligations
            };

        }

        if (unresolvedObligations > 0) {

            throw new WalletRecyclingBlockedError(
                walletId,
                roomId,
                unresolvedObligations
            );

        }

        this._applyRelease(walletId, now);

        this._logInfo(
            `Wallet released | walletId=${walletId} | roomId=${roomId}`
        );

        return {
            released: true,
            walletId,
            unresolvedObligations: 0
        };

    }

    /**
     * R3 / R8 reconciliation entry point used at startup and when a room's
     * obligations change. Keeps in-memory reservations consistent with the
     * durable payment-intent ledger.
     *
     * @param {{ obligationsByRoom: Map<string, number>, now?: number }} args
     */
    reconcile({ obligationsByRoom, now = Date.now() }) {

        this._assertInitialized();

        let released = 0;

        let blocked = 0;

        for (const [roomId, walletId] of [...this._roomToWallet.entries()]) {

            const unresolved = obligationsByRoom?.get?.(roomId) ?? 0;

            if (unresolved > 0) {

                blocked += 1;

                continue;

            }

            this._applyRelease(walletId, now);

            released += 1;

        }

        return { released, blocked };

    }

    // -------------------------------------------------------------------------
    // Durable snapshot
    // -------------------------------------------------------------------------

    /**
     * Persist the current reservation state (public identity only — never
     * secret material).
     *
     * @param {string} snapshotDir
     */
    persistSnapshot(snapshotDir) {

        this._assertInitialized();

        const filePath = join(snapshotDir, "wallet-pool.json");

        const payload = Object.freeze({
            schemaVersion: WALLET_POOL_SCHEMA_VERSION,
            network: this._network,
            poolSize: this._wallets.size,
            reservations: Object.freeze(
                [...this._wallets.values()].map((wallet) => wallet.toRecord())
            ),
            persistedAt: Date.now()
        });

        atomicWriteJson(filePath, payload);

        return filePath;

    }

    _loadSnapshot(snapshotDir) {

        const filePath = join(snapshotDir, "wallet-pool.json");

        if (!existsSync(filePath)) {

            return;

        }

        let parsed;

        try {

            parsed = JSON.parse(readFileSync(filePath, "utf8"));

        } catch (error) {

            throw new PaymentStorageError(
                `failed to read wallet pool snapshot: ${error?.message ?? error}`,
                { filePath }
            );

        }

        if (!Array.isArray(parsed?.reservations)) {

            throw new PaymentStorageError(
                "wallet pool snapshot missing reservations array",
                { filePath }
            );

        }

        for (const record of parsed.reservations) {

            if (record.reservedByRoomId === null
                || record.reservedByRoomId === undefined) {

                continue;

            }

            const wallet = this._wallets.get(record.walletId);

            if (!wallet) {

                continue;

            }

            const ownerRoomId = record.reservedByRoomId;

            if (this._roomToWallet.has(ownerRoomId)) {

                throw new PaymentStorageError(
                    "wallet pool snapshot has conflicting active reservations",
                    { roomId: ownerRoomId, walletId: record.walletId }
                );

            }

            this._applyReservation(wallet, ownerRoomId, record.reservedAt ?? Date.now());

        }

    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    _selectAvailableWallet(network) {

        const effectiveNetwork = network ?? this._network;

        for (const wallet of this._wallets.values()) {

            // Exclude the old oj7v wallet when the active Testnet environment
            // explicitly quarantines its room number. Never recycle an
            // unresolved historical wallet into a new paid game.
            if (this._isQuarantined(wallet)) continue;

            if (wallet.isAvailable() && wallet.network === effectiveNetwork) {

                return wallet;

            }

        }

        return null;

    }

    _isQuarantined(wallet) {
        // Room wallet #1 retains unresolved historical oj7v refunds.
        // Quarantine is a Testnet invariant, never an optional deployment
        // variable: missing Railway env settings must not reassign it.
        if (wallet?.network === "testnet" && wallet.roomNumber === 1) {
            return true;
        }
        // Additional emergency quarantines may still be configured.
        const values = String(process.env.ROOM_WALLET_QUARANTINED_NUMBERS ?? "")
            .split(",").map(value => value.trim()).filter(Boolean);
        return values.includes(String(wallet.roomNumber));
    }

    _selectRequestedWallet(walletId, network, roomId) {

        const wallet = this._wallets.get(walletId);

        if (!wallet) {

            throw new WalletAssignmentConflictError(
                `unknown wallet in pool: ${walletId}`,
                { walletId, roomId }
            );

        }

        if (this._isQuarantined(wallet)) {
            throw new WalletAssignmentConflictError(
                "wallet quarantined due to unresolved historical funds",
                { walletId, roomId }
            );
        }

        if (network !== null && wallet.network !== network) {

            throw new WalletAssignmentConflictError(
                `wallet network mismatch: expected ${network}, found ${wallet.network}`,
                { walletId, roomId, network, walletNetwork: wallet.network }
            );

        }

        // Conflicting active reservation — a wallet has at most one owner.
        if (!wallet.isAvailable()) {

            throw new WalletAssignmentConflictError(
                "wallet is already reserved by another active room",
                {
                    walletId,
                    roomId,
                    reservedByRoomId: wallet.reservedByRoomId,
                    requestedByRoomId: roomId
                }
            );

        }

        return wallet;

    }

    _applyReservation(wallet, roomId, now) {

        const reserved = new RoomWallet({
            ...wallet.toRecord(),
            reservedByRoomId: roomId,
            reservedAt: now
        });

        this._wallets.set(wallet.walletId, reserved);

        this._roomToWallet.set(roomId, wallet.walletId);

    }

    _applyRelease(walletId, now) {

        const wallet = this._wallets.get(walletId);

        if (!wallet) {

            return;

        }

        for (const [roomId, ownedWalletId] of this._roomToWallet.entries()) {

            if (ownedWalletId === walletId) {

                this._roomToWallet.delete(roomId);

                break;

            }

        }

        this._wallets.set(
            walletId,
            new RoomWallet({
                ...wallet.toRecord(),
                reservedByRoomId: null,
                reservedAt: now
            })
        );

    }

    _assertInitialized() {

        if (!this._initialized) {

            throw new PaymentConfigurationError(
                "WalletPoolRegistry is not initialized"
            );

        }

    }

    _logInfo(message) {

        this._logger?.info?.(message);

    }

}

/**
 * Atomic durable write (temp file + rename), matching the existing
 * AdvertisementStorage convention.
 *
 * @param {string} filePath
 * @param {object} payload
 */
export function atomicWriteJson(filePath, payload) { durableWriteJson(filePath, payload); }

/**
 * Load the 64-wallet catalog for inspection. Secrets are stripped at parse
 * time and never returned.
 *
 * @param {string} [catalogPath]
 * @returns {Array<object>}
 */
export function readRoomWalletCatalog(catalogPath = null) {

    const path = catalogPath ?? resolveDefaultRoomWalletCatalogPath();

    if (!existsSync(path)) {

        throw new PaymentConfigurationError(
            "room wallet catalog not found",
            { catalogPath: path }
        );

    }

    return JSON.parse(readFileSync(path, "utf8"), stripSecretsReviver);

}

export { readdirSync };
