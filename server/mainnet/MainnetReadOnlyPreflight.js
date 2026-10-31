/**
 * WheelWin Mainnet phase 1: READ-ONLY deployment preflight.
 *
 * This is deliberately NOT a Mainnet payment runtime. It may parse the
 * existing Mainnet wallet catalog for local consistency, and perform one
 * read-only Toncenter masterchain identity lookup. It cannot construct a
 * payment intent, sign or broadcast a transfer, or enable financial intake.
 *
 * Never log or return wallet credentials, mnemonic data, API keys, addresses
 * or environment-variable values. This module does not import a signer.
 */
import { Address } from "@ton/core";
import {
    loadRoomWalletRuntimeConfig
} from "../payment/roomWallet/RoomWalletRuntimeResolver.js";
import { ROOM_WALLET_COUNT } from "../payment/roomWallet/RoomWalletRegistry.js";
import {
    ToncenterTransactionsClient
} from "../payment/toncenter/ToncenterTransactionsClient.js";

export const MAINNET_GLOBAL_ID = -239;
export const MAINNET_TONCENTER_URL = "https://toncenter.com";

function fail(code) {
    throw new Error(code);
}

function nonEmpty(value) {
    return typeof value === "string" && value.trim().length > 0;
}

function assertNonTestOnlyAddress(address, code) {
    const text = String(address ?? "").trim();
    try {
        const parsed = Address.parse(text);
        if (!parsed) fail(code);
        if (Address.isFriendly(text) && Address.parseFriendly(text).isTestOnly) {
            fail(code);
        }
    } catch {
        fail(code);
    }
}

/**
 * Synchronous, offline check of Mainnet environment identity and the
 * complete 64-entry WalletV4 catalog. Catalog contents stay confined to
 * stack-local variables; returned data contains only non-secret counts.
 *
 * Strict preparation gate: payment acceptance must remain disabled until
 * a separate reviewed Mainnet release explicitly authorizes real transfers.
 */
export function inspectMainnetConfiguration(env = process.env) {
    if (String(env?.TON_NETWORK ?? "").trim().toLowerCase() !== "mainnet") {
        fail("MAINNET_PREFLIGHT_NETWORK_MISMATCH");
    }

    if (String(env?.ROOM_WALLET_PAYMENTS_ENABLED ?? "").trim() === "true") {
        fail("MAINNET_PREFLIGHT_LIVE_PAYMENTS_MUST_REMAIN_DISABLED");
    }

    if (!nonEmpty(env?.ROOM_WALLETS_MAINNET_JSON)) {
        fail("MAINNET_PREFLIGHT_CATALOG_REQUIRED");
    }

    if (!nonEmpty(env?.TON_API_KEY)) {
        fail("MAINNET_PREFLIGHT_RPC_KEY_REQUIRED");
    }

    if (!nonEmpty(env?.OWNER_WALLET)) {
        fail("MAINNET_PREFLIGHT_OWNER_REQUIRED");
    }

    if (!nonEmpty(env?.TON_FINANCIAL_DATA_DIR)) {
        fail("MAINNET_PREFLIGHT_DURABLE_DATA_DIR_REQUIRED");
    }

    assertNonTestOnlyAddress(env.OWNER_WALLET, "MAINNET_PREFLIGHT_OWNER_ADDRESS_INVALID");

    let catalog;
    try {
        catalog = JSON.parse(env.ROOM_WALLETS_MAINNET_JSON);
    } catch {
        fail("MAINNET_PREFLIGHT_CATALOG_INVALID");
    }

    if (!Array.isArray(catalog) || catalog.length !== ROOM_WALLET_COUNT) {
        fail("MAINNET_PREFLIGHT_WALLET_COUNT_INVALID");
    }

    for (const record of catalog) {
        // Explicit network attribution is required for every Mainnet wallet.
        if (record?.network !== "mainnet") {
            fail("MAINNET_PREFLIGHT_WALLET_NETWORK_MISMATCH");
        }
        assertNonTestOnlyAddress(
            record?.address,
            "MAINNET_PREFLIGHT_WALLET_ADDRESS_INVALID"
        );
    }

    let parsed;
    try {
        parsed = loadRoomWalletRuntimeConfig(env);
    } catch {
        // Never echo raw catalog contents, private keys or error causes.
        fail("MAINNET_PREFLIGHT_CATALOG_IDENTITY_INVALID");
    }

    if (parsed.entries.length !== ROOM_WALLET_COUNT) {
        fail("MAINNET_PREFLIGHT_WALLET_COUNT_INVALID");
    }

    return Object.freeze({
        network: "mainnet",
        walletCount: ROOM_WALLET_COUNT,
        ownerConfigured: true,
        durableStoreConfigured: true,
        rpcKeyConfigured: true,
        livePaymentsEnabled: false,
        mode: "READ_ONLY"
    });
}

/**
 * Explicit one-request chain identity probe. Never runs at module import.
 * The caller supplies an authenticated read-only client, or this function
 * constructs one bound to the official Mainnet Toncenter endpoint.
 */
export async function probeMainnetReadOnly({
    env = process.env,
    client = null
} = {}) {
    const checked = inspectMainnetConfiguration(env);
    const rpc = client ?? new ToncenterTransactionsClient({
        baseUrl: MAINNET_TONCENTER_URL,
        apiKeyProvider: () => env.TON_API_KEY
    });

    if (
        rpc?.baseUrl !== MAINNET_TONCENTER_URL
        || typeof rpc.getMasterchainInfo !== "function"
    ) {
        fail("MAINNET_PREFLIGHT_RPC_ENDPOINT_MISMATCH");
    }

    let info;
    try {
        info = await rpc.getMasterchainInfo();
    } catch {
        fail("MAINNET_PREFLIGHT_RPC_UNAVAILABLE");
    }

    if (
        info?.last?.global_id !== MAINNET_GLOBAL_ID
        || !Number.isSafeInteger(info?.last?.seqno)
        || info.last.seqno < 1
    ) {
        fail("MAINNET_PREFLIGHT_CHAIN_IDENTITY_INVALID");
    }

    return Object.freeze({
        ...checked,
        chainGlobalId: MAINNET_GLOBAL_ID,
        chainIdentityVerified: true
    });
}
