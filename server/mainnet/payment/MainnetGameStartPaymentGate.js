import {
    INCOMING_PRINCIPAL_CONFIRMATION_SOURCE,
    LEDGER_ENTRY_KIND
} from "../../payment/ledger/index.js";
import { assessThreePlayerPaymentGate } from "../../payment/runtime/ThreePlayerPaymentGate.js";
import { MAINNET_GLOBAL_ID } from "../config/MainnetRuntimeConfig.js";

function asSafeAtomicAmount(value) {
    if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return null;
    const amount = Number(value);
    return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

/**
 * Mainnet ledger projection for the shared, network-neutral 3/3 start rule.
 * This adapter translates durable Mainnet intents/receipts to the common gate
 * contract; eligibility and all roster/payment checks remain in Testnet's
 * assessThreePlayerPaymentGate implementation.
 */
export class MainnetGameStartPaymentGate {
    constructor({ incomingLedger, nowProvider = Date.now } = {}) {
        if (incomingLedger?.network !== "mainnet"
            || incomingLedger?.globalId !== MAINNET_GLOBAL_ID
            || typeof incomingLedger.listRoomIntents !== "function"
            || typeof incomingLedger.listReceipts !== "function"
            || typeof incomingLedger.listObservations !== "function"
            || typeof nowProvider !== "function") {
            throw new Error("MAINNET_PAYMENT_GATE_LEDGER_REQUIRED");
        }
        this.network = "mainnet";
        this.globalId = MAINNET_GLOBAL_ID;
        this._ledger = incomingLedger;
        this._now = nowProvider;
    }

    getGameStartGateStatus(roomId, playerIds) {
        const intents = this._ledger.listRoomIntents(roomId);
        const receipts = this._ledger.listReceipts(roomId);
        const observations = this._ledger.listObservations(roomId);
        const requirements = intents.map(intent => ({
            roomId: intent.roomId,
            playerId: intent.playerId,
            paymentReference: intent.paymentReference,
            expectedSender: intent.expectedSender,
            amountAtomic: asSafeAtomicAmount(intent.amountAtomic)
        }));
        const normalizedIntents = intents.map(intent => ({
            ...intent,
            amountAtomic: asSafeAtomicAmount(intent.amountAtomic),
            transactionId: intent.confirmedTransactionId
        }));
        const principalEntries = [];

        for (const intent of intents) {
            if (intent.state !== "SETTLED" || !intent.confirmedTransactionId) continue;
            const receipt = receipts.find(item => item.transactionId === intent.confirmedTransactionId);
            const observation = observations.find(item => item.transactionId === intent.confirmedTransactionId);
            if (!receipt || !observation
                || receipt.status !== "CONFIRMED" || receipt.reason !== null
                || receipt.network !== "mainnet" || receipt.globalId !== MAINNET_GLOBAL_ID
                || receipt.roomId !== roomId || receipt.paymentReference !== intent.paymentReference
                || receipt.amountAtomic !== intent.amountAtomic
                || observation.network !== "mainnet" || observation.globalId !== MAINNET_GLOBAL_ID
                || observation.roomId !== roomId || observation.transactionId !== receipt.transactionId
                || observation.amountAtomic !== receipt.amountAtomic || observation.asset !== "TON") continue;

            principalEntries.push({
                kind: LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL,
                roomId,
                network: "mainnet",
                asset: "TON",
                playerId: intent.playerId,
                amountAtomic: asSafeAtomicAmount(receipt.amountAtomic),
                metadata: {
                    paymentReference: intent.paymentReference,
                    transactionId: receipt.transactionId,
                    intentState: "SETTLED",
                    source: INCOMING_PRINCIPAL_CONFIRMATION_SOURCE
                }
            });
        }

        const assessment = assessThreePlayerPaymentGate({
            roomId,
            roomPlayerIds: playerIds,
            network: "mainnet",
            asset: "TON",
            requirements,
            intents: normalizedIntents,
            principalEntries,
            nowMs: this._now()
        });
        const status = this._ledger.getRoomPaymentStatus(roomId);
        return Object.freeze({
            ...assessment,
            roomId: roomId ?? null,
            playerIds: Object.freeze(Array.isArray(playerIds) ? [...playerIds] : []),
            network: "mainnet",
            globalId: MAINNET_GLOBAL_ID,
            confirmedCount: Number.isSafeInteger(status?.confirmedCount) ? status.confirmedCount : 0,
            requiredCount: 3,
            status: status?.status ?? "0/3",
            financialReady: assessment.eligible,
            page5Enabled: false
        });
    }
}
