import { join } from "node:path";
import { Address } from "@ton/core";
import { RoomWalletAdapter } from "../../payment/roomWallet/RoomWalletAdapter.js";
import {
    createRoomWalletRuntimeResolver,
    loadRoomWalletRuntimeConfig
} from "../../payment/roomWallet/RoomWalletRuntimeResolver.js";
import { MAINNET_GLOBAL_ID } from "../config/MainnetRuntimeConfig.js";
import { MainnetNativeTonService } from "./MainnetNativeTonService.js";
import { mainnetAddressIdentity } from "./MainnetAddress.js";

/**
 * Build the shared Wallet V4 adapter with Mainnet-only RPC, keys and state.
 * Runtime activation remains controlled by ROOM_WALLET_PAYMENTS_ENABLED and
 * TON_NETWORK in MainnetPaymentRuntime.
 */
export function createMainnetWalletV4Transport({ config, env = process.env, client = null,
    logger = null, now, sleep, seqnoConfirmTimeoutMs, seqnoConfirmPollMs } = {}) {
    if (config?.network !== "mainnet" || config?.globalId !== MAINNET_GLOBAL_ID
        || typeof config?.dataDir !== "string" || !config.dataDir
        || String(env?.TON_NETWORK ?? "").trim().toLowerCase() !== "mainnet"
        || !Array.isArray(config.walletCatalog)) {
        throw new Error("MAINNET_WALLET_V4_TRANSPORT_CONFIG_INVALID");
    }

    // Validate the whole signing catalog against the public Mainnet catalog
    // before the runtime can enable live operations. Do not defer an identity
    // mismatch until the first outgoing request.
    const signingConfig = loadRoomWalletRuntimeConfig(env);
    const expectedAddresses = new Map(config.walletCatalog.map(wallet => [wallet.roomNumber,
        mainnetAddressIdentity(wallet.address)]));
    if (expectedAddresses.size !== config.walletCatalog.length) {
        throw new Error("MAINNET_WALLET_V4_CATALOG_CONFLICT");
    }
    if (signingConfig.entries.length !== expectedAddresses.size
        || signingConfig.entries.some(identity => identity.network !== "mainnet"
            || expectedAddresses.get(identity.roomNumber) !== mainnetAddressIdentity(identity.address))) {
        throw new Error("MAINNET_WALLET_V4_IDENTITY_MISMATCH");
    }

    const resolveConfiguredWallet = createRoomWalletRuntimeResolver({ env });

    const walletResolver = async roomNumber => {
        const identity = await resolveConfiguredWallet(roomNumber);
        if (identity.network !== "mainnet"
            || expectedAddresses.get(identity.roomNumber) !== mainnetAddressIdentity(identity.address)) {
            throw new Error("MAINNET_WALLET_V4_IDENTITY_MISMATCH");
        }
        return Object.freeze({ ...identity, globalId: MAINNET_GLOBAL_ID });
    };

    return new RoomWalletAdapter({
        sequenceStateDir: join(config.dataDir, "outgoing-seqno"),
        tonService: new MainnetNativeTonService({ config, client }),
        walletResolver,
        logger,
        ...(now ? { now } : {}),
        ...(sleep ? { sleep } : {}),
        ...(seqnoConfirmTimeoutMs ? { seqnoConfirmTimeoutMs } : {}),
        ...(seqnoConfirmPollMs !== undefined ? { seqnoConfirmPollMs } : {})
    });
}
