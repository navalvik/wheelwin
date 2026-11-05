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

    initialize(options = {}) {
        super.initialize(options);

        // Room wallet #1 is retained for existing Mainnet reservations and
        // their payout/refund lifecycle, but must not be allocated to a new
        // room. Use the registry's durable quarantine so a process restart
        // preserves this Mainnet-only operational hold. An explicit admin
        // release remains authoritative and is not silently re-applied.
        if (options.snapshotDir && !this._manualQuarantineReleases.has(1)
            && !this._manualQuarantines.has(1)) {
            this.manuallyQuarantine(1, {
                note: "Mainnet wallet #1 is held out of new room assignments",
                actor: "Mainnet pool policy"
            });
        }
        return this;
    }

    _isQuarantined(wallet) {
        if (wallet?.network === "mainnet" && wallet.roomNumber === 1
            && !this._manualQuarantineReleases.has(1)) return true;
        return super._isQuarantined(wallet);
    }

    /**
     * Resolve the wallet identity historically assigned to a room. Unlike
     * getReservationForRoom(), this remains available after a safe release,
     * but returns null when durable history cannot identify one wallet.
     */
    getReservationForRoomHistory(roomId) {
        if (typeof roomId !== "string" || !roomId) return null;
        const records = this._reservationHistory.filter(record => record.roomId === roomId);
        const walletIds = [...new Set(records.map(record => record.walletId))];
        const active = this.getReservationForRoom(roomId);
        if (active && !walletIds.includes(active.walletId)) walletIds.push(active.walletId);
        if (walletIds.length !== 1) return null;

        const wallet = this._wallets.get(walletIds[0]);
        if (!wallet || records.some(record => record.network !== "mainnet"
            || record.address !== wallet.address || record.network !== wallet.network)) return null;
        if (active && active.walletId !== wallet.walletId) return null;
        return Object.freeze({ ...wallet.toRecord(), reservedByRoomId: roomId,
            reservedAt: records.length ? Math.min(...records.map(record => record.reservedAt)) : active.reservedAt });
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
