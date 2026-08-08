/**
 * T2.3 — Game contract message serializers (ABI encoding only).
 */

import { Address, beginCell, toNano } from "@ton/core";

import {
    GAME_CONTRACT_OPCODES,
    GAME_CONTRACT_VERSION
} from "./GameContractOpcodes.js";
import { SerializationError } from "./GameContractErrors.js";

/** GameEscrow Tact SETTLE opcode width (legacy V4 path still uses 24). */
export const GAME_ESCROW_SETTLE_OPCODE_BITS = 32;

function snapshotHashToUint256(snapshotHash) {

    if (typeof snapshotHash === "bigint") {

        return snapshotHash;

    }

    if (Buffer.isBuffer(snapshotHash)) {

        return BigInt(`0x${snapshotHash.toString("hex")}`);

    }

    const hex = String(snapshotHash ?? "").replace(/^0x/i, "").trim();

    if (!/^[0-9a-f]+$/i.test(hex) || hex.length !== 64) {

        throw new Error("snapshotHash must be a 32-byte hex string");

    }

    return BigInt(`0x${hex}`);

}

function amountToNano(amount) {

    if (typeof amount === "bigint") {

        return amount;

    }

    return toNano(String(amount ?? 0));

}

export function serializeInitGameBody({
    snapshotHash,
    gameId,
    roomId,
    tonNetworkId
}) {

    try {

        const hashBuffer = Buffer.from(String(snapshotHash ?? ""), "hex");

        return beginCell()
            .storeUint(GAME_CONTRACT_OPCODES.INIT_GAME, 32)
            .storeUint(GAME_CONTRACT_VERSION, 16)
            .storeBuffer(hashBuffer.subarray(0, 32).length === 32
                ? hashBuffer.subarray(0, 32)
                : Buffer.alloc(32))
            .storeStringTail(String(gameId ?? ""))
            .storeStringTail(String(roomId ?? ""))
            .storeStringTail(String(tonNetworkId ?? ""))
            .endCell();

    } catch (error) {

        throw new SerializationError(
            "Failed to serialize init game body",
            { cause: error?.message ?? null }
        );

    }

}

/**
 * R7.66H — GameEscrow Tact INIT_GAME body (matches contracts/game_escrow ABI).
 *
 * Layout:
 *   op:uint32 oracle:MsgAddress owner:MsgAddress
 *   contractIdHash:uint256 ^[ snapshotHash:uint256 ]
 */
export function serializeGameEscrowInitGameBody({
    oracle,
    owner,
    contractIdHash,
    snapshotHash
}) {

    try {

        const oracleAddress = Address.parse(String(oracle).trim());
        const ownerAddress = Address.parse(String(owner).trim());
        const contractIdHashInt = snapshotHashToUint256(contractIdHash);
        const snapshotHashInt = snapshotHashToUint256(snapshotHash);

        const tail = beginCell()
            .storeUint(snapshotHashInt, 256)
            .endCell();

        return beginCell()
            .storeUint(GAME_CONTRACT_OPCODES.INIT_GAME, 32)
            .storeAddress(oracleAddress)
            .storeAddress(ownerAddress)
            .storeUint(contractIdHashInt, 256)
            .storeRef(tail)
            .endCell();

    } catch (error) {

        throw new SerializationError(
            "Failed to serialize GameEscrow INIT_GAME body",
            { cause: error?.message ?? null }
        );

    }

}

export function serializeSettleBody({
    winnerWallet,
    winnerAmount,
    organizerAmount
}) {

    try {

        return beginCell()
            .storeUint(GAME_CONTRACT_OPCODES.SETTLE, 24)
            .storeCoins(toNano(String(winnerAmount ?? 0)))
            .storeCoins(toNano(String(organizerAmount ?? 0)))
            .storeAddress(Address.parse(String(winnerWallet).trim()))
            .endCell();

    } catch (error) {

        throw new SerializationError(
            "Failed to serialize settle body",
            { cause: error?.message ?? null }
        );

    }

}

/**
 * R7.66F — GameEscrow Tact SETTLE body (matches contracts/game_escrow ABI).
 *
 * Layout (32-bit opcode):
 *   op:uint32 snapshotHash:uint256 winner:MsgAddress
 *   winnerAmount:Coins ownerAmount:Coins
 *
 * ownerAddress is NOT in the on-chain message (owner comes from INIT storage);
 * callers may pass it for diagnostics only.
 */
export function serializeGameEscrowSettleBody({
    snapshotHash,
    winnerWallet,
    winnerAmount,
    ownerAmount = null,
    organizerAmount = null
}) {

    try {

        const winner = Address.parse(String(winnerWallet).trim());
        const payoutOwnerAmount = ownerAmount ?? organizerAmount ?? 0;

        return beginCell()
            .storeUint(GAME_CONTRACT_OPCODES.SETTLE, GAME_ESCROW_SETTLE_OPCODE_BITS)
            .storeUint(snapshotHashToUint256(snapshotHash), 256)
            .storeAddress(winner)
            .storeCoins(amountToNano(winnerAmount))
            .storeCoins(amountToNano(payoutOwnerAmount))
            .endCell();

    } catch (error) {

        throw new SerializationError(
            "Failed to serialize GameEscrow settle body",
            { cause: error?.message ?? null }
        );

    }

}

export function serializeLegacySettleBody({
    winnerAmount,
    organizerAmount
}) {

    try {

        return beginCell()
            .storeUint(GAME_CONTRACT_OPCODES.SETTLE, 24)
            .storeCoins(toNano(String(winnerAmount ?? 0)))
            .storeCoins(toNano(String(organizerAmount ?? 0)))
            .endCell();

    } catch (error) {

        throw new SerializationError(
            "Failed to serialize legacy settle body",
            { cause: error?.message ?? null }
        );

    }

}

/**
 * R7.69A — OPEN_PAYMENTS body (oracle registers seats after INIT_GAME).
 *
 * Layout matches Tact storeOpenPayments (cell overflow split):
 *   op:uint32 player0 stake0 player1 stake1 ^[ player2 stake2 ]
 */
export function serializeGameEscrowOpenPaymentsBody({
    player0,
    stake0,
    player1,
    stake1,
    player2,
    stake2
}) {

    try {

        const tail = beginCell()
            .storeAddress(Address.parse(String(player2).trim()))
            .storeCoins(amountToNano(stake2))
            .endCell();

        return beginCell()
            .storeUint(GAME_CONTRACT_OPCODES.OPEN_PAYMENTS, 32)
            .storeAddress(Address.parse(String(player0).trim()))
            .storeCoins(amountToNano(stake0))
            .storeAddress(Address.parse(String(player1).trim()))
            .storeCoins(amountToNano(stake1))
            .storeRef(tail)
            .endCell();

    } catch (error) {

        throw new SerializationError(
            "Failed to serialize GameEscrow OPEN_PAYMENTS body",
            { cause: error?.message ?? null }
        );

    }

}

/**
 * R7.69A — STAKE body for TonConnect / player deposits.
 *
 * Layout:
 *   op:uint32 playerIndex:uint8
 */
export function serializeGameEscrowStakeBody({ playerIndex }) {

    try {

        const index = Number(playerIndex);

        if (!Number.isInteger(index) || index < 0 || index > 255) {

            throw new Error("playerIndex must be an integer 0..255");

        }

        return beginCell()
            .storeUint(GAME_CONTRACT_OPCODES.STAKE, 32)
            .storeUint(index, 8)
            .endCell();

    } catch (error) {

        throw new SerializationError(
            "Failed to serialize GameEscrow STAKE body",
            { cause: error?.message ?? null }
        );

    }

}

export function serializeEmergencyCancelBody({ reasonCode = 0 } = {}) {

    try {

        return beginCell()
            .storeUint(GAME_CONTRACT_OPCODES.EMERGENCY_CANCEL, 32)
            .storeUint(Number(reasonCode) || 0, 32)
            .endCell();

    } catch (error) {

        throw new SerializationError(
            "Failed to serialize emergency cancel body",
            { cause: error?.message ?? null }
        );

    }

}

export function serializeArchiveBody() {

    try {

        return beginCell()
            .storeUint(GAME_CONTRACT_OPCODES.ARCHIVE, 32)
            .endCell();

    } catch (error) {

        throw new SerializationError(
            "Failed to serialize archive body",
            { cause: error?.message ?? null }
        );

    }

}

export function serializeDeployBocPlaceholder({ contractId }) {

    return Buffer.from(`deploy:${contractId}`).toString("base64");

}

export function serializeSettleBocPlaceholder({ contractId, winnerId }) {

    return Buffer.from(`settle:${contractId}:${winnerId ?? ""}`).toString("base64");

}
