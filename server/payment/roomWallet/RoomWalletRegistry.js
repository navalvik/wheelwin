/**
 * Room Wallet registry for the new payment architecture.
 *
 * This module deliberately stores wallet identities, not secrets.
 * Secret material is resolved by the runtime wallet provider.
 */

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
        const normalizedAddress = String(address ?? "").trim();

        if (!normalizedAddress) {
            throw new TypeError("address is required");
        }

        const existing = this._entries.get(normalizedRoomNumber);

        if (existing && existing.address !== normalizedAddress) {
            throw new Error(`room ${normalizedRoomNumber} is already mapped to another wallet`);
        }

        const record = Object.freeze({
            roomNumber: normalizedRoomNumber,
            address: normalizedAddress,
            network: network == null ? null : String(network).trim().toLowerCase()
        });

        this._entries.set(normalizedRoomNumber, record);
        return record;
    }

    get(roomNumber) {
        return this._entries.get(normalizeRoomNumber(roomNumber)) ?? null;
    }

    require(roomNumber) {
        const record = this.get(roomNumber);

        if (!record) {
            throw new Error(`room wallet is not registered for room ${roomNumber}`);
        }

        return record;
    }

    has(roomNumber) {
        return this._entries.has(normalizeRoomNumber(roomNumber));
    }

    list() {
        return Object.freeze(
            [...this._entries.values()].sort((a, b) => a.roomNumber - b.roomNumber)
        );
    }

    size() {
        return this._entries.size;
    }

    getByAddress(address) {
        const normalizedAddress = String(address ?? "").trim();

        if (!normalizedAddress) {
            return null;
        }

        for (const record of this._entries.values()) {
            if (record.address === normalizedAddress) {
                return record;
            }
        }

        return null;
    }
}
