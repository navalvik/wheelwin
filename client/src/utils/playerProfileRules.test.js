import {
    calculatePaymentGram,
    isValidPlayerAge
} from "./playerProfileRules.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

assert(calculatePaymentGram(1, 1) === 1, "1 sector stake 1 → 1");

assert(calculatePaymentGram(1, 2) === 2.5, "2 sectors stake 1 → 2.5");

assert(calculatePaymentGram(10, 1) === 10, "1 sector stake 10 → 10");

assert(calculatePaymentGram(10, 2) === 25, "2 sectors stake 10 → 25");

assert(calculatePaymentGram(10) === 10, "default sector count is 1");

assert(isValidPlayerAge(18), "age 18 valid");

assert(!isValidPlayerAge(17), "age 17 invalid");

console.log("playerProfileRules.test.js: all assertions passed");
