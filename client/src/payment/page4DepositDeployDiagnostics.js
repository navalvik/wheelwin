/**
 * R18-S16 — Logging-only Page4 Deposit deploy diagnostics.
 * Observes gate / build / send / wallet-result fields. Does not invent
 * deployValueNanotons, hashes, or broadcast success.
 */

const FIELD_ORDER = [
    "action",
    "canDeploy",
    "canFund",
    "deployValueNanotons",
    "packageDeployValueNanotons",
    "amount",
    "depositAddress",
    "hasStateInit",
    "validUntil",
    "outcome",
    "hasBoc",
    "bocLength",
    "resultType",
    "errorName",
    "errorCode",
    "errorMessage",
    "requestTopLevelKeys",
    "hasTotalNanotons",
    "messageTopLevelKeys",
    "validationError"
];

export function formatPage4DepositDeployLog(event, fields = {}) {

    const parts = [`[R18-S16 Page4DepositDeploy] event=${event}`];

    for (const key of FIELD_ORDER) {

        const value = fields[key];

        if (value === undefined || value === null || value === "") {

            continue;

        }

        parts.push(`${key}=${value}`);

    }

    return parts.join(" | ");

}

export function logPage4DepositDeploy(event, fields = {}) {

    console.info(formatPage4DepositDeployLog(event, fields));

}

export function classifyDepositWalletError(error) {

    const name = String(error?.name ?? "");
    const message = String(error?.message ?? "");
    const code = error?.code ?? error?.errorCode ?? null;

    if (
        code === 300
        || /reject/i.test(name)
        || /reject/i.test(message)
    ) {

        return "WALLET_REJECTION";

    }

    return "TONCONNECT_SEND_FAILURE";

}

/**
 * Observational keys of the object about to be passed to
 * tonConnectUI.sendTransaction(). Does not clone payloads, amounts, or
 * addresses. Does not mutate the request.
 */
export function describeTonConnectSendRequestDiagnostics(request) {

    if (request == null || typeof request !== "object") {

        return {
            sendTransactionCallCount: 1,
            requestIsObject: false,
            requestTopLevelKeys: [],
            hasTotalNanotons: false,
            messageCount: 0,
            messageTopLevelKeys: []
        };

    }

    const requestTopLevelKeys = Object.keys(request);
    const messageKeySet = new Set();

    if (Array.isArray(request.messages)) {

        for (const message of request.messages) {

            if (message != null && typeof message === "object") {

                for (const key of Object.keys(message)) {

                    messageKeySet.add(key);

                }

            }

        }

    }

    return {
        sendTransactionCallCount: 1,
        requestIsObject: true,
        requestTopLevelKeys,
        hasTotalNanotons: Object.prototype.hasOwnProperty.call(
            request,
            "totalNanotons"
        ),
        messageCount: Array.isArray(request.messages)
            ? request.messages.length
            : 0,
        messageTopLevelKeys: Array.from(messageKeySet)
    };

}

export function describeTonConnectResult(result) {

    if (result == null) {

        return {
            resultType: "null",
            hasBoc: false
        };

    }

    if (typeof result !== "object") {

        return {
            resultType: typeof result,
            hasBoc: false
        };

    }

    const boc = result.boc;

    return {
        resultType: "object",
        hasBoc: typeof boc === "string" && boc.length > 0,
        bocLength: typeof boc === "string" ? boc.length : undefined
    };

}
