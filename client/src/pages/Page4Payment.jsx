import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTonConnectUI, useTonWallet } from "@tonconnect/ui-react";

import GameLayout from "../layouts/GameLayout";

import PlayerPaymentRow from "../components/PlayerPaymentRow";

import { useAuthoritativeSession } from "../context/AuthoritativeSessionContext";
import { useLanguage } from "../context/LanguageContext";
import { usePlayerIdentity } from "../context/PlayerIdentityContext";

import {
    canSubmitEntryPayment,
    getLocalPaymentRequest,
    isGameEscrowOnlyPlayerPayment,
    mapPaymentSessionRows,
    mapWalletConnectionRows,
    PAGE4_PAYMENT_PHASE,
    resolveEntryPaymentComponents,
    resolvePage4PaymentPhase,
    shouldShowEntryAction,
    shouldShowPaymentSessionRows,
    shouldShowWaitingCreatorDeposit,
    shouldShowWalletActions,
    WALLET_CONNECTION_STATUS
} from "../game/session";

import { resolveLocalPlayerId } from "../game/session";

import { buildEntryPaymentTransaction, nanotonsToTonDisplay, sumAuthoritativeEntryNanotons, toTonConnectSendTransactionRequest } from "../payment/buildEntryPaymentTransaction";
import { requiredGramToNanotonString } from "../payment/buildTonConnectPaymentTransaction";
import {
    classifyDepositWalletError,
    describeTonConnectResult,
    describeTonConnectSendRequestDiagnostics,
    logPage4DepositDeploy
} from "../payment/page4DepositDeployDiagnostics";

import {
    beginTonConnectAutopsySession,
    classifyTonConnectErrorOrigin,
    configureAutopsySnapshotTransport,
    ensureTonConnectAutopsy,
    ERROR_PROPERTY_CANDIDATES as TONCONNECT_ERROR_PROPERTY_CANDIDATES,
    getAutopsyBeaconPath,
    isTonConnectFailureStep,
    pushAutopsyBrowserError,
    pushAutopsyRawObject,
    pushAutopsySdkError,
    pushAutopsyTimeline,
    pushAutopsyWalletEvent,
    safeJsonStringifyForAutopsy,
    syncAutopsyFromReport
} from "../diagnostics/tonConnectAutopsy";

import { toSessionWalletAddress } from "../utils/tonWalletAddress";

import socket from "../socket/socket";

import { LOBBY_OUTGOING_EVENTS } from "../socket/socketEvents";

import { resolveBackendUrl } from "../config/backendUrl.js";
import { launchGramWalletHandoff } from "../tonconnect/telegramMiniAppGramWalletHandoff.js";

import "../styles/page4payment.css";

/**
 * R7.26 — TonConnect SDK is the source of truth for connector state.
 * Resolve the active account address from React hook and/or UI instance.
 */
function resolveTonConnectSdkAddress(tonConnectUI, tonWallet) {

    return tonWallet?.account?.address
        ?? tonConnectUI?.wallet?.account?.address
        ?? tonConnectUI?.account?.address
        ?? null;

}

/**
 * R7.26 — true when any SDK surface indicates an active session.
 */
function isTonConnectSdkConnected(tonConnectUI, tonWallet) {

    return tonConnectUI?.connected === true
        || tonConnectUI?.connector?.connected === true
        || Boolean(resolveTonConnectSdkAddress(tonConnectUI, tonWallet));

}

/**
 * R7.26 — a new connector.connect() / openModal() is allowed only when
 * every SDK indicator says NOT CONNECTED.
 */
function mayInitiateTonConnectConnect(tonConnectUI, tonWallet) {

    return tonConnectUI?.connected !== true
        && tonConnectUI?.connector?.connected !== true
        && !resolveTonConnectSdkAddress(tonConnectUI, tonWallet);

}

/**
 * R6.11B — dump ENTIRE original TonConnect / wallet / callback error object.
 * No replacement, no truncation, no mapping of wallet payloads.
 */
function dumpRawTonConnectAutopsyObject(label, error, context = {}) {

    const prefix = "[TonConnect AUTOPSY]";

    const origin = classifyTonConnectErrorOrigin(error, label);

    console.log(`${prefix} RAW ERROR DUMP | ${label}`);

    console.log(`${prefix} context`, context);

    console.log(`${prefix} Origin:`, origin);

    console.log(`${prefix} console.log(error):`);

    console.log(error);

    console.log(`${prefix} console.dir(error, { depth: null }):`);

    try {

        console.dir(error, { depth: null });

    } catch (dirError) {

        console.log(`${prefix} console.dir failed:`, dirError);

    }

    if (error != null && (typeof error === "object" || typeof error === "function")) {

        let ownNames = [];

        try {

            ownNames = Object.getOwnPropertyNames(error);

        } catch (namesError) {

            console.log(`${prefix} Object.getOwnPropertyNames failed:`, namesError);

        }

        console.log(
            `${prefix} JSON.stringify(error, Object.getOwnPropertyNames(error), 2):`
        );

        try {

            console.log(JSON.stringify(error, ownNames, 2));

        } catch (jsonError) {

            console.log(
                `${prefix} JSON.stringify(getOwnPropertyNames) failed:`,
                jsonError
            );

            console.log(
                `${prefix} safeJsonStringifyForAutopsy fallback:`,
                safeJsonStringifyForAutopsy(error)
            );

        }

        console.log(`${prefix} Object.keys(error):`, Object.keys(error));

        try {

            console.log(
                `${prefix} Reflect.ownKeys(error):`,
                Reflect.ownKeys(error)
            );

        } catch (reflectError) {

            console.log(`${prefix} Reflect.ownKeys failed:`, reflectError);

        }

        console.log(
            `${prefix} Object.getOwnPropertyNames(error):`,
            ownNames
        );

        try {

            console.log(
                `${prefix} Object.getPrototypeOf(error):`,
                Object.getPrototypeOf(error)
            );

        } catch (protoError) {

            console.log(`${prefix} Object.getPrototypeOf failed:`, protoError);

        }

        console.log(
            `${prefix} constructor.name:`,
            error?.constructor?.name ?? null
        );

        console.log(`${prefix} every available property (candidates + own):`);

        const propertyNames = new Set([
            ...TONCONNECT_ERROR_PROPERTY_CANDIDATES,
            ...ownNames
        ]);

        for (const propertyName of propertyNames) {

            let present = false;

            let value;

            try {

                present = propertyName in error
                    || Object.prototype.hasOwnProperty.call(error, propertyName);

                value = error[propertyName];

            } catch (accessError) {

                console.log(
                    `${prefix} property access failed | ${propertyName}`,
                    accessError
                );

                continue;

            }

            console.log(
                `${prefix} property.${propertyName}`,
                {
                    present,
                    value,
                    valueType: value === null
                        ? "null"
                        : Array.isArray(value)
                            ? "array"
                            : typeof value
                }
            );

            if (
                value != null
                && typeof value === "object"
                && (
                    propertyName === "payload"
                    || propertyName === "response"
                    || propertyName === "data"
                    || propertyName === "details"
                    || propertyName === "cause"
                    || propertyName === "info"
                    || propertyName === "originalError"
                )
            ) {

                console.log(
                    `${prefix} nested object (exact) | ${propertyName}:`
                );

                console.log(value);

                try {

                    console.dir(value, { depth: null });

                } catch {

                    // diagnostics only
                }

                console.log(
                    `${prefix} nested JSON | ${propertyName}:`,
                    safeJsonStringifyForAutopsy(value)
                );

            }

        }

        if (typeof error.stack === "string") {

            console.log(`${prefix} FULL stack (no truncation):`);

            console.log(error.stack);

        } else {

            console.log(`${prefix} stack:`, error.stack ?? null);

        }

    } else {

        console.log(`${prefix} non-object error primitive:`, error);

        console.log(
            `${prefix} String(error):`,
            error == null ? String(error) : String(error)
        );

    }

    return {
        label,
        origin,
        error,
        message: error?.message ?? String(error),
        name: error?.name ?? null,
        code: error?.code ?? error?.errorCode ?? null,
        stack: error?.stack ?? null
    };

}

/** R6.11A/B/C — dump complete SDK / wallet rejection errors + autopsy store. */
function dumpTonConnectError(label, error, context = {}) {

    console.log(`[TonConnect TRACE] ERROR | ${label}`, {
        message: error?.message ?? String(error),
        name: error?.name ?? null,
        code: error?.code ?? error?.errorCode ?? null,
        cause: error?.cause ?? null,
        stack: error?.stack ?? null,
        raw: error
    });

    const dumped = dumpRawTonConnectAutopsyObject(label, error, context);

    // R6.11C — persist forensic error into window.__TONCONNECT_AUTOPSY__
    try {

        pushAutopsySdkError(error, {
            label,
            origin: dumped.origin,
            ...context
        });

    } catch {

        // diagnostics only
    }

    return dumped;

}

/** R6.11B — print final autopsy report for one handshake attempt. */
function printTonConnectAutopsyReport(report) {

    const prefix = "[TonConnect AUTOPSY]";

    console.log("=========================");

    console.log("TonConnect Error Autopsy");

    console.log("=========================");

    console.log(`${prefix} Last Successful Step:`);

    console.log(report.lastSuccessfulStep ?? null);

    console.log(`${prefix} Failure Step:`);

    console.log(report.failureStep ?? null);

    console.log(`${prefix} Origin:`);

    console.log(report.origin ?? "Origin could not be determined.");

    console.log(`${prefix} SDK Error:`);

    console.log(report.sdkError ?? null);

    if (report.sdkError != null) {

        try {

            console.dir(report.sdkError, { depth: null });

        } catch {

            // diagnostics only
        }

    }

    console.log(`${prefix} SDK Internal Response (before throw, if any):`);

    console.log(report.sdkInternalResponse ?? null);

    if (report.sdkInternalResponse != null) {

        try {

            console.dir(report.sdkInternalResponse, { depth: null });

        } catch {

            // diagnostics only
        }

    }

    console.log(`${prefix} Wallet Error:`);

    console.log(report.walletError ?? null);

    if (report.walletError != null) {

        try {

            console.dir(report.walletError, { depth: null });

        } catch {

            // diagnostics only
        }

        console.log(
            `${prefix} Wallet Error JSON (exact as received):`,
            safeJsonStringifyForAutopsy(report.walletError)
        );

    }

    console.log(`${prefix} Callback Exception:`);

    console.log(report.callbackException ?? null);

    if (report.callbackException != null) {

        try {

            console.dir(report.callbackException, { depth: null });

        } catch {

            // diagnostics only
        }

    }

    console.log(`${prefix} Unhandled Promise:`);

    console.log(report.unhandledPromise ?? null);

    if (report.unhandledPromise != null) {

        try {

            console.dir(report.unhandledPromise, { depth: null });

        } catch {

            // diagnostics only
        }

    }

    console.log(`${prefix} Browser Error:`);

    console.log(report.browserError ?? null);

    if (report.browserError != null) {

        try {

            console.dir(report.browserError, { depth: null });

        } catch {

            // diagnostics only
        }

    }

    console.log(`${prefix} Raw Object:`);

    console.log(report.rawObject ?? null);

    if (report.rawObject != null) {

        try {

            console.dir(report.rawObject, { depth: null });

        } catch {

            // diagnostics only
        }

        console.log(
            `${prefix} Raw Object JSON:`,
            safeJsonStringifyForAutopsy(report.rawObject)
        );

    }

    console.log(`${prefix} Stack Trace:`);

    console.log(report.stackTrace ?? null);

    console.log(`${prefix} Most Probable Failure Point:`);

    console.log(report.mostProbableFailurePoint ?? null);

    console.log(`${prefix} attempt chronology:`, report.chronology ?? []);

    console.log(`${prefix} FULL REPORT OBJECT:`);

    console.log(report);

    try {

        console.dir(report, { depth: null });

    } catch {

        // diagnostics only
    }

    console.log("=========================");

}

function resolveLastSuccessfulHandshakeStep(steps) {

    if (!Array.isArray(steps) || steps.length === 0) {

        return null;

    }

    for (let index = steps.length - 1; index >= 0; index -= 1) {

        const step = steps[index]?.step;

        if (step && !isTonConnectFailureStep(step)) {

            return step;

        }

    }

    return null;

}

function resolveMostProbableFailurePoint(report) {

    if (report.callbackException != null) {

        return "Custom callback threw (CALLBACK_EXCEPTION) — distinct from SDK error";

    }

    if (report.failureStep === "ON_STATUS_CHANGE_ERROR") {

        return "TonConnect onStatusChange error callback (wallet/SDK rejection before CONNECTED)";

    }

    if (report.failureStep === "MODAL_CLOSED_WITHOUT_WALLET") {

        return "TonConnect UI modal closed without a connected wallet";

    }

    if (
        report.failureStep === "CONNECTOR_CONNECT_SYNC_THROW"
        || report.failureStep === "CONNECTOR_CONNECT_PROMISE_REJECT"
    ) {

        return "connector.connect() threw or rejected before CONNECTED";

    }

    if (report.unhandledPromise != null) {

        return "Unhandled promise rejection during handshake attempt";

    }

    if (report.browserError != null) {

        return "Browser window.onerror during handshake attempt";

    }

    if (report.walletError != null) {

        return "Wallet error payload received during handshake";

    }

    if (report.sdkError != null) {

        return "TonConnect SDK / UI error before CONNECTED";

    }

    return report.failureStep
        ?? report.origin
        ?? "Origin could not be determined.";

}

/** R6.11A — structured wallet field dump for onStatusChange / state traces. */
function summarizeTonWalletFields(wallet) {

    if (!wallet) {

        return { wallet: null };

    }

    return {
        provider: wallet.provider ?? null,
        name: wallet.name ?? null,
        accountAddress: wallet.account?.address ?? null,
        accountChain: wallet.account?.chain ?? null,
        publicKey: wallet.account?.publicKey ?? null,
        walletStateInit: wallet.account?.walletStateInit ?? null,
        devicePlatform: wallet.device?.platform ?? null,
        deviceAppName: wallet.device?.appName ?? null,
        deviceAppVersion: wallet.device?.appVersion ?? null,
        deviceMaxProtocolVersion: wallet.device?.maxProtocolVersion ?? null,
        connectItems: wallet.connectItems ?? null,
        wallet
    };

}

/** R6.11A — summarize connector.connect() wallet source / info args. */
function summarizeConnectWalletSource(source) {

    if (source == null) {

        return { rawType: "nullish", source: null };

    }

    if (Array.isArray(source)) {

        return {
            rawType: "array",
            length: source.length,
            items: source.map((item) => summarizeConnectWalletSource(item))
        };

    }

    if (typeof source !== "object") {

        return { rawType: typeof source, source };

    }

    return {
        rawType: "object",
        name: source.name ?? null,
        appName: source.appName ?? null,
        bridgeUrl: source.bridgeUrl ?? null,
        universalLink: source.universalLink ?? null,
        jsBridgeKey: source.jsBridgeKey ?? null,
        embedded: source.embedded ?? null,
        aboutUrl: source.aboutUrl ?? null,
        imageUrl: source.imageUrl ?? null,
        tondns: source.tondns ?? null,
        platforms: source.platforms ?? null,
        openMethod: source.openMethod ?? null
    };

}

function tryExtractBridgeUrlFromLink(link) {

    if (typeof link !== "string" || !link) {

        return null;

    }

    try {

        const url = new URL(link);

        return url.searchParams.get("bridge")
            ?? url.searchParams.get("bridge_url")
            ?? url.searchParams.get("bridgeUrl")
            ?? null;

    } catch {

        return null;

    }

}

export default function Page4Payment({ onNavigate }) {

    // P6.2 — wallet connection; P6.3 — authoritative Payment Session after READY.
    // P6.7 — Page4 stays open until server OPEN_PAGE5 (never local navigation).
    // R18-S16 — DepositContract phase before GameEscrow STAKE.
    const authoritative = useAuthoritativeSession();

    const { t } = useLanguage();

    const { identity } = usePlayerIdentity();

    const [tonConnectUI] = useTonConnectUI();

    const tonWallet = useTonWallet();

    const depositProjection = authoritative?.deposit ?? null;

    const [depositSubmitting, setDepositSubmitting] = useState(false);
    const [depositSubmitError, setDepositSubmitError] = useState("");

    // R18-S16 — ONE TonConnect sendTransaction for full game entry.
    // Creator: deploy + FundSeat + STAKE. Players 2/3: FundSeat + STAKE.
    // Creator role comes from the deposit projection, never seatIndex === 0.
    const handleConfirmInTelegramWallet = useCallback(async () => {

        if (depositSubmitting) {

            return;

        }

        if (!tonConnectUI?.sendTransaction) {

            setDepositSubmitError(t("payment.telegramNotConnected"));

            return;

        }

        if (!tonWallet?.account?.address && !tonConnectUI?.account?.address) {

            setDepositSubmitError(t("payment.telegramNotConnected"));

            return;

        }

        const lifecycle = authoritative?.lifecycle ?? null;
        const paymentSession = authoritative?.paymentSession ?? null;
        const gameContract = authoritative?.gameContract ?? null;
        const gameEscrowOnly = isGameEscrowOnlyPlayerPayment(gameContract, {
            deposit: depositProjection,
            paymentSession
        });

        if (!gameEscrowOnly) {

            if (!depositProjection) {

                setDepositSubmitError(t("payment.serverStateMismatch"));

                return;

            }

            if (depositProjection.isCreator !== true && depositProjection.isCreator !== false) {

                setDepositSubmitError(t("payment.serverStateMismatch"));

                return;

            }

        }

        const localPlayerId = resolveLocalPlayerId(
            identity.playerId ?? null,
            authoritative.players,
            {
                verifyCompleted: Boolean(lifecycle?.verifyCompleted)
            }
        );
        const paymentRequest = getLocalPaymentRequest(paymentSession, localPlayerId);
        const components = resolveEntryPaymentComponents({
            deposit: depositProjection,
            paymentSession,
            gameContract,
            localPlayerId,
            lifecycle
        });

        logPage4DepositDeploy("GATE", {
            canDeploy: components.includeDeploy,
            canFund: components.includeFund,
            canStake: components.includeStake,
            action: "entry",
            deployValueNanotons: depositProjection?.package?.deployValueNanotons,
            depositAddress: depositProjection?.depositAddress,
            gameEscrowAddress: paymentRequest?.contractAddress
                ?? gameContract?.contractAddress
                ?? null,
            playerIndex: paymentRequest?.playerIndex ?? paymentRequest?.seatIndex ?? null
        });

        if (!canSubmitEntryPayment({
            deposit: depositProjection,
            paymentSession,
            gameContract,
            localPlayerId,
            lifecycle
        })) {

            setDepositSubmitError(t("payment.stakeUnavailable"));
            return;

        }

        setDepositSubmitting(true);
        setDepositSubmitError("");

        let sendAttempted = false;
        let tonConnectRuntimeDiagnostics = null;

        try {

            const playerIndex = paymentRequest?.playerIndex
                ?? paymentRequest?.seatIndex
                ?? null;

            const transactionObject = buildEntryPaymentTransaction({
                gameEscrowOnly,
                isCreator: gameEscrowOnly ? false : depositProjection.isCreator === true,
                includeDeploy: gameEscrowOnly ? false : components.includeDeploy,
                includeFund: gameEscrowOnly ? false : components.includeFund,
                includeStake: components.includeStake,
                depositPackage: !gameEscrowOnly && components.includeDeploy
                    ? {
                        stateInit: {
                            codeBoc: depositProjection.package.stateInit.codeBoc,
                            dataBoc: depositProjection.package.stateInit.dataBoc
                        },
                        deployValueNanotons: depositProjection.package.deployValueNanotons,
                        depositAddress: depositProjection.depositAddress
                    }
                    : null,
                depositAddress: gameEscrowOnly ? null : depositProjection.depositAddress,
                mySeatIndex: gameEscrowOnly ? null : depositProjection.mySeatIndex,
                myExpectedAmountNanotons: gameEscrowOnly
                    ? null
                    : depositProjection.myExpectedAmountNanotons,
                network: gameEscrowOnly ? null : depositProjection.network,
                gameEscrowAddress: paymentRequest?.contractAddress
                    ?? gameContract?.contractAddress
                    ?? null,
                requiredGram: paymentRequest?.requiredGram ?? null,
                playerIndex
            });

            const { totalNanotons } = transactionObject;
            const tonConnectTransaction = toTonConnectSendTransactionRequest(
                transactionObject
            );

            tonConnectRuntimeDiagnostics = describeTonConnectSendRequestDiagnostics(
                tonConnectTransaction
            );

            logPage4DepositDeploy("BUILD", {
                action: "entry",
                amount: totalNanotons,
                messageCount: transactionObject.messages.length,
                packageDeployValueNanotons: components.includeDeploy
                    ? depositProjection?.package?.deployValueNanotons
                    : undefined,
                depositAddress: depositProjection?.depositAddress,
                hasStateInit: Boolean(transactionObject.messages[0]?.stateInit)
            });

            logPage4DepositDeploy("SEND", {
                action: "entry",
                amount: totalNanotons,
                validUntil: tonConnectTransaction.validUntil,
                messageCount: tonConnectTransaction.messages.length,
                requestTopLevelKeys:
                    tonConnectRuntimeDiagnostics.requestTopLevelKeys.join(","),
                hasTotalNanotons:
                    tonConnectRuntimeDiagnostics.hasTotalNanotons,
                messageTopLevelKeys:
                    tonConnectRuntimeDiagnostics.messageTopLevelKeys.join(",")
            });

            try {

                ensureTonConnectAutopsy({
                    roomId: authoritative?.roomId ?? null,
                    playerId: localPlayerId
                });
                pushAutopsyTimeline({
                    event: "PAGE4_SEND_TRANSACTION_REQUEST",
                    payloadSummary: {
                        requestTopLevelKeys:
                            tonConnectRuntimeDiagnostics.requestTopLevelKeys,
                        hasTotalNanotons:
                            tonConnectRuntimeDiagnostics.hasTotalNanotons,
                        messageCount: tonConnectRuntimeDiagnostics.messageCount,
                        messageTopLevelKeys:
                            tonConnectRuntimeDiagnostics.messageTopLevelKeys,
                        sendTransactionCallCount:
                            tonConnectRuntimeDiagnostics.sendTransactionCallCount
                    }
                });

            } catch {

                // diagnostics only
            }

            sendAttempted = true;

            const walletResult = await tonConnectUI.sendTransaction(tonConnectTransaction);
            const described = describeTonConnectResult(walletResult);

            logPage4DepositDeploy("WALLET_RESULT", {
                action: "entry",
                outcome: "USER_CONFIRMED",
                amount: totalNanotons,
                messageCount: transactionObject.messages.length,
                ...described
            });

            socket.emit(LOBBY_OUTGOING_EVENTS.PAYMENT_CONFIRM_INTENT);

        } catch (error) {

            const validationError = String(error?.message ?? "").slice(0, 240);

            logPage4DepositDeploy("WALLET_RESULT", {
                action: "entry",
                outcome: sendAttempted
                    ? classifyDepositWalletError(error)
                    : "TRANSACTION_BUILD_FAILURE",
                errorName: error?.name,
                errorCode: error?.code ?? error?.errorCode,
                errorMessage: error?.message,
                requestTopLevelKeys:
                    tonConnectRuntimeDiagnostics?.requestTopLevelKeys?.join(",")
                    ?? "",
                hasTotalNanotons:
                    tonConnectRuntimeDiagnostics?.hasTotalNanotons,
                validationError
            });

            try {

                pushAutopsyTimeline({
                    event: "PAGE4_SEND_TRANSACTION_VALIDATION",
                    payloadSummary: {
                        requestTopLevelKeys:
                            tonConnectRuntimeDiagnostics?.requestTopLevelKeys
                            ?? [],
                        hasTotalNanotons:
                            tonConnectRuntimeDiagnostics?.hasTotalNanotons
                            ?? false,
                        validationError
                    }
                });

            } catch {

                // diagnostics only
            }

            console.error("[Page4Payment] Entry wallet submit failed:", error);

            setDepositSubmitError(
                error?.message || t("payment.entryFailed")
            );

        } finally {

            setDepositSubmitting(false);

        }

    }, [
        authoritative,
        depositProjection,
        depositSubmitting,
        identity.playerId,
        t,
        tonConnectUI,
        tonWallet
    ]);

    const [localError, setLocalError] = useState("");

    const [connecting, setConnecting] = useState(false);

    // R6.11A — Desktop Connection convenience (presentation only)
    const [tonConnectModalOpen, setTonConnectModalOpen] = useState(false);

    const [tonConnectUniversalLink, setTonConnectUniversalLink] = useState("");

    const [tonConnectLinkCopied, setTonConnectLinkCopied] = useState(false);

    // R6.11A — chronological handshake attempt trace (diagnostics only)
    const handshakeTraceRef = useRef([]);

    const handshakeAttemptIdRef = useRef(0);

    const prevTonWalletRef = useRef(undefined);

    const tonConnectUniversalLinkRef = useRef("");

    // R7.36 — one STARTED+REPORT pair per wallet proof until disconnect.
    const lastWalletProofEmitRef = useRef(null);

    // R6.11B — per-attempt autopsy findings + temporary global handlers
    const autopsyAttemptRef = useRef({
        active: false,
        attemptId: 0,
        reportPrinted: false,
        findings: {
            sdkError: null,
            walletError: null,
            callbackException: null,
            unhandledPromise: null,
            browserError: null,
            rawObject: null,
            stackTrace: null,
            origin: null,
            failureStep: null,
            sdkInternalResponse: null
        },
        restoreGlobalHandlers: null
    });

    const walletConnection = authoritative.walletConnection;

    const paymentSession = authoritative.paymentSession;

    const gameContract = authoritative.gameContract;

    const paymentConnectionReady = authoritative.lifecycle
        ?.paymentConnectionReady === true;

    const localPlayerId = resolveLocalPlayerId(
        identity.playerId ?? null,
        authoritative.players,
        {
            verifyCompleted: Boolean(authoritative.lifecycle?.verifyCompleted)
        }
    );

    const paymentPhase = resolvePage4PaymentPhase({
        deposit: depositProjection,
        paymentSession,
        gameContract,
        localPlayerId,
        paymentConnectionReady,
        lifecycle: authoritative.lifecycle
    });

    const walletPhase = shouldShowWalletActions(paymentPhase);
    const showPaymentRows = shouldShowPaymentSessionRows(paymentPhase);
    const showEntryAction = shouldShowEntryAction(paymentPhase);
    const inPostWalletPhase = paymentPhase !== PAGE4_PAYMENT_PHASE.WALLET;

    const entryComponents = resolveEntryPaymentComponents({
        deposit: depositProjection,
        paymentSession,
        gameContract,
        localPlayerId,
        lifecycle: authoritative.lifecycle
    });

    const entryActionEnabled = canSubmitEntryPayment({
        deposit: depositProjection,
        paymentSession,
        gameContract,
        localPlayerId,
        lifecycle: authoritative.lifecycle
    });

    let entryTotalLabel = null;

    if (showEntryAction && entryActionEnabled) {

        try {

            const stakeNanotons = entryComponents.includeStake
                ? requiredGramToNanotonString(
                    getLocalPaymentRequest(paymentSession, localPlayerId)?.requiredGram
                )
                : null;
            const totalNanotons = sumAuthoritativeEntryNanotons({
                deployValueNanotons: entryComponents.includeDeploy
                    ? depositProjection?.package?.deployValueNanotons
                    : null,
                fundSeatNanotons: entryComponents.includeFund
                    ? depositProjection?.myExpectedAmountNanotons
                    : null,
                stakeNanotons
            });
            entryTotalLabel = nanotonsToTonDisplay(totalNanotons);

        } catch {

            entryTotalLabel = null;

        }

    }

    const confirmedSeatCount = Number(depositProjection?.confirmedSeats);
    const gameEscrowOnly = isGameEscrowOnlyPlayerPayment(gameContract, {
        deposit: depositProjection,
        paymentSession
    });

    const depositStatusParts = [];

    if (
        !gameEscrowOnly
        && Number.isFinite(confirmedSeatCount)
        && inPostWalletPhase
        && !showPaymentRows
    ) {

        depositStatusParts.push(
            t("payment.depositSeatsProgress", { funded: confirmedSeatCount })
        );

    }

    if (paymentPhase === PAGE4_PAYMENT_PHASE.GAMEESCROW_STAKE) {

        depositStatusParts.push(t("payment.waitingGameEscrow"));

    } else if (shouldShowWaitingCreatorDeposit({
        paymentPhase,
        gameContract,
        deposit: depositProjection,
        paymentSession
    })) {

        depositStatusParts.push(t("payment.waitingCreatorDeposit"));

    } else if (paymentPhase === PAGE4_PAYMENT_PHASE.DEPOSIT_ACTIVATION) {

        depositStatusParts.push(t("payment.waitingGameEscrow"));

    } else if (
        paymentPhase === PAGE4_PAYMENT_PHASE.DEPOSIT_WAIT_FULL
        || paymentPhase === PAGE4_PAYMENT_PHASE.DEPOSIT_FULL
    ) {

        depositStatusParts.push(t("payment.waitingDepositFull"));

        if (depositProjection?.mySeatStatus === "FUNDED") {

            depositStatusParts.push(t("payment.mySeatFunded"));

        }

    } else if (paymentPhase === PAGE4_PAYMENT_PHASE.FUND_SEAT) {

        depositStatusParts.push(
            depositProjection?.mySeatStatus === "FUNDED"
                ? t("payment.mySeatFunded")
                : t("payment.mySeatPending")
        );

    }

    const depositStatusText = depositStatusParts.join(" · ");

    const walletPlayers = useMemo(
        () => mapWalletConnectionRows(
            walletConnection,
            authoritative.players
        ),
        [walletConnection, authoritative.players]
    );

    const paymentPlayers = useMemo(
        () => mapPaymentSessionRows(
            paymentSession,
            authoritative.players
        ),
        [paymentSession, authoritative.players]
    );

    const players = showPaymentRows ? paymentPlayers : walletPlayers;

    const localWalletSeat = useMemo(
        () => walletPlayers.find(
            (player) => String(player.playerId) === String(localPlayerId)
        ) ?? null,
        [walletPlayers, localPlayerId]
    );

    const localWalletStatus = localWalletSeat?.status
        ?? WALLET_CONNECTION_STATUS.WAITING;

    // R7.26 — gate Connect on server seat + SDK. ADDRESS_MISMATCH requires
    // Disconnect before a new connect() is allowed. SDK-connected + WAITING
    // still enables Connect (reuse path, no openModal).
    const canConnect = walletPhase
        && localWalletStatus !== WALLET_CONNECTION_STATUS.CONNECTED
        && localWalletStatus !== WALLET_CONNECTION_STATUS.CONNECTING
        && localWalletStatus !== WALLET_CONNECTION_STATUS.ADDRESS_MISMATCH
        && !connecting;

    const localPaymentRequest = useMemo(
        () => getLocalPaymentRequest(paymentSession, localPlayerId),
        [paymentSession, localPlayerId]
    );

    // R6.11E — wire forensic autopsy snapshots to server room diagnostics
    useEffect(() => {

        const backendUrl = resolveBackendUrl();
        const beaconPath = getAutopsyBeaconPath();

        configureAutopsySnapshotTransport({
            emit: (event, payload) => {

                if (payload === undefined) {

                    socket.emit(event);

                } else {

                    socket.emit(event, payload);

                }

            },
            getMeta: () => ({
                roomId: authoritative.roomId ?? null,
                playerId: localPlayerId
            }),
            beaconUrl: `${backendUrl}${beaconPath}`
        });

    }, [authoritative.roomId, localPlayerId]);

    const pushHandshakeTrace = useCallback((step, detail = {}) => {

        const entry = {
            at: Date.now(),
            attemptId: handshakeAttemptIdRef.current,
            step,
            playerId: localPlayerId,
            roomId: authoritative.roomId ?? null,
            ...detail
        };

        handshakeTraceRef.current.push(entry);

        console.log(`[TonConnect TRACE] ${step}`, entry);

        // R6.11C — feed unified autopsy timeline (keep TRACE console too)
        try {

            ensureTonConnectAutopsy({
                roomId: authoritative.roomId ?? null,
                playerId: localPlayerId
            });

            pushAutopsyTimeline({
                event: step,
                payloadSummary: detail
            });

        } catch {

            // diagnostics only
        }

        if (isTonConnectFailureStep(step)) {

            const autopsy = autopsyAttemptRef.current;

            if (autopsy.active && !autopsy.findings.failureStep) {

                autopsy.findings.failureStep = step;

            }

        }

        return entry;

    }, [authoritative.roomId, localPlayerId]);

    const recordAutopsyFinding = useCallback((partial) => {

        const autopsy = autopsyAttemptRef.current;

        if (!autopsy.active) {

            return;

        }

        autopsy.findings = {
            ...autopsy.findings,
            ...partial
        };

    }, []);

    const restoreAutopsyGlobalHandlers = useCallback(() => {

        const autopsy = autopsyAttemptRef.current;

        if (typeof autopsy.restoreGlobalHandlers === "function") {

            try {

                autopsy.restoreGlobalHandlers();

            } catch (restoreError) {

                console.log(
                    "[TonConnect AUTOPSY] restore global handlers failed",
                    restoreError
                );

            }

            autopsy.restoreGlobalHandlers = null;

        }

        autopsy.active = false;

    }, []);

    const installAutopsyGlobalHandlers = useCallback(() => {

        const autopsy = autopsyAttemptRef.current;

        if (typeof autopsy.restoreGlobalHandlers === "function") {

            try {

                autopsy.restoreGlobalHandlers();

            } catch {

                // diagnostics only
            }

            autopsy.restoreGlobalHandlers = null;

        }

        const previousUnhandledRejection = window.onunhandledrejection;

        const previousOnError = window.onerror;

        window.onunhandledrejection = function tonConnectAutopsyUnhandledRejection(
            event
        ) {

            const reason = event?.reason ?? event;

            console.log(
                "[TonConnect AUTOPSY] window.onunhandledrejection COMPLETE object:"
            );

            console.log(event);

            try {

                console.dir(event, { depth: null });

            } catch {

                // diagnostics only
            }

            dumpTonConnectError(
                "window.onunhandledrejection",
                reason,
                {
                    attemptId: handshakeAttemptIdRef.current,
                    event
                }
            );

            // R6.11C — persist into autopsy browserErrors[]
            try {

                pushAutopsyBrowserError({
                    kind: "unhandledrejection",
                    message: reason?.message ?? String(reason),
                    source: "window.onunhandledrejection",
                    stack: reason?.stack ?? null,
                    reason
                });

            } catch {

                // diagnostics only
            }

            recordAutopsyFinding({
                unhandledPromise: reason,
                rawObject: autopsy.findings.rawObject ?? reason,
                stackTrace: reason?.stack
                    ?? autopsy.findings.stackTrace
                    ?? null,
                origin: classifyTonConnectErrorOrigin(
                    reason,
                    "window.onunhandledrejection"
                ),
                failureStep: autopsy.findings.failureStep
                    ?? "UNHANDLED_REJECTION"
            });

            pushHandshakeTrace("UNHANDLED_REJECTION", {
                message: reason?.message ?? String(reason),
                name: reason?.name ?? null
            });

            if (typeof previousUnhandledRejection === "function") {

                return previousUnhandledRejection.call(window, event);

            }

            return undefined;

        };

        window.onerror = function tonConnectAutopsyOnError(
            message,
            source,
            lineno,
            colno,
            error
        ) {

            const browserError = {
                message,
                source,
                lineno,
                colno,
                error: error ?? null
            };

            console.log(
                "[TonConnect AUTOPSY] window.onerror COMPLETE object:"
            );

            console.log(browserError);

            try {

                console.dir(browserError, { depth: null });

            } catch {

                // diagnostics only
            }

            if (error != null) {

                dumpTonConnectError("window.onerror error arg", error, {
                    attemptId: handshakeAttemptIdRef.current,
                    browserError
                });

            }

            // R6.11C — persist into autopsy browserErrors[]
            try {

                pushAutopsyBrowserError({
                    kind: "onerror",
                    message: String(message),
                    source,
                    stack: error?.stack ?? null,
                    reason: error ?? browserError,
                    lineno,
                    colno
                });

            } catch {

                // diagnostics only
            }

            recordAutopsyFinding({
                browserError,
                rawObject: autopsy.findings.rawObject ?? error ?? browserError,
                stackTrace: error?.stack
                    ?? autopsy.findings.stackTrace
                    ?? null,
                origin: classifyTonConnectErrorOrigin(
                    error ?? browserError,
                    "window.onerror browser"
                ),
                failureStep: autopsy.findings.failureStep ?? "WINDOW_ONERROR"
            });

            pushHandshakeTrace("WINDOW_ONERROR", {
                message: String(message),
                source,
                lineno,
                colno
            });

            if (typeof previousOnError === "function") {

                return previousOnError.call(
                    window,
                    message,
                    source,
                    lineno,
                    colno,
                    error
                );

            }

            return false;

        };

        autopsy.restoreGlobalHandlers = () => {

            window.onunhandledrejection = previousUnhandledRejection;

            window.onerror = previousOnError;

            console.log(
                "[TonConnect AUTOPSY] window.onunhandledrejection / onerror restored"
            );

        };

        console.log(
            "[TonConnect AUTOPSY] window.onunhandledrejection / onerror capture installed"
        );

    }, [pushHandshakeTrace, recordAutopsyFinding]);

    const beginAutopsyAttempt = useCallback((attemptId) => {

        restoreAutopsyGlobalHandlers();

        autopsyAttemptRef.current = {
            active: true,
            attemptId,
            reportPrinted: false,
            findings: {
                sdkError: null,
                walletError: null,
                callbackException: null,
                unhandledPromise: null,
                browserError: null,
                rawObject: null,
                stackTrace: null,
                origin: null,
                failureStep: null,
                sdkInternalResponse: null
            },
            restoreGlobalHandlers: null
        };

        // R6.11C — start unified window.__TONCONNECT_AUTOPSY__ session
        try {

            beginTonConnectAutopsySession({
                attemptId,
                roomId: authoritative.roomId ?? null,
                playerId: localPlayerId
            });

            pushAutopsyTimeline({
                event: "openModal start",
                stage: "openModal",
                payloadSummary: { attemptId }
            });

        } catch {

            // diagnostics only
        }

        installAutopsyGlobalHandlers();

        console.log("[TonConnect AUTOPSY] attempt capture started", {
            attemptId,
            timestamp: Date.now()
        });

    }, [
        authoritative.roomId,
        installAutopsyGlobalHandlers,
        localPlayerId,
        restoreAutopsyGlobalHandlers
    ]);

    const printAttemptAutopsyReport = useCallback((reason) => {

        const autopsy = autopsyAttemptRef.current;

        const steps = [...handshakeTraceRef.current];

        const lastStep = steps.length > 0 ? steps[steps.length - 1] : null;

        const failureStep = autopsy.findings.failureStep
            ?? (isTonConnectFailureStep(lastStep?.step) ? lastStep.step : null)
            ?? reason
            ?? null;

        const lastSuccessfulStep = resolveLastSuccessfulHandshakeStep(steps);

        const rawObject = autopsy.findings.rawObject
            ?? autopsy.findings.sdkError
            ?? autopsy.findings.walletError
            ?? autopsy.findings.callbackException
            ?? autopsy.findings.unhandledPromise
            ?? autopsy.findings.browserError
            ?? null;

        const origin = autopsy.findings.origin
            ?? (
                rawObject != null
                    ? classifyTonConnectErrorOrigin(
                        rawObject,
                        failureStep ?? reason ?? ""
                    )
                    : "Origin could not be determined."
            );

        const report = {
            reason,
            attemptId: handshakeAttemptIdRef.current,
            lastSuccessfulStep,
            failureStep,
            origin,
            sdkError: autopsy.findings.sdkError,
            walletError: autopsy.findings.walletError,
            callbackException: autopsy.findings.callbackException,
            unhandledPromise: autopsy.findings.unhandledPromise,
            browserError: autopsy.findings.browserError,
            rawObject,
            stackTrace: autopsy.findings.stackTrace
                ?? rawObject?.stack
                ?? null,
            sdkInternalResponse: autopsy.findings.sdkInternalResponse,
            chronology: steps.map((entry) => ({
                at: entry.at,
                step: entry.step
            })),
            mostProbableFailurePoint: null
        };

        report.mostProbableFailurePoint = resolveMostProbableFailurePoint(
            report
        );

        if (!autopsy.reportPrinted) {

            autopsy.reportPrinted = true;

            printTonConnectAutopsyReport(report);

        } else {

            console.log(
                "[TonConnect AUTOPSY] report already printed for attempt; skip duplicate",
                { reason, attemptId: report.attemptId }
            );

        }

        // R6.11C — sync final steps into window.__TONCONNECT_AUTOPSY__
        try {

            syncAutopsyFromReport(report);

        } catch {

            // diagnostics only
        }

        restoreAutopsyGlobalHandlers();

        return report;

    }, [restoreAutopsyGlobalHandlers]);

    const dumpHandshakeSummary = useCallback((reason) => {

        const steps = [...handshakeTraceRef.current];

        const lastStep = steps.length > 0 ? steps[steps.length - 1] : null;

        const lastSuccessfulStep = resolveLastSuccessfulHandshakeStep(steps);

        console.log("[TonConnect TRACE] ATTEMPT SUMMARY", {
            reason,
            attemptId: handshakeAttemptIdRef.current,
            stepCount: steps.length,
            lastSuccessfulStep,
            lastStep: lastStep?.step ?? null,
            lastStepAt: lastStep?.at ?? null,
            chronology: steps.map((entry) => ({
                at: entry.at,
                step: entry.step
            })),
            steps
        });

        const findings = autopsyAttemptRef.current.findings;

        const shouldAutopsy = isTonConnectFailureStep(lastStep?.step)
            || findings.failureStep != null
            || findings.sdkError != null
            || findings.walletError != null
            || findings.callbackException != null
            || findings.unhandledPromise != null
            || findings.browserError != null
            || /error|reject|exception|fail|abort|closed_without|blocked/i.test(
                String(reason || "")
            );

        if (shouldAutopsy) {

            printAttemptAutopsyReport(reason);

        } else if (autopsyAttemptRef.current.active) {

            restoreAutopsyGlobalHandlers();

        }

    }, [printAttemptAutopsyReport, restoreAutopsyGlobalHandlers]);

    const runAutopsyGuardedCallback = useCallback((
        callbackLabel,
        callbackBody
    ) => {

        try {

            return callbackBody();

        } catch (callbackError) {

            console.log(
                "[TonConnect AUTOPSY] CALLBACK_EXCEPTION",
                { callbackLabel }
            );

            dumpTonConnectError(
                `CALLBACK_EXCEPTION | ${callbackLabel}`,
                callbackError,
                { callbackLabel }
            );

            recordAutopsyFinding({
                callbackException: callbackError,
                rawObject: callbackError,
                stackTrace: callbackError?.stack ?? null,
                origin: "Generated inside custom callback",
                failureStep: "CALLBACK_EXCEPTION"
            });

            pushHandshakeTrace("CALLBACK_EXCEPTION", {
                callbackLabel,
                message: callbackError?.message ?? String(callbackError),
                name: callbackError?.name ?? null
            });

            dumpHandshakeSummary(`callback_exception_${callbackLabel}`);

            return undefined;

        }

    }, [
        dumpHandshakeSummary,
        pushHandshakeTrace,
        recordAutopsyFinding
    ]);

    const emitWalletSocketEvent = useCallback((event, payload) => {

        console.log("[TonConnect TRACE] socket.emit BEFORE", {
            event,
            payload: payload === undefined ? null : payload,
            playerId: localPlayerId,
            roomId: authoritative.roomId ?? null,
            timestamp: Date.now()
        });

        pushHandshakeTrace("SOCKET_EMIT", {
            event,
            payload: payload === undefined ? null : payload
        });

        if (payload === undefined) {

            socket.emit(event);

        } else {

            socket.emit(event, payload);

        }

        console.log("[TonConnect TRACE] socket.emit AFTER", {
            event,
            playerId: localPlayerId,
            roomId: authoritative.roomId ?? null,
            timestamp: Date.now()
        });

    }, [authoritative.roomId, localPlayerId, pushHandshakeTrace]);

    const reportConnectedWallet = useCallback((rawAddress) => {

        console.log("[TonConnect] REPORT CONNECTED WALLET", {
            rawAddress,
            timestamp: Date.now(),
            playerId: localPlayerId,
            roomId: authoritative.roomId ?? null
        });

        pushHandshakeTrace("REPORT_CONNECTED_WALLET", { rawAddress });

        const connectedWallet = toSessionWalletAddress(rawAddress);

        console.log("[TonConnect TRACE] toSessionWalletAddress result", {
            connectedWallet
        });

        if (!connectedWallet) {

            console.log(
                "[TonConnect TRACE] REPORT ABORTED | reason=connectedWallet == null"
            );

            pushHandshakeTrace("REPORT_ABORTED", {
                reason: "connectedWallet_null"
            });

            dumpHandshakeSummary("report_aborted_null_wallet");

            setLocalError(
                t("payment.walletMismatch")
            );

            return;

        }

        pushHandshakeTrace("TONCONNECT_WALLET_RECEIVED", {
            connectedWallet
        });

        // R7.36 — STARTED only after wallet proof exists; always before REPORT.
        if (lastWalletProofEmitRef.current !== connectedWallet) {

            lastWalletProofEmitRef.current = connectedWallet;

            emitWalletSocketEvent(
                LOBBY_OUTGOING_EVENTS.WALLET_CONNECT_STARTED
            );

            pushHandshakeTrace("WALLET_CONNECT_STARTED", {
                connectedWallet,
                reason: "wallet_proof_exists"
            });

        } else {

            pushHandshakeTrace("WALLET_CONNECT_STARTED_SKIPPED", {
                connectedWallet,
                reason: "already_emitted_for_proof"
            });

        }

        const reportPayload = {
            roomId: authoritative.roomId ?? null,
            playerId: localPlayerId,
            connectedWallet
        };

        emitWalletSocketEvent(
            LOBBY_OUTGOING_EVENTS.WALLET_CONNECT_REPORT,
            reportPayload
        );

        pushHandshakeTrace("WALLET_CONNECT_REPORT_EMITTED", {
            connectedWallet
        });

        dumpHandshakeSummary("wallet_connect_report_emitted");

    }, [
        authoritative.roomId,
        dumpHandshakeSummary,
        emitWalletSocketEvent,
        localPlayerId,
        pushHandshakeTrace,
        t
    ]);

    useEffect(() => {

        const previous = prevTonWalletRef.current;

        const nextAddress = tonWallet?.account?.address ?? null;

        const prevAddress = previous?.account?.address ?? null;

        console.log("[TonConnect TRACE] React tonWallet state change", {
            previous: summarizeTonWalletFields(previous ?? null),
            next: summarizeTonWalletFields(tonWallet ?? null),
            addressChanged: prevAddress !== nextAddress,
            previousAddress: prevAddress,
            nextAddress,
            localWalletStatus,
            inPostWalletPhase,
            sdkConnected: isTonConnectSdkConnected(tonConnectUI, tonWallet),
            timestamp: Date.now()
        });

        pushHandshakeTrace("REACT_TON_WALLET_STATE", {
            previousAddress: prevAddress,
            nextAddress,
            addressChanged: prevAddress !== nextAddress,
            localWalletStatus
        });

        prevTonWalletRef.current = tonWallet ?? null;

        if (!tonWallet?.account?.address) {

            console.log(
                "[TonConnect TRACE] EARLY RETURN | reason=no tonWallet.account.address"
            );

            // R7.36 — allow STARTED again after SDK clears the wallet.
            lastWalletProofEmitRef.current = null;

            return;

        }

        if (inPostWalletPhase) {

            return;

        }

        // Already synchronized for this room seat — do not re-emit.
        if (localWalletStatus === WALLET_CONNECTION_STATUS.CONNECTED) {

            return;

        }

        // Wrong wallet already classified — Disconnect is required (no reconnect).
        if (localWalletStatus === WALLET_CONNECTION_STATUS.ADDRESS_MISMATCH) {

            pushHandshakeTrace("ADDRESS_MISMATCH", {
                source: "sdk_wallet_present",
                nextAddress
            });

            return;

        }

        const sdkConnected = isTonConnectSdkConnected(tonConnectUI, tonWallet);

        if (
            sdkConnected
            && localWalletStatus === WALLET_CONNECTION_STATUS.WAITING
        ) {

            pushHandshakeTrace("SDK_ALREADY_CONNECTED", {
                source: "react_ton_wallet_effect",
                nextAddress
            });

            pushHandshakeTrace("REUSE_EXISTING_WALLET", {
                source: "auto_sync",
                nextAddress
            });

        }

        setConnecting(false);

        reportConnectedWallet(tonWallet.account.address);

        if (
            sdkConnected
            && localWalletStatus === WALLET_CONNECTION_STATUS.WAITING
        ) {

            pushHandshakeTrace("SERVER_SYNCHRONIZED", {
                path: "auto_sync_waiting_seat"
            });

        }

    }, [
        tonWallet,
        tonConnectUI,
        localWalletStatus,
        inPostWalletPhase,
        reportConnectedWallet,
        pushHandshakeTrace
    ]);

    useEffect(() => {

        if (localWalletStatus === WALLET_CONNECTION_STATUS.ADDRESS_MISMATCH) {

            setLocalError(
                t("payment.walletMismatch")
            );

            pushHandshakeTrace("ADDRESS_MISMATCH", {
                source: "local_wallet_status"
            });

            return;

        }

        if (localWalletStatus === WALLET_CONNECTION_STATUS.CONNECTED) {

            setLocalError("");

        }

    }, [localWalletStatus, pushHandshakeTrace, t]);

    useEffect(() => {

        console.log("[TonConnect TRACE] localWalletStatus change", {
            localWalletStatus,
            playerId: localPlayerId,
            roomId: authoritative.roomId ?? null,
            timestamp: Date.now()
        });

    }, [localWalletStatus, localPlayerId, authoritative.roomId]);

    // R6.11B — restore temporary window handlers if Page4 unmounts mid-attempt
    useEffect(() => {

        return () => {

            const autopsy = autopsyAttemptRef.current;

            if (typeof autopsy.restoreGlobalHandlers === "function") {

                try {

                    autopsy.restoreGlobalHandlers();

                } catch {

                    // diagnostics only
                }

                autopsy.restoreGlobalHandlers = null;

            }

            autopsy.active = false;

        };

    }, []);

    useEffect(() => {

        const unsubscribe = tonConnectUI.onModalStateChange((state) => {

            runAutopsyGuardedCallback("onModalStateChange", () => {

                const isOpen = state?.status === "opened";

                console.log("[TonConnect TRACE] onModalStateChange", {
                    status: state?.status ?? null,
                    closeReason: state?.closeReason ?? null,
                    isOpen,
                    walletSelected: state?.status === "opened"
                        ? (tonConnectUI.wallet
                            ? summarizeTonWalletFields(tonConnectUI.wallet)
                            : null)
                        : null,
                    hasConnectorWallet: Boolean(tonConnectUI.wallet),
                    fullState: state,
                    timestamp: Date.now()
                });

                pushHandshakeTrace("MODAL_STATE_CHANGE", {
                    status: state?.status ?? null,
                    closeReason: state?.closeReason ?? null
                });

                try {

                    pushAutopsyTimeline({
                        event: isOpen ? "modal opened" : "modal closed",
                        stage: "modal",
                        payloadSummary: {
                            status: state?.status ?? null,
                            closeReason: state?.closeReason ?? null
                        }
                    });

                } catch {

                    // diagnostics only
                }

                setTonConnectModalOpen(isOpen);

                if (!isOpen) {

                    if (tonConnectUniversalLinkRef.current) {

                        pushHandshakeTrace("QR_LINK_CLEARED_ON_MODAL_CLOSE", {
                            hadLink: true,
                            linkLength: tonConnectUniversalLinkRef.current.length
                        });

                    }

                    tonConnectUniversalLinkRef.current = "";

                    setTonConnectUniversalLink("");

                    setTonConnectLinkCopied(false);

                }

                if (state?.status === "closed" && !tonConnectUI.wallet) {

                    setConnecting(false);

                    // R7.36 — modal closed without proof; no STARTED was owed.
                    lastWalletProofEmitRef.current = null;

                    if (localWalletStatus === WALLET_CONNECTION_STATUS.CONNECTING) {

                        console.log(
                            "[TonConnect TRACE] modal closed without wallet → WALLET_DISCONNECT_REPORT",
                            { localWalletStatus }
                        );

                        console.log(
                            "[TonConnect AUTOPSY] MODAL_CLOSED_WITHOUT_WALLET | full modal state (exact):"
                        );

                        console.log(state);

                        try {

                            console.dir(state, { depth: null });

                        } catch {

                            // diagnostics only
                        }

                        recordAutopsyFinding({
                            rawObject: state,
                            origin: "Generated by TonConnectUI",
                            failureStep: "MODAL_CLOSED_WITHOUT_WALLET"
                        });

                        try {

                            pushAutopsyRawObject({
                                kind: "modalClosedWithoutWallet",
                                label: "MODAL_CLOSED_WITHOUT_WALLET",
                                value: state
                            });

                        } catch {

                            // diagnostics only
                        }

                        pushHandshakeTrace("MODAL_CLOSED_WITHOUT_WALLET", {
                            localWalletStatus,
                            closeReason: state?.closeReason ?? null
                        });

                        emitWalletSocketEvent(
                            LOBBY_OUTGOING_EVENTS.WALLET_DISCONNECT_REPORT
                        );

                        dumpHandshakeSummary("modal_closed_without_wallet");

                    }

                }

            });

        });

        return () => {

            unsubscribe?.();

        };

    }, [
        tonConnectUI,
        localWalletStatus,
        pushHandshakeTrace,
        emitWalletSocketEvent,
        dumpHandshakeSummary,
        runAutopsyGuardedCallback,
        recordAutopsyFinding
    ]);

    // R6.16E — Observe connector.connect only; return exact originalConnect
    // result identity (no Promise wrap). Universal-link capture stays sync.
    useEffect(() => {

        const connector = tonConnectUI?.connector;

        if (!connector || typeof connector.connect !== "function") {

            console.log(
                "[TonConnect TRACE] connector.connect wrap skipped | no connector"
            );

            return;

        }

        const originalConnect = connector.connect.bind(connector);

        connector.connect = (...args) => {

            const walletSource = summarizeConnectWalletSource(args[0]);

            console.log("TONCONNECT_NATIVE_CONNECT_START");

            console.log("[TonConnect TRACE] connector.connect BEFORE", {
                argsCount: args.length,
                walletSource,
                bridgeUrl: walletSource?.bridgeUrl
                    ?? walletSource?.items?.[0]?.bridgeUrl
                    ?? null,
                universalLinkHint: walletSource?.universalLink
                    ?? walletSource?.items?.[0]?.universalLink
                    ?? null,
                options: args[1] ?? null,
                timestamp: Date.now()
            });

            console.log(
                "[TonConnect AUTOPSY] connector.connect args (exact, complete):"
            );

            console.log(args);

            try {

                console.dir(args, { depth: null });

            } catch {

                // diagnostics only
            }

            // R7.26 — never invoke SDK connect while session already active.
            if (connector.connected === true) {

                pushHandshakeTrace("SDK_ALREADY_CONNECTED", {
                    source: "connector_connect_wrap"
                });

                pushHandshakeTrace("CONNECT_SKIPPED", {
                    reason: "sdk_already_connected",
                    walletSource
                });

                dumpHandshakeSummary("connect_skipped_already_connected");

                console.log(
                    "[TonConnect TRACE] CONNECT_SKIPPED | connector.connected=true"
                        + " — refusing duplicate connect()"
                );

                return undefined;

            }

            pushHandshakeTrace("CONNECTOR_CONNECT_BEFORE", {
                walletSource,
                bridgeUrl: walletSource?.bridgeUrl
                    ?? walletSource?.items?.[0]?.bridgeUrl
                    ?? null
            });

            let result;

            try {

                result = originalConnect(...args);

            } catch (error) {

                console.log(
                    "[TonConnect AUTOPSY] connector.connect sync throw | any prior result/response:"
                );

                console.log(null);

                const dumped = dumpTonConnectError(
                    "connector.connect sync throw",
                    error,
                    { args, walletSource }
                );

                recordAutopsyFinding({
                    sdkError: error,
                    rawObject: error,
                    stackTrace: error?.stack ?? null,
                    origin: dumped.origin,
                    failureStep: "CONNECTOR_CONNECT_SYNC_THROW"
                });

                pushHandshakeTrace("CONNECTOR_CONNECT_SYNC_THROW", {
                    message: error?.message ?? String(error),
                    name: error?.name ?? null,
                    code: error?.code ?? error?.errorCode ?? null
                });

                dumpHandshakeSummary("connector_connect_sync_throw");

                throw error;

            }

            console.log(
                "TONCONNECT_NATIVE_CONNECT_RETURNED",
                result === null
                    ? "null"
                    : Array.isArray(result)
                        ? "array"
                        : typeof result
            );

            const observeResolved = (resolved) => {

                const returnType = resolved === null
                    ? "null"
                    : Array.isArray(resolved)
                        ? "array"
                        : typeof resolved;

                const universalLink = typeof resolved === "string"
                    ? resolved
                    : null;

                console.log("[TonConnect TRACE] connector.connect AFTER", {
                    returnType,
                    isString: typeof resolved === "string",
                    isPromiseWrapped: false,
                    universalLink,
                    universalLinkLength: universalLink?.length ?? 0,
                    bridgeUrlFromLink: tryExtractBridgeUrlFromLink(universalLink),
                    bridgeUrlFromSource: walletSource?.bridgeUrl
                        ?? walletSource?.items?.[0]?.bridgeUrl
                        ?? null,
                    timestamp: Date.now()
                });

                console.log(
                    "[TonConnect AUTOPSY] connector.connect internal response BEFORE any throw (complete):"
                );

                console.log(resolved);

                try {

                    console.dir(resolved, { depth: null });

                } catch {

                    // diagnostics only
                }

                console.log(
                    "[TonConnect AUTOPSY] connector.connect response JSON:",
                    safeJsonStringifyForAutopsy(resolved)
                );

                recordAutopsyFinding({
                    sdkInternalResponse: resolved
                });

                pushHandshakeTrace("CONNECTOR_CONNECT_AFTER", {
                    returnType,
                    universalLinkLength: universalLink?.length ?? 0,
                    hasUniversalLink: Boolean(universalLink)
                });

                if (typeof resolved === "string" && resolved.length > 0) {

                    tonConnectUniversalLinkRef.current = resolved;

                    setTonConnectUniversalLink(resolved);

                    setTonConnectLinkCopied(false);

                    pushHandshakeTrace("QR_UNIVERSAL_LINK_CAPTURED", {
                        linkLength: resolved.length,
                        linkPreview: resolved.slice(0, 160),
                        bridgeUrlFromLink: tryExtractBridgeUrlFromLink(resolved)
                    });

                    try {

                        pushAutopsyTimeline({
                            event: "QR created / universal link generated",
                            stage: "qrOrLink",
                            payloadSummary: {
                                linkLength: resolved.length,
                                linkPreview: resolved.slice(0, 160),
                                bridgeUrlFromLink: tryExtractBridgeUrlFromLink(
                                    resolved
                                )
                            }
                        });

                    } catch {

                        // diagnostics only
                    }

                }

            };

            // OBSERVE ONLY — never return .then() chain (new Promise identity).
            if (result != null && typeof result.then === "function") {

                console.log(
                    "[TonConnect TRACE] connector.connect returned Promise (observe only)"
                );

                result.then(
                    (resolved) => {

                        observeResolved(resolved);

                    },
                    (error) => {

                        console.log(
                            "[TonConnect AUTOPSY] connector.connect promise reject | SDK response before throw (if any):"
                        );

                        console.log(result);

                        try {

                            console.dir(result, { depth: null });

                        } catch {

                            // diagnostics only
                        }

                        const dumped = dumpTonConnectError(
                            "connector.connect promise reject",
                            error,
                            { walletSource }
                        );

                        recordAutopsyFinding({
                            sdkError: error,
                            walletError: error?.payload
                                ?? error?.data
                                ?? error?.response
                                ?? error?.details
                                ?? null,
                            rawObject: error,
                            stackTrace: error?.stack ?? null,
                            origin: dumped.origin,
                            failureStep: "CONNECTOR_CONNECT_PROMISE_REJECT"
                        });

                        pushHandshakeTrace("CONNECTOR_CONNECT_PROMISE_REJECT", {
                            message: error?.message ?? String(error),
                            name: error?.name ?? null,
                            code: error?.code ?? error?.errorCode ?? null
                        });

                        dumpHandshakeSummary("connector_connect_promise_reject");

                    }
                );

                return result;

            }

            observeResolved(result);

            return result;

        };

        console.log("[TonConnect TRACE] connector.connect wrap installed (R6.16E identity pass-through)");

        return () => {

            connector.connect = originalConnect;

            console.log("[TonConnect TRACE] connector.connect wrap restored");

        };

    }, [
        tonConnectUI,
        pushHandshakeTrace,
        dumpHandshakeSummary,
        recordAutopsyFinding
    ]);

    // R6.11A — probe optional SDK event hooks (CONNECTING/CONNECTED/…)
    useEffect(() => {

        const connector = tonConnectUI?.connector;

        if (!connector) {

            return;

        }

        console.log("[TonConnect TRACE] SDK hook surface", {
            hasUiOnStatusChange: typeof tonConnectUI.onStatusChange === "function",
            hasUiOnModalStateChange:
                typeof tonConnectUI.onModalStateChange === "function",
            hasConnectorOnStatusChange:
                typeof connector.onStatusChange === "function",
            hasEmitter: Boolean(connector.emitter),
            hasOn: typeof connector.on === "function",
            hasListen: typeof connector.listen === "function",
            connected: tonConnectUI.connected === true,
            publicKeys: Object.keys(connector)
                .filter((key) => !key.startsWith("_"))
                .slice(0, 40),
            timestamp: Date.now()
        });

        const unsubs = [];

        const eventNames = [
            "connecting",
            "connected",
            "disconnected",
            "error",
            "restored",
            "CONNECTING",
            "CONNECTED",
            "DISCONNECTED",
            "ERROR",
            "RESTORED",
            "status_changed",
            "statusChange"
        ];

        const attach = (target, methodOn, methodOff, label) => {

            if (!target || typeof target[methodOn] !== "function") {

                return;

            }

            for (const evt of eventNames) {

                try {

                    const handler = (payload) => {

                        runAutopsyGuardedCallback(
                            `SDK event ${label}:${evt}`,
                            () => {

                                console.log(
                                    `[TonConnect TRACE] SDK event ${label}:${evt}`,
                                    {
                                        payload,
                                        timestamp: Date.now()
                                    }
                                );

                                console.log(
                                    `[TonConnect AUTOPSY] SDK event ${label}:${evt} payload (exact):`
                                );

                                console.log(payload);

                                try {

                                    console.dir(payload, { depth: null });

                                } catch {

                                    // diagnostics only
                                }

                                pushHandshakeTrace(`SDK_EVENT_${evt}`, {
                                    source: label,
                                    payloadType: payload == null
                                        ? "null"
                                        : typeof payload
                                });

                                if (
                                    evt === "error"
                                    || evt === "ERROR"
                                    || payload instanceof Error
                                ) {

                                    const dumped = dumpTonConnectError(
                                        `SDK event ${label}:${evt}`,
                                        payload
                                    );

                                    recordAutopsyFinding({
                                        sdkError: payload,
                                        walletError: payload?.payload
                                            ?? payload?.data
                                            ?? payload?.response
                                            ?? payload?.details
                                            ?? null,
                                        rawObject: payload,
                                        stackTrace: payload?.stack ?? null,
                                        origin: dumped.origin,
                                        failureStep: autopsyAttemptRef.current
                                            .findings.failureStep
                                            ?? `SDK_EVENT_${evt}`
                                    });

                                }

                            }
                        );

                    };

                    target[methodOn](evt, handler);

                    unsubs.push(() => {

                        try {

                            target[methodOff]?.(evt, handler);

                        } catch {

                            // diagnostics only
                        }

                    });

                } catch (error) {

                    dumpTonConnectError(
                        `attach SDK event ${label}:${evt}`,
                        error
                    );

                }

            }

        };

        attach(connector.emitter, "on", "off", "connector.emitter");

        attach(connector, "on", "off", "connector");

        attach(tonConnectUI, "on", "off", "tonConnectUI");

        return () => {

            for (const unsub of unsubs) {

                unsub();

            }

        };

    }, [
        tonConnectUI,
        pushHandshakeTrace,
        runAutopsyGuardedCallback,
        recordAutopsyFinding
    ]);

    // R6.7B / R6.11A/B — observe SDK status; full wallet dump + raw error autopsy
    useEffect(() => {

        if (!tonConnectUI?.onStatusChange) {

            return;

        }

        const unsubscribe = tonConnectUI.onStatusChange(
            (wallet) => {

                runAutopsyGuardedCallback("onStatusChange wallet callback", () => {

                    console.log("TONCONNECT_STATUS_CHANGE");
                    console.log("================================================");
                    console.log("[TonConnect] onStatusChange");
                    console.log("[TonConnect TRACE] onStatusChange wallet dump");
                    console.log("================================================");

                    if (!wallet) {

                        console.log("[TonConnect TRACE] wallet: null → disconnected");
                        console.log("timestamp:", Date.now());
                        console.log(
                            "reason: disconnected or ConnectEvent not received"
                        );
                        console.log("================================================");

                        pushHandshakeTrace("ON_STATUS_CHANGE_NULL", {
                            connected: tonConnectUI.connected === true
                        });

                        try {

                            pushAutopsyWalletEvent({
                                status: "disconnected",
                                wallet: null,
                                detail: {
                                    connected: tonConnectUI.connected === true
                                }
                            });

                            pushAutopsyTimeline({
                                event: "onStatusChange fired",
                                stage: "onStatusChange",
                                payloadSummary: { wallet: null }
                            });

                        } catch {

                            // diagnostics only
                        }

                        dumpHandshakeSummary("onStatusChange_null_disconnected");

                        return;

                    }

                    const fields = summarizeTonWalletFields(wallet);

                    console.log("timestamp:", Date.now());
                    console.log("[TonConnect TRACE] wallet fields", fields);
                    console.log("provider:", fields.provider);
                    console.log("connected:", tonConnectUI.connected === true);
                    console.log("account.address:", fields.accountAddress);
                    console.log("account.chain:", fields.accountChain);
                    console.log("publicKey:", fields.publicKey);
                    console.log("walletStateInit:", fields.walletStateInit);
                    console.log("device.platform:", fields.devicePlatform);
                    console.log("device.appName:", fields.deviceAppName);
                    console.log("device.appVersion:", fields.deviceAppVersion);
                    console.log("================================================");

                    pushHandshakeTrace("ON_STATUS_CHANGE_WALLET", {
                        address: fields.accountAddress,
                        chain: fields.accountChain,
                        provider: fields.provider,
                        appName: fields.deviceAppName
                    });

                    try {

                        pushAutopsyWalletEvent({
                            status: "success",
                            wallet,
                            detail: fields
                        });

                        pushAutopsyTimeline({
                            event: "onStatusChange success",
                            stage: "onStatusChange",
                            payloadSummary: {
                                address: fields.accountAddress,
                                chain: fields.accountChain,
                                appName: fields.deviceAppName,
                                platform: fields.devicePlatform
                            }
                        });

                    } catch {

                        // diagnostics only
                    }

                });

            },
            (error) => {

                runAutopsyGuardedCallback("onStatusChange error callback", () => {

                    console.log(
                        "[TonConnect] onStatusChange ERROR (wallet rejection)"
                    );

                    console.log(
                        "[TonConnect AUTOPSY] ON_STATUS_CHANGE_ERROR | wallet error payload exactly as received:"
                    );

                    console.log(error);

                    try {

                        console.dir(error, { depth: null });

                    } catch {

                        // diagnostics only
                    }

                    const dumped = dumpTonConnectError(
                        "onStatusChange error callback",
                        error,
                        { path: "ON_STATUS_CHANGE_ERROR" }
                    );

                    const walletPayload = error?.payload
                        ?? error?.data
                        ?? error?.response
                        ?? error?.details
                        ?? error?.info
                        ?? error;

                    console.log(
                        "[TonConnect AUTOPSY] wallet/SDK nested payload fields (exact, no mapping):"
                    );

                    console.log({
                        payload: error?.payload,
                        data: error?.data,
                        response: error?.response,
                        details: error?.details,
                        info: error?.info,
                        cause: error?.cause,
                        walletPayload
                    });

                    recordAutopsyFinding({
                        sdkError: error,
                        walletError: walletPayload,
                        rawObject: error,
                        stackTrace: error?.stack ?? null,
                        origin: dumped.origin,
                        failureStep: "ON_STATUS_CHANGE_ERROR"
                    });

                    pushHandshakeTrace("ON_STATUS_CHANGE_ERROR", {
                        message: error?.message ?? String(error),
                        name: error?.name ?? null,
                        code: error?.code ?? error?.errorCode ?? null,
                        origin: dumped.origin
                    });

                    try {

                        pushAutopsyWalletEvent({
                            status: "error",
                            wallet: tonConnectUI.wallet ?? null,
                            error,
                            detail: { walletPayload }
                        });

                        pushAutopsyTimeline({
                            event: "onStatusChange error",
                            stage: "onStatusChange",
                            payloadSummary: {
                                message: error?.message ?? String(error),
                                name: error?.name ?? null,
                                code: error?.code ?? error?.errorCode ?? null
                            }
                        });

                    } catch {

                        // diagnostics only
                    }

                    dumpHandshakeSummary("onStatusChange_error_wallet_rejection");

                });

            }
        );

        return () => {

            unsubscribe?.();

        };

    }, [
        tonConnectUI,
        pushHandshakeTrace,
        dumpHandshakeSummary,
        runAutopsyGuardedCallback,
        recordAutopsyFinding
    ]);

    async function handleCopyTonConnectLink() {

        if (!tonConnectUniversalLink) {

            return;

        }

        try {

            if (navigator.clipboard?.writeText) {

                await navigator.clipboard.writeText(tonConnectUniversalLink);

            } else {

                const textArea = document.createElement("textarea");

                textArea.value = tonConnectUniversalLink;

                textArea.setAttribute("readonly", "");

                textArea.style.position = "fixed";

                textArea.style.left = "-9999px";

                document.body.appendChild(textArea);

                textArea.select();

                document.execCommand("copy");

                document.body.removeChild(textArea);

            }

            setTonConnectLinkCopied(true);

            window.setTimeout(() => {

                setTonConnectLinkCopied(false);

            }, 1500);

        } catch {

            setTonConnectLinkCopied(false);

        }

    }

    // R6.11A / R18-S16 — Open the SDK Universal Link.
    // Telegram Mini App + Gram Wallet: Telegram.WebApp.openLink (Mini App
    // stays open). Ordinary browser: window.open / <a target="_blank">.
    function handleOpenTonConnectLink() {

        const link = tonConnectUniversalLink;

        if (!link) {

            return;

        }

        launchGramWalletHandoff(link, {
            createAnchorClick: (href) => {

                const anchor = document.createElement("a");

                anchor.href = href;

                anchor.target = "_blank";

                anchor.rel = "noopener noreferrer";

                anchor.style.display = "none";

                document.body.appendChild(anchor);

                anchor.click();

                document.body.removeChild(anchor);

            }
        });

    }

    async function handleConnectWallet() {

        handshakeAttemptIdRef.current += 1;

        handshakeTraceRef.current = [];

        beginAutopsyAttempt(handshakeAttemptIdRef.current);

        const sdkConnected = isTonConnectSdkConnected(tonConnectUI, tonWallet);

        const sdkAddress = resolveTonConnectSdkAddress(tonConnectUI, tonWallet);

        const mayInitiateConnect = mayInitiateTonConnectConnect(
            tonConnectUI,
            tonWallet
        );

        console.log("[TonConnect] CONNECT TELEGRAM WALLET click", {
            timestamp: Date.now(),
            attemptId: handshakeAttemptIdRef.current,
            roomId: authoritative.roomId ?? null,
            playerId: localPlayerId,
            walletRequested: "telegram",
            canConnect,
            currentStatus: localWalletStatus,
            paymentPhase,
            callingOpenModal: mayInitiateConnect,
            hasTonConnectUI: Boolean(tonConnectUI),
            alreadyConnected: sdkConnected,
            currentWallet: summarizeTonWalletFields(tonConnectUI?.wallet ?? null),
            sdkAddress
        });

        pushHandshakeTrace("CONNECT_BUTTON_CLICK", {
            walletRequested: "telegram",
            canConnect,
            currentStatus: localWalletStatus,
            sdkConnected,
            mayInitiateConnect
        });

        if (!canConnect) {

            console.log(
                "[TonConnect TRACE] EARLY RETURN | reason=canConnect == false",
                {
                    localWalletStatus,
                    inPostWalletPhase,
                    connecting
                }
            );

            pushHandshakeTrace("CONNECT_BLOCKED", {
                reason: "canConnect_false",
                localWalletStatus,
                inPostWalletPhase,
                connecting
            });

            dumpHandshakeSummary("connect_blocked");

            return;

        }

        setLocalError("");

        // R7.26 — SDK already connected: reuse wallet, never openModal/connect.
        if (!mayInitiateConnect) {

            pushHandshakeTrace("SDK_ALREADY_CONNECTED", {
                source: "handleConnectWallet",
                sdkAddress,
                uiConnected: tonConnectUI?.connected === true,
                connectorConnected: tonConnectUI?.connector?.connected === true
            });

            pushHandshakeTrace("CONNECT_SKIPPED", {
                reason: "sdk_already_connected"
            });

            if (!sdkAddress) {

                setLocalError(
                    t("payment.telegramSessionNoAddress")
                );

                dumpHandshakeSummary("reuse_blocked_no_address");

                return;

            }

            pushHandshakeTrace("REUSE_EXISTING_WALLET", {
                source: "handleConnectWallet",
                sdkAddress
            });

            setConnecting(false);

            reportConnectedWallet(sdkAddress);

            pushHandshakeTrace("SERVER_SYNCHRONIZED", {
                path: "reuse_existing_wallet_click"
            });

            dumpHandshakeSummary("reuse_existing_wallet");

            return;

        }

        setConnecting(true);

        // R7.36 — do not emit WALLET_CONNECT_STARTED here.
        // Server CONNECTING waits until wallet proof → reportConnectedWallet.

        try {

            console.log("[TonConnect TRACE] openModal BEFORE", {
                timestamp: Date.now()
            });

            pushHandshakeTrace("OPEN_MODAL_BEFORE");

            try {

                pushAutopsyTimeline({
                    event: "openModal start",
                    stage: "openModal",
                    payloadSummary: { attemptId: handshakeAttemptIdRef.current }
                });

            } catch {

                // diagnostics only
            }

            await tonConnectUI.openModal();

            console.log("[TonConnect TRACE] openModal AFTER (resolved)", {
                timestamp: Date.now()
            });

            pushHandshakeTrace("OPEN_MODAL_AFTER");

            try {

                pushAutopsyTimeline({
                    event: "openModal resolved",
                    stage: "openModal",
                    payloadSummary: { attemptId: handshakeAttemptIdRef.current }
                });

            } catch {

                // diagnostics only
            }

        } catch (error) {

            const dumped = dumpTonConnectError("openModal exception", error);

            recordAutopsyFinding({
                sdkError: error,
                rawObject: error,
                stackTrace: error?.stack ?? null,
                origin: dumped.origin,
                failureStep: "OPEN_MODAL_EXCEPTION"
            });

            pushHandshakeTrace("OPEN_MODAL_EXCEPTION", {
                message: error?.message ?? String(error),
                name: error?.name ?? null,
                code: error?.code ?? error?.errorCode ?? null
            });

            dumpHandshakeSummary("openModal_exception");

            setConnecting(false);

            emitWalletSocketEvent(
                LOBBY_OUTGOING_EVENTS.WALLET_DISCONNECT_REPORT
            );

            setLocalError(t("payment.unableOpenTelegramWallet"));

        }

    }

    async function handleDisconnectWallet() {

        setLocalError("");

        console.log("[TonConnect] DISCONNECT click", {
            timestamp: Date.now(),
            playerId: localPlayerId,
            roomId: authoritative.roomId ?? null,
            currentWallet: summarizeTonWalletFields(tonWallet ?? null)
        });

        pushHandshakeTrace("DISCONNECT_CLICK");

        lastWalletProofEmitRef.current = null;

        try {

            console.log("[TonConnect TRACE] disconnect BEFORE");

            await tonConnectUI.disconnect();

            console.log("[TonConnect TRACE] disconnect AFTER");

            pushHandshakeTrace("DISCONNECT_AFTER");

        } catch (error) {

            const dumped = dumpTonConnectError("disconnect exception", error);

            recordAutopsyFinding({
                sdkError: error,
                rawObject: error,
                stackTrace: error?.stack ?? null,
                origin: dumped.origin,
                failureStep: "DISCONNECT_EXCEPTION"
            });

            pushHandshakeTrace("DISCONNECT_EXCEPTION", {
                message: error?.message ?? String(error)
            });

            // Still report disconnect so the room returns to WAITING.
        }

        emitWalletSocketEvent(LOBBY_OUTGOING_EVENTS.WALLET_DISCONNECT_REPORT);

        dumpHandshakeSummary("disconnect_complete");

        setConnecting(false);

    }

    return (

        <GameLayout

            message={t("page.payment.title")}

            backEnabled={walletPhase}

            onBack={() => onNavigate(5)}

            nextEnabled={false}

            onNext={() => {}}

        >

            <div className="page4">

                <div className="paymentPanel">

                    <div className="paymentPlayers">

                        {players.map((player) => (

                            <PlayerPaymentRow

                                key={player.key}

                                labelTitle={player.labelTitle}

                                nickname={player.nickname}

                                icon={player.icon}

                                connectionStatus={
                                    showPaymentRows
                                        ? undefined
                                        : player.status
                                }

                                connectionStatusLabel={
                                    showPaymentRows
                                        ? undefined
                                        : player.statusLabel
                                }

                                paymentStatus={
                                    showPaymentRows
                                        ? player.status
                                        : undefined
                                }

                                paymentStatusLabel={
                                    showPaymentRows
                                        ? player.statusLabel
                                        : undefined
                                }

                                walletRegistered={
                                    showPaymentRows
                                        ? Boolean(player.wallet)
                                        : undefined
                                }

                            />

                        ))}

                    </div>

                    {localError && (

                        <div
                            className="paymentPlayersWaiting"
                            aria-live="assertive"
                        >

                            {localError}

                        </div>

                    )}

                    {!walletPhase ? (

                        <div className="page4__connectActions">

                            {depositSubmitError && (

                                <div
                                    className="paymentPlayersWaiting"
                                    aria-live="assertive"
                                >

                                    {depositSubmitError}

                                </div>

                            )}

                            {depositStatusText ? (

                                <div className="smartContractStatus">

                                    {depositStatusText}

                                </div>

                            ) : null}

                            {paymentPhase === PAGE4_PAYMENT_PHASE.WAITING_PAGE5
                                || paymentSession?.status === "COMPLETED" ? (

                                <div className="smartContractStatus">

                                    {t("payment.allConfirmed")}

                                </div>

                            ) : paymentSession?.status === "FAILED"
                                || gameContract?.status === "DEPLOY_FAILED" ? (

                                <div className="smartContractStatus">

                                    {gameContract?.status === "DEPLOY_FAILED"
                                        ? t("payment.deploymentFailed")
                                        : t("payment.sessionFailed")}

                                </div>

                            ) : showEntryAction ? (

                                <button
                                    type="button"
                                    className="page4__connectButton"
                                    disabled={!entryActionEnabled || depositSubmitting}
                                    onClick={handleConfirmInTelegramWallet}
                                >

                                    {depositSubmitting
                                        ? t("payment.openingWallet")
                                        : entryTotalLabel
                                            ? t("payment.payAmount", { amount: entryTotalLabel })
                                            : t("payment.confirmInWallet")}

                                </button>

                            ) : null}

                        </div>

                    ) : (

                        <div className="page4__connectActions">

                            <button
                                type="button"
                                className="page4__connectButton"
                                disabled={!canConnect}
                                onClick={handleConnectWallet}
                            >

                                {t("payment.connectWallet")}

                            </button>

                            {(
                                localWalletStatus === WALLET_CONNECTION_STATUS.CONNECTED
                                || localWalletStatus === WALLET_CONNECTION_STATUS.ADDRESS_MISMATCH
                                || Boolean(tonWallet)
                            ) && (

                                <button
                                    type="button"
                                    className="page4__disconnectButton"
                                    onClick={handleDisconnectWallet}
                                >

                                    {t("payment.disconnect")}

                                </button>

                            )}

                            {/*
                              R6.11A — Desktop Connection block lives on Page4
                              (not inside @tonconnect/ui modal): the QR modal is
                              third-party and cannot be extended without editing
                              node_modules. Link is the exact string returned by
                              tonConnectUI.connector.connect() — same value the
                              UI modal stores as universalLink for QR sourceUrl.
                            */}
                            {tonConnectModalOpen
                                && tonConnectUniversalLink && (

                                <div
                                    className="page4__desktopConnection"
                                    aria-label={t("payment.desktopConnection")}
                                >

                                    <div className="page4__desktopConnectionTitle">

                                        {t("payment.desktopConnection")}

                                    </div>

                                    <label
                                        className="page4__desktopConnectionLabel"
                                        htmlFor="page4-tonconnect-link"
                                    >

                                        {t("payment.universalLink")}

                                    </label>

                                    <div className="page4__desktopConnectionRow">

                                        <input
                                            id="page4-tonconnect-link"
                                            className="page4__desktopConnectionInput"
                                            type="text"
                                            readOnly
                                            value={tonConnectUniversalLink}
                                            onFocus={(event) => {
                                                event.target.select();
                                            }}
                                        />

                                    </div>

                                    <div className="page4__desktopConnectionActions">

                                        <button
                                            type="button"
                                            className="page4__desktopConnectionCopy"
                                            onClick={handleCopyTonConnectLink}
                                        >

                                            {tonConnectLinkCopied
                                                ? t("common.copied")
                                                : t("common.copy")}

                                        </button>

                                        <button
                                            type="button"
                                            className="page4__desktopConnectionOpen"
                                            onClick={handleOpenTonConnectLink}
                                        >

                                            {t("payment.openWallet")}

                                        </button>

                                    </div>

                                </div>

                            )}

                    </div>

                    )}

                </div>

            </div>

        </GameLayout>

    );

}
