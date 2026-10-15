/**
 * @typedef {object} PaymentIntentStoreContract
 * @property {string} dataDir
 * @property {number} size
 * @property {() => void} initialize
 * @property {(paymentReference: string) => boolean} has
 * @property {(paymentReference: string) => import("./PaymentIntent.js").PaymentIntent|null} get
 * @property {(paymentReference: string) => import("./PaymentIntent.js").PaymentIntent} require
 * @property {() => Array<import("./PaymentIntent.js").PaymentIntent>} list
 * @property {(roomId: string) => Array<import("./PaymentIntent.js").PaymentIntent>} listForRoom
 * @property {(transactionId: string) => import("./PaymentIntent.js").PaymentIntent|null} findByTransactionId
 * @property {() => Map<string, string>} listCreditedTransactions
 * @property {(intent: import("./PaymentIntent.js").PaymentIntent|object) => import("./PaymentIntent.js").PaymentIntent} save
 * @property {(intent: import("./PaymentIntent.js").PaymentIntent|object) => import("./PaymentIntent.js").PaymentIntent} update
 */

/**
 * Structural contract shared by the payment service and room ledger.
 *
 * This intentionally describes only the capabilities those consumers use.
 * A store may implement the contract without inheriting from PaymentIntentStore.
 */
const REQUIRED_METHODS = Object.freeze([
    "initialize",
    "has",
    "get",
    "require",
    "list",
    "listForRoom",
    "findByTransactionId",
    "listCreditedTransactions",
    "save",
    "update"
]);

/**
 * @param {unknown} value
 * @returns {value is PaymentIntentStoreContract}
 */
export function isPaymentIntentStoreContract(value) {

    if (value === null || (typeof value !== "object" && typeof value !== "function")) {

        return false;

    }

    if (typeof value.dataDir !== "string" || value.dataDir.trim() === "") {

        return false;

    }

    if (!("size" in value)) {

        return false;

    }

    return REQUIRED_METHODS.every((method) => typeof value[method] === "function");

}
