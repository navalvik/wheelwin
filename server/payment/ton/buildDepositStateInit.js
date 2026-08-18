/**
 * R17.9L.12 — Deterministic DepositContract StateInit builder.
 *
 * Layout matches Tact DepositContract$Data / initDepositContract_init_args
 * (contracts/build/DepositContract/DepositContract_DepositContract.ts).
 */
import { readFileSync } from "node:fs";

import {
    Address,
    beginCell,
    Cell,
    contractAddress
} from "@ton/core";

import {
    assertPlayerBindings,
    normalizeDepositIdPart,
    REQUIRED_DEPOSIT_PLAYER_COUNT
} from "../../deposit/depositValidation.js";
import { canonicalizeTonWalletAddress } from "../../models/TonWalletAddress.js";
import { resolveOracleWalletConfig } from "../../config/tonNetworkProfiles.js";
import {
    bufferToUint256,
    hashDepositId,
    hashGameId,
    hashRoomId
} from "./depositContractHashes.js";
import {
    assertVerifiedDepositArtifact,
    DEPOSIT_CONTRACT_ARTIFACT_BOC_PATH,
    DepositArtifactVerificationError
} from "./verifyDepositArtifact.js";

export {
    DepositArtifactVerificationError
} from "./verifyDepositArtifact.js";

export const DEPOSIT_CONTRACT_VERSION = 1;
export const DEPOSIT_STATUS_UNINITIALIZED = 0;
export const DEPOSIT_NETWORK_TAG_TESTNET = 0;
export const DEPOSIT_NETWORK_TAG_MAINNET = 1;

const ZERO_ADDRESS = new Address(0, Buffer.alloc(32));

let cachedCodeCell = null;

export class DepositStateInitError extends Error {

    constructor(message, details = {}) {

        super(message);

        this.name = "DepositStateInitError";

        this.details = Object.freeze({ ...details });

    }

}

function resolveTonAddress(raw, fallback = ZERO_ADDRESS) {

    if (raw instanceof Address) {

        return raw;

    }

    if (typeof raw === "string" && raw.trim()) {

        const canonical = canonicalizeTonWalletAddress(raw.trim());

        if (canonical) {

            return Address.parse(canonical);

        }

        try {

            return Address.parse(raw.trim());

        } catch {

            return fallback;

        }

    }

    return fallback;

}

function assertPositiveNanoton(value, fieldName) {

    let amount;

    if (typeof value === "bigint") {

        amount = value;

    } else if (typeof value === "number" && Number.isInteger(value)) {

        amount = BigInt(value);

    } else {

        throw new DepositStateInitError(`${fieldName} must be an integer nanoton`, {
            fieldName,
            value
        });

    }

    if (amount < 0n) {

        throw new DepositStateInitError(`${fieldName} must be non-negative`, {
            fieldName,
            value: amount.toString()
        });

    }

    return amount;

}

function assertExpiresAt(value) {

    if (typeof value === "bigint") {

        if (value <= 0n) {

            throw new DepositStateInitError("expiresAt must be a positive unix timestamp", {
                expiresAt: value.toString()
            });

        }

        return value;

    }

    const numeric = Number(value);

    if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric <= 0) {

        throw new DepositStateInitError("expiresAt must be a positive integer unix timestamp", {
            expiresAt: value
        });

    }

    return BigInt(numeric);

}

function resolveNetworkTag(network) {

    const normalized = String(network ?? "").trim().toLowerCase();

    if (normalized === "testnet") {

        return DEPOSIT_NETWORK_TAG_TESTNET;

    }

    if (normalized === "mainnet") {

        return DEPOSIT_NETWORK_TAG_MAINNET;

    }

    throw new DepositStateInitError("network must be testnet or mainnet", { network });

}

function resolveTestOnly({ network = null, testOnly = null } = {}) {

    if (testOnly === true || testOnly === false) {

        return testOnly;

    }

    return String(network ?? "").trim().toLowerCase() === "testnet";

}

/**
 * Load verified DepositContract code cell. Verification runs before cache/load.
 *
 * @param {{ forceReload?: boolean, expectedSha256?: string|null, bocPath?: string }} [options]
 */
export function loadDepositCodeCell(options = {}) {

    assertVerifiedDepositArtifact({
        expectedSha256: options.expectedSha256 ?? null,
        bocPath: options.bocPath ?? DEPOSIT_CONTRACT_ARTIFACT_BOC_PATH
    });

    if (cachedCodeCell && !options.forceReload) {

        return cachedCodeCell;

    }

    const bocPath = options.bocPath ?? DEPOSIT_CONTRACT_ARTIFACT_BOC_PATH;
    const boc = readFileSync(bocPath);
    const cells = Cell.fromBoc(boc);

    if (!cells.length) {

        throw new DepositArtifactVerificationError(
            `DepositContract artifact empty: ${bocPath}`
        );

    }

    cachedCodeCell = cells[0];

    return cachedCodeCell;

}

/**
 * Encode DepositContract init data (Tact-compatible nested refs).
 *
 * @param {object} params
 */
export function buildDepositDataCell({
    contractVersion = DEPOSIT_CONTRACT_VERSION,
    depositIdHash,
    roomIdHash,
    gameIdHash,
    player0,
    player1,
    player2,
    expectedStake0,
    expectedStake1,
    expectedStake2,
    creationFeePerSeat,
    expiresAt,
    releaseAuthority,
    networkTag = DEPOSIT_NETWORK_TAG_TESTNET,
    status = DEPOSIT_STATUS_UNINITIALIZED,
    paidMask = 0,
    creditedAmount0 = 0n,
    creditedAmount1 = 0n,
    creditedAmount2 = 0n,
    surplusNano = 0n,
    refundMask = 0,
    releasedTo = ZERO_ADDRESS,
    totalCredited = 0n
} = {}) {

    const p0 = resolveTonAddress(player0, ZERO_ADDRESS);
    const p1 = resolveTonAddress(player1, ZERO_ADDRESS);
    const p2 = resolveTonAddress(player2, ZERO_ADDRESS);
    const authority = resolveTonAddress(releaseAuthority, ZERO_ADDRESS);
    const released = resolveTonAddress(releasedTo, ZERO_ADDRESS);

    const stake0 = assertPositiveNanoton(expectedStake0, "expectedStake0");
    const stake1 = assertPositiveNanoton(expectedStake1, "expectedStake1");
    const stake2 = assertPositiveNanoton(expectedStake2, "expectedStake2");
    const fee = assertPositiveNanoton(creationFeePerSeat, "creationFeePerSeat");
    const expiry = assertExpiresAt(expiresAt);

    const b3 = beginCell()
        .storeCoins(creditedAmount2)
        .storeCoins(surplusNano)
        .storeUint(Number(refundMask) & 0xff, 8)
        .storeAddress(released)
        .storeCoins(totalCredited)
        .endCell();

    const b2 = beginCell()
        .storeCoins(stake1)
        .storeCoins(stake2)
        .storeCoins(fee)
        .storeUint(expiry, 64)
        .storeAddress(authority)
        .storeUint(Number(networkTag) & 0xff, 8)
        .storeUint(Number(status) & 0xff, 8)
        .storeUint(Number(paidMask) & 0xff, 8)
        .storeCoins(creditedAmount0)
        .storeCoins(creditedAmount1)
        .storeRef(b3)
        .endCell();

    const b1 = beginCell()
        .storeAddress(p0)
        .storeAddress(p1)
        .storeAddress(p2)
        .storeCoins(stake0)
        .storeRef(b2)
        .endCell();

    return beginCell()
        .storeUint(Number(contractVersion), 16)
        .storeUint(bufferToUint256(depositIdHash), 256)
        .storeUint(bufferToUint256(roomIdHash), 256)
        .storeUint(bufferToUint256(gameIdHash), 256)
        .storeRef(b1)
        .endCell();

}

/**
 * Decode DepositContract init data produced by buildDepositDataCell.
 *
 * @param {Cell} dataCell
 */
export function loadDepositDataCell(dataCell) {

    const slice = dataCell.beginParse();
    const contractVersion = slice.loadUint(16);
    const depositIdHash = slice.loadUintBig(256);
    const roomIdHash = slice.loadUintBig(256);
    const gameIdHash = slice.loadUintBig(256);

    const sc1 = slice.loadRef().beginParse();
    const player0 = sc1.loadAddress();
    const player1 = sc1.loadAddress();
    const player2 = sc1.loadAddress();
    const expectedStake0 = sc1.loadCoins();

    const sc2 = sc1.loadRef().beginParse();
    const expectedStake1 = sc2.loadCoins();
    const expectedStake2 = sc2.loadCoins();
    const creationFeePerSeat = sc2.loadCoins();
    const expiresAt = sc2.loadUintBig(64);
    const releaseAuthority = sc2.loadAddress();
    const networkTag = sc2.loadUintBig(8);
    const status = sc2.loadUintBig(8);
    const paidMask = sc2.loadUintBig(8);
    const creditedAmount0 = sc2.loadCoins();
    const creditedAmount1 = sc2.loadCoins();

    const sc3 = sc2.loadRef().beginParse();
    const creditedAmount2 = sc3.loadCoins();
    const surplusNano = sc3.loadCoins();
    const refundMask = sc3.loadUintBig(8);
    const releasedTo = sc3.loadAddress();
    const totalCredited = sc3.loadCoins();

    return {
        contractVersion,
        depositIdHash,
        roomIdHash,
        gameIdHash,
        player0,
        player1,
        player2,
        expectedStake0,
        expectedStake1,
        expectedStake2,
        creationFeePerSeat,
        expiresAt,
        releaseAuthority,
        networkTag,
        status,
        paidMask,
        creditedAmount0,
        creditedAmount1,
        creditedAmount2,
        surplusNano,
        refundMask,
        releasedTo,
        totalCredited
    };

}

function normalizePlayers(rawPlayers, { roomId, gameId }) {

    if (!Array.isArray(rawPlayers)) {

        throw new DepositStateInitError("players must be an array", { roomId, gameId });

    }

    if (rawPlayers.length !== REQUIRED_DEPOSIT_PLAYER_COUNT) {

        throw new DepositStateInitError(
            `Deposit StateInit requires exactly ${REQUIRED_DEPOSIT_PLAYER_COUNT} players`,
            { roomId, gameId, playerCount: rawPlayers.length }
        );

    }

    const normalized = rawPlayers.map((raw, index) => {

        const walletRaw = raw?.wallet ?? raw?.walletAddress ?? "";

        const wallet = canonicalizeTonWalletAddress(String(walletRaw));

        if (!wallet) {

            throw new DepositStateInitError("Each player must include a valid wallet", {
                roomId,
                gameId,
                seatIndex: index,
                wallet: walletRaw
            });

        }

        const expectedStake = assertPositiveNanoton(
            raw?.expectedStake ?? raw?.expectedStakeNano ?? raw?.stakeNano,
            `players[${index}].expectedStake`
        );

        return {
            playerId: normalizeDepositIdPart(raw?.playerId) || `seat${index}`,
            wallet,
            expectedAmount: Number(expectedStake),
            expectedStake
        };

    });

    return assertPlayerBindings(normalized, { roomId, gameId });

}

function resolveReleaseAuthority(network, releaseAuthority = null, env = process.env) {

    if (releaseAuthority) {

        const resolved = resolveTonAddress(releaseAuthority, ZERO_ADDRESS);

        if (resolved.equals(ZERO_ADDRESS)) {

            throw new DepositStateInitError("releaseAuthority is invalid", {
                network,
                releaseAuthority
            });

        }

        return resolved;

    }

    const oracle = resolveOracleWalletConfig(network, env);

    if (!oracle.configured || !oracle.address) {

        throw new DepositStateInitError(
            "releaseAuthority is not configured for network",
            { network, oracleSource: oracle.source }
        );

    }

    return resolveTonAddress(oracle.address, ZERO_ADDRESS);

}

/**
 * Build deterministic DepositContract StateInit.
 *
 * @param {object} params
 */
export function buildDepositStateInit({
    depositId,
    roomId,
    gameId,
    players,
    creationFeePerSeat,
    expiresAt,
    network = "testnet",
    releaseAuthority = null,
    contractVersion = DEPOSIT_CONTRACT_VERSION,
    workchain = 0,
    testOnly = null,
    expectedArtifactSha256 = null,
    env = process.env
} = {}) {

    const normalizedDepositId = normalizeDepositIdPart(depositId);

    if (!normalizedDepositId) {

        throw new DepositStateInitError("depositId is required");

    }

    const normalizedRoomId = normalizeDepositIdPart(roomId);

    if (!normalizedRoomId) {

        throw new DepositStateInitError("roomId is required");

    }

    const normalizedGameId = normalizeDepositIdPart(gameId);

    if (!normalizedGameId) {

        throw new DepositStateInitError("gameId is required");

    }

    const version = Number(contractVersion);

    if (!Number.isInteger(version) || version <= 0) {

        throw new DepositStateInitError("contractVersion must be a positive integer", {
            contractVersion
        });

    }

    if (version !== DEPOSIT_CONTRACT_VERSION) {

        throw new DepositStateInitError("unsupported DepositContract version", {
            contractVersion: version,
            supportedVersion: DEPOSIT_CONTRACT_VERSION
        });

    }

    const bindings = normalizePlayers(players, {
        roomId: normalizedRoomId,
        gameId: normalizedGameId
    });

    const fee = assertPositiveNanoton(creationFeePerSeat, "creationFeePerSeat");
    const expiry = assertExpiresAt(expiresAt);
    const networkTag = resolveNetworkTag(network);
    const authority = resolveReleaseAuthority(network, releaseAuthority, env);

    const depositIdHashBuffer = hashDepositId(normalizedDepositId);
    const roomIdHashBuffer = hashRoomId(normalizedRoomId);
    const gameIdHashBuffer = hashGameId(normalizedGameId);

    const code = loadDepositCodeCell({ expectedSha256: expectedArtifactSha256 });

    const data = buildDepositDataCell({
        contractVersion: version,
        depositIdHash: depositIdHashBuffer,
        roomIdHash: roomIdHashBuffer,
        gameIdHash: gameIdHashBuffer,
        player0: bindings[0].wallet,
        player1: bindings[1].wallet,
        player2: bindings[2].wallet,
        expectedStake0: BigInt(bindings[0].expectedAmount),
        expectedStake1: BigInt(bindings[1].expectedAmount),
        expectedStake2: BigInt(bindings[2].expectedAmount),
        creationFeePerSeat: fee,
        expiresAt: expiry,
        releaseAuthority: authority,
        networkTag
    });

    const stateInit = { code, data };
    const address = contractAddress(workchain, stateInit);
    const testOnlyFlag = resolveTestOnly({ network, testOnly });

    return {
        code,
        data,
        stateInit,
        address,
        addressFriendly: address.toString({
            bounceable: true,
            urlSafe: true,
            testOnly: testOnlyFlag
        }),
        depositId: normalizedDepositId,
        roomId: normalizedRoomId,
        gameId: normalizedGameId,
        depositIdHash: depositIdHashBuffer.toString("hex"),
        roomIdHash: roomIdHashBuffer.toString("hex"),
        gameIdHash: gameIdHashBuffer.toString("hex"),
        contractVersion: version,
        networkTag,
        network,
        creationFeePerSeat: fee,
        expiresAt: expiry,
        releaseAuthority: authority,
        bindings,
        workchain
    };

}

export function getZeroTonAddress() {

    return ZERO_ADDRESS;

}

export function resetDepositCodeCellCacheForTests() {

    cachedCodeCell = null;

}
