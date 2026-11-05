import { ROOM_LIFETIME_MS } from "../testnet_source/payment/RoomPaymentConstants.js";

/** Page4 protocol binding over the copied Testnet session and intent APIs. */
export class MainnetPage4PaymentApplicationBinding {
    constructor({ runtime, walletPool, dataDir, roomManager, nowProvider = Date.now,
        paymentAcceptanceEnabled = false } = {}) {
        if (runtime?.network !== "mainnet" || runtime?.globalId !== -239
            || typeof runtime?.sessionAdapter?.prepareRoom !== "function"
            || typeof runtime?.paymentService?.listPaymentIntentsForRoom !== "function"
            || walletPool?.network !== "mainnet"
            || typeof walletPool.reserve !== "function"
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
        this._paymentAcceptanceEnabled = paymentAcceptanceEnabled === true;
    }

    prepareRoomPaymentSession(roomId, playerPayments) {
        const room = this._roomManager.getRoom(roomId);
        if (!room || room.maxPlayers !== 3 || !Array.isArray(room.players)
            || room.players.length !== 3 || new Set(room.players).size !== 3
            || !Array.isArray(playerPayments) || playerPayments.length !== 3) {
            throw new Error("MAINNET_PAGE4_ROOM_ROSTER_INVALID");
        }
        const byPlayer = new Map();
        for (const payment of playerPayments) {
            if (!payment || !room.players.includes(payment.playerId)
                || byPlayer.has(payment.playerId)
                || typeof payment.paymentReference !== "string"
                || !Number.isSafeInteger(payment.amountAtomic) || payment.amountAtomic <= 0) {
                throw new Error("MAINNET_PAGE4_PAYMENT_REQUIREMENTS_INVALID");
            }
            byPlayer.set(payment.playerId, payment);
        }
        if (byPlayer.size !== 3) throw new Error("MAINNET_PAGE4_PAYMENT_ROSTER_MISMATCH");

        const before = this.runtime.paymentService.listPaymentIntentsForRoom(roomId).length;
        const createdAt = Number.isSafeInteger(room.createdAt) && room.createdAt > 0
            ? room.createdAt : this._now();
        if (createdAt + ROOM_LIFETIME_MS <= this._now()) {
            throw new Error("MAINNET_PAGE4_ROOM_PAYMENT_WINDOW_EXPIRED");
        }
        const session = this.runtime.sessionAdapter.prepareRoom({
            roomId,
            roomCreatedAt: createdAt,
            network: "mainnet",
            asset: "TON",
            stakeLedgerRelation: "ONE_PLAYER_STAKE_AND_PRINCIPAL_PER_PAYMENT",
            requiredPlayers: room.players.map(playerId => ({
                roomId,
                playerId,
                paymentReference: byPlayer.get(playerId).paymentReference,
                expectedSender: byPlayer.get(playerId).expectedSender,
                amountAtomic: byPlayer.get(playerId).amountAtomic
            }))
        });
        const reservation = this.runtime.paymentService.getWalletForRoom(roomId);
        if (!reservation || reservation.network !== "mainnet") {
            throw new Error("MAINNET_PAGE4_WALLET_RESERVATION_REQUIRED");
        }
        return Object.freeze({
            prepared: true,
            idempotent: before === 3,
            intentCount: session.payments.length,
            payments: this._paymentAcceptanceEnabled
                ? this.getPaymentRequestData(roomId)
                : Object.freeze([]),
            paymentStatus: this.runtime.paymentGate.getGameStartGateStatus(roomId, room.players)
        });
    }

    getPaymentRequestData(roomId) {
        const room = this._roomManager.getRoom(roomId);
        const intents = this.runtime.paymentService.listPaymentIntentsForRoom(roomId);
        const reservation = this._walletPool.getReservationForRoom(roomId);
        if (!room || room.players?.length !== 3 || intents.length !== 3
            || !reservation || reservation.network !== "mainnet") {
            throw new Error("MAINNET_PAGE4_PAYMENT_STATE_UNAVAILABLE");
        }
        return Object.freeze(room.players.map(playerId => {
            const intent = intents.find(item => item.playerId === playerId);
            if (!intent || intent.network !== "mainnet"
                || intent.destinationWalletId !== reservation.walletId
                || intent.destinationWalletAddress !== reservation.address) {
                throw new Error("MAINNET_PAGE4_SAVED_INTENT_CONFLICT");
            }
            return Object.freeze({
                playerId,
                paymentReference: intent.paymentReference,
                destinationWalletAddress: intent.destinationWalletAddress,
                amountAtomic: intent.amountAtomic,
                asset: intent.asset,
                network: intent.network,
                expiresAt: intent.expiresAt
            });
        }));
    }
}
