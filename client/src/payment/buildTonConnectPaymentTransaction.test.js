import assert from "node:assert/strict";

import {
    buildTonConnectPaymentTransaction,
    requiredGramToNanotonString
} from "./buildTonConnectPaymentTransaction.js";

assert.equal(requiredGramToNanotonString(10), "10000000000");
assert.equal(requiredGramToNanotonString("1"), "1000000000");

assert.throws(
    () => requiredGramToNanotonString(0),
    /positive/
);

assert.throws(
    () => requiredGramToNanotonString(null),
    /requiredGram/
);

const nowMs = 1_700_000_000_000;
const destination = "EQDROOMWALLET";

const tx = buildTonConnectPaymentTransaction({
    paymentDestination: destination,
    requiredGram: 1,
    validUntilSeconds: 600,
    nowMs
});

assert.equal(tx.validUntil, Math.floor(nowMs / 1000) + 600);
assert.equal(tx.messages.length, 1);
assert.equal(tx.messages[0].address, destination);
assert.equal(tx.messages[0].amount, "1000000000");
assert.equal("payload" in tx.messages[0], false);

assert.throws(
    () => buildTonConnectPaymentTransaction({
        paymentDestination: "",
        requiredGram: 1
    }),
    /payment destination/
);

console.log("buildTonConnectPaymentTransaction.test.js: all assertions passed");
