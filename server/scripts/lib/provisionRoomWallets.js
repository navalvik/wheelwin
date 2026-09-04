/**
 * Offline TESTNET Room Wallet identity provisioning.
 *
 * Generates WalletContractV4 keypairs with cryptographically secure randomness
 * and the same identity rules as RoomWalletRuntimeResolver. Does not send
 * transactions, fund wallets, or write secrets unless an explicit output
 * directory outside the Git work tree is supplied.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { Address } from "@ton/core";
import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import { ROOM_WALLET_COUNT } from "../../payment/roomWallet/RoomWalletRegistry.js";
import { loadRoomWalletRuntimeConfig } from "../../payment/roomWallet/RoomWalletRuntimeResolver.js";

export const ROOM_WALLET_PROVISION_COUNT = ROOM_WALLET_COUNT;
export const ROOM_WALLET_PROVISION_NETWORK = "testnet";
export const ROOM_WALLET_PROVISION_WORKCHAIN = 0;
export const ROOM_WALLET_CONTRACT_TYPE = "WalletContractV4R2";
export const MASTER_BACKUP_FILENAME = "room-wallets-testnet-master-backup.json";
export const RUNTIME_JSON_FILENAME = "room-wallets-testnet-ROOM_WALLETS_JSON.json";

const PUBLIC_KEY_BYTES = 32;
const SECRET_KEY_BYTES = 64;
const HEX_PUBLIC_KEY_LENGTH = PUBLIC_KEY_BYTES * 2;
const HEX_SECRET_KEY_LENGTH = SECRET_KEY_BYTES * 2;
const MAX_UNIQUE_ATTEMPTS = 8;

export function generateRoomWalletIdentities({
    count = ROOM_WALLET_PROVISION_COUNT,
    network = ROOM_WALLET_PROVISION_NETWORK,
    workchain = ROOM_WALLET_PROVISION_WORKCHAIN,
    randomBytesFn = randomBytes
} = {}) {
    if (network !== ROOM_WALLET_PROVISION_NETWORK) {
        throw new Error("this provisioning utility only generates TESTNET identities");
    }

    if (workchain !== ROOM_WALLET_PROVISION_WORKCHAIN) {
        throw new Error(`workchain must be ${ROOM_WALLET_PROVISION_WORKCHAIN}`);
    }

    if (!Number.isInteger(count) || count !== ROOM_WALLET_PROVISION_COUNT) {
        throw new RangeError(`must generate exactly ${ROOM_WALLET_PROVISION_COUNT} wallets`);
    }

    const entries = [];
    const seenAddresses = new Set();
    const seenPublicKeys = new Set();
    const seenSecretKeys = new Set();

    for (let roomNumber = 1; roomNumber <= count; roomNumber += 1) {
        let entry = null;

        for (let attempt = 1; attempt <= MAX_UNIQUE_ATTEMPTS; attempt += 1) {
            entry = generateOneIdentity(roomNumber, { network, workchain, randomBytesFn });

            if (
                !seenAddresses.has(entry.address)
                && !seenPublicKeys.has(entry.publicKey)
                && !seenSecretKeys.has(entry.secretKey)
            ) {
                break;
            }

            entry = null;
        }

        if (!entry) {
            throw new Error(`failed to generate a unique identity for room ${roomNumber}`);
        }

        seenAddresses.add(entry.address);
        seenPublicKeys.add(entry.publicKey);
        seenSecretKeys.add(entry.secretKey);
        entries.push(entry);
    }

    return entries;
}

export function buildRuntimePayload(identities) {
    return identities.map((entry) => ({
        roomNumber: entry.roomNumber,
        address: entry.address,
        publicKey: entry.publicKey,
        secretKey: entry.secretKey,
        workchain: entry.workchain,
        network: entry.network
    }));
}

export function buildMasterBackup(identities, { generatedAt = new Date().toISOString() } = {}) {
    return {
        schemaVersion: 1,
        purpose: "WheelWin Room Wallet offline master backup",
        network: ROOM_WALLET_PROVISION_NETWORK,
        workchain: ROOM_WALLET_PROVISION_WORKCHAIN,
        walletContractType: ROOM_WALLET_CONTRACT_TYPE,
        roomCount: identities.length,
        generatedAt,
        wallets: identities.map((entry) => ({
            roomNumber: entry.roomNumber,
            address: entry.address,
            publicKey: entry.publicKey,
            secretKey: entry.secretKey,
            network: entry.network,
            workchain: entry.workchain,
            walletContractType: entry.walletContractType,
            walletId: entry.walletId
        }))
    };
}

export function validateProvisionedCatalog(identities, { envNetwork = ROOM_WALLET_PROVISION_NETWORK } = {}) {
    if (!Array.isArray(identities) || identities.length !== ROOM_WALLET_PROVISION_COUNT) {
        throw new RangeError(`catalog must contain exactly ${ROOM_WALLET_PROVISION_COUNT} wallets`);
    }

    const addresses = new Set();
    const publicKeys = new Set();
    const secretKeys = new Set();
    const publicSummary = [];

    for (let index = 0; index < identities.length; index += 1) {
        const entry = identities[index];
        const expectedRoomNumber = index + 1;

        if (entry.roomNumber !== expectedRoomNumber) {
            throw new Error(`room assignment is not sequential: expected ${expectedRoomNumber}`);
        }

        assertHexKey(entry.publicKey, HEX_PUBLIC_KEY_LENGTH, `room ${entry.roomNumber} publicKey`);
        assertHexKey(entry.secretKey, HEX_SECRET_KEY_LENGTH, `room ${entry.roomNumber} secretKey`);
        assertLocalIdentity(entry);

        if (entry.network !== ROOM_WALLET_PROVISION_NETWORK) {
            throw new Error(`room ${entry.roomNumber} network must be testnet`);
        }

        if (entry.workchain !== ROOM_WALLET_PROVISION_WORKCHAIN) {
            throw new Error(`room ${entry.roomNumber} workchain must be 0`);
        }

        if (entry.walletContractType !== ROOM_WALLET_CONTRACT_TYPE) {
            throw new Error(`room ${entry.roomNumber} wallet type must be ${ROOM_WALLET_CONTRACT_TYPE}`);
        }

        if (addresses.has(entry.address)) {
            throw new Error(`duplicate address at room ${entry.roomNumber}`);
        }

        if (publicKeys.has(entry.publicKey)) {
            throw new Error(`duplicate publicKey at room ${entry.roomNumber}`);
        }

        if (secretKeys.has(entry.secretKey)) {
            throw new Error(`duplicate secretKey at room ${entry.roomNumber}`);
        }

        addresses.add(entry.address);
        publicKeys.add(entry.publicKey);
        secretKeys.add(entry.secretKey);
        publicSummary.push({
            roomNumber: entry.roomNumber,
            address: entry.address,
            workchain: entry.workchain,
            network: entry.network,
            walletContractType: entry.walletContractType
        });
    }

    const runtimePayload = buildRuntimePayload(identities);
    const parsed = loadRoomWalletRuntimeConfig({
        ROOM_WALLETS_JSON: JSON.stringify(runtimePayload),
        ROOM_WALLET_PAYMENT_INTAKE_MODE: "ROOM_WALLET",
        TON_NETWORK: envNetwork
    });

    if (parsed.entries.length !== ROOM_WALLET_PROVISION_COUNT) {
        throw new RangeError("production parser did not accept 64 Room Wallet entries");
    }

    for (let roomNumber = 1; roomNumber <= ROOM_WALLET_PROVISION_COUNT; roomNumber += 1) {
        const parsedEntry = parsed.entries.find((entry) => entry.roomNumber === roomNumber);
        const generated = identities[roomNumber - 1];

        if (!parsedEntry) {
            throw new Error(`production parser is missing roomNumber ${roomNumber}`);
        }

        if (parsedEntry.address !== generated.address) {
            throw new Error(`parser address mismatch for room ${roomNumber}`);
        }

        if (parsedEntry.workchain !== ROOM_WALLET_PROVISION_WORKCHAIN) {
            throw new Error(`parser workchain mismatch for room ${roomNumber}`);
        }

        if (parsedEntry.network !== ROOM_WALLET_PROVISION_NETWORK) {
            throw new Error(`parser network mismatch for room ${roomNumber}`);
        }
    }

    return Object.freeze({
        count: identities.length,
        uniqueAddresses: addresses.size,
        uniquePublicKeys: publicKeys.size,
        uniqueSecretKeys: secretKeys.size,
        workchain: ROOM_WALLET_PROVISION_WORKCHAIN,
        network: ROOM_WALLET_PROVISION_NETWORK,
        walletContractType: ROOM_WALLET_CONTRACT_TYPE,
        rooms: publicSummary
    });
}

export function assertOutputDirSafe(outputDir, gitRoot) {
    if (!outputDir || typeof outputDir !== "string") {
        throw new TypeError("--output-dir is required");
    }

    if (!path.isAbsolute(outputDir)) {
        throw new Error("--output-dir must be an absolute path outside the Git repository");
    }

    const resolvedOutput = path.resolve(outputDir);
    const resolvedRoot = path.resolve(gitRoot);

    if (isPathInside(resolvedRoot, resolvedOutput)) {
        throw new Error("refusing to write Room Wallet secrets inside the Git repository");
    }

    return resolvedOutput;
}

export async function writeProvisionArtifacts(outputDir, { masterBackup, runtimePayload }) {
    await mkdir(outputDir, { recursive: true, mode: 0o700 });

    const masterPath = path.join(outputDir, MASTER_BACKUP_FILENAME);
    const runtimePath = path.join(outputDir, RUNTIME_JSON_FILENAME);

    await assertFileDoesNotExist(masterPath);
    await assertFileDoesNotExist(runtimePath);

    const masterBody = `${JSON.stringify(masterBackup, null, 2)}\n`;
    const runtimeBody = `${JSON.stringify(runtimePayload, null, 2)}\n`;

    await writeFile(masterPath, masterBody, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await writeFile(runtimePath, runtimeBody, { encoding: "utf8", mode: 0o600, flag: "wx" });

    return {
        masterPath,
        runtimePath,
        masterSha256: sha256Buffer(Buffer.from(masterBody, "utf8")),
        runtimeSha256: sha256Buffer(Buffer.from(runtimeBody, "utf8"))
    };
}

export async function hashFileSha256(filePath) {
    const bytes = await readFile(filePath);
    return sha256Buffer(bytes);
}

export function sha256Buffer(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

export function buildPublicSummary(stats, artifactPaths) {
    return {
        count: stats.count,
        uniqueAddresses: stats.uniqueAddresses,
        uniquePublicKeys: stats.uniquePublicKeys,
        uniqueSecretKeys: stats.uniqueSecretKeys,
        workchain: stats.workchain,
        network: stats.network,
        walletContractType: stats.walletContractType,
        rooms: stats.rooms,
        artifacts: artifactPaths
    };
}

function generateOneIdentity(roomNumber, { network, workchain, randomBytesFn }) {
    const seed = randomBytesFn(PUBLIC_KEY_BYTES);

    if (!Buffer.isBuffer(seed) || seed.length !== PUBLIC_KEY_BYTES) {
        throw new TypeError("CSPRNG must return a 32-byte Buffer");
    }

    const keyPair = keyPairFromSeed(seed);
    const wallet = WalletContractV4.create({
        workchain,
        publicKey: keyPair.publicKey
    });

    if (wallet.address.workChain !== ROOM_WALLET_PROVISION_WORKCHAIN) {
        throw new Error(`room ${roomNumber} derived workchain is not 0`);
    }

    return {
        roomNumber,
        address: wallet.address.toString({ bounceable: true, urlSafe: true }),
        publicKey: Buffer.from(keyPair.publicKey).toString("hex"),
        secretKey: Buffer.from(keyPair.secretKey).toString("hex"),
        workchain,
        network,
        walletContractType: ROOM_WALLET_CONTRACT_TYPE,
        walletId: wallet.walletId
    };
}

function assertHexKey(value, expectedLength, label) {
    if (typeof value !== "string" || value.length !== expectedLength || !/^[0-9a-f]+$/.test(value)) {
        throw new TypeError(`${label} must be ${expectedLength} lowercase hex characters`);
    }
}

function assertLocalIdentity(entry) {
    const publicKey = Buffer.from(entry.publicKey, "hex");
    const secretKey = Buffer.from(entry.secretKey, "hex");

    if (publicKey.length !== PUBLIC_KEY_BYTES) {
        throw new RangeError(`room ${entry.roomNumber} publicKey must be ${PUBLIC_KEY_BYTES} bytes`);
    }

    if (secretKey.length !== SECRET_KEY_BYTES) {
        throw new RangeError(`room ${entry.roomNumber} secretKey must be ${SECRET_KEY_BYTES} bytes`);
    }

    const derivedPair = keyPairFromSeed(Buffer.from(secretKey.subarray(0, PUBLIC_KEY_BYTES)));

    if (!Buffer.from(derivedPair.publicKey).equals(publicKey)) {
        throw new Error(`room ${entry.roomNumber} publicKey does not match secretKey`);
    }

    if (!Buffer.from(derivedPair.secretKey).equals(secretKey)) {
        throw new Error(`room ${entry.roomNumber} secretKey is not a WalletContractV4 key pair`);
    }

    const wallet = WalletContractV4.create({
        workchain: entry.workchain,
        publicKey
    });
    const derivedAddress = wallet.address.toString({ bounceable: true, urlSafe: true });
    const configuredAddress = Address.parse(entry.address)
        .toString({ bounceable: true, urlSafe: true });

    if (derivedAddress !== configuredAddress || configuredAddress !== entry.address) {
        throw new Error(`room ${entry.roomNumber} address does not match WalletContractV4(publicKey)`);
    }
}

function isPathInside(parent, child) {
    const normalizedParent = normalizeFsPath(parent);
    const normalizedChild = normalizeFsPath(child);

    return normalizedChild === normalizedParent
        || normalizedChild.startsWith(`${normalizedParent}${path.sep}`);
}

function normalizeFsPath(value) {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function assertFileDoesNotExist(filePath) {
    try {
        await stat(filePath);
    } catch (error) {
        if (error && error.code === "ENOENT") {
            return;
        }

        throw error;
    }

    throw new Error(`refusing to overwrite existing file: ${path.basename(filePath)}`);
}
