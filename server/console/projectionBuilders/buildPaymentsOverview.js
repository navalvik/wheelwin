import {
    PAYMENT_PARTICIPANT_STATUS,
    PAYMENT_SESSION_STATUS
} from "../../models/PaymentSession.js";
import { GAME_CONTRACT_STATUS } from "../../models/GameContract.js";

const SETTLING_STATUSES = new Set([
    GAME_CONTRACT_STATUS.SETTLEMENT_PREPARING,
    GAME_CONTRACT_STATUS.SETTLEMENT_SUBMITTED,
    GAME_CONTRACT_STATUS.SETTLEMENT_PENDING,
    GAME_CONTRACT_STATUS.SETTLEMENT_CONFIRMED
]);

/**
 * R6.0C — Payments overview (no organizer/private wallet data).
 */
export function buildPaymentsOverview({
    paymentSessionManager,
    gameContractManager,
    contractSettlementManager
}) {

    const roomIds = paymentSessionManager?.listSessionRoomIds?.() ?? [];
    const contractRoomIds = gameContractManager?.listContractRoomIds?.() ?? [];
    const settlements = contractSettlementManager?.listSettlementSnapshots?.()
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

    const contracts = [];

    for (const roomId of contractRoomIds) {

        const contract = gameContractManager.getContract(roomId);

        if (!contract) {

            continue;

        }

        contracts.push(Object.freeze({
            contractId: contract.contractId,
            roomId: contract.roomId,
            gameId: contract.gameId,
            status: contract.status,
            createdAt: contract.createdAt
        }));

    }

    let settling = 0;
    let completed = 0;

    const settlementSummaries = settlements.map((settlement) => {

        if (SETTLING_STATUSES.has(settlement.status)) {

            settling += 1;

        }

        if (settlement.status === GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED) {

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
