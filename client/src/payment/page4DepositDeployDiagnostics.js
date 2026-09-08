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

function safeValidUntilRemainingSeconds(validUntil, nowEpochSeconds) {

    const until = Number(validUntil);
    const now = Number(nowEpochSeconds);

    if (!Number.isFinite(until) || !Number.isFinite(now)) {

        return null;

    }

    return until - now;

}

/**
 * Observational keys of the object about to be passed to
 * tonConnectUI.sendTransaction(). Does not clone payloads, amounts, or
 * addresses onto the request. Does not mutate the request.
 */
export function describeTonConnectSendRequestDiagnostics(request, extras = {}) {

    const nowEpochSeconds = Number.isFinite(Number(extras.nowEpochSeconds))
        ? Number(extras.nowEpochSeconds)
        : Math.floor(Date.now() / 1000);

    if (request == null || typeof request !== "object") {

        return {
            sendTransactionCallCount: 1,
            requestIsObject: false,
            requestTopLevelKeys: [],
            hasTotalNanotons: false,
            messageCount: 0,
            messageTopLevelKeys: [],
            messageDestination: null,
            messageAmount: null,
            hasPayload: false,
            hasStateInit: false,
            validUntil: null,
            nowEpochSeconds,
            validUntilRemainingSeconds: null,
            network: extras.network ?? null,
            walletChain: extras.walletChain ?? null
        };

    }

    const requestTopLevelKeys = Object.keys(request);
    const messageKeySet = new Set();
    const firstMessage = Array.isArray(request.messages)
        ? request.messages[0]
        : null;

    if (Array.isArray(request.messages)) {

        for (const message of request.messages) {

            if (message != null && typeof message === "object") {

                for (const key of Object.keys(message)) {

                    messageKeySet.add(key);

                }

            }

        }

    }

    const validUntil = Object.prototype.hasOwnProperty.call(request, "validUntil")
        ? request.validUntil
        : null;

    const hasPayload = firstMessage != null
        && typeof firstMessage === "object"
        && Object.prototype.hasOwnProperty.call(firstMessage, "payload")
        && firstMessage.payload != null
        && firstMessage.payload !== "";

    const hasStateInit = firstMessage != null
        && typeof firstMessage === "object"
        && Object.prototype.hasOwnProperty.call(firstMessage, "stateInit")
        && firstMessage.stateInit != null
        && firstMessage.stateInit !== "";

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
        messageTopLevelKeys: Array.from(messageKeySet),
        messageDestination: firstMessage != null && typeof firstMessage === "object"
            ? (firstMessage.address ?? null)
            : null,
        messageAmount: firstMessage != null && typeof firstMessage === "object"
            ? (firstMessage.amount ?? null)
            : null,
        hasPayload,
        hasStateInit,
        validUntil,
        nowEpochSeconds,
        validUntilRemainingSeconds: safeValidUntilRemainingSeconds(
            validUntil,
            nowEpochSeconds
        ),
        network: extras.network ?? null,
        walletChain: extras.walletChain ?? null
    };

}

/**
 * Forensic context for a Page4 sendTransaction attempt. Never includes
 * mnemonics, private keys, tokens, or walletStateInit.
 */
export function describePage4SendTransactionForensicContext({
    roomId = null,
    gameId = null,
    localPlayerId = null,
    playerIndex = null,
    playerWalletAddress = null,
    paymentDestination = null,
    requiredGram = null,
    requestDiagnostics = null,
    tonConnectUI = null,
    tonWallet = null,
    reusedExistingSdkConnection = null,
    autopsySessionId = null,
    attemptId = null,
    nowEpochSeconds = null
} = {}) {

    const wallet = tonWallet ?? tonConnectUI?.wallet ?? null;
    const resolvedNow = Number.isFinite(Number(nowEpochSeconds))
        ? Number(nowEpochSeconds)
        : (requestDiagnostics?.nowEpochSeconds ?? Math.floor(Date.now() / 1000));

    return {
        event: "PAGE4_SEND_TRANSACTION_REJECTION",
        roomId: roomId ?? null,
        gameId: gameId ?? null,
        localPlayerId: localPlayerId ?? null,
        playerIndex: playerIndex ?? null,
        playerWalletAddress: playerWalletAddress ?? null,
        paymentDestination: paymentDestination ?? null,
        requiredGram: requiredGram ?? null,
        transactionAmount: requestDiagnostics?.messageAmount ?? null,
        transactionValidUntil: requestDiagnostics?.validUntil ?? null,
        nowEpochSeconds: resolvedNow,
        validUntilRemainingSeconds:
            requestDiagnostics?.validUntilRemainingSeconds
            ?? safeValidUntilRemainingSeconds(
                requestDiagnostics?.validUntil,
                resolvedNow
            ),
        tonConnectUiConnected: tonConnectUI?.connected ?? null,
        tonConnectConnectorConnected: tonConnectUI?.connector?.connected ?? null,
        activeWalletAddress: wallet?.account?.address
            ?? tonConnectUI?.account?.address
            ?? playerWalletAddress
            ?? null,
        walletAccountChain: wallet?.account?.chain
            ?? requestDiagnostics?.walletChain
            ?? null,
        walletProvider: wallet?.provider ?? null,
        walletAppName: wallet?.device?.appName ?? wallet?.name ?? null,
        walletAppVersion: wallet?.device?.appVersion ?? null,
        walletDevicePlatform: wallet?.device?.platform ?? null,
        network: requestDiagnostics?.network ?? null,
        reusedExistingSdkConnection: reusedExistingSdkConnection === true,
        autopsySessionId: autopsySessionId ?? null,
        attemptId: attemptId ?? null,
        requestTopLevelKeys: requestDiagnostics?.requestTopLevelKeys ?? [],
        messageCount: requestDiagnostics?.messageCount ?? 0,
        messageTopLevelKeys: requestDiagnostics?.messageTopLevelKeys ?? [],
        hasPayload: requestDiagnostics?.hasPayload === true,
        hasStateInit: requestDiagnostics?.hasStateInit === true
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
