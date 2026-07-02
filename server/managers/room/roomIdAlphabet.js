import { randomInt } from "node:crypto";

export const ROOM_ID_LENGTH = 4;

export const ROOM_ID_ALPHABET = "ACDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

export function generateRoomId(randomIntFn = randomInt) {

    let roomId = "";

    for (let index = 0; index < ROOM_ID_LENGTH; index += 1) {

        const alphabetIndex = randomIntFn(ROOM_ID_ALPHABET.length);

        roomId += ROOM_ID_ALPHABET[alphabetIndex];

    }

    return roomId;

}

export function isValidRoomId(roomId) {

    if (typeof roomId !== "string" || roomId.length !== ROOM_ID_LENGTH) {

        return false;

    }

    for (let index = 0; index < roomId.length; index += 1) {

        if (!ROOM_ID_ALPHABET.includes(roomId[index])) {

            return false;

        }

    }

    return true;

}

export function normalizeRoomId(rawRoomId) {

    if (rawRoomId === null || rawRoomId === undefined) {

        return null;

    }

    const normalized = String(rawRoomId).trim();

    if (normalized.length === 0) {

        return null;

    }

    return normalized;

}
