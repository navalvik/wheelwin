/**
 * Synchronous pre-destruction financial guard for native GRAM Testnet rooms.
 *
 * A room reaching Page4 owns a numbered wallet until authoritative on-chain
 * reconciliation and all obligated transfers are complete. Destruction may
 * proceed only AFTER a durable quarantine marker has been written.
 *
 * This is NOT the transfer executor and does NOT read wallet secrets.
 */
import { tonWalletAccountsEqual } from "../../models/TonWalletAddress.js";
import { TON_FINANCIAL_RECORD_TYPES } from "../../persistence/TonFinancialRecordTypes.js";

export class RoomWalletRefundDestructionGuard {
    constructor({
        repository,
        paymentSessionManager,
        setupSessionLifecycle,
        roomWalletRegistry,
        financialPersistence
    } = {}) {
        if (typeof repository?.beginQuarantine !== "function"
            || typeof repository?.beginSettlementQuarantine !== "function"
            || typeof paymentSessionManager?.getSession !== "function"
            || typeof setupSessionLifecycle?.isGameplayOwnershipReleased !== "function"
            || typeof roomWalletRegistry?.get !== "function"
            || typeof financialPersistence?.findByRoom !== "function") {
            throw new TypeError("Room Wallet destruction guard dependencies are required");
        }
        this._repository = repository;
        this._paymentSessions = paymentSessionManager;
        this._setup = setupSessionLifecycle;
        this._wallets = roomWalletRegistry;
        this._persistence = financialPersistence;
    }

    prepareRoomForDestruction(room) {
        if (!room?.roomId || !Number.isInteger(room.roomNumber)) {
            throw new Error("ROOM_WALLET_DESTROY_ROOM_IDENTITY_REQUIRED");
        }

        // A Page5 room may be destroyed before its winner and owner payments
        // are confirmed. Persist a DIFFERENT quarantine rather than treating
        // the game as eligible for pre-game refunds or releasing its wallet.
        if (this._setup.isGameplayOwnershipReleased(room.roomId)) {
            const mapping = this._wallets.get(room.roomNumber);
            if (!mapping?.address) {
                throw new Error("ROOM_WALLET_POST_PAGE5_ADDRESS_UNAVAILABLE");
            }
            const persisted = this._persistence.findByRoom(room.roomId);
            const payment = this._paymentSessions.getSession(room.roomId)
                ?? persisted.find(x => x.recordType === TON_FINANCIAL_RECORD_TYPES.PAYMENT_SESSION)?.payload;
            const settlements = persisted.filter(x =>
                x.recordType === TON_FINANCIAL_RECORD_TYPES.SETTLEMENT);
            if (settlements.length > 1) {
                throw new Error("ROOM_WALLET_POST_PAGE5_SETTLEMENT_AMBIGUOUS");
            }
            const settlement = settlements[0]?.payload ?? null;
            const gameId = payment?.gameId ?? settlement?.gameId;
            if (!gameId || (settlement && settlement.gameId !== gameId)
                || (payment?.roomWalletAddress
                    && !tonWalletAccountsEqual(payment.roomWalletAddress, mapping.address))
                || (settlement?.request?.roomNumber != null
                    && Number(settlement.request.roomNumber) !== room.roomNumber)) {
                throw new Error("ROOM_WALLET_POST_PAGE5_IDENTITY_UNVERIFIED");
            }
            const hold = this._repository.beginSettlementQuarantine({
                network: "testnet", roomId: room.roomId,
                roomNumber: room.roomNumber, roomWallet: mapping.address, gameId
            });
            return Object.freeze({
                quarantined: true,
                reason: "POST_PAGE5_SETTLEMENT_RECONCILIATION_REQUIRED",
                created: hold.created
            });
        }

        let session = this._paymentSessions.getSession(room.roomId);
        if (!session) {
            // Closing can remove the in-memory session first. The persisted
            // payment record, if any, still proves a Page4 wallet was exposed.
            const saved = this._persistence.findByRoom(room.roomId)
                .filter(x => x.recordType === TON_FINANCIAL_RECORD_TYPES.PAYMENT_SESSION);
            if (saved.length > 1) {
                throw new Error("ROOM_WALLET_AMBIGUOUS_PERSISTED_PAYMENT_SESSIONS");
            }
            session = saved[0]?.payload ?? null;
        }

        // No Page4 ever existed; no wallet address was advertised for payment.
        if (!session) {
            return Object.freeze({ quarantined: false, reason: "NO_PAYMENT_SESSION" });
        }

        if (String(session.network ?? "").toLowerCase() !== "testnet") {
            throw new Error("ROOM_WALLET_DESTROY_NETWORK_UNVERIFIED");
        }

        const mapping = this._wallets.get(room.roomNumber);
        if (!session.paymentSessionId
            || !session.gameId
            || !session.roomWalletAddress
            || !mapping?.address
            || !tonWalletAccountsEqual(session.roomWalletAddress, mapping.address)) {
            throw new Error("ROOM_WALLET_DESTROY_PAYMENT_IDENTITY_MISMATCH");
        }
        if (session.roomNumber != null && Number(session.roomNumber) !== room.roomNumber) {
            throw new Error("ROOM_WALLET_DESTROY_ROOM_NUMBER_MISMATCH");
        }

        // This must be a synchronous durable filesystem write BEFORE
        // RoomManager sets DESTROYED or releases the room number.
        const result = this._repository.beginQuarantine({
            network: "testnet",
            roomId: room.roomId,
            roomNumber: room.roomNumber,
            roomWallet: mapping.address,
            gameId: session.gameId,
            paymentSessionId: session.paymentSessionId
        });
        return Object.freeze({ quarantined: true, created: result.created });
    }
}
