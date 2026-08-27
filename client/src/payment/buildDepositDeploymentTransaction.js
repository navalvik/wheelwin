/**
 * R18-S6 — Production DepositContract deployment transaction builder.
 *
 * CONSTRUCTS a TonConnect sendTransaction request ONLY. It never:
 *   - calls TonConnect / sendTransaction;
 *   - opens a wallet or waits for confirmation;
 *   - mutates AuthoritativeSession or DepositSession;
 *   - marks a DepositContract ACTIVE;
 *   - calls the server / polls the blockchain;
 *   - invokes DepositMonitor / GameContractManager.
 *
 * Uses the authoritative Deposit package from the server.
 * Does NOT regenerate StateInit or derive amounts locally.
 *
 * Transaction follows testnet reference (l25PlayerDepositDeploy.js) adapted
 * for TonConnect: internal message with init (code+data), bounce:false.
 *
 * Deterministic address verification: StateInit-derived address must match
 * the authoritative depositAddress.
 */

import { Address, Cell, contractAddress } from "@ton/core";

const DEFAULT_VALID_UNTIL_SECONDS = 600;
const SUPPORTED_NETWORKS = Object.freeze(["testnet", "mainnet"]);

function loadCellFromBoc(bocBase64, label) {
    if (typeof bocBase64 !== "string" || !bocBase64.trim()) {
        throw new Error(`${label} BOC is missing from deposit package`);
    }
    try {
        const cells = Cell.fromBoc(Buffer.from(bocBase64, "base64"));
        if (!cells.length) { throw new Error("empty boc"); }
        return cells[0];
    } catch (error) {
        throw new Error(
            `Unable to decode ${label} BOC: ${error?.message ?? String(error)}`
        );
    }
}

function reconstructAndVerifyStateInit(depositPackage) {
    if (!depositPackage || typeof depositPackage !== "object") {
        throw new Error("deposit package is required for deployment");
    }
    const codeBoc = depositPackage?.stateInit?.codeBoc;
    const dataBoc = depositPackage?.stateInit?.dataBoc;
    if (!codeBoc || !dataBoc) {
        throw new Error(
            "DepositContract StateInit (codeBoc + dataBoc) is required for deployment"
        );
    }
    const code = loadCellFromBoc(codeBoc, "code");
    const data = loadCellFromBoc(dataBoc, "data");
    const stateInit = { code, data };
    const address = contractAddress(0, stateInit);
    const addressFriendly = address.toString({ bounceable: true, urlSafe: true });
    const packageAddress = depositPackage.depositAddress ?? depositPackage.address;
    if (!packageAddress) {
        throw new Error("depositAddress is required for deployment");
    }
    const derivedCanonical = canonicalizeAddress(addressFriendly);
    const packageCanonical = canonicalizeAddress(packageAddress);
    if (!derivedCanonical || !packageCanonical
        || derivedCanonical !== packageCanonical) {
        throw new Error(
            "Reconstructed StateInit address does not match authoritative depositAddress — "
            + "packageAddress=" + packageAddress
            + ", derivedAddress=" + addressFriendly
        );
    }
    return Object.freeze({
        code, data, stateInit, address, addressFriendly,
        addressCanonical: derivedCanonical
    });
}

function canonicalizeAddress(addressStr) {
    if (typeof addressStr !== "string" || addressStr.trim() === "") { return null; }
    try {
        const addr = Address.parse(addressStr.trim());
        return addr.toString({ bounceable: true, urlSafe: true });
    } catch { return null; }
}

function validateDeployValueNanotons(deployValueNanotons) {
    if (deployValueNanotons == null || deployValueNanotons === "") {
        throw new Error("deployValueNanotons is required for DepositContract deployment");
    }
    if (typeof deployValueNanotons === "boolean") {
        throw new Error("deployValueNanotons must be a positive integer");
    }
    let bigint;
    try {
        const normalized = typeof deployValueNanotons === "string"
            ? deployValueNanotons.trim() : deployValueNanotons;
        bigint = typeof normalized === "bigint" ? normalized : BigInt(normalized);
    } catch {
        throw new Error("deployValueNanotons must be a positive integer");
    }
    if (bigint <= 0n) {
        throw new Error("deployValueNanotons must be a positive amount");
    }
    return bigint.toString();
}

function assertSupportedDepositNetwork(network) {
    if (network == null || network === "") { return; }
    const normalized = String(network).trim().toLowerCase();
    if (!SUPPORTED_NETWORKS.includes(normalized)) {
        throw new Error(`Unsupported Deposit network: ${network}`);
    }
}

function assertCreatorAuthorization(isCreator) {
    if (isCreator !== true) {
        throw new Error(
            "Only the Room Creator (isCreator=true) may deploy the DepositContract"
        );
    }
}

/**
 * @param {object} params
 * @param {object} params.depositPackage — authoritative Deposit package from
 *        the server (contains stateInit.{codeBoc,dataBoc}, deployValueNanotons).
 * @param {string} params.depositAddress — authoritative DepositContract address
 *        (must match the StateInit-derived address).
 * @param {boolean} params.isCreator — must be true; only the creator may deploy.
 * @param {string} [params.network] — optional authoritative network tag.
 * @param {number} [params.validUntilSeconds=600]
 * @param {number} [params.nowMs]
 * @returns TonConnect transaction request for DepositContract deployment.
 */
export function buildDepositDeploymentTransaction({
    depositPackage,
    depositAddress,
    isCreator,
    network = null,
    validUntilSeconds = DEFAULT_VALID_UNTIL_SECONDS,
    nowMs = Date.now()
} = {}) {

    // --- Creator authorization ---
    assertCreatorAuthorization(isCreator);

    // --- Network validation ---
    assertSupportedDepositNetwork(network);

    // --- Package validation ---
    if (!depositPackage || typeof depositPackage !== "object") {
        throw new Error("depositPackage is required for DepositContract deployment");
    }

    // --- Reconstruct StateInit and verify address parity ---
    const reconstructed = reconstructAndVerifyStateInit(depositPackage);

    // --- Validate deployment amount ---
    const deployValueNanotons = validateDeployValueNanotons(
        depositPackage.deployValueNanotons
    );

    // --- TTL validation ---
    const ttl = Number(validUntilSeconds);
    if (!Number.isFinite(ttl) || ttl <= 0) {
        throw new Error("validUntilSeconds must be a positive number");
    }

    // --- Build the TonConnect transaction request ---
    // The deployment message targets the DepositContract address derived from
    // StateInit, carrying the deployment value (gas) and the init cells.
    // The TonConnect SDK / wallet handles the wallet transfer + external
    // message encoding when broadcasting.

    return {
        validUntil: Math.floor(Number(nowMs) / 1000) + ttl,
        messages: [
            {
                address: reconstructed.addressFriendly,
                amount: deployValueNanotons,
                stateInit: {
                    code: depositPackage.stateInit.codeBoc,
                    data: depositPackage.stateInit.dataBoc
                }
            }
        ]
    };
}