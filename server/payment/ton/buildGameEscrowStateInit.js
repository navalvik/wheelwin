import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    Address,
    beginCell,
    Cell,
    contractAddress
} from "@ton/core";
import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import {
    GAME_ESCROW_MODE_GAME,
    GAME_ESCROW_MODE_V4,
    resolveGameEscrowMode
} from "../../config/gameEscrowMode.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export {
    GAME_ESCROW_MODE_GAME,
    GAME_ESCROW_MODE_V4,
    resolveGameEscrowMode
};

export const GAME_ESCROW_VERSION = 1;
export const GAME_ESCROW_STATUS_UNINITIALIZED = 0;

const ARTIFACT_BOC_PATH = join(__dirname, "artifacts", "GameEscrow.code.boc");
const ARTIFACT_META_PATH = join(__dirname, "artifacts", "GameEscrow.code.json");

const ZERO_ADDRESS = new Address(0, Buffer.alloc(32));

let cachedCodeCell = null;

/**
 * P6.6 / R7.66D / R7.67A — Deterministic Game Escrow StateInit.
 *
 * GAME_ESCROW_MODE=game → GameEscrow (testnet default)
 * GAME_ESCROW_MODE=v4  → legacy WalletContractV4 (explicit rollback / mainnet default)
 */

export function hashGameContractSnapshot(snapshot) {

    const payload = JSON.stringify({
        gameId: snapshot?.gameId ?? null,
        roomId: snapshot?.roomId ?? null,
        totalPot: snapshot?.totalPot ?? null,
        organizerFee: snapshot?.organizerFee ?? null,
        players: (snapshot?.players ?? []).map((player) => ({
            playerId: player.playerId,
            wallet: player.wallet,
            requiredGram: player.requiredGram
        }))
    });

    return createHash("sha256").update(payload).digest();

}

export function bufferToUint256(buffer) {

    return BigInt(`0x${Buffer.from(buffer).toString("hex")}`);

}

export function hashToUint256(value) {

    if (typeof value === "bigint") {

        return value;

    }

    if (Buffer.isBuffer(value)) {

        return bufferToUint256(value);

    }

    const hex = String(value ?? "").replace(/^0x/i, "");

    if (/^[0-9a-f]+$/i.test(hex) && hex.length === 64) {

        return BigInt(`0x${hex}`);

    }

    return bufferToUint256(
        createHash("sha256").update(String(value ?? "")).digest()
    );

}

export function resolveTonAddress(raw, fallback = ZERO_ADDRESS) {

    if (raw instanceof Address) {

        return raw;

    }

    if (typeof raw === "string" && raw.trim()) {

        try {

            return Address.parse(raw.trim());

        } catch {

            return fallback;

        }

    }

    return fallback;

}

/**
 * Load compiled GameEscrow code cell from committed artifact.
 */
export function loadGameEscrowCodeCell({ forceReload = false } = {}) {

    if (cachedCodeCell && !forceReload) {

        return cachedCodeCell;

    }

    const boc = readFileSync(ARTIFACT_BOC_PATH);
    const cells = Cell.fromBoc(boc);

    if (!cells.length) {

        throw new Error(`GameEscrow artifact empty: ${ARTIFACT_BOC_PATH}`);

    }

    cachedCodeCell = cells[0];

    return cachedCodeCell;

}

export function loadGameEscrowArtifactMeta() {

    return JSON.parse(readFileSync(ARTIFACT_META_PATH, "utf8"));

}

/**
 * Tact storage layout (after loaded=1 bit) — R7.69C:
 * version:uint16 status:uint8 oracle owner contractIdHash:uint256
 * ^[ snapshotHash winner winnerAmount ownerAmount settled paidMask totalPaid
 *    ^[ requiredTotal player0 stake0 player1 stake1
 *       ^[ player2 stake2 refundMask refundedAmount cancelReason ] ] ]
 */
export function buildGameEscrowDataCell({
    version = GAME_ESCROW_VERSION,
    status = GAME_ESCROW_STATUS_UNINITIALIZED,
    oracle,
    owner,
    contractIdHash,
    snapshotHash,
    winner = ZERO_ADDRESS,
    winnerAmount = 0n,
    ownerAmount = 0n,
    settled = false,
    paidMask = 0,
    totalPaid = 0n,
    requiredTotal = 0n,
    player0 = ZERO_ADDRESS,
    stake0 = 0n,
    player1 = ZERO_ADDRESS,
    stake1 = 0n,
    player2 = ZERO_ADDRESS,
    stake2 = 0n,
    refundMask = 0,
    refundedAmount = 0n,
    cancelReason = 0
} = {}) {

    const oracleAddress = resolveTonAddress(oracle, ZERO_ADDRESS);
    const ownerAddress = resolveTonAddress(owner, ZERO_ADDRESS);
    const winnerAddress = resolveTonAddress(winner, ZERO_ADDRESS);
    const p0 = resolveTonAddress(player0, ZERO_ADDRESS);
    const p1 = resolveTonAddress(player1, ZERO_ADDRESS);
    const p2 = resolveTonAddress(player2, ZERO_ADDRESS);

    const contractIdHashInt = hashToUint256(contractIdHash);
    const snapshotHashInt = hashToUint256(snapshotHash);

    const rosterTail = beginCell()
        .storeAddress(p2)
        .storeCoins(stake2)
        .storeUint(Number(refundMask) & 0xff, 8)
        .storeCoins(refundedAmount)
        .storeUint(Number(cancelReason) >>> 0, 32)
        .endCell();

    const roster = beginCell()
        .storeCoins(requiredTotal)
        .storeAddress(p0)
        .storeCoins(stake0)
        .storeAddress(p1)
        .storeCoins(stake1)
        .storeRef(rosterTail)
        .endCell();

    const tail = beginCell()
        .storeUint(snapshotHashInt, 256)
        .storeAddress(winnerAddress)
        .storeCoins(winnerAmount)
        .storeCoins(ownerAmount)
        .storeBit(Boolean(settled))
        .storeUint(Number(paidMask) & 0xff, 8)
        .storeCoins(totalPaid)
        .storeRef(roster)
        .endCell();

    // loaded=1 → contract_load reads GameEscrow$Data (skips empty init()).
    return beginCell()
        .storeBit(true)
        .storeUint(Number(version), 16)
        .storeUint(Number(status), 8)
        .storeAddress(oracleAddress)
        .storeAddress(ownerAddress)
        .storeUint(contractIdHashInt, 256)
        .storeRef(tail)
        .endCell();

}

export function buildGameEscrowStateInit({
    contractId,
    snapshot,
    oracle = null,
    owner = null,
    workchain = 0
} = {}) {

    const snapshotHashBuffer = hashGameContractSnapshot(snapshot);
    const contractIdHashBuffer = createHash("sha256")
        .update(String(contractId ?? ""))
        .digest();

    const oracleAddress = resolveTonAddress(
        oracle
            ?? snapshot?.oracleWallet
            ?? snapshot?.oracle
            ?? process.env.GAME_ESCROW_ORACLE
            ?? process.env.TON_ORACLE_ADDRESS,
        ZERO_ADDRESS
    );

    const ownerAddress = resolveTonAddress(
        owner
            ?? snapshot?.ownerWallet
            ?? process.env.GAME_ESCROW_OWNER,
        ZERO_ADDRESS
    );

    const code = loadGameEscrowCodeCell();
    const data = buildGameEscrowDataCell({
        version: GAME_ESCROW_VERSION,
        status: GAME_ESCROW_STATUS_UNINITIALIZED,
        oracle: oracleAddress,
        owner: ownerAddress,
        contractIdHash: contractIdHashBuffer,
        snapshotHash: snapshotHashBuffer,
        winner: ZERO_ADDRESS,
        winnerAmount: 0n,
        ownerAmount: 0n,
        settled: false,
        refundMask: 0,
        refundedAmount: 0n,
        cancelReason: 0
    });

    const stateInit = { code, data };
    const address = contractAddress(workchain, stateInit);

    return {
        mode: GAME_ESCROW_MODE_GAME,
        wallet: null,
        keyPair: null,
        code,
        data,
        stateInit,
        address,
        addressFriendly: address.toString({
            bounceable: true,
            urlSafe: true
        }),
        snapshotHash: snapshotHashBuffer.toString("hex"),
        contractIdHash: contractIdHashBuffer.toString("hex"),
        oracle: oracleAddress,
        owner: ownerAddress,
        workchain
    };

}

function buildV4EscrowWallet({ contractId, snapshot }) {

    const snapshotHash = hashGameContractSnapshot(snapshot);

    const seed = createHash("sha256")
        .update(Buffer.concat([
            snapshotHash,
            Buffer.from(String(contractId))
        ]))
        .digest();

    const keyPair = keyPairFromSeed(seed);

    const wallet = WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey
    });

    return {
        mode: GAME_ESCROW_MODE_V4,
        wallet,
        keyPair,
        address: wallet.address,
        addressFriendly: wallet.address.toString({
            bounceable: true,
            urlSafe: true
        }),
        snapshotHash: snapshotHash.toString("hex"),
        stateInit: wallet.init
    };

}

/**
 * Build escrow StateInit for deploy.
 * Testnet default is game; pass mode=v4 (or GAME_ESCROW_MODE=v4) for rollback.
 */
export function buildGameEscrowWallet({
    contractId,
    snapshot,
    oracle = null,
    owner = null,
    mode = null,
    workchain = 0
} = {}) {

    const resolvedMode = resolveGameEscrowMode(mode);

    if (resolvedMode === GAME_ESCROW_MODE_GAME) {

        return buildGameEscrowStateInit({
            contractId,
            snapshot,
            oracle,
            owner,
            workchain
        });

    }

    return buildV4EscrowWallet({ contractId, snapshot });

}

export function parseFriendlyAddress(raw) {

    if (typeof raw !== "string" || !raw.trim()) {

        return null;

    }

    try {

        return Address.parse(raw.trim());

    } catch {

        return null;

    }

}

export function getZeroTonAddress() {

    return ZERO_ADDRESS;

}
