import { Address } from "@ton/core";

// Keep the existing Testnet Page3 acceptance rule byte-for-byte equivalent.
const TESTNET_WALLET_PATTERN = /^(?:0:[0-9a-fA-F]{64}|[A-Za-z0-9_-]{48})$/;

export function isValidPage3WalletAddress(value, network) {

    const candidate = typeof value === "string" ? value.trim() : "";

    if (network !== "mainnet") {

        return TESTNET_WALLET_PATTERN.test(candidate);

    }

    try {

        const parsed = Address.parseFriendly(candidate);

        return parsed.isTestOnly === false && parsed.address.workChain === 0;

    } catch {

        return false;

    }

}
