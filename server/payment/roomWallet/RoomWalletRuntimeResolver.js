/**
 * Runtime resolver for Room Wallet signing identities.
 *
 * Wallet addresses and signing material are supplied only through runtime
 * environment configuration. No private key material belongs in source control
 * or in RoomWalletRegistry.
 *
 * Expected environment variable:
 *   ROOM_WALLETS_JSON='[{"roomNumber":1,"address":"...","publicKey":"hex","secretKey":"hex","workchain":0}]'
 *
 * publicKey/secretKey may be hex (preferred) or base64. The parser validates
 * the basic byte lengths required by WalletContractV4 before returning an
 * identity to the signing adapter.
 */

import { ROOM_WALLET_COUNT, RoomWalletRegistry } from "./RoomWalletRegistry.js";

const PUBLIC_KEY_BYTES = 32;
const SECRET_KEY_BYTES = 64;

export function loadRoomWalletRuntimeConfig(env = process.env) {
    const raw = String(env.ROOM_WALLETS_JSON ?? "").trim();

    if (!raw) {
        return Object.freeze({ entries: [] });
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(`ROOM_WALLETS_JSON is not valid JSON: ${error.message}`);
    }

    if (!Array.isArray(parsed)) {
        throw new TypeError("ROOM_WALLETS_JSON must contain an array");
    }

    if (parsed.length > ROOM_WALLET_COUNT) {
        throw new RangeError(`ROOM_WALLETS_JSON cannot contain more than ${ROOM_WALLET_COUNT} wallets`);
    }

    const entries = parsed.map((entry) => normalizeEntry(entry));
    return Object.freeze({ entries });
}

export function createRoomWalletRuntimeResolver({ env = process.env, registry = null } = {}) {
    const runtimeConfig = loadRoomWalletRuntimeConfig(env);
    const resolvedRegistry = registry ?? new RoomWalletRegistry({
        entries: runtimeConfig.entries.map(({ roomNumber, address, network }) => ({
            roomNumber,
            address,
            network
        }))
    });

    const identities = new Map(
        runtimeConfig.entries.map((entry) => [entry.roomNumber, Object.freeze(entry)])
    );

    return Object.freeze(async (roomNumber) => {
        const record = resolvedRegistry.require(roomNumber);
        const identity = identities.get(record.roomNumber);

        if (!identity) {
            throw new Error(`signing material is unavailable for room ${record.roomNumber}`);
        }

        if (identity.address !== record.address) {
            throw new Error(`room ${record.roomNumber} wallet identity drift`);
        }

        return identity;
    });
}

export function createRoomWalletRegistryFromEnv(env = process.env) {
    const runtimeConfig = loadRoomWalletRuntimeConfig(env);
    return new RoomWalletRegistry({
        entries: runtimeConfig.entries.map(({ roomNumber, address, network }) => ({
            roomNumber,
            address,
            network
        }))
    });
}

function normalizeEntry(entry) {
    if (!entry || typeof entry !== "object") {
        throw new TypeError("each Room Wallet entry must be an object");
    }

    const roomNumber = Number(entry.roomNumber);
    if (!Number.isInteger(roomNumber) || roomNumber < 1 || roomNumber > ROOM_WALLET_COUNT) {
        throw new RangeError(`roomNumber must be an integer from 1 to ${ROOM_WALLET_COUNT}`);
    }

    const address = String(entry.address ?? "").trim();
    if (!address) {
        throw new TypeError(`address is required for room ${roomNumber}`);
    }

    const publicKey = decodeKey(entry.publicKey, `publicKey for room ${roomNumber}`, PUBLIC_KEY_BYTES);
    const secretKey = decodeKey(entry.secretKey, `secretKey for room ${roomNumber}`, SECRET_KEY_BYTES);
    const workchain = Number(entry.workchain ?? 0);

    if (!Number.isInteger(workchain)) {
        throw new TypeError(`workchain must be an integer for room ${roomNumber}`);
    }

    return {
        roomNumber,
        address,
        network: entry.network == null ? null : String(entry.network).trim().toLowerCase(),
        workchain,
        publicKey,
        secretKey
    };
}

function decodeKey(value, label, expectedBytes) {
    const raw = String(value ?? "").trim();
    if (!raw) {
        throw new TypeError(`${label} is required`);
    }

    let bytes;

    if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
        bytes = Buffer.from(raw, "hex");
    } else {
        try {
            bytes = Buffer.from(raw, "base64");
        } catch (error) {
            throw new TypeError(`${label} is not valid hex or base64: ${error.message}`);
        }
    }

    if (bytes.length !== expectedBytes) {
        throw new RangeError(`${label} must decode to exactly ${expectedBytes} bytes`);
    }

    return Uint8Array.from(bytes);
}
