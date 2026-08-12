/**
 * R13.7A — Presentation-only wallet masking for production UI.
 * Does not mutate stored wallet data.
 *
 * Format: first 6 + "..." + last 6 (when length allows).
 */

const PREFIX_LEN = 6;

const SUFFIX_LEN = 6;

/**
 * @param {unknown} wallet
 * @returns {string}
 */
export function formatWalletAddress(wallet) {

    if (wallet === null || wallet === undefined) {

        return "";

    }

    const value = String(wallet).trim();

    if (!value) {

        return "";

    }

    if (value.length <= PREFIX_LEN + SUFFIX_LEN) {

        return value;

    }

    return `${value.slice(0, PREFIX_LEN)}...${value.slice(-SUFFIX_LEN)}`;

}
