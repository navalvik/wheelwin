/**
 * R17.9L.23 — Production DepositOrchestrator (pre-deployment lifecycle only).
 *
 * Connects PAYMENT_CONNECTION_READY → DepositSession → StateInit → package →
 * read-only activation verification. No TON send, no deploy, no monitor bypass.
 */

import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { canonicalizeTonWalletAddress } from "../models/TonWalletAddress.js";
import { resolveOracleWalletConfig } from "../config/tonNetworkProfiles.js";
import { buildDepositStateInit } from "../payment/ton/buildDepositStateInit.js";
import { DEPOSIT_ACTIVATION_STATUS } from "./DepositActivationVerificationErrors.js";
import {
    DepositOrchestratorError,
    DEPOSIT_ORCHESTRATOR_ERROR_CODES
} from "./DepositOrchestratorErrors.js";
import {
    resolveContractExpiresAtUnix,
    resolveDepositOrchestrationFinancials
} from "./resolveDepositOrchestrationFinancials.js";
import { DEPOSIT_SESSION_STATUS } from "./DepositSessionStates.js";
import { isDepositSessionTerminal } from "./DepositSessionStates.js";

function resolveReleaseAuthority(network, env) {

    const oracle = resolveOracleWalletConfig(network, env);

    if (!oracle.configured || !oracle.address) {

        throw new DepositOrchestratorError(
            "releaseAuthority is not configured for network",
            DEPOSIT_ORCHESTRATOR_ERROR_CODES.FINANCIAL_CONFIG_UNAVAILABLE,
            { network, oracleSource: oracle.source ?? null }
        );

    }

    return oracle.address;

}

function serializeStateInitCells(stateInit) {

    const code = stateInit?.code ?? null;
    const data = stateInit?.data ?? null;

    if (!code || !data) {

        throw new DepositOrchestratorError(
            "StateInit code/data cells are missing",
            DEPOSIT_ORCHESTRATOR_ERROR_CODES.STATE_INIT_FAILED
        );

    }

    return Object.freeze({
        codeBoc: code.toBoc().toString("base64"),
        dataBoc: data.toBoc().toString("base64")
    });

}

/**
 * Role A — DepositContract StateInit deployment attach.
 * Proven TESTNET value for deploy + activation + 3 × FundSeat.
 * Independent of creationFeePerSeat (B), stake (C), and FundSeat expectedAmount (D).
 */
const DEPOSIT_CONTRACT_DEPLOY_VALUE_NANOTONS = "10000000";

function freezeDepositPackage({
    session,
    built,
    bindings,
    financials,
    contractExpiresAt
}) {

    const stateInit = serializeStateInitCells(built.stateInit);

    const enrichedBindings = bindings.map((binding, index) => Object.freeze({
        ...binding,
        expectedStake: Number(session.metadata?.[`expectedStake${index}`] ?? 0)
    }));

    return Object.freeze({
        depositId: session.depositId,
        roomId: session.roomId,
        gameId: session.gameId,
        depositAddress: session.depositAddress,
        address: session.depositAddress,
        stateInit,
        bindings: Object.freeze(enrichedBindings),
        creationFeePerSeat: financials.creationFeePerSeat.toString(),
        deployValueNanotons: DEPOSIT_CONTRACT_DEPLOY_VALUE_NANOTONS,
        network: financials.network,
        expiresAt: Number(contractExpiresAt),
        contractExpiresAt: Number(contractExpiresAt),
        publishedAt: Date.now()
    });

}

export class DepositOrchestrator {

    constructor({
        logger = null,
        eventBus = null,
        depositSessionCoordinator = null,
        depositActivationVerificationCoordinator = null,
        gameplayContextResolver = null,
        roomManager = null,
        playerManager = null,
        sessionWalletStore = null,
        financialParameters = null,
        resolveFinancialParameters = null,
        env = process.env,
        gameEscrowOnlyPlayerPayment = false,
        activationRetryIntervalMs = 3_000,
        activationRetryMaxMs = 300_000
    } = {}) {

        this._logger = logger ?? { info() {}, warn() {}, error() {}, debug() {} };

        this._eventBus = eventBus;

        this._depositSessionCoordinator = depositSessionCoordinator;

        this._depositActivationVerificationCoordinator =
            depositActivationVerificationCoordinator;

        this._gameplayContextResolver = gameplayContextResolver;

        this._roomManager = roomManager;

        this._playerManager = playerManager;

        this._sessionWalletStore = sessionWalletStore;

        this._financialParameters = financialParameters;

        this._resolveFinancialParameters = resolveFinancialParameters;

        this._env = env;

        this._gameEscrowOnlyPlayerPayment = gameEscrowOnlyPlayerPayment === true;

        this._initialized = false;

        this._activationRetryIntervalMs = Number(activationRetryIntervalMs) > 0
            ? Number(activationRetryIntervalMs)
            : 3_000;

        this._activationRetryMaxMs = Number(activationRetryMaxMs) > 0
            ? Number(activationRetryMaxMs)
            : 300_000;

        this._activationRetryTimers = new Map();

        this._activationRetryStartedAt = new Map();

        this._boundActivationWaitingHandler = (envelope) => {

            const depositId = typeof envelope?.payload?.depositId === "string"
                ? envelope.payload.depositId.trim()
                : "";

            if (!depositId) {

                return;

            }

            this._scheduleActivationRetry(depositId);

        };

        this._boundHandler = (envelope) => {

            void this.handlePaymentConnectionReady(envelope?.payload ?? {}).catch((error) => {

                // R18.0B — preserve exact failure details in the message itself.
                // The session-history developerLog persists only {at, level,
                // source, message}, so structured fields alone are lost.
                const errorCode = error?.code ?? null;
                const errorName = error?.name ?? null;
                const errorMessage = error?.message ?? String(error);
                const errorDetails = error?.details ?? null;

                this._logger.error?.(
                    "DepositOrchestrator PAYMENT_CONNECTION_READY failed"
                    + ` | stage=PAYMENT_CONNECTION_READY`
                    + ` | code=${errorCode ?? "UNKNOWN"}`
                    + ` | errorName=${errorName ?? "UNKNOWN"}`
                    + ` | error=${errorMessage}`
                    + (errorDetails != null
                        ? ` | details=${JSON.stringify(errorDetails)}`
                        : ""),
                    {
                        roomId: envelope?.payload?.roomId ?? null,
                        stage: "PAYMENT_CONNECTION_READY",
                        code: errorCode,
                        errorName,
                        errorMessage,
                        details: errorDetails
                    }
                );

            });

        };

    }

    initialize() {

        if (this._initialized) {

            return;

        }

        if (this._eventBus?.subscribe) {

            this._eventBus.subscribe(
                EVENT_TYPES.PAYMENT_CONNECTION_READY,
                this._boundHandler
            );

            this._eventBus.subscribe(
                EVENT_TYPES.DEPOSIT_ACTIVATION_WAITING,
                this._boundActivationWaitingHandler
            );

        }

        this._initialized = true;

    }

    shutdown() {

        this._clearActivationRetries();

        if (this._eventBus?.unsubscribe && this._initialized) {

            this._eventBus.unsubscribe(
                EVENT_TYPES.PAYMENT_CONNECTION_READY,
                this._boundHandler
            );

            this._eventBus.unsubscribe(
                EVENT_TYPES.DEPOSIT_ACTIVATION_WAITING,
                this._boundActivationWaitingHandler
            );

        }

        this._initialized = false;

    }

    /**
     * @param {{ roomId?: string|null }} payload
     */
    async handlePaymentConnectionReady(payload = {}) {

        if (this._gameEscrowOnlyPlayerPayment) {

            this._logger.info?.(
                "DepositOrchestrator skipped PAYMENT_CONNECTION_READY | game_escrow_only"
            );

            return Object.freeze({
                ok: true,
                skipped: true,
                reason: "game_escrow_only"
            });

        }

        const roomId = typeof payload?.roomId === "string"
            ? payload.roomId.trim()
            : "";

        if (!roomId) {

            throw new DepositOrchestratorError(
                "roomId is required",
                DEPOSIT_ORCHESTRATOR_ERROR_CODES.ROOM_NOT_FOUND,
                { roomId }
            );

        }

        const gameId = this._gameplayContextResolver
            ?.resolveGameIdByRoomId?.(roomId) ?? null;

        if (!gameId) {

            throw new DepositOrchestratorError(
                "Authoritative gameId could not be resolved",
                DEPOSIT_ORCHESTRATOR_ERROR_CODES.GAME_NOT_FOUND,
                { roomId }
            );

        }

        const room = this._roomManager?.getRoom?.(roomId) ?? null;

        if (!room) {

            throw new DepositOrchestratorError(
                "Room not found",
                DEPOSIT_ORCHESTRATOR_ERROR_CODES.ROOM_NOT_FOUND,
                { roomId }
            );

        }

        const playerIds = Array.isArray(room.players) ? [...room.players] : [];

        if (playerIds.length !== 3) {

            throw new DepositOrchestratorError(
                "Deposit orchestration requires exactly three players",
                DEPOSIT_ORCHESTRATOR_ERROR_CODES.INVALID_PLAYER_COUNT,
                { roomId, playerCount: playerIds.length }
            );

        }

        const financials = this._resolveFinancials();

        const bindingsInput = [];
        const expectedStakeByIndex = [];

        for (const playerId of playerIds) {

            const identity = this._playerManager?.getIdentity?.(playerId) ?? null;
            const wallet = this._sessionWalletStore?.getWallet?.(roomId, playerId) ?? null;

            if (!wallet) {

                throw new DepositOrchestratorError(
                    "Authoritative player wallet is unavailable",
                    DEPOSIT_ORCHESTRATOR_ERROR_CODES.WALLET_UNAVAILABLE,
                    { roomId, playerId }
                );

            }

            const canonicalWallet = canonicalizeTonWalletAddress(wallet) ?? wallet;
            const expectedStakeNano = financials.resolveExpectedStakeNano(identity);
            const expectedAmount = Number(expectedStakeNano + financials.creationFeePerSeat);

            expectedStakeByIndex.push(expectedStakeNano);

            bindingsInput.push({
                playerId,
                wallet: canonicalWallet,
                expectedAmount
            });

        }

        const contractExpiresAt = resolveContractExpiresAtUnix(financials.depositTimeoutMs);

        let session = this._depositSessionCoordinator
            ?.getByRoomAndGame?.(roomId, gameId) ?? null;

        if (session) {

            return this._handleExistingSession({
                session,
                roomId,
                gameId
            });

        }

        session = this._depositSessionCoordinator.createSession({
            roomId,
            gameId,
            metadata: {
                network: financials.network,
                tonNetwork: financials.network,
                creationFeePerSeat: Number(financials.creationFeePerSeat),
                depositTimeoutMs: financials.depositTimeoutMs,
                contractExpiresAt: Number(contractExpiresAt),
                expectedStake0: Number(expectedStakeByIndex[0]),
                expectedStake1: Number(expectedStakeByIndex[1]),
                expectedStake2: Number(expectedStakeByIndex[2]),
                releaseAuthority: resolveReleaseAuthority(financials.network, this._env)
            }
        });

        this._depositSessionCoordinator.bindPlayers(session.depositId, bindingsInput);

        return this._finalizeOrchestration({
            session: this._depositSessionCoordinator.getSession(session.depositId),
            bindingsInput,
            financials,
            contractExpiresAt,
            expectedStakeByIndex
        });

    }

    async _handleExistingSession({
        session,
        roomId,
        gameId
    }) {

        if (isDepositSessionTerminal(session.state)) {

            throw new DepositOrchestratorError(
                "Existing deposit session is terminal",
                DEPOSIT_ORCHESTRATOR_ERROR_CODES.SESSION_INCOMPATIBLE,
                { depositId: session.depositId, state: session.state }
            );

        }

        const existingPackage = session.metadata?.depositPackage ?? null;

        if (existingPackage?.depositAddress && session.depositAddress) {

            const canonicalExisting = canonicalizeTonWalletAddress(session.depositAddress)
                ?? session.depositAddress;

            const canonicalPackage = canonicalizeTonWalletAddress(existingPackage.depositAddress)
                ?? existingPackage.depositAddress;

            if (canonicalExisting !== canonicalPackage) {

                throw new DepositOrchestratorError(
                    "Persisted deposit package address mismatch",
                    DEPOSIT_ORCHESTRATOR_ERROR_CODES.SESSION_INCOMPATIBLE,
                    {
                        depositId: session.depositId,
                        sessionAddress: session.depositAddress,
                        packageAddress: existingPackage.depositAddress
                    }
                );

            }

            return this._verifyActivationOnly(session);

        }

        if (session.bindings?.length || session.depositAddress) {

            throw new DepositOrchestratorError(
                "Partial deposit session cannot be orchestrated",
                DEPOSIT_ORCHESTRATOR_ERROR_CODES.SESSION_INCOMPATIBLE,
                {
                    depositId: session.depositId,
                    state: session.state,
                    hasBindings: Boolean(session.bindings?.length),
                    hasAddress: Boolean(session.depositAddress)
                }
            );

        }

        throw new DepositOrchestratorError(
            "Existing deposit session is in an unexpected state",
            DEPOSIT_ORCHESTRATOR_ERROR_CODES.SESSION_INCOMPATIBLE,
            { depositId: session.depositId, roomId, gameId, state: session.state }
        );

    }

    async _finalizeOrchestration({
        session,
        financials,
        contractExpiresAt,
        expectedStakeByIndex
    }) {

        let built;

        try {

            built = buildDepositStateInit({
                depositId: session.depositId,
                roomId: session.roomId,
                gameId: session.gameId,
                players: session.bindings.map((binding, index) => ({
                    playerId: binding.playerId,
                    wallet: binding.wallet,
                    expectedStake: expectedStakeByIndex[index]
                })),
                creationFeePerSeat: financials.creationFeePerSeat,
                expiresAt: contractExpiresAt,
                network: financials.network,
                env: this._env
            });

        } catch (error) {

            throw new DepositOrchestratorError(
                error?.message ?? "StateInit construction failed",
                DEPOSIT_ORCHESTRATOR_ERROR_CODES.STATE_INIT_FAILED,
                { depositId: session.depositId, cause: error?.name ?? null }
            );

        }

        this._depositSessionCoordinator.setDepositAddress(
            session.depositId,
            built.addressFriendly
        );

        const refreshed = this._depositSessionCoordinator.getSession(session.depositId);

        const depositPackage = freezeDepositPackage({
            session: refreshed,
            built,
            bindings: refreshed.bindings,
            financials,
            contractExpiresAt
        });

        try {

            this._depositSessionCoordinator.recordDepositPackage(
                refreshed.depositId,
                depositPackage
            );

        } catch (error) {

            throw new DepositOrchestratorError(
                error?.message ?? "Deposit package persistence failed",
                DEPOSIT_ORCHESTRATOR_ERROR_CODES.PACKAGE_PERSISTENCE_FAILED,
                { depositId: refreshed.depositId }
            );

        }

        if (refreshed.state === DEPOSIT_SESSION_STATUS.PLAYER_BINDING) {

            this._depositSessionCoordinator.markAwaitingFunds(refreshed.depositId);

        }

        const awaiting = this._depositSessionCoordinator.getSession(refreshed.depositId);

        this._emitPackagePublished(awaiting, depositPackage);

        return this._verifyActivation(awaiting, depositPackage);

    }

    async _verifyActivationOnly(session) {

        if (
            session.state === DEPOSIT_SESSION_STATUS.CREATED
            || session.state === DEPOSIT_SESSION_STATUS.PLAYER_BINDING
        ) {

            this._depositSessionCoordinator.markAwaitingFunds(session.depositId);

            session = this._depositSessionCoordinator.getSession(session.depositId);

        }

        return this._verifyActivation(
            session,
            session.metadata?.depositPackage ?? null
        );

    }

    async _verifyActivation(session, depositPackage) {

        if (!this._depositActivationVerificationCoordinator?.verifyActivation) {

            throw new DepositOrchestratorError(
                "DepositActivationVerificationCoordinator is not configured",
                DEPOSIT_ORCHESTRATOR_ERROR_CODES.ACTIVATION_VERIFICATION_FAILED,
                { depositId: session.depositId }
            );

        }

        const activation = await this._depositActivationVerificationCoordinator
            .verifyActivation(session.depositId);

        const acceptable = new Set([
            DEPOSIT_ACTIVATION_STATUS.WAITING_FOR_PLAYER_DEPLOYMENT,
            DEPOSIT_ACTIVATION_STATUS.VERIFIED,
            DEPOSIT_ACTIVATION_STATUS.ALREADY_VERIFIED
        ]);

        if (!acceptable.has(activation.status)) {

            throw new DepositOrchestratorError(
                "Deposit activation verification rejected orchestration",
                DEPOSIT_ORCHESTRATOR_ERROR_CODES.ACTIVATION_VERIFICATION_FAILED,
                {
                    depositId: session.depositId,
                    activationStatus: activation.status
                }
            );

        }

        return Object.freeze({
            ok: true,
            depositId: session.depositId,
            roomId: session.roomId,
            gameId: session.gameId,
            depositAddress: session.depositAddress,
            depositPackage,
            activationStatus: activation.status,
            watchStarted: activation.watchStarted === true
        });

    }

    _clearActivationRetries() {

        for (const timer of this._activationRetryTimers.values()) {

            clearTimeout(timer);

        }

        this._activationRetryTimers.clear();
        this._activationRetryStartedAt.clear();

    }

    _scheduleActivationRetry(depositId) {

        if (this._activationRetryTimers.has(depositId)) {

            return;

        }

        const session = this._depositSessionCoordinator?.getSession?.(depositId) ?? null;

        if (session?.roomId && this._roomManager?.getRoom
            && !this._roomManager.getRoom(session.roomId)) {

            return;

        }

        if (!this._activationRetryStartedAt.has(depositId)) {

            this._activationRetryStartedAt.set(depositId, Date.now());

        }

        const elapsed = Date.now() - this._activationRetryStartedAt.get(depositId);

        if (elapsed >= this._activationRetryMaxMs) {

            this._logger.warn?.(
                "DepositOrchestrator activation retry timed out"
                + ` | depositId=${depositId}`
            );
            this._activationRetryStartedAt.delete(depositId);

            return;

        }

        const timer = setTimeout(() => {

            this._activationRetryTimers.delete(depositId);
            void this._retryActivation(depositId);

        }, this._activationRetryIntervalMs);

        this._activationRetryTimers.set(depositId, timer);

    }

    async _retryActivation(depositId) {

        const session = this._depositSessionCoordinator?.getSession?.(depositId) ?? null;

        if (!session || isDepositSessionTerminal(session.state)) {

            this._activationRetryStartedAt.delete(depositId);

            return;

        }

        if (session.roomId && this._roomManager?.getRoom
            && !this._roomManager.getRoom(session.roomId)) {

            this._activationRetryStartedAt.delete(depositId);

            return;

        }

        if (!this._depositActivationVerificationCoordinator?.verifyActivation) {

            this._activationRetryStartedAt.delete(depositId);

            return;

        }

        try {

            const result = await this._depositActivationVerificationCoordinator
                .verifyActivation(depositId);

            if (
                result.status === DEPOSIT_ACTIVATION_STATUS.VERIFIED
                || result.status === DEPOSIT_ACTIVATION_STATUS.ALREADY_VERIFIED
            ) {

                this._activationRetryStartedAt.delete(depositId);

                return;

            }

            if (result.status === DEPOSIT_ACTIVATION_STATUS.WAITING_FOR_PLAYER_DEPLOYMENT) {

                this._scheduleActivationRetry(depositId);

                return;

            }

            this._activationRetryStartedAt.delete(depositId);

        } catch (error) {

            this._logger.warn?.(
                "DepositOrchestrator activation retry failed"
                + ` | depositId=${depositId}`
                + ` | error=${error?.message ?? String(error)}`
            );
            this._scheduleActivationRetry(depositId);

        }

    }

    _resolveFinancials() {

        if (this._financialParameters) {

            return this._financialParameters;

        }

        if (typeof this._resolveFinancialParameters === "function") {

            return this._resolveFinancialParameters();

        }

        return resolveDepositOrchestrationFinancials({
            env: this._env,
            network: this._env?.TON_NETWORK ?? "testnet"
        });

    }

    _emitPackagePublished(session, depositPackage) {

        if (!this._eventBus) {

            return;

        }

        this._eventBus.emit({
            source: EVENT_SOURCES.DEPOSIT_ORCHESTRATOR,
            type: EVENT_TYPES.DEPOSIT_PACKAGE_PUBLISHED,
            payload: Object.freeze({
                depositId: session.depositId,
                roomId: session.roomId,
                gameId: session.gameId,
                depositAddress: session.depositAddress,
                package: depositPackage
            })
        });

    }

}
