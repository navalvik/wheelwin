/**
 * R17.9L.25 — Live TESTNET player deployment E2E (opt-in only).
 *
 * Enable:
 *   RUN_TESTNET_R179L25=true
 *   TON_NETWORK=testnet
 *   L25_PLAYER_0_MNEMONIC / L25_PLAYER_1_MNEMONIC / L25_PLAYER_2_MNEMONIC
 *   TON_DEPOSIT_CREATION_FEE_PER_SEAT_NANO
 *   TON_DEPOSIT_STAKE_NANOTON_BY_PROFILE
 *   TON_TESTNET_ORACLE_ADDRESS
 *
 * Never part of ordinary `npm test`. Never uses WheelWin deployers.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadTonConfig } from "../../../config/ton.js";
import { DEPOSIT_ACCOUNT_STATE } from "../../../deposit/RealTonDepositBlockchainSource.js";
import { TonService } from "../../../services/TonService.js";
import {
    deployDepositContractAsPlayer,
    L25_DEFAULT_DEPLOY_VALUE_TON,
    reconstructPackageStateInit
} from "./l25PlayerDepositDeploy.js";
import { fundSeatAsPlayer } from "./l25PlayerFundSeat.js";
import {
    loadL25PlayerWallets,
    toPublicPlayerSnapshot
} from "./l25PlayerWallets.js";
import { assertZeroWheelWinSpend } from "./l25ZeroSpendProof.js";
import {
    buildFailureDiagnostic,
    createL25LiveStack,
    createL25Logger,
    waitForAuthorizationValid,
    waitForDepositFullOnChain
} from "./l25Harness.js";
import { L25_ERROR_CODES, L25TestError } from "./l25Errors.js";
import { l25WithRpcRetry } from "./l25RpcRetry.js";

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
    resolve(currentDir, "../../../.env"),
    resolve(currentDir, "../../../../.env"),
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "server/.env")
]) {

    loadEnvFile(candidate);

}

function isLiveEnabled(env = process.env) {

    const flag = String(env.RUN_TESTNET_R179L25 || "").trim().toLowerCase();

    return flag === "true" || flag === "1" || flag === "yes";

}

function requireEnv(env, keys) {

    const missing = keys.filter((key) => !String(env[key] ?? "").trim());

    if (missing.length) {

        throw new L25TestError(
            `Missing required L.25 environment: ${missing.join(", ")}`,
            L25_ERROR_CODES.ENV_MISSING,
            { missing }
        );

    }

}

function publicLog(label, value) {

    process.stdout.write(`${label}=${typeof value === "string" ? value : JSON.stringify(value)}\n`);

}

async function main() {

    const logger = createL25Logger();
    const env = process.env;

    if (!isLiveEnabled(env)) {

        publicLog("status", "SKIPPED");
        publicLog("reason", "RUN_TESTNET_R179L25 not enabled");
        publicLog("hint", "npm run testnet:r179l25 with RUN_TESTNET_R179L25=true");
        process.exit(0);

    }

    if (String(env.TON_NETWORK || "").toLowerCase() === "mainnet") {

        throw new L25TestError(
            "Refusing to run L.25 on mainnet",
            L25_ERROR_CODES.ENV_DISABLED
        );

    }

    env.TON_NETWORK = "testnet";

    requireEnv(env, [
        "TON_TESTNET_ORACLE_ADDRESS",
        "TON_DEPOSIT_CREATION_FEE_PER_SEAT_NANO",
        "TON_DEPOSIT_STAKE_NANOTON_BY_PROFILE",
        "L25_PLAYER_0_MNEMONIC",
        "L25_PLAYER_1_MNEMONIC",
        "L25_PLAYER_2_MNEMONIC"
    ]);

    if (!env.TON_DEPOSIT_TIMEOUT_MS) {

        env.TON_DEPOSIT_TIMEOUT_MS = "1200000";

    }

    const tonConfig = loadTonConfig(env);
    const tonService = new TonService({
        logger,
        tonConfig
    });

    tonService.initialize();

    const playerWallets = await loadL25PlayerWallets(env);

    publicLog("players", toPublicPlayerSnapshot(playerWallets));

    const stack = createL25LiveStack({
        tonService,
        playerWallets,
        env,
        network: "testnet"
    });

    const windowStartMs = Date.now();
    const playerTxHashes = [];
    let phase = "PREPARE";

    try {

        // ── Phase B: orchestration ──
        phase = "ORCHESTRATION";

        const orchestration = await stack.depositOrchestrator
            .handlePaymentConnectionReady({ roomId: stack.roomId });

        if (orchestration.activationStatus
            !== stack.DEPOSIT_ACTIVATION_STATUS.WAITING_FOR_PLAYER_DEPLOYMENT) {

            throw new L25TestError(
                "Expected WAITING_FOR_PLAYER_DEPLOYMENT before player deploy",
                L25_ERROR_CODES.PHASE_FAILED,
                { activationStatus: orchestration.activationStatus }
            );

        }

        const session = stack.depositSessionCoordinator.getSession(
            orchestration.depositId
        );

        if (!session
            || session.state !== stack.DEPOSIT_SESSION_STATUS.AWAITING_FUNDS
            || !session.metadata?.depositPackage
            || !session.depositAddress) {

            throw new L25TestError(
                "Orchestration did not produce AWAITING_FUNDS package session",
                L25_ERROR_CODES.PHASE_FAILED
            );

        }

        if (stack.packageEvents.length < 1) {

            throw new L25TestError(
                "DEPOSIT_PACKAGE_PUBLISHED was not emitted",
                L25_ERROR_CODES.PHASE_FAILED
            );

        }

        publicLog("depositId", session.depositId);
        publicLog("depositAddress", session.depositAddress);
        publicLog("phaseB", "PASS");

        // ── Phase C: player deploy ──
        phase = "PLAYER_DEPLOY";

        const depositPackage = session.metadata.depositPackage;
        const reconstructed = reconstructPackageStateInit(depositPackage);

        publicLog("stateInitAddressMatch", reconstructed.addressCanonical);

        const deployResult = await deployDepositContractAsPlayer({
            depositPackage,
            playerWallet: playerWallets[0],
            tonService,
            getContractState: (address) => l25WithRpcRetry(
                () => stack.blockchainSource.getContractState(address),
                { operationName: "getContractState/deploy" }
            ),
            deployValueTon: env.L25_DEPOSIT_DEPLOY_VALUE_TON
                || L25_DEFAULT_DEPLOY_VALUE_TON,
            env
        });

        playerTxHashes.push(deployResult.transactionHash);
        publicLog("deploySender", deployResult.senderAddress);
        publicLog("deployTx", deployResult.transactionHash);
        publicLog("phaseC", "PASS");

        // ── Phase D: activation ──
        phase = "ACTIVATION";

        const activation = await stack.depositActivationVerification
            .verifyActivation(session.depositId);

        if (activation.status !== stack.DEPOSIT_ACTIVATION_STATUS.VERIFIED
            && activation.status !== stack.DEPOSIT_ACTIVATION_STATUS.ALREADY_VERIFIED) {

            throw new L25TestError(
                "L.22 did not VERIFIED after ACTIVE deploy",
                L25_ERROR_CODES.PHASE_FAILED,
                { activationStatus: activation.status }
            );

        }

        if (activation.watchStarted !== true
            || stack.depositMonitor.listActiveWatches().length < 1) {

            throw new L25TestError(
                "DepositMonitor watch did not start after VERIFIED",
                L25_ERROR_CODES.PHASE_FAILED,
                {
                    watchStarted: activation.watchStarted,
                    watches: stack.depositMonitor.listActiveWatches().length
                }
            );

        }

        publicLog("activationStatus", activation.status);
        publicLog("watchStarted", true);
        publicLog("phaseD", "PASS");

        // ── Phase E: FundSeat × 3 ──
        phase = "FUNDING";

        const refreshed = stack.depositSessionCoordinator.getSession(session.depositId);

        for (let seatIndex = 0; seatIndex < 3; seatIndex += 1) {

            const fundResult = await fundSeatAsPlayer({
                session: refreshed,
                playerWallet: playerWallets[seatIndex],
                seatIndex,
                tonService,
                env
            });

            playerTxHashes.push(fundResult.transactionHash);
            publicLog(`fundSeat${seatIndex}Tx`, fundResult.transactionHash);
            publicLog(`fundSeat${seatIndex}ValueNano`, fundResult.valueNano);

        }

        publicLog("phaseE", "PASS");

        // ── Phase F: monitor + FULL + VALID ──
        phase = "MONITOR_FULL";

        await waitForDepositFullOnChain(stack);
        publicLog("depositFullOnChain", true);

        await waitForAuthorizationValid(stack);

        const auth = stack.deploymentAuthorizationCoordinator
            .getByRoomAndGame(stack.roomId, stack.gameId);

        if (!auth || auth.status !== stack.DEPLOYMENT_AUTHORIZATION_STATUS.VALID) {

            throw new L25TestError(
                "DeploymentAuthorization did not become VALID",
                L25_ERROR_CODES.PHASE_FAILED,
                { status: auth?.status ?? null }
            );

        }

        publicLog("authorizationStatus", auth.status);
        publicLog("phaseF", "PASS");

        // ── Phase G: zero-spend + isolation ──
        phase = "ZERO_SPEND";

        if (stack.gameContractDeployCalls.length !== 0) {

            throw new L25TestError(
                "GameContract deployment was invoked",
                L25_ERROR_CODES.PHASE_FAILED,
                { calls: stack.gameContractDeployCalls.length }
            );

        }

        const zeroSpend = await assertZeroWheelWinSpend({
            tonService,
            depositAddress: refreshed.depositAddress,
            windowStartMs,
            windowEndMs: Date.now(),
            env
        });

        publicLog("zeroSpend", {
            ok: zeroSpend.ok,
            watchedWallets: zeroSpend.watchedWallets,
            violations: 0
        });

        publicLog("playerTxHashes", playerTxHashes.filter(Boolean));
        publicLog("gameContractDeployCalls", 0);
        publicLog("verdict", "R17.9L.25 PASS");
        publicLog("wheelWinSpendBeforeDepositFull", 0);

        stack.shutdown();
        process.exit(0);

    } catch (error) {

        const diagnostic = buildFailureDiagnostic(stack, phase, error, {
            playerTxHashes: playerTxHashes.filter(Boolean),
            players: toPublicPlayerSnapshot(playerWallets)
        });

        publicLog("verdict", "R17.9L.25 BLOCKED");
        publicLog("diagnostic", diagnostic);

        try {

            stack.shutdown();

        } catch {

            // ignore

        }

        process.exit(1);

    }

}

main().catch((error) => {

    process.stderr.write(`[L25 FATAL] ${error?.message ?? error}\n`);
    process.exit(1);

});
