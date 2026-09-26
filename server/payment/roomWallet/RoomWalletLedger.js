/**
 * New Room Wallet payment architecture — durable accounting model boundary.
 *
 * This is an in-memory ledger aggregate used by the payment layer. Persistence
 * is deliberately injected later so the financial model is not coupled to a
 * storage implementation. No blockchain signing or broadcasting happens here.
 */

import {
    assertNonNegativeNano,
    buildSourceWalletTransfer,
    gramsToNano
} from "./RoomWalletFinancialPolicy.js";

export const ROOM_LEDGER_ENTRY_TYPES = Object.freeze({
    PLAYER_PAYMENT: "PLAYER_PAYMENT",
    WINNER_PAYOUT: "WINNER_PAYOUT",
    OWNER_PAYOUT: "OWNER_PAYOUT",
    OWNER_RETAINED: "OWNER_RETAINED",
    RESIDUAL_SWEEP: "RESIDUAL_SWEEP",
    GAS: "GAS",
    ADJUSTMENT: "ADJUSTMENT"
});

export class RoomWalletLedger {

    constructor({ roomId, gameId = null, roomNumber = null, clock = () => Date.now() } = {}) {
        if (!roomId) {
            throw new TypeError("roomId is required");
        }

        this.roomId = String(roomId);
        this.gameId = gameId == null ? null : String(gameId);
        this.roomNumber = roomNumber == null ? null : Number(roomNumber);
        this._clock = clock;
        this._entries = [];
        this._entryIds = new Set();

    }

    record({
        entryId,
        type,
        direction,
        amountNano,
        counterparty = null,
        gameId = this.gameId,
        roomNumber = this.roomNumber,
        playerId = null,
        reference = null,
        metadata = {}
    } = {}) {
        if (!entryId || this._entryIds.has(String(entryId))) {
            throw new Error("entryId is required and must be unique");
        }

        if (!Object.values(ROOM_LEDGER_ENTRY_TYPES).includes(type)) {
            throw new TypeError(`Unsupported ledger entry type: ${type}`);
        }

        if (direction !== "CREDIT" && direction !== "DEBIT") {
            throw new TypeError("direction must be CREDIT or DEBIT");
        }

        assertNonNegativeNano(amountNano, "amountNano");

        const entry = Object.freeze({
            entryId: String(entryId),
            roomId: this.roomId,
            roomNumber: roomNumber == null || roomNumber === ""
                ? this.roomNumber
                : Number(roomNumber),
            gameId: gameId == null ? null : String(gameId),
            playerId: playerId == null ? null : String(playerId),
            type,
            direction,
            amountNano,
            counterparty,
            reference,
            metadata: Object.freeze({ ...metadata }),
            createdAt: this._clock()
        });

        this._entryIds.add(entry.entryId);
        this._entries.push(entry);

        return entry;
    }

    recordTransfer({
        entryId,
        type,
        amountNano,
        gasNano,
        counterparty,
        reference = null,
        metadata = {}
    } = {}) {
        const transfer = buildSourceWalletTransfer({ amountNano, gasNano });

        const amountEntry = this.record({
            entryId: `${entryId}:amount`,
            type,
            direction: "DEBIT",
            amountNano: transfer.amountNano,
            counterparty,
            reference,
            metadata
        });

        const gasEntry = this.record({
            entryId: `${entryId}:gas`,
            type: ROOM_LEDGER_ENTRY_TYPES.GAS,
            direction: "DEBIT",
            amountNano: transfer.gasNano,
            counterparty: "BLOCKCHAIN_FEE",
            reference,
            metadata: {
                ...metadata,
                sourceEntryId: amountEntry.entryId
            }
        });

        return Object.freeze({
            amountEntry,
            gasEntry,
            sourceDebitNano: transfer.sourceDebitNano,
            recipientCreditNano: transfer.recipientCreditNano
        });
    }

    getEntries() {
        return Object.freeze([...this._entries]);
    }

    getBalanceDeltaNano() {
        return this._entries.reduce(
            (total, entry) =>
                total + (entry.direction === "CREDIT"
                    ? entry.amountNano
                    : -entry.amountNano),
            0n
        );
    }

    getDebitsNano() {
        return this._entries.reduce(
            (total, entry) =>
                total + (entry.direction === "DEBIT" ? entry.amountNano : 0n),
            0n
        );
    }

    getCreditsNano() {
        return this._entries.reduce(
            (total, entry) =>
                total + (entry.direction === "CREDIT" ? entry.amountNano : 0n),
            0n
        );
    }

    hasEntry(entryId) {
        return this._entryIds.has(String(entryId));
    }

    listPlayerPayments(gameId = this.gameId) {
        const scopedGameId = gameId == null ? null : String(gameId);

        return Object.freeze(
            this._entries.filter((entry) => (
                entry.type === ROOM_LEDGER_ENTRY_TYPES.PLAYER_PAYMENT
                && entry.direction === "CREDIT"
                && (scopedGameId == null || entry.gameId === scopedGameId)
            ))
        );
    }

}

export function buildRoomWalletPlayerPaymentEntryId(transactionHash) {
    const hash = String(transactionHash ?? "").trim();

    if (!hash) {
        throw new TypeError("transactionHash is required");
    }

    return `rwp:${hash}`;
}

/**
 * In-process registry of per-game Room Wallet ledgers.
 * Sequential games in one room get separate ledger instances keyed by gameId.
 */
export class RoomWalletLedgerRegistry {
    constructor({ clock = () => Date.now() } = {}) {
        this._clock = clock;
        this._byGameId = new Map();
        this._byEntryId = new Map();
    }

    getOrCreate({ roomId, gameId, roomNumber = null } = {}) {
        if (!gameId) {
            throw new TypeError("gameId is required");
        }

        const key = String(gameId);
        let ledger = this._byGameId.get(key);

        if (!ledger) {
            ledger = new RoomWalletLedger({
                roomId,
                gameId: key,
                roomNumber,
                clock: this._clock
            });
            this._byGameId.set(key, ledger);
        }

        return ledger;
    }

    getByGameId(gameId) {
        if (gameId == null || gameId === "") {
            return null;
        }

        return this._byGameId.get(String(gameId)) ?? null;
    }

    hasEntry(entryId) {
        return this._byEntryId.has(String(entryId));
    }

    recordPlayerPayment({
        roomId,
        roomNumber = null,
        gameId,
        playerId,
        paymentReference = null,
        txHash,
        amountGram,
        sender = null,
        destination = null,
        lt = null,
        comment = ""
    } = {}) {
        if (!roomId || !gameId || !playerId || !txHash) {
            throw new TypeError("roomId, gameId, playerId, and txHash are required");
        }

        const entryId = buildRoomWalletPlayerPaymentEntryId(txHash);
        const existing = this._byEntryId.get(entryId);

        if (existing) {
            if (
                existing.gameId !== String(gameId)
                || existing.playerId !== String(playerId)
            ) {
                throw new Error(
                    "duplicate transaction hash already attributed to another payment"
                );
            }

            return existing;
        }

        const ledger = this.getOrCreate({ roomId, gameId, roomNumber });
        const entry = ledger.record({
            entryId,
            type: ROOM_LEDGER_ENTRY_TYPES.PLAYER_PAYMENT,
            direction: "CREDIT",
            amountNano: gramsToNano(Number(amountGram)),
            counterparty: String(playerId),
            playerId: String(playerId),
            gameId: String(gameId),
            roomNumber,
            reference: paymentReference ?? String(txHash),
            metadata: Object.freeze({
                txHash: String(txHash),
                sender: sender ?? null,
                destination: destination ?? null,
                lt: lt ?? null,
                comment: comment ?? "",
                amountGram: Number(amountGram)
            })
        });

        this._byEntryId.set(entryId, entry);
        return entry;
    }

    listPlayerPayments(gameId) {
        const ledger = this.getByGameId(gameId);

        if (!ledger) {
            return Object.freeze([]);
        }

        return ledger.listPlayerPayments(gameId);
    }
}
