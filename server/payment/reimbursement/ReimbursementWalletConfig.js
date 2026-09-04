/**
 * R17.8V.2P.O — Reimbursement wallet configuration (isolated from Owner / Deployer).
 *
 * Never logs mnemonic or private keys.
 */

import { Address } from "@ton/core";

import { deriveResiduesWalletIdentity } from "../roomWallet/ResiduesWalletConfig.js";
import { tonStringToNanoton } from "./nanoton.js";

export const TON_REIMBURSEMENT_MNEMONIC_ENV = "TON_REIMBURSEMENT_MNEMONIC";
export const TON_REIMBURSEMENT_EXPECTED_ADDRESS_ENV =
    "TON_REIMBURSEMENT_EXPECTED_ADDRESS";
export const REIMBURSEMENT_ENABLED_ENV = "REIMBURSEMENT_ENABLED";
export const REIMBURSEMENT_MAX_TRANSFER_ENV = "REIMBURSEMENT_MAX_TRANSFER";
export const REIMBURSEMENT_DAILY_LIMIT_ENV = "REIMBURSEMENT_DAILY_LIMIT";
export const REIMBURSEMENT_WALLET_RESERVE_ENV = "REIMBURSEMENT_WALLET_RESERVE";

/** Conservative default; override via env for production. */
export const DEFAULT_REIMBURSEMENT_MAX_TRANSFER_TON = "0.05";

/** UTC daily spend cap across confirmed + in-flight reimbursements. */
export const DEFAULT_REIMBURSEMENT_DAILY_LIMIT_TON = "1";

/** Leave this much TON in the reimbursement wallet after each send. */
export const DEFAULT_REIMBURSEMENT_WALLET_RESERVE_TON = "0.05";

export const REIMBURSEMENT_WALLET_CONTRACT_TYPE = "WalletContractV4R2";
export const REIMBURSEMENT_WALLET_WORKCHAIN = 0;

/**
 * Emergency send gate. Fail-closed: unset / empty defaults to blocked.
 * Explicit true/1/yes required to allow sends (with master flag).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isReimbursementEmergencySendAllowed(env = process.env) {

    const raw = String(env?.[REIMBURSEMENT_ENABLED_ENV] ?? "false")
        .trim()
        .toLowerCase();

    return raw === "true" || raw === "1" || raw === "yes";

}

/**
 * Residues role migration: reimbursement send is permanently retired.
 * Historical flags cannot re-authorize a transfer from this wallet.
 *
 * @returns {true}
 */
export function isReimbursementSendPermanentlyRetired() {

    return true;

}

/**
 * Master feature + emergency pause used to allow a send.
 * Permanently false: enabling REIMBURSEMENT_ENABLED or
 * DEPLOYMENT_REIMBURSEMENT_ENABLED cannot spend from this wallet.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isReimbursementSendAllowed(env = process.env) {

    void env;
    return false;

}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function getReimbursementMaxTransferTon(env = process.env) {

    const raw = String(env?.[REIMBURSEMENT_MAX_TRANSFER_ENV] ?? "").trim();

    if (raw && tonStringToNanoton(raw) != null) {

        return raw;

    }

    return DEFAULT_REIMBURSEMENT_MAX_TRANSFER_TON;

}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function getReimbursementDailyLimitTon(env = process.env) {

    const raw = String(env?.[REIMBURSEMENT_DAILY_LIMIT_ENV] ?? "").trim();

    if (raw && tonStringToNanoton(raw) != null) {

        return raw;

    }

    return DEFAULT_REIMBURSEMENT_DAILY_LIMIT_TON;

}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function getReimbursementWalletReserveTon(env = process.env) {

    const raw = String(env?.[REIMBURSEMENT_WALLET_RESERVE_ENV] ?? "").trim();

    if (raw && tonStringToNanoton(raw) != null) {

        return raw;

    }

    return DEFAULT_REIMBURSEMENT_WALLET_RESERVE_TON;

}

/**
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function reimbursementAddressesEqual(left, right) {

    if (!left || !right) {

        return false;

    }

    try {

        const a = typeof left === "string" ? Address.parse(left) : left;
        const b = typeof right === "string" ? Address.parse(right) : right;

        return a.equals(b);

    } catch {

        return String(left).trim() === String(right).trim();

    }

}

/**
 * Derive bounceable url-safe address from mnemonic (V4R2). Does not log secrets.
 *
 * @param {string} mnemonic
 * @returns {Promise<{ address: string, publicKey: Buffer, secretKey: Buffer, walletId: number }>}
 */
/**
 * Identical V4R2 / workchain 0 derivation as Residues Wallet.
 * The physical identity did not change; only the application role did.
 *
 * @param {string} mnemonic
 * @returns {Promise<{ address: string, publicKey: Buffer, secretKey: Buffer, walletId: number }>}
 */
export async function deriveReimbursementWalletIdentity(mnemonic) {

    const identity = await deriveResiduesWalletIdentity(mnemonic);

    return Object.freeze({
        address: identity.address,
        publicKey: identity.publicKey,
        secretKey: identity.secretKey,
        walletId: identity.walletId
    });

}

/**
 * Load + validate reimbursement wallet config.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{
 *   ok: true,
 *   expectedAddress: string,
 *   derivedAddress: string,
 *   maxTransferTon: string,
 *   publicKey: Buffer,
 *   secretKey: Buffer,
 *   walletId: number
 * } | {
 *   ok: false,
 *   code: string,
 *   message: string
 * }>}
 */
export async function loadReimbursementWalletConfig(env = process.env) {

    const mnemonic = String(env?.[TON_REIMBURSEMENT_MNEMONIC_ENV] ?? "").trim();
    const expectedAddress = String(
        env?.[TON_REIMBURSEMENT_EXPECTED_ADDRESS_ENV] ?? ""
    ).trim();

    if (!mnemonic) {

        return {
            ok: false,
            code: "MISSING_MNEMONIC",
            message: "TON_REIMBURSEMENT_MNEMONIC is required"
        };

    }

    if (!expectedAddress) {

        return {
            ok: false,
            code: "MISSING_EXPECTED_ADDRESS",
            message: "TON_REIMBURSEMENT_EXPECTED_ADDRESS is required"
        };

    }

    let identity;

    try {

        identity = await deriveReimbursementWalletIdentity(mnemonic);

    } catch (error) {

        return {
            ok: false,
            code: "MNEMONIC_INVALID",
            message: error?.message ?? "Failed to derive reimbursement wallet"
        };

    }

    if (!reimbursementAddressesEqual(identity.address, expectedAddress)) {

        return {
            ok: false,
            code: "ADDRESS_MISMATCH",
            message:
                "Derived reimbursement wallet address does not match "
                + "TON_REIMBURSEMENT_EXPECTED_ADDRESS"
        };

    }

    return {
        ok: true,
        expectedAddress,
        derivedAddress: identity.address,
        maxTransferTon: getReimbursementMaxTransferTon(env),
        publicKey: identity.publicKey,
        secretKey: identity.secretKey,
        walletId: identity.walletId
    };

}
