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
 * the basic byte lengths required by WalletContractV4, that secretKey derives
 * publicKey, and that address is the WalletContractV4 address for that key.
 *
 * ROOM_WALLETS_JSON is a secret. Never log, print, or return its raw value.
 */

import { Address } from "@ton/core";
import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import { ROOM_WALLET_COUNT, RoomWalletRegistry } from "./RoomWalletRegistry.js";

const PUBLIC_KEY_BYTES = 32;
const SECRET_KEY_BYTES = 64;
const ROOM_WALLET_WORKCHAIN = 0;
const ROOM_WALLET_NETWORKS = Object.freeze(["testnet", "mainnet"]);

export function loadRoomWalletRuntimeConfig(env = process.env) {
    const raw = String(env.ROOM_WALLETS_JSON ?? "").trim();
    const intakeEnabled = isRoomWalletPaymentIntakeModeEnabled(env);

    if (!raw) {
        if (intakeEnabled) {
            throw new Error(
                "ROOM_WALLETS_JSON is required when ROOM_WALLET_PAYMENT_INTAKE_MODE=ROOM_WALLET"
            );
        }

        return Object.freeze({ entries: [] });
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error("ROOM_WALLETS_JSON is not valid JSON");
    }

    if (!Array.isArray(parsed)) {
        throw new TypeError("ROOM_WALLETS_JSON must contain an array");
    }

    if (parsed.length > ROOM_WALLET_COUNT) {
        throw new RangeError(`ROOM_WALLETS_JSON cannot contain more than ${ROOM_WALLET_COUNT} wallets`);
    }

    const envNetwork = normalizeOptionalNetwork(env.TON_NETWORK);
    const entries = [];
    const seenRoomNumbers = new Set();
    const seenAddresses = new Set();
    const seenNetworks = new Set();

    for (const entry of parsed) {
        const normalized = normalizeEntry(entry);

        if (seenRoomNumbers.has(normalized.roomNumber)) {
            throw new Error(`duplicate roomNumber ${normalized.roomNumber}`);
        }

        seenRoomNumbers.add(normalized.roomNumber);

        if (seenAddresses.has(normalized.address)) {
            throw new Error(`duplicate Room Wallet address for room ${normalized.roomNumber}`);
        }

        seenAddresses.add(normalized.address);

        if (normalized.network) {
            seenNetworks.add(normalized.network);

            if (envNetwork && normalized.network !== envNetwork) {
                throw new Error(
                    `room ${normalized.roomNumber} network does not match TON_NETWORK`
                );
            }
        }

        entries.push(normalized);
    }

    if (seenNetworks.size > 1) {
        throw new Error("ROOM_WALLETS_JSON cannot mix network values");
    }

    if (intakeEnabled) {
        assertCompleteRoomWalletCatalog(entries);
    }

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

function isRoomWalletPaymentIntakeModeEnabled(env) {
    return String(env?.ROOM_WALLET_PAYMENT_INTAKE_MODE || "").trim().toUpperCase() === "ROOM_WALLET";
}

function assertCompleteRoomWalletCatalog(entries) {
    if (entries.length !== ROOM_WALLET_COUNT) {
        throw new RangeError(
            `ROOM_WALLETS_JSON must contain exactly ${ROOM_WALLET_COUNT} wallets when Room Wallet intake is enabled`
        );
    }

    const present = new Set(entries.map((entry) => entry.roomNumber));

    for (let roomNumber = 1; roomNumber <= ROOM_WALLET_COUNT; roomNumber += 1) {
        if (!present.has(roomNumber)) {
            throw new RangeError(
                `ROOM_WALLETS_JSON is missing roomNumber ${roomNumber}`
            );
        }
    }
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
    const workchain = Number(entry.workchain ?? ROOM_WALLET_WORKCHAIN);

    if (!Number.isInteger(workchain)) {
        throw new TypeError(`workchain must be an integer for room ${roomNumber}`);
    }

    if (workchain !== ROOM_WALLET_WORKCHAIN) {
        throw new RangeError(
            `workchain must be ${ROOM_WALLET_WORKCHAIN} for WalletContractV4 (room ${roomNumber})`
        );
    }

    const network = normalizeOptionalNetwork(entry.network);

    if (entry.network != null && String(entry.network).trim() !== "" && !network) {
        throw new TypeError(`network must be testnet or mainnet for room ${roomNumber}`);
    }

    const canonicalAddress = assertLocalWalletIdentity({
        roomNumber,
        address,
        publicKey,
        secretKey,
        workchain
    });

    return {
        roomNumber,
        address: canonicalAddress,
        network,
        workchain,
        publicKey,
        secretKey
    };
}

function assertLocalWalletIdentity({
    roomNumber,
    address,
    publicKey,
    secretKey,
    workchain
}) {
    const derivedPair = keyPairFromSeed(Buffer.from(secretKey.subarray(0, PUBLIC_KEY_BYTES)));

    if (!Buffer.from(derivedPair.publicKey).equals(Buffer.from(publicKey))) {
        throw new Error(`room ${roomNumber} publicKey does not match secretKey`);
    }

    if (!Buffer.from(derivedPair.secretKey).equals(Buffer.from(secretKey))) {
        throw new Error(`room ${roomNumber} secretKey is not a WalletContractV4 key pair`);
    }

    const wallet = WalletContractV4.create({
        workchain,
        publicKey: Buffer.from(publicKey)
    });
    const derivedAddress = wallet.address.toString({ bounceable: true, urlSafe: true });

    let configuredAddress;
    try {
        configuredAddress = Address.parse(address)
            .toString({ bounceable: true, urlSafe: true });
    } catch {
        throw new TypeError(`address is not a valid TON address for room ${roomNumber}`);
    }

    if (derivedAddress !== configuredAddress) {
        throw new Error(`room ${roomNumber} address does not match WalletContractV4(publicKey)`);
    }

    return configuredAddress;
}

function normalizeOptionalNetwork(value) {
    if (value == null) {
        return null;
    }

    const network = String(value).trim().toLowerCase();

    if (!network) {
        return null;
    }

    return ROOM_WALLET_NETWORKS.includes(network) ? network : null;
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
