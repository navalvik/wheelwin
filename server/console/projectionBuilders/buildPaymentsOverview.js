import {
    PAYMENT_PARTICIPANT_STATUS,
    PAYMENT_SESSION_STATUS
} from "../../models/PaymentSession.js";
import { IN_PROGRESS_SETTLEMENT_SESSION_STATUSES, SETTLEMENT_SESSION_STATUS } from "../../payment/SettlementSessionStates.js";

const SETTLING_STATUSES = new Set(IN_PROGRESS_SETTLEMENT_SESSION_STATUSES);

/**
 * R6.0C — Payments overview (no organizer/private wallet data).
 */
export function buildPaymentsOverview({
    paymentSessionManager,
    settlementManager
}) {

    const roomIds = paymentSessionManager?.listSessionRoomIds?.() ?? [];
    const settlements = settlementManager?.listSettlementSnapshots?.()
        ?? [];

    const sessions = [];
    let pendingSessions = 0;
    let confirmed = 0;

    for (const roomId of roomIds) {

        const session = paymentSessionManager.getSession(roomId);

        if (!session) {

            continue;

        }

        const snapshot = session.toSnapshot();
        const participants = snapshot.participants ?? [];
        const confirmedCount = participants.filter(
            (participant) => participant.status
                === PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
        ).length;

        if (snapshot.status === PAYMENT_SESSION_STATUS.ACTIVE) {

            pendingSessions += 1;

        }

        if (snapshot.status === PAYMENT_SESSION_STATUS.COMPLETED
            || (
                snapshot.status === PAYMENT_SESSION_STATUS.ACTIVE
                && confirmedCount === participants.length
                && participants.length > 0
            )) {

            confirmed += 1;

        }

        sessions.push(Object.freeze({
            paymentSessionId: snapshot.paymentSessionId,
            roomId: snapshot.roomId,
            gameId: snapshot.gameId ?? null,
            status: snapshot.status,
            participantCount: participants.length,
            confirmedCount,
            createdAt: snapshot.createdAt,
            expiresAt: snapshot.expiresAt ?? null,
            completedAt: snapshot.completedAt ?? null
        }));

    }

    let settling = 0;
    let completed = 0;

    const settlementSummaries = settlements.map((settlement) => {

        if (SETTLING_STATUSES.has(settlement.status)) {

            settling += 1;

        }

        if (settlement.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED) {

            completed += 1;

        }

        return Object.freeze({
            gameId: settlement.gameId,
            roomId: settlement.roomId,
            contractId: settlement.contractId,
            status: settlement.status,
            winnerId: settlement.winnerId ?? null,
            startedAt: settlement.startedAt ?? null,
            completedAt: settlement.completedAt ?? null
            // organizerAmount / settlementTxHash / ownerWallet omitted
        });

    });

    return Object.freeze({
        pendingSessions,
        confirmed,
        settling,
        completed,
        sessions: Object.freeze(sessions),
        contracts: Object.freeze(contracts),
        settlements: Object.freeze(settlementSummaries)
    });

}
