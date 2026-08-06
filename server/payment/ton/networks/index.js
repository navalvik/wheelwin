/**
 * R7.66A — Network registry for future GameEscrow deploy (not used by V4 path).
 */

import { mainnet } from "./mainnet.js";
import { testnet } from "./testnet.js";

export { mainnet, testnet };

const BY_NAME = Object.freeze({
    testnet,
    mainnet
});

/**
 * @param {string} name
 * @returns {typeof testnet | typeof mainnet}
 */
export function getTonNetwork(name) {

    const key = String(name ?? "").trim().toLowerCase();

    const network = BY_NAME[key];

    if (!network) {

        throw new Error(`Unknown TON network: ${name}`);

    }

    return network;

}

export function listTonNetworks() {

    return Object.freeze([testnet, mainnet]);

}
