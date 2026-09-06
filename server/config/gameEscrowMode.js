/**
 * R7.67A — GameEscrow vs legacy WalletContractV4 mode resolution.
 *
 * Testnet default: game (GameEscrow).
 * Mainnet default: v4 (unchanged; legacy path).
 * Explicit GAME_ESCROW_MODE=v4 remains the rollback switch on testnet.
 */

export const GAME_ESCROW_MODE_V4 = "v4";
export const GAME_ESCROW_MODE_GAME = "game";

export const GAME_ESCROW_MODE_ALLOWED = Object.freeze([
    GAME_ESCROW_MODE_V4,
    GAME_ESCROW_MODE_GAME
]);

/**
 * @param {string|null|undefined} network
 * @returns {"v4"|"game"}
 */
export function defaultGameEscrowModeForNetwork(network) {

    const normalized = String(network ?? "").trim().toLowerCase();

    // Testnet only — GameEscrow is the default deploy/settle path.
    if (normalized === "testnet") {

        return GAME_ESCROW_MODE_GAME;

    }

    // Mainnet and unknown: keep legacy v4 (do not enable GameEscrow by default).
    return GAME_ESCROW_MODE_V4;

}

/**
 * Resolve escrow mode from an explicit override and/or env.
 *
 * Unset → network default (testnet=game, otherwise=v4).
 * Present but empty / unknown → throws (ambiguous).
 *
 * @param {string|null|undefined} explicitMode
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [env]
 * @returns {"v4"|"game"}
 */
export function resolveGameEscrowMode(explicitMode, env = process.env) {

    const envBag = env ?? {};
    const network = envBag.TON_NETWORK;
    const defaultMode = defaultGameEscrowModeForNetwork(network);

    const explicitRaw = explicitMode === undefined || explicitMode === null
        ? null
        : String(explicitMode).trim();

    if (explicitRaw) {

        return assertValidGameEscrowMode(explicitRaw);

    }

    const envHasKey = Object.prototype.hasOwnProperty.call(
        envBag,
        "GAME_ESCROW_MODE"
    );

    if (envHasKey) {

        const envRaw = envBag.GAME_ESCROW_MODE;

        if (envRaw === undefined || envRaw === null || String(envRaw).trim() === "") {

            throw new Error(
                "Ambiguous GAME_ESCROW_MODE (empty). Allowed values: v4 | game"
            );

        }

        return assertValidGameEscrowMode(String(envRaw).trim());

    }

    return defaultMode;

}

/**
 * Player payment uses GameEscrow STAKE only — no Deposit Contract / FundSeat.
 *
 * @param {string|null|undefined} mode
 * @returns {boolean}
 */
export function isGameEscrowOnlyPlayerPayment(mode) {

    return String(mode ?? "").trim().toLowerCase() === GAME_ESCROW_MODE_GAME;

}

/**
 * @param {string} raw
 * @returns {"v4"|"game"}
 */
export function assertValidGameEscrowMode(raw) {

    const mode = String(raw ?? "").trim().toLowerCase();

    if (mode === GAME_ESCROW_MODE_GAME) {

        return GAME_ESCROW_MODE_GAME;

    }

    if (mode === GAME_ESCROW_MODE_V4) {

        return GAME_ESCROW_MODE_V4;

    }

    throw new Error(
        `Ambiguous GAME_ESCROW_MODE="${raw}". Allowed values: v4 | game`
    );

}
