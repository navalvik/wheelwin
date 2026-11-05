import { RoomWallet, WalletPoolRegistry } from "../testnet_source/payment/WalletPoolRegistry.js";
import { MAINNET_WALLET_COUNT } from "../config/MainnetRuntimeConfig.js";

/** Mainnet catalog input for the original Testnet wallet-pool lifecycle. */
export class MainnetWalletPoolRegistry extends WalletPoolRegistry {
    constructor({ config, logger = null } = {}) {
        if (config?.network !== "mainnet" || config?.globalId !== -239
            || !Array.isArray(config.walletCatalog)
            || config.walletCatalog.length !== MAINNET_WALLET_COUNT) {
            throw new Error("MAINNET_WALLET_POOL_CONFIG_INVALID");
        }
        super({ catalogPath: "<mainnet-catalog-loaded-in-memory>", network: "mainnet", logger });
        this._mainnetCatalog = config.walletCatalog;
    }

    _loadCatalog() {
        const wallets = new Map();
        const roomNumbers = new Set();
        for (const record of this._mainnetCatalog) {
            if (record?.network !== "mainnet") throw new Error("MAINNET_WALLET_NETWORK_MISMATCH");
            const wallet = RoomWallet.fromRecord(record);
            if (wallet.network !== "mainnet" || roomNumbers.has(wallet.roomNumber)
                || wallets.has(wallet.walletId)) throw new Error("MAINNET_WALLET_CATALOG_CONFLICT");
            roomNumbers.add(wallet.roomNumber);
            wallets.set(wallet.walletId, wallet);
        }
        if (wallets.size !== MAINNET_WALLET_COUNT || roomNumbers.size !== MAINNET_WALLET_COUNT) {
            throw new Error("MAINNET_WALLET_CATALOG_INCOMPLETE");
        }
        this._wallets = wallets;
    }
}
