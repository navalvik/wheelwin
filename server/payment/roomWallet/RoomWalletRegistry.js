/**
 * Room Wallet registry for the new payment architecture.
 *
 * This module deliberately stores wallet identities, not secrets.
 * Secret material is resolved by the runtime wallet provider.
 */

import {
    canonicalizeTonWalletAddress,
    tonWalletAccountsEqual
} from "../../models/TonWalletAddress.js";

export const ROOM_WALLET_COUNT = 64;

export function normalizeRoomNumber(roomNumber) {
    const value = Number(roomNumber);

    if (!Number.isInteger(value) || value < 1 || value > ROOM_WALLET_COUNT) {
        throw new RangeError(`roomNumber must be an integer from 1 to ${ROOM_WALLET_COUNT}`);
    }

    return value;
}

export function tryNormalizeRoomNumber(roomNumber) {
    try {
        return normalizeRoomNumber(roomNumber);
    } catch {
        return null;
    }
}

export class RoomWalletRegistry {
    constructor({ entries = [] } = {}) {
        if (!Array.isArray(entries)) {
            throw new TypeError("entries must be an array");
        }

        this._entries = new Map();

        for (const entry of entries) {
            this.register(entry);
        }
    }

    register({ roomNumber, address, network = null } = {}) {
        const normalizedRoomNumber = normalizeRoomNumber(roomNumber);
        const normalizedAddress = canonicalizeTonWalletAddress(address);

        if (!normalizedAddress) {
            throw new TypeError("address is required");
        }

        const normalizedNetwork = normalizeNetwork(network);
        const key = makeRegistryKey(normalizedRoomNumber, normalizedNetwork);
        const existing = this._entries.get(key);

        if (
            existing
            && !tonWalletAccountsEqual(existing.address, normalizedAddress)
        ) {
            throw new Error(
                "room " + normalizedRoomNumber
                + " is already mapped to another wallet on network "
                + (normalizedNetwork ?? "unspecified")
            );
        }

        const record = Object.freeze({
            roomNumber: normalizedRoomNumber,
            address: normalizedAddress,
            network: normalizedNetwork
        });

        this._entries.set(key, record);
        return record;
    }

    get(roomNumber) {
        const normalizedRoomNumber = normalizeRoomNumber(roomNumber);
        const matches = [...this._entries.values()]
            .filter((entry) => entry.roomNumber === normalizedRoomNumber);

        return matches.length === 1 ? matches[0] : null;
    }

    getForNetwork(roomNumber, network) {
        const normalizedRoomNumber = normalizeRoomNumber(roomNumber);
        const normalizedNetwork = normalizeNetwork(network);

        if (!normalizedNetwork) {
            return this.get(normalizedRoomNumber);
        }

        return this._entries.get(
            makeRegistryKey(normalizedRoomNumber, normalizedNetwork)
        ) ?? null;
    }

    require(roomNumber, network = null) {
        const record = network == null
            ? this.get(roomNumber)
            : this.getForNetwork(roomNumber, network);

        if (!record) {
            throw new Error(
                "room wallet is not uniquely registered for room "
                + roomNumber + "; specify network"
            );
        }

        return record;
    }

    has(roomNumber, network = null) {
        return network == null
            ? this.get(roomNumber) != null
            : this.getForNetwork(roomNumber, network) != null;
    }

    list() {
        return Object.freeze(
            [...this._entries.values()].sort((a, b) =>
                a.roomNumber - b.roomNumber
                || String(a.network ?? "").localeCompare(String(b.network ?? ""))
            )
        );
    }

    size() {
        return this._entries.size;
    }

    getByAddress(address) {
        if (!address) {
            return null;
        }

        for (const record of this._entries.values()) {
            if (tonWalletAccountsEqual(record.address, address)) {
                return record;
            }
        }

        return null;
    }
}


function normalizeNetwork(network) {
    if (network == null || String(network).trim() === "") {
        return null;
    }

    const normalized = String(network).trim().toLowerCase();

    if (normalized !== "testnet" && normalized !== "mainnet") {
        throw new TypeError("network must be testnet or mainnet");
    }

    return normalized;
}

function makeRegistryKey(roomNumber, network) {
    return String(roomNumber) + "::" + (network ?? "unspecified");
}
