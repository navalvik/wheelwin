import { MAINNET_GLOBAL_ID } from "../config/MainnetRuntimeConfig.js";

/** Read-only adapter for the existing GameStartAuthorization payment-gate contract. */
export class MainnetGameStartPaymentGate {
    constructor({ incomingLedger } = {}) {
        if (incomingLedger?.network !== "mainnet"
            || incomingLedger?.globalId !== MAINNET_GLOBAL_ID
            || typeof incomingLedger.getRoomPaymentStatus !== "function"
            || typeof incomingLedger.listRoomIntents !== "function") {
            throw new Error("MAINNET_PAYMENT_GATE_LEDGER_REQUIRED");
        }
        this.network = "mainnet";
        this.globalId = MAINNET_GLOBAL_ID;
        this._ledger = incomingLedger;
    }

    getGameStartGateStatus(roomId, playerIds) {
        const ids = Array.isArray(playerIds) ? [...playerIds] : [];
        const validRoster = typeof roomId === "string" && roomId.length > 0
            && ids.length === 3 && ids.every((id) => typeof id === "string" && id.length > 0)
            && new Set(ids).size === 3;
        if (!validRoster) {
            return Object.freeze({ roomId: roomId ?? null, playerIds: ids, eligible: false,
                reason: "mainnet_payment_roster_invalid", network: "mainnet", globalId: MAINNET_GLOBAL_ID,
                confirmedCount: 0, requiredCount: 3, status: "0/3" });
        }
        const intents = this._ledger.listRoomIntents(roomId);
        const exactRoster = intents.length === 3
            && ids.every((playerId) => intents.some((intent) => intent.playerId === playerId));
        const status = this._ledger.getRoomPaymentStatus(roomId);
        const ready = exactRoster && status.network === "mainnet"
            && status.globalId === MAINNET_GLOBAL_ID
            && status.confirmedCount === 3 && status.financialReady === true;
        return Object.freeze({ roomId, playerIds: ids, eligible: ready,
            reason: ready ? null : exactRoster ? "mainnet_payments_incomplete" : "mainnet_payment_intents_incomplete",
            network: "mainnet", globalId: MAINNET_GLOBAL_ID,
            confirmedCount: status.confirmedCount, requiredCount: 3,
            status: status.status, financialReady: ready, page5Enabled: false });
    }
}
