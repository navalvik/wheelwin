/**
 * R17.9L.14B — TESTNET Deposit Contract deploy + read-only verification.
 *
 * Uses TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC only via getTestnetDepositDeployer().
 * Does NOT use TON_DEPLOYER_MNEMONIC / WheelWin Deploy Wallet.
 * Does NOT deploy Game Contract. Does NOT send FundSeat.
 *
 * Usage:
 *   node server/scripts/r179l14_deploy_deposit_testnet.mjs
 *   node server/scripts/r179l14_deploy_deposit_testnet.mjs --execute
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadTonConfig } from "../config/ton.js";
import { DepositMonitor } from "../deposit/DepositMonitor.js";
import { DepositSession } from "../deposit/DepositSession.js";
import { TonFinancialDepositPersistence } from "../deposit/DepositPersistencePort.js";
import { TonFinancialDepositObservationPersistence } from "../deposit/DepositObservationPersistencePort.js";
import { DepositSessionCoordinator } from "../deposit/DepositSessionCoordinator.js";
import { DEPOSIT_SESSION_STATUS } from "../deposit/DepositSessionStates.js";
import {
    DEPOSIT_ACCOUNT_STATE,
    RealTonDepositBlockchainSource
} from "../deposit/RealTonDepositBlockchainSource.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import {
    assertDedicatedTestnetDepositDeployer,
    assertSenderIsNotProductionDeployWallet,
    assertTestnetNetworkConfig,
    DepositTestnetDeployError,
    prepareDepositTestnetDeployPlan,
    TESTNET_DEPLOYMENT_CREDENTIAL_REQUIRED,
    toPublicDeployPlan
} from "../payment/ton/depositTestnetDeploy.js";
import {
    FROZEN_DEPOSIT_ARTIFACT_SHA256,
    FROZEN_DEPOSIT_CODE_CELL_HASH,
    FROZEN_DEPOSIT_EXPECTED_ADDRESS,
    PRODUCTION_DEPLOY_WALLET
} from "../payment/ton/depositTestnetFixture.js";
import { canonicalizeTonWalletAddress } from "../models/TonWalletAddress.js";
import { executeDepositTestnetDeploy } from "../payment/ton/executeDepositTestnetDeploy.js";
import {
    TESTNET_DEPOSIT_DEPLOYER_CREDENTIAL_REQUIRED,
    getTestnetDepositDeployer
} from "../payment/ton/getTestnetDepositDeployer.js";
import {
    assertImmutableGettersMatchPlan,
    assertInitialMutableState,
    readFullDepositGetters
} from "../payment/ton/readDepositGetters.js";
import { TonFinancialRecovery } from "../recovery/TonFinancialRecovery.js";
import { TonService } from "../services/TonService.js";

const currentDir = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(filePath) {

    if (!existsSync(filePath)) {

        return;

    }

    for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {

        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith("#")) {

            continue;

        }

        const index = trimmed.indexOf("=");

        if (index <= 0) {

            continue;

        }

        const key = trimmed.slice(0, index).trim();
        let value = trimmed.slice(index + 1).trim();

        if (
            (value.startsWith("\"") && value.endsWith("\""))
            || (value.startsWith("'") && value.endsWith("'"))
        ) {

            value = value.slice(1, -1);

        }

        if (process.env[key] === undefined) {

            process.env[key] = value;

        }

    }

}

for (const candidate of [
    resolve(currentDir, "../.env"),
    resolve(currentDir, "../../.env"),
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "server/.env")
]) {

    loadEnvFile(candidate);

}

function logPublic(label, value) {

    process.stdout.write(`${label}=${value}\n`);

}

function createLogger() {

    return {
        info(message) {

            process.stdout.write(`${message}\n`);

        },
        warn(message) {

            process.stderr.write(`${message}\n`);

        },
        error(message) {

            process.stderr.write(`${message}\n`);

        },
        debug() {},
        decisionTrace() {}
    };

}

function isMissingDedicatedCredential(error) {

    return error instanceof DepositTestnetDeployError
        && (
            error.code === TESTNET_DEPOSIT_DEPLOYER_CREDENTIAL_REQUIRED
            || error.code === "TESTNET_DEPLOYMENT_CREDENTIAL_REQUIRED"
        );

}

function createSanitizedTestnetTonConfig(env) {

    const loaded = loadTonConfig(env);

    if (loaded.network !== "testnet") {

        throw new DepositTestnetDeployError(
            "TESTNET_DEPOSIT_DEPLOYER_REQUIRES_TESTNET",
            { code: "TESTNET_DEPOSIT_DEPLOYER_REQUIRES_TESTNET" }
        );

    }

    return {
        ...loaded,
        network: "testnet",
        deployerMnemonic: null
    };

}

function fixtureBindings(plan) {

    return [
        {
            playerId: "seat0",
            wallet: plan.player0,
            expectedAmount: Number(plan.expectedStake0)
        },
        {
            playerId: "seat1",
            wallet: plan.player1,
            expectedAmount: Number(plan.expectedStake1)
        },
        {
            playerId: "seat2",
            wallet: plan.player2,
            expectedAmount: Number(plan.expectedStake2)
        }
    ];

}

async function runWatchAndRestart({ plan, source, eventBus, logger }) {

    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-r179l14b-"));
    const persistence = new TonFinancialPersistence({
        dataDir,
        autoCheckpoint: false
    });

    persistence.initialize();

    const emitted = [];

    for (const type of [
        EVENT_TYPES.DEPLOY_AUTHORIZATION_CREATED,
        EVENT_TYPES.DEPLOY_AUTHORIZATION_VALID,
        EVENT_TYPES.GAME_CONTRACT_DEPLOYED,
        EVENT_TYPES.GAME_INITIALIZED
    ]) {

        eventBus.subscribe(type, (envelope) => {

            emitted.push(envelope.type);

        });

    }

    const depositPersistence = new TonFinancialDepositPersistence(persistence);
    const coordinator = new DepositSessionCoordinator({
        eventBus,
        persistence: depositPersistence
    });

    const session = new DepositSession({
        depositId: plan.depositId,
        roomId: plan.roomId,
        gameId: plan.gameId,
        state: DEPOSIT_SESSION_STATUS.AWAITING_FUNDS,
        depositAddress: plan.expectedAddress,
        bindings: fixtureBindings(plan),
        metadata: { network: "testnet" }
    });

    depositPersistence.saveDepositSession(session);
    coordinator.restoreFromPersistence(plan.depositId);

    const monitor = new DepositMonitor({
        logger,
        eventBus,
        depositSessionCoordinator: coordinator,
        persistence: new TonFinancialDepositObservationPersistence(persistence),
        blockchainSource: source,
        network: "testnet"
    });

    monitor.initialize();
    monitor.startWatching(coordinator.getSession(plan.depositId));

    async function pollUntilOk(instance, label) {

        let last = null;

        for (let attempt = 1; attempt <= 5; attempt += 1) {

            last = await instance.poll();

            if (last.results[0]?.ok === true) {

                return last;

            }

            process.stdout.write(
                `${label} poll attempt ${attempt} not ok; waiting before retry\n`
            );
            await new Promise((resolve) => setTimeout(resolve, 8000));

        }

        return last;

    }

    const firstPoll = await pollUntilOk(monitor, "first");

    monitor.shutdown();

    const restoredCoordinator = new DepositSessionCoordinator({
        eventBus,
        persistence: depositPersistence
    });

    const restoredMonitor = new DepositMonitor({
        logger,
        eventBus,
        depositSessionCoordinator: restoredCoordinator,
        persistence: new TonFinancialDepositObservationPersistence(persistence),
        blockchainSource: source,
        network: "testnet"
    });

    restoredMonitor.initialize();

    const recovery = new TonFinancialRecovery({
        logger,
        eventBus,
        financialPersistence: persistence,
        depositSessionCoordinator: restoredCoordinator,
        depositMonitor: restoredMonitor
    });

    recovery.initialize();

    const recoveryReport = await recovery.recover({
        trigger: "r179l14b-restart",
        reason: "isolated DepositMonitor restart verification"
    });

    const secondPoll = await pollUntilOk(restoredMonitor, "restart");

    return Object.freeze({
        firstPollOk: firstPoll.results[0]?.ok === true,
        firstObserved: firstPoll.observed,
        restored: restoredMonitor.listActiveWatches().length,
        recoveryErrors: recoveryReport?.errors?.length ?? 0,
        secondPollOk: secondPoll.results[0]?.ok === true,
        secondAddress: secondPoll.results[0]?.contractState?.address ?? null,
        secondCodeHash: secondPoll.results[0]?.contractState?.codeHash ?? null,
        secondObserved: secondPoll.observed,
        sideEffectEvents: emitted.slice()
    });

}

async function main() {

    const execute = process.argv.includes("--execute");
    const verifyOnly = process.argv.includes("--verify-only");

    process.stdout.write("R17.9L.14B TESTNET Deposit deploy + read-only verification\n");

    const network = assertTestnetNetworkConfig(process.env);

    logPublic("network", network.network);
    logPublic("endpointHost", new URL(network.endpoint).host);
    logPublic("artifactSha256Expected", FROZEN_DEPOSIT_ARTIFACT_SHA256);
    logPublic("expectedCodeCellHash", FROZEN_DEPOSIT_CODE_CELL_HASH);
    logPublic("frozenExpectedAddress", FROZEN_DEPOSIT_EXPECTED_ADDRESS);
    logPublic("executeRequested", String(execute));
    logPublic("verifyOnlyRequested", String(verifyOnly));

    const plan = prepareDepositTestnetDeployPlan({ env: process.env });
    const publicPlan = toPublicDeployPlan(plan);

    for (const [key, value] of Object.entries(publicPlan)) {

        logPublic(key, value);

    }

    try {

        assertDedicatedTestnetDepositDeployer(process.env);

    } catch (error) {

        if (isMissingDedicatedCredential(error)) {

            process.stdout.write(`${TESTNET_DEPLOYMENT_CREDENTIAL_REQUIRED}\n`);
            process.stdout.write("BLOCKED — TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC NOT CONFIGURED\n");
            process.stdout.write("NO TRANSACTION\n");
            process.exitCode = 2;

            return;

        }

        if (error.code === "TESTNET_DEPOSIT_DEPLOYER_MUST_NOT_EQUAL_PRODUCTION_DEPLOYER") {

            process.stdout.write("BLOCKED — TESTNET DEPLOYER IS PRODUCTION DEPLOYER\n");
            process.stdout.write("NO TRANSACTION\n");
            process.exitCode = 2;

            return;

        }

        throw error;

    }

    const deployer = await getTestnetDepositDeployer(process.env);

    assertSenderIsNotProductionDeployWallet(deployer.walletAddress);

    logPublic("testnetDepositDeployerRole", deployer.role);
    logPublic("testnetDepositDeployerAddress", deployer.walletAddress);
    logPublic("testnetDepositDeployerAccountId", deployer.accountId);
    logPublic("testnetDepositDeployerWalletVersion", deployer.walletVersion);
    logPublic("testnetDepositDeployerNetworkGlobalId", String(deployer.networkGlobalId));
    logPublic("testnetDepositDeployerWorkchain", String(deployer.workchain));
    logPublic("testnetDepositDeployerSubwalletNumber", String(deployer.subwalletNumber));
    logPublic("productionDeployWallet", PRODUCTION_DEPLOY_WALLET);
    logPublic("addressesIdentical", String(
        (canonicalizeTonWalletAddress(deployer.walletAddress)
            || deployer.walletAddress)
        === (canonicalizeTonWalletAddress(PRODUCTION_DEPLOY_WALLET)
            || PRODUCTION_DEPLOY_WALLET)
    ));

    const tonConfig = createSanitizedTestnetTonConfig(process.env);
    const logger = createLogger();
    const tonService = new TonService({
        logger,
        tonConfig,
        retryPolicy: {
            maxAttempts: 5,
            initialDelayMs: 1000,
            maxDelayMs: 8000,
            multiplier: 2,
            timeoutMs: 30_000
        }
    });

    tonService.initialize();
    await tonService.connect();

    if (tonService.getActiveNetwork() !== "testnet") {

        throw new DepositTestnetDeployError(
            "TonService is not on testnet",
            { code: "TON_SERVICE_NOT_TESTNET" }
        );

    }

    const source = new RealTonDepositBlockchainSource({
        logger,
        tonService,
        network: "testnet",
        expectedArtifactSha256: FROZEN_DEPOSIT_ARTIFACT_SHA256
    });

    const existing = await source.getContractState(plan.expectedAddress);

    logPublic("preDeployAccountState", existing.state);
    logPublic("preDeployCodeHash", existing.codeHash ?? "none");
    logPublic("preDeployBalanceNano", existing.balanceNano == null ? "none" : String(existing.balanceNano));
    logPublic("preDeployLastLt", existing.lastLt ?? "none");

    if (!execute && !verifyOnly) {

        process.stdout.write("Dry-run only (pass --execute to send testnet TON).\n");
        process.stdout.write("NO TRANSACTION\n");
        await tonService.shutdown();

        return;

    }

    if (verifyOnly) {

        process.stdout.write("Verify-only: no deployment transaction will be sent.\n");
        process.stdout.write("NO TRANSACTION\n");

    } else {

    process.stdout.write("\nNETWORK: TESTNET\n");
    process.stdout.write(`SENDER:\n${deployer.walletAddress}\n`);
    process.stdout.write(`TARGET:\n${plan.expectedAddress}\n`);
    process.stdout.write("DEPLOYMENT VALUE:\n0.05 TON\n");
    process.stdout.write(`ARTIFACT SHA256:\n${FROZEN_DEPOSIT_ARTIFACT_SHA256}\n`);
    process.stdout.write("PRODUCTION DEPLOYER USED:\nNO\n");
    process.stdout.write("PLAYER FUNDING:\nNO\n");
    process.stdout.write("GAME CONTRACT:\nNO\n\n");

    if (deployer.walletAddress !== "0QBSm-tvehArk8g8VybQEUpI83rI1IZozP3KUK8WdvMSjaIl"
        || plan.expectedAddress !== FROZEN_DEPOSIT_EXPECTED_ADDRESS
        || plan.artifactSha256 !== FROZEN_DEPOSIT_ARTIFACT_SHA256
        || deployer.walletVersion !== "WalletContractV5R1") {

        throw new DepositTestnetDeployError(
            "Pre-broadcast confirmation values do not match frozen identity",
            { code: "PRE_BROADCAST_CONFIRMATION_MISMATCH" }
        );

    }

    const deployResult = await executeDepositTestnetDeploy({
        env: process.env,
        plan,
        tonService,
        getContractState: (address) => source.getContractState(address),
        send: true
    });

    logPublic("deploymentResult", deployResult.action);
    logPublic("deploymentSent", String(deployResult.sent));
    logPublic("deploymentSender", deployResult.senderAddress);
    logPublic("depositContractAddress", deployResult.expectedAddress);
    logPublic("deploymentTransactionHash", deployResult.transactionHash ?? "unknown");
    logPublic("deploymentLogicalTime", deployResult.logicalTime ?? "unknown");
    logPublic("accountState", deployResult.accountState);
    logPublic("deployValueTon", deployResult.deployValueTon);

    }

    const liveState = await source.getContractState(plan.expectedAddress);

    logPublic("onChainAccountState", liveState.state);
    logPublic("onChainCodeHash", liveState.codeHash ?? "none");
    logPublic("codeHashMatch", String(liveState.codeHash === plan.expectedCodeHash));
    logPublic("addressMatch", String(liveState.address === plan.expectedAddress));

    if (liveState.state !== DEPOSIT_ACCOUNT_STATE.ACTIVE) {

        throw new DepositTestnetDeployError(
            "Deployed account is not ACTIVE",
            { code: "NOT_ACTIVE", state: liveState.state }
        );

    }

    if (liveState.codeHash !== FROZEN_DEPOSIT_CODE_CELL_HASH
        || liveState.codeHash !== plan.expectedCodeHash) {

        throw new DepositTestnetDeployError(
            "On-chain code hash does not match frozen artifact",
            { code: "ONCHAIN_CODE_MISMATCH" }
        );

    }

    const getters = await readFullDepositGetters(tonService, plan.expectedAddress);

    assertImmutableGettersMatchPlan(getters, plan);
    assertInitialMutableState(getters);

    logPublic("getterContractVersion", String(getters.contractVersion));
    logPublic("getterDepositIdHash", String(getters.depositIdHash));
    logPublic("getterRoomIdHash", String(getters.roomIdHash));
    logPublic("getterGameIdHash", String(getters.gameIdHash));
    logPublic("getterPlayer0", getters.player0);
    logPublic("getterPlayer1", getters.player1);
    logPublic("getterPlayer2", getters.player2);
    logPublic("getterExpectedStake0", String(getters.expectedStake0));
    logPublic("getterExpectedStake1", String(getters.expectedStake1));
    logPublic("getterExpectedStake2", String(getters.expectedStake2));
    logPublic("getterCreationFeePerSeat", String(getters.creationFeePerSeat));
    logPublic("getterExpectedAmount0", String(getters.expectedAmount0));
    logPublic("getterExpectedAmount1", String(getters.expectedAmount1));
    logPublic("getterExpectedAmount2", String(getters.expectedAmount2));
    logPublic("getterNetworkTag", String(getters.networkTag));
    logPublic("getterStatus", String(getters.status));
    logPublic("getterPaidMask", String(getters.paidMask));
    logPublic("getterCredited0", String(getters.creditedAmount0));
    logPublic("getterCredited1", String(getters.creditedAmount1));
    logPublic("getterCredited2", String(getters.creditedAmount2));
    logPublic("getterSurplus", String(getters.surplusNano));
    logPublic("getterExpiresAt", String(getters.expiresAt));
    logPublic("getterReleaseAuthority", getters.releaseAuthority);
    logPublic("getterRefundMask", String(getters.refundMask));
    logPublic("getterReleasedTo", getters.releasedTo);
    logPublic("getterTotalCredited", String(getters.totalCredited));
    logPublic("immutableGettersMatch", "YES");
    logPublic("initialStateMatch", "YES");

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();
    const watchResult = await runWatchAndRestart({
        plan,
        source,
        eventBus,
        logger
    });

    logPublic("watchPollOk", String(watchResult.firstPollOk));
    logPublic("watchObservedFunding", String(watchResult.firstObserved));
    logPublic("restartWatchRestored", String(watchResult.restored));
    logPublic("restartPollOk", String(watchResult.secondPollOk));
    logPublic("restartSameAddress", String(watchResult.secondAddress === plan.expectedAddress));
    logPublic("restartSameCode", String(watchResult.secondCodeHash === plan.expectedCodeHash));
    logPublic("restartObservedFunding", String(watchResult.secondObserved));
    logPublic("restartRecoveryErrors", String(watchResult.recoveryErrors));
    logPublic(
        "restartSideEffects",
        watchResult.sideEffectEvents.length ? watchResult.sideEffectEvents.join(",") : "none"
    );

    if (!watchResult.firstPollOk || !watchResult.secondPollOk) {

        throw new DepositTestnetDeployError(
            "Real DepositMonitor poll failed",
            { code: "MONITOR_POLL_FAILED" }
        );

    }

    if (watchResult.firstObserved !== 0 || watchResult.secondObserved !== 0) {

        throw new DepositTestnetDeployError(
            "Unexpected funding observation without FundSeat",
            { code: "UNEXPECTED_FUNDING_OBSERVATION" }
        );

    }

    if (watchResult.sideEffectEvents.length) {

        throw new DepositTestnetDeployError(
            "Forbidden side-effect event emitted",
            { code: "SIDE_EFFECT_EVENT" }
        );

    }

    process.stdout.write("NO PLAYER FUNDING\n");
    process.stdout.write("R17.9L.14E LIVE VERIFICATION COMPLETE\n");

    await tonService.shutdown();

}

main().catch((error) => {

    process.stderr.write(`${error?.message ?? error}\n`);

    if (error?.details?.code === "INSUFFICIENT_TESTNET_TON"
        || error?.code === "INSUFFICIENT_TESTNET_TON") {

        logPublic("blocker", "INSUFFICIENT_TESTNET_TON");
        logPublic("senderAddress", error.details?.senderAddress ?? "unknown");
        logPublic("senderBalanceNano", error.details?.balanceNano ?? "unknown");
        logPublic("requiredNano", error.details?.requiredNano ?? "unknown");

    }

    process.stdout.write("NO TRANSACTION\n");
    process.exitCode = 1;

});
