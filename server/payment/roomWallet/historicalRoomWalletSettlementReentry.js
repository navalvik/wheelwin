/**
 * Narrow historical re-entry for Room Wallet settlements that failed solely
 * because of the old adapter field-mismatch (`prizeAmount` required).
 *
 * Safety failures never match. Amounts and destinations are taken only from
 * persisted settlement evidence or sealed incident-archive facts that already
 * agree with that evidence. Operator overrides are not accepted here.
 */

import { SETTLEMENT_SESSION_STATUS } from "../SettlementSessionStates.js";
import { ROOM_WALLET_SETTLEMENT_SAFETY_CODES } from "./RoomWalletSettlementAdapter.js";
import { getSealedTerminalSettlementEvidence } from "./sealedTerminalSettlementEvidence.js";

export const HISTORICAL_ROOM_WALLET_ADAPTER_INTERFACE_FAILURE =
    "adapter_threw:prizeAmount or prizeAmountNano is required";

export function isHistoricalRoomWalletAdapterInterfaceFailure(session) {
    if (session?.status !== SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED) {
        return false;
    }

    const reason = String(session.reason ?? "").trim();
    if (reason !== HISTORICAL_ROOM_WALLET_ADAPTER_INTERFACE_FAILURE) {
        return false;
    }

    if (isSafetyFailureReason(reason)) {
        return false;
    }

    return true;
}

export function reconstructHistoricalRoomWalletRequest(session) {
    if (!isHistoricalRoomWalletAdapterInterfaceFailure(session)) {
        return null;
    }

    const request = session.request && typeof session.request === "object"
        ? { ...session.request }
        : {};
    const sealed = getSealedTerminalSettlementEvidence(session.gameId);

    fillIfAbsent(request, "gameId", session.gameId);
    fillIfAbsent(request, "roomId", session.roomId);
    fillIfAbsent(request, "contractId", session.contractId);
    fillIfAbsent(request, "winnerId", session.winnerId);
    fillIfAbsent(request, "winnerWallet", session.winnerWallet ?? request.winnerWallet);
    fillIfAbsent(request, "ownerWallet", session.ownerWallet ?? request.ownerWallet);
    fillIfAbsent(request, "winnerAmount", session.prizeAmount ?? session.winnerAmount);
    fillIfAbsent(request, "organizerAmount", session.organizerAmount);
    fillIfAbsent(request, "totalPot", session.totalPot);
    fillIfAbsent(request, "traceSeed", session.traceSeed);

    if (sealed) {
        if (!sealedFieldsAgree(session, request, sealed)) {
            return null;
        }
        fillIfAbsent(request, "roomNumber", sealed.roomNumber);
        fillIfAbsent(request, "winnerId", sealed.winnerId);
        fillIfAbsent(request, "winnerWallet", sealed.winnerWallet);
        fillIfAbsent(request, "ownerWallet", sealed.ownerWallet);
        fillIfAbsent(request, "winnerAmount", sealed.winnerAmount);
        fillIfAbsent(request, "organizerAmount", sealed.organizerAmount);
        fillIfAbsent(request, "roomId", sealed.roomId);
    }

    if (!isCompleteSettlementRequest(request)) {
        return null;
    }

    return Object.freeze(request);
}

function isSafetyFailureReason(reason) {
    const text = String(reason ?? "");
    if (text.includes("disagree") || text.includes("AMOUNT_MISMATCH")) {
        return true;
    }
    return Object.values(ROOM_WALLET_SETTLEMENT_SAFETY_CODES).some((code) => (
        text === code || text.includes(code)
    ));
}

function fillIfAbsent(target, key, value) {
    if (target[key] == null || target[key] === "") {
        if (value != null && value !== "") {
            target[key] = value;
        }
    }
}

function sealedFieldsAgree(session, request, sealed) {
    if (String(sealed.originalFailureReason ?? "") !== HISTORICAL_ROOM_WALLET_ADAPTER_INTERFACE_FAILURE) {
        return false;
    }
    if (String(session.reason ?? "") !== String(sealed.originalFailureReason)) {
        return false;
    }
    return valuesAgree(request.gameId ?? session.gameId, sealed.gameId)
        && valuesAgree(request.roomId ?? session.roomId, sealed.roomId)
        && valuesAgree(request.winnerWallet ?? session.winnerWallet, sealed.winnerWallet)
        && valuesAgree(request.ownerWallet ?? session.ownerWallet, sealed.ownerWallet)
        && numbersAgree(request.winnerAmount ?? session.prizeAmount, sealed.winnerAmount)
        && numbersAgree(request.organizerAmount ?? session.organizerAmount, sealed.organizerAmount);
}

function valuesAgree(left, right) {
    if (left == null || left === "" || right == null || right === "") {
        return true;
    }
    return String(left) === String(right);
}

function numbersAgree(left, right) {
    if (left == null || left === "" || right == null || right === "") {
        return true;
    }
    return Number(left) === Number(right);
}

function isCompleteSettlementRequest(request) {
    return Boolean(
        request.gameId
        && request.roomId
        && request.roomNumber != null
        && request.winnerId
        && request.winnerWallet
        && request.ownerWallet
        && request.winnerAmount != null
        && request.organizerAmount != null
    );
}
