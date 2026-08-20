/**
 * R17.9L.25 — TEST-ONLY live harness stack (real backend components).
 * Uses RealTonDepositBlockchainSource. Never FakeDepositBlockchainSource.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DepositActivationVerificationCoordinator } from "../../../deposit/DepositActivationVerificationCoordinator.js";
import { DEPOSIT_ACTIVATION_STATUS } from "../../../deposit/DepositActivationVerificationErrors.js";
import { DepositFullAuthorizationAutomation } from "../../../deposit/DepositFullAuthorizationAutomation.js";
import { DepositMonitor } from "../../../deposit/DepositMonitor.js";
import { DepositOnChainVerificationCoordinator } from "../../../deposit/DepositOnChainVerificationCoordinator.js";
import { DepositOrchestrator } from "../../../deposit/DepositOrchestrator.js";
import {
    TonFinancialDepositPersistence
} from "../../../deposit/DepositPersistencePort.js";
import {
    TonFinancialDepositObservationPersistence
} from "../../../deposit/DepositObservationPersistencePort.js";
import { DepositSessionCoordinator } from "../../../deposit/DepositSessionCoordinator.js";
import { DEPOSIT_SESSION_STATUS } from "../../../deposit/DepositSessionStates.js";
import { DeploymentAuthorizationCoordinator } from "../../../deposit/DeploymentAuthorizationCoordinator.js";
import {
    TonFinancialDeploymentAuthorizationPersistence
} from "../../../deposit/DeploymentAuthorizationPersistencePort.js";
import { DEPLOYMENT_AUTHORIZATION_STATUS } from "../../../deposit/DeploymentAuthorizationStates.js";
import {
    RealTonDepositBlockchainSource
} from "../../../deposit/RealTonDepositBlockchainSource.js";
import {
    resolveDepositOrchestrationFinancials
} from "../../../deposit/resolveDepositOrchestrationFinancials.js";
import { EventBus } from "../../../events/EventBus.js";
import { EVENT_TYPES } from "../../../events/EventTypes.js";
import { TonFinancialPersistence } from "../../../persistence/TonFinancialPersistence.js";
import { GameplayContextResolver } from "../../../socket/GameplayContextResolver.js";
import { L25_ERROR_CODES, L25TestError } from "./l25Errors.js";

export function createL25Logger() {

    return {
        info(message) {

            process.stdout.write(`[L25] ${message}\n`);

        },
        warn(message) {

            process.stderr.write(`[L25 WARN] ${message}\n`);

        },
        error(message) {

            process.stderr.write(`[L25 ERROR] ${message}\n`);

        },
        debug() {},
        decisionTrace() {}
    };

}

function sleep(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

/**
 * Build controlled room/player/wallet stores for L.23 orchestration.
 */
export function createL25FixtureStores({
    roomId,
    gameId,
    playerWallets,
    baseStake = 1,
    sectorCount = 1
}) {

    const playerIds = ["p0", "p1", "p2"];

    const roomManager = {
        getRoom(id) {

            if (id !== roomId) {

                return null;

            }

            return {
                roomId,
                players: [...playerIds]
            };

        }
    };

    const playerManager = {
        getIdentity(playerId) {

            const index = playerIds.indexOf(playerId);

            if (index < 0) {

                return null;

            }

            return {
                playerId,
                baseStake,
                sectorCount
            };

        },
        hasPlayer(playerId) {

            return playerIds.includes(playerId);

        },
        getRuntime(playerId) {

            if (!playerIds.includes(playerId)) {

                return null;

            }

            return { roomId };

        }
    };

    const sessionWalletStore = {
        getWallet(id, playerId) {

            if (id !== roomId) {

                return null;

            }

            const index = playerIds.indexOf(playerId);

            return index >= 0
                ? playerWallets[index].addressCanonical
                : null;

        }
    };

    const gameplayContextResolver = new GameplayContextResolver({
        logger: createL25Logger(),
        playerManager,
        roomManager
    });

    gameplayContextResolver.activateRoomGame(roomId, gameId);

    return Object.freeze({
        roomId,
        gameId,
        playerIds,
        roomManager,
        playerManager,
        sessionWalletStore,
        gameplayContextResolver
    });

}

/**
 * Create the real deposit stack for live L.25 E2E.
 */
export function createL25LiveStack({
    tonService,
    playerWallets,
    env = process.env,
    network = "testnet",
    roomId = `room-l25-${Date.now()}`,
    gameId = `game-l25-${Date.now()}`
} = {}) {

    const logger = createL25Logger();
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-l25-"));

    const financialPersistence = new TonFinancialPersistence({
        dataDir,
        autoCheckpoint: false
    });

    financialPersistence.initialize();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const fixtures = createL25FixtureStores({
        roomId,
        gameId,
        playerWallets
    });

    const depositSessionCoordinator = new DepositSessionCoordinator({
        eventBus,
        persistence: new TonFinancialDepositPersistence(financialPersistence),
        env
    });

    const deploymentAuthorizationCoordinator = new DeploymentAuthorizationCoordinator({
        eventBus,
        persistence: new TonFinancialDeploymentAuthorizationPersistence(
            financialPersistence
        )
    });

    const depositFullAuthorizationAutomation = new DepositFullAuthorizationAutomation({
        logger,
        eventBus,
        depositSessionCoordinator,
        deploymentAuthorizationCoordinator
    });

    depositFullAuthorizationAutomation.initialize();

    const blockchainSource = new RealTonDepositBlockchainSource({
        logger,
        tonService,
        network
    });

    const depositMonitor = new DepositMonitor({
        logger,
        eventBus,
        depositSessionCoordinator,
        persistence: new TonFinancialDepositObservationPersistence(
            financialPersistence
        ),
        blockchainSource,
        network,
        requireActivationVerification: true
    });

    depositMonitor.initialize();

    const depositOnChainVerification = new DepositOnChainVerificationCoordinator({
        logger,
        eventBus,
        depositSessionCoordinator,
        observationPersistence: new TonFinancialDepositObservationPersistence(
            financialPersistence
        ),
        network
    });

    depositOnChainVerification.initialize();

    const depositActivationVerification = new DepositActivationVerificationCoordinator({
        logger,
        eventBus,
        depositSessionCoordinator,
        depositMonitor,
        blockchainSource,
        tonService,
        network,
        env
    });

    const gameContractDeployCalls = [];

    const gameContractManager = {
        deployContract(...args) {

            gameContractDeployCalls.push({ args, at: Date.now() });

            throw new Error("L25 STOP BOUNDARY — GameContract deploy forbidden");

        },
        createContractRequest(...args) {

            gameContractDeployCalls.push({ args, at: Date.now(), kind: "create" });

            throw new Error("L25 STOP BOUNDARY — GameContract create forbidden");

        }
    };

    const financialParameters = resolveDepositOrchestrationFinancials({
        env,
        network,
        paymentDurationMs: Number(env.TON_DEPOSIT_TIMEOUT_MS) || 600_000
    });

    const depositOrchestrator = new DepositOrchestrator({
        logger,
        eventBus,
        depositSessionCoordinator,
        depositActivationVerificationCoordinator: depositActivationVerification,
        gameplayContextResolver: fixtures.gameplayContextResolver,
        roomManager: fixtures.roomManager,
        playerManager: fixtures.playerManager,
        sessionWalletStore: fixtures.sessionWalletStore,
        financialParameters,
        env
    });

    const packageEvents = [];
    const depositFullEvents = [];
    const authValidEvents = [];
    const seatFundedEvents = [];
    const fullOnChainEvents = [];

    eventBus.subscribe(EVENT_TYPES.DEPOSIT_PACKAGE_PUBLISHED, (envelope) => {

        packageEvents.push(envelope);

    });

    eventBus.subscribe(EVENT_TYPES.DEPOSIT_FULL, (envelope) => {

        depositFullEvents.push(envelope);

    });

    eventBus.subscribe(EVENT_TYPES.DEPLOY_AUTHORIZATION_VALID, (envelope) => {

        authValidEvents.push(envelope);

    });

    eventBus.subscribe(EVENT_TYPES.DEPOSIT_SEAT_FUNDED, (envelope) => {

        seatFundedEvents.push(envelope);

    });

    eventBus.subscribe(EVENT_TYPES.DEPOSIT_FULL_ONCHAIN, (envelope) => {

        fullOnChainEvents.push(envelope);

    });

    return {
        logger,
        dataDir,
        eventBus,
        roomId,
        gameId,
        fixtures,
        depositSessionCoordinator,
        deploymentAuthorizationCoordinator,
        depositMonitor,
        depositOnChainVerification,
        depositActivationVerification,
        depositOrchestrator,
        blockchainSource,
        gameContractManager,
        gameContractDeployCalls,
        packageEvents,
        depositFullEvents,
        authValidEvents,
        seatFundedEvents,
        fullOnChainEvents,
        financialParameters,
        DEPOSIT_ACTIVATION_STATUS,
        DEPOSIT_SESSION_STATUS,
        DEPLOYMENT_AUTHORIZATION_STATUS,
        shutdown() {

            depositMonitor.shutdown();
            depositOnChainVerification.shutdown?.();
            eventBus.shutdown();

        }
    };

}

/**
 * Poll DepositMonitor until DEPOSIT_FULL_ONCHAIN or timeout.
 */
export async function waitForDepositFullOnChain(stack, {
    timeoutMs = 180_000,
    pollMs = 4_000
} = {}) {

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {

        await stack.depositMonitor.poll();

        if (stack.fullOnChainEvents.length > 0) {

            return stack.fullOnChainEvents[stack.fullOnChainEvents.length - 1];

        }

        await sleep(pollMs);

    }

    throw new L25TestError(
        "Timed out waiting for DEPOSIT_FULL_ONCHAIN",
        L25_ERROR_CODES.TIMEOUT,
        {
            seatFunded: stack.seatFundedEvents.length,
            fullOnChain: stack.fullOnChainEvents.length
        }
    );

}

/**
 * Poll until domain DEPOSIT_FULL + VALID authorization.
 */
export async function waitForAuthorizationValid(stack, {
    timeoutMs = 60_000,
    pollMs = 1_000
} = {}) {

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {

        if (stack.depositFullEvents.length > 0 && stack.authValidEvents.length > 0) {

            return {
                depositFull: stack.depositFullEvents[stack.depositFullEvents.length - 1],
                authorization: stack.authValidEvents[stack.authValidEvents.length - 1]
            };

        }

        // Domain transition may already be in flight from EventBus handlers.
        await sleep(pollMs);

    }

    throw new L25TestError(
        "Timed out waiting for DEPOSIT_FULL / DEPLOY_AUTHORIZATION_VALID",
        L25_ERROR_CODES.TIMEOUT,
        {
            depositFullCount: stack.depositFullEvents.length,
            authValidCount: stack.authValidEvents.length
        }
    );

}

export function buildFailureDiagnostic(stack, phase, error, extra = {}) {

    const session = stack?.depositSessionCoordinator
        ?.getByRoomAndGame?.(stack.roomId, stack.gameId)
        ?? null;

    return Object.freeze({
        phase,
        depositId: session?.depositId ?? null,
        roomId: stack?.roomId ?? null,
        gameId: stack?.gameId ?? null,
        depositAddress: session?.depositAddress ?? null,
        sessionState: session?.state ?? null,
        errorCode: error?.code ?? null,
        errorMessage: error?.message ?? String(error),
        ...extra
    });

}
