import { RoomWallet, WalletPoolRegistry } from "../../payment/WalletPoolRegistry.js";
import { MAINNET_WALLET_COUNT } from "../config/MainnetRuntimeConfig.js";

/** Mainnet catalog adapter over the unchanged, network-aware pool lifecycle. */
export class MainnetWalletPoolRegistry extends WalletPoolRegistry {
    constructor({ config, logger = null } = {}) {
        if (config?.network !== "mainnet" || config?.globalId !== -239
            || !Array.isArray(config.walletCatalog)
            || config.walletCatalog.length !== MAINNET_WALLET_COUNT) {
            throw new Error("MAINNET_WALLET_POOL_CONFIG_INVALID");
        }
        super({
            catalogPath: "<mainnet-catalog-loaded-in-memory>",
            network: "mainnet",
            logger
        });
        this._mainnetCatalog = config.walletCatalog;
    }

    /** Release a closed-room reservation using Mainnet's recorded blocking obligations. */
    releaseForMainnetOutcome({ roomId, financialLedger, now = Date.now() } = {}) {
        if (financialLedger?.network !== "mainnet" || financialLedger?.globalId !== -239
            || typeof financialLedger.countWalletBlockingObligations !== "function") {
            throw new Error("MAINNET_FINANCIAL_LEDGER_REQUIRED_FOR_WALLET_RELEASE");
        }
        return this.release({ roomId,
            unresolvedObligations: financialLedger.countWalletBlockingObligations(roomId), now });
    }

    _loadCatalog() {
        const wallets = new Map();
        const byRoomNumber = new Set();
        for (const record of this._mainnetCatalog) {
            if (record?.network !== "mainnet") {
                throw new Error("MAINNET_WALLET_NETWORK_MISMATCH");
            }
            const wallet = RoomWallet.fromRecord(record);
            if (wallet.network !== "mainnet" || byRoomNumber.has(wallet.roomNumber)
                || wallets.has(wallet.walletId)) {
                throw new Error("MAINNET_WALLET_CATALOG_CONFLICT");
            }
            byRoomNumber.add(wallet.roomNumber);
            wallets.set(wallet.walletId, wallet);
        }
        if (wallets.size !== MAINNET_WALLET_COUNT || byRoomNumber.size !== MAINNET_WALLET_COUNT) {
            throw new Error("MAINNET_WALLET_CATALOG_INCOMPLETE");
        }
        this._wallets = wallets;
    }
}
