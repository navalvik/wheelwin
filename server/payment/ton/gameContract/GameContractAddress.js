/**
 * T2.3 — Game contract address validation.
 */

import { Address } from "@ton/core";

import { InvalidAddressError } from "./GameContractErrors.js";

export function parseContractAddress(raw, { network = null } = {}) {

    if (typeof raw !== "string" || !raw.trim()) {

        throw new InvalidAddressError(raw, "empty");

    }

    let address = null;

    try {

        address = Address.parse(raw.trim());

    } catch {

        throw new InvalidAddressError(raw, "invalid_format");

    }

    if (address.workChain !== 0 && address.workChain !== -1) {

        throw new InvalidAddressError(raw, "unsupported_workchain");

    }

    const friendly = address.toString({
        bounceable: true,
        urlSafe: true
    });

    return Object.freeze({
        raw: raw.trim(),
        friendly,
        workchain: address.workChain,
        network: network ?? null
    });

}

export function assertNetworkCompatibility(addressInfo, activeNetwork) {

    if (!addressInfo?.network || !activeNetwork) {

        return;

    }

    if (normalizeNetwork(addressInfo.network) !== normalizeNetwork(activeNetwork)) {

        throw new InvalidAddressError(
            addressInfo.friendly,
            `network_mismatch:${addressInfo.network}:${activeNetwork}`
        );

    }

}

function normalizeNetwork(network) {

    return String(network ?? "").trim().toLowerCase();

}
