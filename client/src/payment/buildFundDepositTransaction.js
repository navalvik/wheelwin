/**
 * R18-S5 — Production DepositContract FundSeat transaction builder.
 *
 * CONSTRUCTS a TonConnect sendTransaction request ONLY. It never:
 *   - calls TonConnect / sendTransaction;
 *   - opens a wallet or waits for confirmation;
 *   - mutates AuthoritativeSession or DepositSession;
 *   - emits PAYMENT_CONFIRM_INTENT or any funding event;
 *   - marks a seat FUNDED;
 *   - calls the server / polls the blockchain;
 *   - invokes DepositMonitor / GameContractManager.
 *
 * Encoding matches the authoritative server implementation
 * (server/deposit/RealTonDepositBlockchainSource.js):
 *   FUND_SEAT_OPCODE (0x46554E44, 32 bits) + seat_index (uint8).
 * The authoritative encoder carries NO query_id; this builder follows it exactly.
 *
 * All values are server-authoritative. This helper never derives seat index,
 * creator role, expected amount, fees, or sector costs locally.
 */

import { beginCell } from "@ton/core";

import { isValidTelegramWallet } from "../utils/telegramWalletRules.js";

/**
 * FundSeat opcode mirror of the authoritative server constant
 * server/deposit/RealTonDepositBlockchainSource.js::FUND_SEAT_OPCODE (0x46554E44).
 * Kept client-side intentionally, following the existing GameEscrow STAKE
 * convention (GAME_ESCROW_STAKE_OPCODE) — never duplicated protocol data.
 */
export const FUND_SEAT_OPCODE = 0x46554E44;

const DEFAULT_VALID_UNTIL_SECONDS = 600;

const SUPPORTED_NETWORKS = Object.freeze(["testnet", "mainnet"]);

/**
 * Encode the FundSeat body as a base64 BOC: opcode (32 bits) + seatIndex (uint8).
 * Mirrors server encodeFundSeatBody(seatIndex).
 */
export function buildFundSeatPayload(seatIndex) {

    const index = Number(seatIndex);

    if (!Number.isInteger(index) || index < 0 || index > 2) {

        throw new Error("mySeatIndex must be an integer 0..2 for FundSeat payload");

    }

    return beginCell()
        .storeUint(FUND_SEAT_OPCODE, 32)
        .storeUint(index, 8)
        .endCell()
        .toBoc()
        .toString("base64");

}

/**
 * Convert the authoritative expected amount (nanotons, integer) to an exact
 * decimal string. Uses BigInt so no precision is lost and nothing is added
 * (no fees / stake / sector computation).
 */
export function expectedAmountNanotonsToString(myExpectedAmountNanotons) {

    if (myExpectedAmountNanotons == null || myExpectedAmountNanotons === "") {

        throw new Error("myExpectedAmountNanotons is required for FundSeat amount");

    }

    if (typeof myExpectedAmountNanotons === "boolean") {

        throw new Error("myExpectedAmountNanotons must be a positive integer");

    }

    let bigint;

    try {

        const raw = myExpectedAmountNanotons;

        const normalized = typeof raw === "string" ? raw.trim() : raw;

        bigint = typeof normalized === "bigint"
            ? normalized
            : BigInt(normalized);

    } catch {

        throw new Error("myExpectedAmountNanotons must be a positive integer");

    }

    if (bigint <= 0n) {

        throw new Error("myExpectedAmountNanotons must be a positive amount");

    }

    return bigint.toString();

}

/**
 * Validate a Deposit projection network tag when supplied. Does NOT switch
 * networks and does not compare against any global env (no such config system
 * exists client-side). Fails closed on an unknown network value.
 */
function assertSupportedDepositNetwork(network) {

    if (network == null || network === "") {

        return;

    }

    const normalized = String(network).trim().toLowerCase();

    if (!SUPPORTED_NETWORKS.includes(normalized)) {

        throw new Error(`Unsupported Deposit network: ${network}`);

    }

}

/**
 * @param {object} params
 * @param {string} params.depositAddress — authoritative DepositContract destination
 * @param {number} params.mySeatIndex — authoritative seat index (0..2)
 * @param {number|string|bigint} params.myExpectedAmountNanotons — authoritative
 *        per-seat expected amount in nanotons (exact)
 * @param {string} [params.network] — optional authoritative network tag
 * @param {number} [params.validUntilSeconds=600]
 * @param {number} [params.nowMs]
 * @returns TonConnect transaction request for DepositContract.FundSeat.
 */
export function buildFundDepositTransaction({
    depositAddress,
    mySeatIndex,
    myExpectedAmountNanotons,
    network = null,
    validUntilSeconds = DEFAULT_VALID_UNTIL_SECONDS,
    nowMs = Date.now()
} = {}) {

    if (typeof depositAddress !== "string" || depositAddress.trim() === "") {

        throw new Error("depositAddress is required for Deposit FundSeat transaction");

    }

    if (!isValidTelegramWallet(depositAddress)) {

        throw new Error("depositAddress is not a valid TON address");

    }

    assertSupportedDepositNetwork(network);

    // Rejects missing / non-integer / out-of-range seat index.
    const seatIndex = Number(mySeatIndex);

    if (
        mySeatIndex == null
        || mySeatIndex === ""
        || !Number.isInteger(seatIndex)
        || seatIndex < 0
        || seatIndex > 2
    ) {

        throw new Error("mySeatIndex must be an integer 0..2 for Deposit FundSeat");

    }

    const amountNano = expectedAmountNanotonsToString(myExpectedAmountNanotons);

    const payload = buildFundSeatPayload(seatIndex);

    const ttl = Number(validUntilSeconds);

    if (!Number.isFinite(ttl) || ttl <= 0) {

        throw new Error("validUntilSeconds must be a positive number");

    }

    return {
        validUntil: Math.floor(Number(nowMs) / 1000) + ttl,
        messages: [
            {
                address: depositAddress.trim(),
                amount: amountNano,
                payload
            }
        ]
    };

}