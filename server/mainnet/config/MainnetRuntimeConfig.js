import { isAbsolute, relative, resolve, sep } from "node:path";
import { Address } from "@ton/core";
import { deriveTonAddressIdentity } from "../../payment/incoming/TonAddressIdentity.js";
import { resolveDefaultRoomWalletPaymentDataDir } from "../../payment/runtime/PaymentRuntimeFactory.js";

export const MAINNET_GLOBAL_ID = -239;
export const MAINNET_TONCENTER_BASE_URL = "https://toncenter.com";
export const MAINNET_WALLET_COUNT = 64;

const SENSITIVE_KEYS = new Set([
    "secret", "secretkey", "privatekey", "mnemonic", "seed", "passphrase", "apikey", "token"
]);

export class MainnetRuntimeConfigError extends Error {
    constructor(code) {
        super(code);
        this.name = "MainnetRuntimeConfigError";
        this.code = code;
    }
}

function requireValue(env, key) {
    const value = typeof env[key] === "string" ? env[key].trim() : "";
    if (!value) throw new MainnetRuntimeConfigError(`MAINNET_CONFIG_${key}_REQUIRED`);
    return value;
}

function pathContains(parent, child) {
    const rel = relative(parent, child);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

const MAINNET_STORAGE_DIRS = Object.freeze([
    "incoming-payment-ledger",
    "financial-lifecycle",
    "outgoing-seqno",
    "gameplay-recovery",
    "wallet-registry"
]);

const TESTNET_STORAGE_DIRS = Object.freeze([
    "financial-outcomes",
    "payment-intents",
    "incoming-receipts",
    "payment-forensics",
    "payment-core",
    "ledger/entries",
    "manifests",
    "refunds/refund-obligations",
    "refunds/closed-refund-rooms",
    "outbound-sequences",
    "native-refund-broadcast-claims",
    "testnet-native-payout-attempts"
]);

function resolveTestnetDataDir(env) {
    try {
        return resolve(resolveDefaultRoomWalletPaymentDataDir(env));
    } catch (error) {
        if (error?.message === "Persistent room-wallet volume is required on Railway") {
            throw new MainnetRuntimeConfigError("MAINNET_TESTNET_DATA_DIR_UNRESOLVABLE");
        }
        throw error;
    }
}

function assertStorageRootsIsolated(mainnetDataDir, testnetDataDir) {
    // Equal roots are forbidden even though each network normally uses
    // namespaced children: a future store could otherwise silently collide.
    if (pathContains(mainnetDataDir, testnetDataDir)
        && pathContains(testnetDataDir, mainnetDataDir)) {
        throw new MainnetRuntimeConfigError("MAINNET_DATA_DIR_MUST_BE_ISOLATED");
    }

    const testnetNetworkDir = resolve(testnetDataDir, "testnet");
    const mainnetStores = MAINNET_STORAGE_DIRS.map((name) => resolve(mainnetDataDir, name));
    const testnetStores = TESTNET_STORAGE_DIRS.map((name) => resolve(testnetNetworkDir, name));
    for (const mainnetStore of mainnetStores) {
        for (const testnetStore of testnetStores) {
            if (pathContains(mainnetStore, testnetStore) || pathContains(testnetStore, mainnetStore)) {
                throw new MainnetRuntimeConfigError("MAINNET_DATA_DIR_MUST_BE_ISOLATED");
            }
        }
    }
}

function parseWalletCatalog(raw) {
    let sensitiveFieldFound = false;
    let wallets;
    try {
        wallets = JSON.parse(raw, (key, value) => {
            if (SENSITIVE_KEYS.has(String(key).toLowerCase())) {
                sensitiveFieldFound = true;
                return undefined;
            }
            return value;
        });
    } catch {
        throw new MainnetRuntimeConfigError("MAINNET_WALLET_CATALOG_INVALID_JSON");
    }
    if (sensitiveFieldFound) {
        throw new MainnetRuntimeConfigError("MAINNET_WALLET_CATALOG_MUST_NOT_CONTAIN_SECRETS");
    }
    if (!Array.isArray(wallets) || wallets.length !== MAINNET_WALLET_COUNT) {
        throw new MainnetRuntimeConfigError("MAINNET_WALLET_CATALOG_MUST_CONTAIN_64_ENTRIES");
    }

    const ids = new Set();
    const numbers = new Set();
    const addresses = new Set();
    return Object.freeze(wallets.map((wallet) => {
        if (!wallet || typeof wallet !== "object"
            || wallet.network !== "mainnet"
            || !Number.isInteger(wallet.roomNumber)
            || wallet.roomNumber < 1 || wallet.roomNumber > MAINNET_WALLET_COUNT
            || typeof wallet.walletId !== "string" || !wallet.walletId.trim()
            || typeof wallet.address !== "string") {
            throw new MainnetRuntimeConfigError("MAINNET_WALLET_CATALOG_ENTRY_INVALID");
        }
        let identity;
        try {
            identity = deriveTonAddressIdentity(wallet.address);
            if (/^[A-Za-z0-9_-]{48}$/.test(wallet.address)
                && Address.parseFriendly(wallet.address).isTestOnly) {
                throw new Error("test-only address tag");
            }
        } catch {
            throw new MainnetRuntimeConfigError("MAINNET_WALLET_ADDRESS_INVALID");
        }
        if (ids.has(wallet.walletId) || numbers.has(wallet.roomNumber) || addresses.has(identity)) {
            throw new MainnetRuntimeConfigError("MAINNET_WALLET_CATALOG_DUPLICATE_IDENTITY");
        }
        ids.add(wallet.walletId);
        numbers.add(wallet.roomNumber);
        addresses.add(identity);
        return Object.freeze({
            walletId: wallet.walletId,
            roomNumber: wallet.roomNumber,
            address: wallet.address,
            publicKey: typeof wallet.publicKey === "string" ? wallet.publicKey : null,
            workchain: Number.isInteger(wallet.workchain) ? wallet.workchain : 0,
            network: "mainnet"
        });
    }));
}

/** Load an explicit, Mainnet-only config. No Testnet key, catalog or path is a fallback. */
export function loadMainnetRuntimeConfig(env = process.env) {
    if (String(env.TON_NETWORK ?? "").trim().toLowerCase() !== "mainnet") {
        throw new MainnetRuntimeConfigError("MAINNET_TON_NETWORK_MUST_BE_EXPLICIT");
    }
    for (const key of [
        "TON_API_KEY", "ROOM_WALLETS_TESTNET_JSON", "ROOM_WALLETS_TESTNET_JSON_PATH", "ROOM_WALLETS_JSON"
    ]) {
        if (typeof env[key] === "string" && env[key].trim()) {
            throw new MainnetRuntimeConfigError("TESTNET_CREDENTIAL_OR_CATALOG_PRESENT_IN_MAINNET_RUNTIME");
        }
    }

    const apiKey = requireValue(env, "MAINNET_TONCENTER_API_KEY");
    const dataDirRaw = requireValue(env, "MAINNET_ROOM_WALLET_DATA_DIR");
    if (!isAbsolute(dataDirRaw)) {
        throw new MainnetRuntimeConfigError("MAINNET_DATA_DIR_MUST_BE_ABSOLUTE");
    }
    const dataDir = resolve(dataDirRaw);
    const testnetDataDir = resolveTestnetDataDir(env);
    assertStorageRootsIsolated(dataDir, testnetDataDir);

    const walletCatalog = parseWalletCatalog(requireValue(env, "MAINNET_ROOM_WALLETS_JSON"));
    if (new Set(walletCatalog.map((wallet) => wallet.roomNumber)).size !== MAINNET_WALLET_COUNT) {
        throw new MainnetRuntimeConfigError("MAINNET_WALLET_ROOM_NUMBERS_INCOMPLETE");
    }
    for (let roomNumber = 1; roomNumber <= MAINNET_WALLET_COUNT; roomNumber++) {
        if (!walletCatalog.some((wallet) => wallet.roomNumber === roomNumber)) {
            throw new MainnetRuntimeConfigError("MAINNET_WALLET_ROOM_NUMBERS_INCOMPLETE");
        }
    }

    const config = {
        network: "mainnet",
        globalId: MAINNET_GLOBAL_ID,
        toncenterBaseUrl: MAINNET_TONCENTER_BASE_URL,
        dataDir,
        walletCatalog
    };
    Object.defineProperty(config, "apiKeyProvider", {
        enumerable: false,
        value: () => apiKey
    });
    return Object.freeze(config);
}
