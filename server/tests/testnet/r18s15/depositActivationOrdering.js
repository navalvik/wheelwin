/**
 * R18-S15 — TEST-ONLY Deposit activation ordering helpers.
 * Do not change production verifyActivation / assertInitialMutableState.
 */

export const DEPOSIT_ACTIVATION_WAITING = "DEPOSIT_ACTIVATION_WAITING";
export const DEPOSIT_ACTIVATION_VERIFIED = "DEPOSIT_ACTIVATION_VERIFIED";
export const DEPOSIT_ACTIVATION_REJECTED = "DEPOSIT_ACTIVATION_REJECTED";
export const DEPOSIT_FULL_ONCHAIN = "DEPOSIT_FULL_ONCHAIN";
export const DEPLOY_AUTHORIZATION_VALID = "DEPLOY_AUTHORIZATION_VALID";

export function matchesDepositActivationIdentity(payload, expected) {

    if (!payload || !expected) {

        return false;

    }

    return payload.depositId === expected.depositId
        && payload.roomId === expected.roomId
        && payload.gameId === expected.gameId;

}

export function assertFundSeatAllowedAfterVerified({
    expected,
    verifiedPayload,
    fundSeatStarted = false
} = {}) {

    if (fundSeatStarted) {

        throw new Error("FundSeat already started before activation verification");

    }

    if (!matchesDepositActivationIdentity(verifiedPayload, expected)) {

        throw new Error(
            "FundSeat is forbidden until DEPOSIT_ACTIVATION_VERIFIED"
            + " matches this roomId/gameId/depositId"
        );

    }

    return true;

}

export function logContainsEventBusType(logText, eventType) {

    if (typeof logText !== "string" || !eventType) {

        return false;

    }

    const escaped = String(eventType).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    return new RegExp(`(?:^|[\\s])${escaped}(?:\\s|$)`, "m").test(logText);

}

export function createProductionLogScanner() {

    let text = "";

    return {
        push(chunk) {

            text += String(chunk ?? "");

        },
        snapshot() {

            return text;

        },
        hasEventBusType(eventType) {

            return logContainsEventBusType(text, eventType);

        }
    };

}

export function readPersistedActivationRecord(sessionRecord) {

    const payload = sessionRecord?.payload ?? sessionRecord ?? {};
    const verification = payload.metadata?.activationVerification
        ?? sessionRecord?.metadata?.activationVerification
        ?? null;

    return {
        depositId: payload.depositId ?? sessionRecord?.depositId ?? sessionRecord?.recordId ?? null,
        roomId: payload.roomId ?? sessionRecord?.roomId ?? null,
        gameId: payload.gameId ?? sessionRecord?.gameId ?? null,
        status: verification?.status ?? null,
        verification
    };

}

export function isPersistedActivationVerified(sessionRecord, expected) {

    const record = readPersistedActivationRecord(sessionRecord);

    if (!matchesDepositActivationIdentity(record, expected)) {

        return false;

    }

    return record.status === "VERIFIED"
        || record.status === "ALREADY_VERIFIED";

}
