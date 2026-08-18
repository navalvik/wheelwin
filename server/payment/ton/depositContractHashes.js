/**
 * R17.9L.12 — Deterministic Deposit Contract identity hashes (R17.9L.10).
 */
import { createHash } from "node:crypto";

import { normalizeDepositIdPart } from "../../deposit/depositValidation.js";

export const DOMAIN_DEPOSIT_ID = "WheelWin:Deposit:depositId:v1";
export const DOMAIN_ROOM = "WheelWin:Deposit:roomId:v1";
export const DOMAIN_GAME = "WheelWin:Deposit:gameId:v1";

function domainSeparatedHash(domain, rawValue) {

    const normalized = normalizeDepositIdPart(String(rawValue ?? ""));

    return createHash("sha256")
        .update(Buffer.from(domain, "utf8"))
        .update(Buffer.from([0x00]))
        .update(Buffer.from(normalized, "utf8"))
        .digest();

}

/**
 * @param {string} depositId
 * @returns {Buffer} 32-byte SHA256 digest
 */
export function hashDepositId(depositId) {

    return domainSeparatedHash(DOMAIN_DEPOSIT_ID, depositId);

}

/**
 * @param {string} roomId
 * @returns {Buffer}
 */
export function hashRoomId(roomId) {

    return domainSeparatedHash(DOMAIN_ROOM, roomId);

}

/**
 * @param {string} gameId
 * @returns {Buffer}
 */
export function hashGameId(gameId) {

    return domainSeparatedHash(DOMAIN_GAME, gameId);

}

/**
 * @param {Buffer|bigint|string} value
 * @returns {bigint}
 */
export function bufferToUint256(value) {

    if (typeof value === "bigint") {

        return value;

    }

    if (Buffer.isBuffer(value)) {

        return BigInt(`0x${value.toString("hex")}`);

    }

    const hex = String(value ?? "").replace(/^0x/i, "");

    if (/^[0-9a-f]+$/i.test(hex) && hex.length === 64) {

        return BigInt(`0x${hex}`);

    }

    throw new Error("Invalid uint256 value");

}
