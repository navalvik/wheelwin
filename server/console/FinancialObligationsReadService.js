import { countUnsettledRoomFinancialObligations } from "../payment/runtime/countUnsettledRoomFinancialObligations.js";
import { OBLIGATION_OPEN_STATES } from "../payment/PaymentIntentStatus.js";
import { LEDGER_ENTRY_KIND } from "../payment/ledger/LedgerConstants.js";

function addRoom(rooms, roomId, closed = false) {
    if (typeof roomId !== "string" || roomId.length === 0) return;
    const current = rooms.get(roomId) ?? { roomId, closedRoom: false };
    current.closedRoom ||= closed;
    rooms.set(roomId, current);
}

/** Read-only Testnet view of durable financial obligations, including closed rooms. */
export class FinancialObligationsReadService {
    constructor({ getRuntime, now = () => Date.now() } = {}) {
        this.getRuntime = getRuntime;
        this.now = now;
    }

    snapshot() {
        const runtime = this.getRuntime?.();
        if (!runtime?.initialized || runtime.network !== "testnet" || runtime.globalId !== -3) {
            throw new Error("TESTNET_PAYMENT_RUNTIME_UNAVAILABLE");
        }

        const { ledger, ledgerStore, refundStore, receiptStore, intentStore } = runtime;
        if (typeof ledgerStore?.list !== "function"
            || typeof ledgerStore?.listForRoom !== "function"
            || typeof ledger?.listPayoutObligations !== "function"
            || typeof refundStore?.list !== "function"
            || typeof refundStore?.listClosedRooms !== "function"
            || typeof receiptStore?.list !== "function"
            || typeof receiptStore?.listForRoom !== "function"
            || typeof receiptStore?.listUnresolved !== "function"
            || typeof intentStore?.list !== "function") {
            throw new Error("TESTNET_FINANCIAL_STORES_UNAVAILABLE");
        }

        const ledgerEntries = ledgerStore.list();
        const refunds = refundStore.list();
        const receipts = receiptStore.list();
        const intents = intentStore.list();
        const closedRooms = refundStore.listClosedRooms();
        const rooms = new Map();

        for (const entry of ledgerEntries) addRoom(rooms, entry.roomId);
        for (const refund of refunds) addRoom(rooms, refund.roomId);
        for (const intent of intents) addRoom(rooms, intent.roomId);
        for (const receipt of receipts) {
            if (receipt.ownershipStatus === "UNRESOLVED") {
                for (const candidateRoomId of receipt.candidateRoomIds ?? []) addRoom(rooms, candidateRoomId);
            } else {
                addRoom(rooms, receipt.roomId);
            }
        }
        for (const closed of closedRooms) addRoom(rooms, closed.roomId, true);

        const closedRoomIds = new Set(closedRooms.map(room => room.roomId));
        const obligations = [];
        let unsettledCount = 0;

        for (const room of rooms.values()) {
            const roomEntries = ledgerEntries.filter(entry => entry.roomId === room.roomId);
            const roomRefunds = refunds.filter(refund => refund.roomId === room.roomId);
            const roomReceipts = receipts.filter(receipt => receipt.roomId === room.roomId);
            const roomIntents = intents.filter(intent => intent.roomId === room.roomId);
            const roomLedger = {
                store: { listForRoom: () => roomEntries },
                listPayoutObligations: () => ledger.listPayoutObligations(room.roomId)
            };
            const roomRefundStore = { list: () => roomRefunds };
            const roomReceiptStore = { listForRoom: () => roomReceipts };
            const roomCount = countUnsettledRoomFinancialObligations({
                roomId: room.roomId,
                ledger: roomLedger,
                refundStore: roomRefundStore,
                receiptStore: roomReceiptStore
            });
            const pendingIntents = roomIntents.filter(intent => OBLIGATION_OPEN_STATES.includes(intent.state));
            const roomObligations = [];
            const principalEntries = roomEntries.filter(entry => entry.kind === LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL);
            const creditedTransactionIds = new Set(principalEntries.map(entry => entry.metadata?.transactionId));
            const unreturnedReceipts = roomReceipts.filter(receipt =>
                !creditedTransactionIds.has(receipt.transactionId)
                && !roomRefunds.some(refund => refund.incomingTransactionId === receipt.transactionId
                    && refund.state === "COMPLETE"));

            if (unreturnedReceipts.length > 0) {
                for (const _receipt of unreturnedReceipts) {
                    roomObligations.push({ type: "INCOMING_RECEIPT", roomId: room.roomId, state: "UNRETURNED" });
                }
            } else {
                for (const refund of roomRefunds.filter(item => item.state !== "COMPLETE")) {
                    roomObligations.push({ type: "REFUND", roomId: room.roomId, state: refund.state });
                }

                for (const payout of ledger.listPayoutObligations(room.roomId).filter(item => !item.settled)) {
                    roomObligations.push({ type: "PAYOUT", roomId: room.roomId, state: "UNSETTLED" });
                }

                if (roomObligations.length === 0 && roomCount > 0) {
                    const payoutPlans = roomEntries.filter(entry => entry.kind === LEDGER_ENTRY_KIND.PAYOUT_PLAN);
                    const state = payoutPlans.length > 0
                        ? "INCOMPLETE_OR_CONTRADICTORY_SETTLEMENT"
                        : "AWAITING_REFUND_OR_PAYOUT";
                    const returned = new Set(roomRefunds.filter(item => item.state === "COMPLETE")
                        .map(item => `${item.paymentIntentId}:${item.incomingTransactionId}`));
                    const unsettledPrincipal = principalEntries.filter(entry => {
                        const reference = entry.metadata?.paymentReference;
                        const transactionId = entry.metadata?.transactionId;
                        return !reference || !transactionId
                            || !returned.has(`${reference}:${transactionId}`);
                    });
                    const principalCount = payoutPlans.length > 0 ? 1 : unsettledPrincipal.length;
                    for (let index = 0; index < Math.max(1, principalCount); index += 1) {
                        roomObligations.push({
                            type: payoutPlans.length > 0 ? "PAYOUT_PLAN" : "COLLECTED_PRINCIPAL",
                            roomId: room.roomId,
                            state
                        });
                    }
                }
            }

            for (const intent of pendingIntents) {
                roomObligations.push({ type: "PAYMENT_INTENT", roomId: room.roomId, state: intent.state });
            }

            // Keep the canonical room hold count visible alongside the detailed rows.
            // A mismatch is represented as a fail-closed diagnostic row, never hidden.
            if (roomObligations.length - pendingIntents.length !== roomCount) {
                roomObligations.push({
                    type: "ROOM_FINANCIAL_HOLD",
                    roomId: room.roomId,
                    state: "DETAIL_COUNT_MISMATCH"
                });
            }

            for (const item of roomObligations) {
                obligations.push({ ...item, closedRoom: closedRoomIds.has(room.roomId) });
            }
            unsettledCount += roomCount + pendingIntents.length;
        }

        const unresolvedReceipts = receiptStore.listUnresolved();
        for (const _receipt of unresolvedReceipts) {
            obligations.push({
                type: "INCOMING_RECEIPT",
                roomId: null,
                candidateRoomIds: [...new Set(_receipt.candidateRoomIds ?? [])],
                state: "UNRESOLVED_OWNERSHIP",
                closedRoom: false
            });
        }
        unsettledCount += unresolvedReceipts.length;

        obligations.sort((a, b) =>
            String(a.roomId ?? "").localeCompare(String(b.roomId ?? ""))
            || a.type.localeCompare(b.type)
            || a.state.localeCompare(b.state));

        return Object.freeze({
            network: "TESTNET",
            globalId: -3,
            updatedAt: new Date(this.now()).toISOString(),
            roomsScanned: rooms.size,
            closedRoomsScanned: closedRoomIds.size,
            unsettledCount,
            obligations: Object.freeze(obligations.map(item => Object.freeze(item)))
        });
    }
}
