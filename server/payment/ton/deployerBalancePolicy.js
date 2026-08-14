import { toNano } from "@ton/core";

/**
 * R17.8M.2 — Minimum deployer wallet reserve before GameEscrow deploy.
 * Covers deploy value, fees, initialization, and safety buffer.
 */
export const DEPLOYER_MIN_BALANCE_REQUIRED_TON = "0.2";

export const DEPLOYER_MIN_BALANCE_REQUIRED_NANO = toNano(
    DEPLOYER_MIN_BALANCE_REQUIRED_TON
);
