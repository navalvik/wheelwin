import { join } from "node:path";
import { ROOM_LIFETIME_MS } from "../../payment/RoomPaymentConstants.js";
import { mainnetAddressIdentity } from "./MainnetAddress.js";

/** Page4 preparation adapter over the existing Mainnet pool and receipt ledger. */
export class MainnetPage4PaymentApplicationBinding {
    constructor({ runtime, walletPool, dataDir, roomManager, nowProvider = Date.now } = {}) {
        if (runtime?.network !== "mainnet" || runtime?.globalId !== -239
            || runtime?.liveOperationsEnabled !== false
            || typeof runtime?.incomingPayments?.createRoomPaymentIntents !== "function"
            || typeof runtime?.incomingLedger?.listRoomIntents !== "function"
            || typeof runtime?.incomingLedger?.getRoomPaymentStatus !== "function"
            || walletPool?.network !== "mainnet"
            || typeof walletPool.reserve !== "function"
            || typeof walletPool.getReservationForRoom !== "function"
            || typeof walletPool.persistSnapshot !== "function"
            || typeof dataDir !== "string" || !dataDir
            || typeof roomManager?.getRoom !== "function"
            || typeof nowProvider !== "function") {
            throw new Error("MAINNET_PAGE4_BINDING_CONFIG_INVALID");
        }
        this.runtime = runtime;
        this._walletPool = walletPool;
        this._dataDir = dataDir;
        this._roomManager = roomManager;
        this._now = nowProvider;
    }

    /** Create exactly three durable intents. Retries return the existing set. */
    prepareRoomPaymentSession(roomId, playerPayments) {
        const room = this._roomManager.getRoom(roomId);
        if (!room || room.maxPlayers !== 3 || !Array.isArray(room.players)
            || room.players.length !== 3 || new Set(room.players).size !== 3
            || !Array.isArray(playerPayments) || playerPayments.length !== 3) {
            throw new Error("MAINNET_PAGE4_ROOM_ROSTER_INVALID");
        }
        const requested = new Map();
        for (const payment of playerPayments) {
            if (!payment || !room.players.includes(payment.playerId)
                || requested.has(payment.playerId)
                || typeof payment.paymentReference !== "string"
                || !Number.isSafeInteger(payment.amountAtomic) || payment.amountAtomic <= 0) {
                throw new Error("MAINNET_PAGE4_PAYMENT_REQUIREMENTS_INVALID");
            }
            mainnetAddressIdentity(payment.expectedSender);
            requested.set(payment.playerId, payment);
        }
        if (room.players.some(playerId => !requested.has(playerId))) {
            throw new Error("MAINNET_PAGE4_PAYMENT_ROSTER_MISMATCH");
        }

        const ledger = this.runtime.incomingLedger;
        const existing = ledger.listRoomIntents(roomId);
        if (existing.length !== 0 && existing.length !== 3) {
            throw new Error("MAINNET_PAGE4_PARTIAL_INTENT_SET");
        }

        let reservation = this._walletPool.getReservationForRoom(roomId);
        if (existing.length === 3) {
            const first = existing[0];
            const exact = existing.every(intent => {
                const payment = requested.get(intent.playerId);
                return payment
                    && intent.network === "mainnet" && intent.globalId === -239
                    && intent.destinationWalletId === first.destinationWalletId
                    && mainnetAddressIdentity(intent.destinationWalletAddress)
                        === mainnetAddressIdentity(first.destinationWalletAddress)
                    && intent.paymentReference === payment.paymentReference
                    && mainnetAddressIdentity(intent.expectedSender)
                        === mainnetAddressIdentity(payment.expectedSender)
                    && intent.amountAtomic === String(payment.amountAtomic);
            });
            if (!exact) throw new Error("MAINNET_PAGE4_EXISTING_INTENTS_CONFLICT");
            if (!reservation) {
                const catalogWallet = this._walletPool.getWallet(first.destinationWalletId);
                if (!catalogWallet || catalogWallet.network !== "mainnet"
                    || mainnetAddressIdentity(catalogWallet.address)
                        !== mainnetAddressIdentity(first.destinationWalletAddress)) {
                    throw new Error("MAINNET_PAGE4_WALLET_RESERVATION_CONFLICT");
                }
                reservation = this._walletPool.reserve({
                    roomId, network: "mainnet", walletId: first.destinationWalletId, now: this._now()
                }).wallet;
                this._persistWalletPool();
            }
            if (reservation.walletId !== first.destinationWalletId
                || reservation.network !== "mainnet"
                || mainnetAddressIdentity(reservation.address)
                    !== mainnetAddressIdentity(first.destinationWalletAddress)) {
                throw new Error("MAINNET_PAGE4_WALLET_RESERVATION_CONFLICT");
            }
            return Object.freeze({ prepared: true, idempotent: true, payments: Object.freeze([]),
                intentCount: 3, paymentStatus: ledger.getRoomPaymentStatus(roomId) });
        }

        if (!reservation) {
            reservation = this._walletPool.reserve({
                roomId, network: "mainnet", now: this._now()
            }).wallet;
            this._persistWalletPool();
        }
        if (reservation.network !== "mainnet") {
            throw new Error("MAINNET_PAGE4_WALLET_NETWORK_MISMATCH");
        }
        const createdAt = Number.isSafeInteger(room.createdAt) && room.createdAt > 0
            ? room.createdAt : this._now();
        const expiresAt = createdAt + ROOM_LIFETIME_MS;
        if (expiresAt <= this._now()) throw new Error("MAINNET_PAGE4_ROOM_PAYMENT_WINDOW_EXPIRED");

        const intents = this.runtime.incomingPayments.createRoomPaymentIntents({
            roomId,
            wallet: { walletId: reservation.walletId, address: reservation.address,
                network: "mainnet", globalId: -239 },
            createdAt,
            expiresAt,
            players: room.players.map(playerId => {
                const payment = requested.get(playerId);
                return { playerId, paymentReference: payment.paymentReference,
                    expectedSender: payment.expectedSender, amountAtomic: payment.amountAtomic };
            })
        });
        if (intents.length !== 3) throw new Error("MAINNET_PAGE4_INTENT_COUNT_INVALID");

        // No PAYMENT_REQUEST payloads: live acceptance is deliberately off.
        return Object.freeze({ prepared: true, idempotent: false, payments: Object.freeze([]),
            intentCount: intents.length, paymentStatus: ledger.getRoomPaymentStatus(roomId) });
    }

    _persistWalletPool() {
        this._walletPool.persistSnapshot(join(this._dataDir, "wallet-registry"));
    }
}
