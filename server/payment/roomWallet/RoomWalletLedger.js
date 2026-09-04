/**
 * New Room Wallet payment architecture — durable accounting model boundary.
 *
 * This is an in-memory ledger aggregate used by the payment layer. Persistence
 * is deliberately injected later so the financial model is not coupled to a
 * storage implementation. No blockchain signing or broadcasting happens here.
 */

import {
    assertNonNegativeNano,
    buildSourceWalletTransfer
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

    constructor({ roomId, gameId = null, clock = () => Date.now() } = {}) {
        if (!roomId) {
            throw new TypeError("roomId is required");
        }

        this.roomId = String(roomId);
        this.gameId = gameId == null ? null : String(gameId);
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
            gameId: gameId == null ? null : String(gameId),
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

}
