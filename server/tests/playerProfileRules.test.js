import {
    isAllowedBaseStake,
    isValidPlayerAge,
    MAX_PLAYER_AGE,
    MIN_PLAYER_AGE
} from "../models/PlayerProfileRules.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

assert(MIN_PLAYER_AGE === 18, "min age must be 18");

assert(MAX_PLAYER_AGE === 120, "max age must be 120");

assert(isValidPlayerAge(18), "age 18 must be accepted");

assert(isValidPlayerAge(120), "age 120 must be accepted");

assert(isValidPlayerAge("25"), "numeric string ages must be accepted");

assert(!isValidPlayerAge(17), "age 17 must be rejected");

assert(!isValidPlayerAge(121), "age 121 must be rejected");

assert(!isValidPlayerAge(18.5), "non-integer age must be rejected");

assert(!isValidPlayerAge(""), "empty age must be rejected");

assert(!isValidPlayerAge(null), "null age must be rejected");

assert(isAllowedBaseStake(1), "stake 1 must be allowed");

assert(isAllowedBaseStake(10), "stake 10 must be allowed");

assert(!isAllowedBaseStake(5), "stake 5 must be rejected");

console.log("PlayerProfileRules tests passed");
