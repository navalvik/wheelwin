import {
    generateRoomId,
    isValidRoomId,
    normalizeRoomId,
    ROOM_ID_ALPHABET,
    ROOM_ID_LENGTH
} from "../managers/room/roomIdAlphabet.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

assert(
    generateRoomId(() => 0).length === ROOM_ID_LENGTH,
    "generated room id should be 4 characters"
);

assert(
    generateRoomId(() => 0) === ROOM_ID_ALPHABET[0].repeat(ROOM_ID_LENGTH),
    "generated room id should use the configured alphabet"
);

assert(isValidRoomId("A7fK"), "mixed-case example should be valid");

assert(isValidRoomId("p9Q2"), "mixed-case example should be valid");

assert(isValidRoomId("X8mZ"), "mixed-case example should be valid");

assert(!isValidRoomId("room_123"), "uuid-style room ids should be invalid");

assert(!isValidRoomId("ABCD"), "B is not in the alphabet");

assert(!isValidRoomId("A7f"), "room id must be exactly 4 characters");

assert(!isValidRoomId("A7fK9"), "room id must be exactly 4 characters");

assert(
    normalizeRoomId("  p9Q2  ") === "p9Q2",
    "normalize should trim whitespace"
);

console.log("roomIdAlphabet tests passed");
