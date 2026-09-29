/**
 * R18.S125 — Operator-facing TON Explorer reference helpers (DISPLAY-ONLY).
 *
 * Built on the existing R7.66A network presets (`mainnet.js` / `testnet.js`
 * `explorerBaseUrl`). These helpers ONLY construct human-readable URLs that an
 * operator can open manually in a browser to perform the FINAL verification
 * step of the refund / settlement validation procedure.
 *
 * Hard rules (must never be violated by any consumer):
 * - WheelWin NEVER reads Explorer data back into the system. There is no
 *   fetch, no scraping, no parsing of Explorer responses anywhere.
 * - Explorer references are NEVER part of payout/refund authorization,
 *   preflight gating, or any financial decision. On-chain confirmation
 *   authority remains the configured TON Center RPC
 *   (`confirmPayoutOnChain` in `roomWalletTerminalRecoveryChain.js`).
 * - The Explorer step is a FINAL HUMAN verification step performed AFTER the
 *   code-level TON Center confirmation has already succeeded.
 * - Pure functions: no network I/O, no secrets, no external dependencies.
 * - Fail-safe: any invalid input yields `null` instead of a guess.
 */

import { mainnet } from "./mainnet.js";
import { testnet } from "./testnet.js";

const PRESETS_BY_NETWORK_ID = Object.freeze({
    [String(testnet.networkId).toLowerCase()]: testnet,
    [String(mainnet.networkId).toLowerCase()]: mainnet
});

// TON transaction hashes are 64 hex characters (toncenter v2 transaction ids).
const TRANSACTION_HASH_PATTERN = /^[0-9a-fA-F]{64}$/;

// TON user-friendly address (base64url body) or raw address (workchain:hex).
const USER_FRIENDLY_ADDRESS_PATTERN = /^(?:EQ|UQ)[A-Za-z0-9_-]{46}$/;
const RAW_ADDRESS_PATTERN = /^(?:0|-1):[0-9a-fA-F]{64}$/;

/**
 * Resolve the explorer base URL for a network id ("testnet" | "mainnet").
 * @param {string|null} networkId
 * @returns {string|null} base URL without trailing slash, or null.
 */
export function resolveOperatorExplorerBaseUrl(networkId) {

    const key = String(networkId ?? "").trim().toLowerCase();

    const preset = PRESETS_BY_NETWORK_ID[key];

    const base = String(preset?.explorerBaseUrl ?? "").trim();

    if (!base) {

        return null;

    }

    return base.replace(/\/+$/, "");

}

/**
 * Build an operator-facing explorer transaction URL. DISPLAY-ONLY.
 * @param {string|null} networkId
 * @param {string|null} transactionHash
 * @returns {string|null}
 */
export function buildOperatorExplorerTransactionUrl(networkId, transactionHash) {

    const base = resolveOperatorExplorerBaseUrl(networkId);

    const hash = String(transactionHash ?? "").trim().toLowerCase();

    if (!base || !TRANSACTION_HASH_PATTERN.test(hash)) {

        return null;

    }

    return `${base}/transaction/${hash}`;

}

/**
 * Build an operator-facing explorer address URL. DISPLAY-ONLY.
 * @param {string|null} networkId
 * @param {string|null} address
 * @returns {string|null}
 */
export function buildOperatorExplorerAddressUrl(networkId, address) {

    const base = resolveOperatorExplorerBaseUrl(networkId);

    const value = String(address ?? "").trim();

    const isAddress = USER_FRIENDLY_ADDRESS_PATTERN.test(value)
        || RAW_ADDRESS_PATTERN.test(value);

    if (!base || !isAddress) {

        return null;

    }

    return `${base}/address/${encodeURIComponent(value)}`;

}
