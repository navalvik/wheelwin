/**
 * T2.6 — TON wallet address validation for WalletManager.
 */

import { Address } from "@ton/core";

import { canonicalizeTonWalletAddress } from "../models/TonWalletAddress.js";
import { WalletNetworkMismatchError, WalletValidationError } from "./WalletManagerErrors.js";

export function validateWalletAddress(rawAddress, { network = null } = {}) {

    if (typeof rawAddress !== "string" || !rawAddress.trim()) {

        throw new WalletValidationError("Wallet address is required", {
            field: "walletAddress",
            reason: "empty"
        });

    }

    let parsed = null;

    try {

        parsed = Address.parse(rawAddress.trim());

    } catch {

        throw new WalletValidationError("Invalid TON wallet address.", {
            field: "walletAddress",
            reason: "invalid_format",
            value: rawAddress
        });

    }

    if (parsed.workChain !== 0 && parsed.workChain !== -1) {

        throw new WalletValidationError("Unsupported TON workchain", {
            field: "walletAddress",
            reason: "unsupported_workchain",
            workchain: parsed.workChain
        });

    }

    const friendly = canonicalizeTonWalletAddress(rawAddress);

    if (!friendly) {

        throw new WalletValidationError("Unable to canonicalize wallet address", {
            field: "walletAddress",
            reason: "canonicalization_failed",
            value: rawAddress
        });

    }

    return Object.freeze({
        raw: rawAddress.trim(),
        friendly,
        workchain: parsed.workChain,
        network: network ?? null
    });

}

export function assertWalletNetworkCompatibility(addressInfo, activeNetwork) {

    if (!addressInfo?.network || !activeNetwork) {

        return;

    }

    const left = normalizeNetwork(addressInfo.network);

    const right = normalizeNetwork(activeNetwork);

    if (left !== right) {

        throw new WalletNetworkMismatchError(addressInfo.network, activeNetwork);

    }

}

export function normalizeNetwork(network) {

    return String(network ?? "").trim().toLowerCase();

}

/**
 * Pluggable TonConnect proof verification interface.
 * Real proof validation is wired in a later stage.
 */
export class WalletProofVerifier {

    async verify({ session, proof = null, tonService = null } = {}) {

        if (!session?.walletAddress) {

            throw new WalletValidationError("Wallet address missing for verification", {
                walletSessionId: session?.walletSessionId ?? null
            });

        }

        validateWalletAddress(session.walletAddress, { network: session.network });

        if (proof?.tonConnectProof) {

            return Object.freeze({
                verified: true,
                method: "TONCONNECT_PROOF",
                proofReceived: true,
                tonServiceAvailable: tonService?.isConnected?.() === true
            });

        }

        return Object.freeze({
            verified: true,
            method: "ADDRESS_ONLY",
            proofReceived: false,
            tonServiceAvailable: tonService?.isConnected?.() === true
        });

    }

}
