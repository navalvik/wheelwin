/**
 * R18-S15 — Drive the REAL WheelWinApplication lobby to Page5 on TESTNET.
 * Starts production `app.js`. Does not emit lifecycle events manually.
 * Does not print secrets.
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Address, beginCell, external, internal, SendMode, storeMessage, toNano } from "@ton/core";
import { io } from "socket.io-client";

import { loadTonConfig } from "../config/ton.js";
import { RealTonDepositBlockchainSource } from "../deposit/RealTonDepositBlockchainSource.js";
import { serializeGameEscrowStakeBody } from "../payment/ton/gameContract/GameContractSerializer.js";
import { TonService } from "../services/TonService.js";
import { deployDepositContractAsPlayer } from "../tests/testnet/r179l25/l25PlayerDepositDeploy.js";
import { fundSeatAsPlayer } from "../tests/testnet/r179l25/l25PlayerFundSeat.js";
import { loadL25PlayerWallets, toPublicPlayerSnapshot } from "../tests/testnet/r179l25/l25PlayerWallets.js";
import { l25Sleep, l25WithRpcRetry } from "../tests/testnet/r179l25/l25RpcRetry.js";
import {
    assertFundSeatAllowedAfterVerified,
    createProductionLogScanner,
    DEPOSIT_ACTIVATION_VERIFIED,
    DEPOSIT_ACTIVATION_WAITING,
    DEPOSIT_FULL_ONCHAIN,
    DEPLOY_AUTHORIZATION_VALID,
    isPersistedActivationVerified
} from "../tests/testnet/r18s15/depositActivationOrdering.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(currentDir, "..");
const PLAYER_SEND_MODE = SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS;

const TRACKED_EVENTS = Object.freeze([
    "roomCreated",
    "roomJoined",
    "roomState",
    "roomError",
    "startGame",
    "PLAYER_UPDATE",
    "SECRET_MATRIX_ACCEPTED",
    "SECRET_MATRIX_REJECTED",
    "VERIFY_COMPLETED",
    "PAYMENT_STAGE_READY",
    "WALLET_CONNECTION_SESSION_UPDATED",
    "PAYMENT_CONNECTION_READY",
    "PAYMENT_SESSION_CREATED",
    "PAYMENT_SESSION_UPDATED",
    "DEPOSIT_PACKAGE_PUBLISHED",
    "DEPOSIT_ACTIVATION_WAITING",
    "DEPOSIT_ACTIVATION_VERIFIED",
    "DEPOSIT_FULL_ONCHAIN",
    "DEPLOY_AUTHORIZATION_VALID",
    "GAME_CONTRACT_UPDATED",
    "GAME_CONTRACT_DEPLOYED",
    "GAME_CONTRACT_DEPLOY_FAILED",
    "PAYMENT_REQUEST",
    "PAYMENT_SESSION_COMPLETED",
    "PAYMENT_SESSION_FAILED",
    "GAME_START_AUTHORIZED",
    "GAME_START_BOOTSTRAP_READY",
    "GAME_INITIALIZING",
    "ENTRY_PAYMENT_COMPLETED",
    "OPEN_PAGE5"
]);

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
    resolve(SERVER_DIR, ".env"),
    resolve(currentDir, "../../.env"),
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "server/.env")
]) {

    loadEnvFile(candidate);

}

function publicLog(label, value) {

    process.stdout.write(
        `${label}=${typeof value === "string" ? value : JSON.stringify(value)}\n`
    );

}

function signTelegramInitData(botToken, userId, label) {

    const authDate = String(Math.floor(Date.now() / 1000));
    const user = JSON.stringify({
        id: userId,
        first_name: label,
        username: label.toLowerCase()
    });
    const fields = {
        auth_date: authDate,
        query_id: `r18s15_${userId}`,
        user
    };
    const dataCheckString = Object.keys(fields)
        .sort()
        .map((key) => `${key}=${fields[key]}`)
        .join("\n");
    const secretKey = crypto
        .createHmac("sha256", "WebAppData")
        .update(botToken)
        .digest();
    const hash = crypto
        .createHmac("sha256", secretKey)
        .update(dataCheckString)
        .digest("hex");

    return Object.entries({ ...fields, hash })
        .map(([key, value]) => `${key}=${value}`)
        .join("&");

}

function waitFor(socket, eventName, timeoutMs, predicate = null) {

    return new Promise((resolve, reject) => {

        const timer = setTimeout(() => {

            socket.off(eventName, onEvent);
            reject(new Error(`timeout waiting for ${eventName}`));

        }, timeoutMs);

        function onEvent(payload) {

            if (predicate && !predicate(payload)) {

                return;

            }

            clearTimeout(timer);
            socket.off(eventName, onEvent);
            resolve(payload);

        }

        socket.on(eventName, onEvent);

    });

}

function attachTracker(socket, bag, seatLabel) {

    for (const eventName of TRACKED_EVENTS) {

        socket.on(eventName, (payload) => {

            bag.push({
                at: Date.now(),
                seat: seatLabel,
                event: eventName,
                roomId: payload?.roomId ?? payload?.deposit?.roomId ?? null,
                gameId: payload?.gameId ?? payload?.deposit?.gameId ?? null,
                contractAddress: payload?.contractAddress ?? null,
                code: payload?.code ?? null
            });

            if (
                eventName === "roomError"
                || eventName === "GAME_CONTRACT_DEPLOY_FAILED"
                || eventName === "PAYMENT_SESSION_FAILED"
                || eventName === "OPEN_PAGE5"
                || eventName === "PAYMENT_SESSION_COMPLETED"
                || eventName === "DEPOSIT_PACKAGE_PUBLISHED"
                || eventName === "GAME_CONTRACT_DEPLOYED"
            ) {

                publicLog("socketEvent", {
                    seat: seatLabel,
                    event: eventName,
                    roomId: payload?.roomId ?? payload?.deposit?.roomId ?? null,
                    gameId: payload?.gameId ?? null,
                    code: payload?.code ?? null,
                    contractAddress: payload?.contractAddress ?? null,
                    depositAddress: payload?.deposit?.depositAddress ?? null
                });

            }

        });

    }

}

async function connectSeat({ url, origin, initData, label, bag }) {

    const socket = io(url, {
        transports: ["websocket"],
        extraHeaders: origin ? { Origin: origin } : undefined,
        auth: { telegramInitData: initData }
    });

    attachTracker(socket, bag, label);

    await new Promise((resolve, reject) => {

        const timer = setTimeout(() => {

            reject(new Error(`${label} socket connect timeout`));

        }, 15_000);

        socket.once("connect", () => {

            clearTimeout(timer);
            resolve();

        });

        socket.once("connect_error", (error) => {

            clearTimeout(timer);
            reject(error);

        });

    });

    return socket;

}

async function waitHealth(url, timeoutMs) {

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {

        try {

            const response = await fetch(url);

            if (response.ok) {

                return true;

            }

        } catch {

            // starting

        }

        await l25Sleep(1_000);

    }

    return false;

}

async function sendStake({ playerWallet, contractAddress, playerIndex, requiredGram, tonService }) {

    const amount = toNano(String(requiredGram));
    const walletAddress = playerWallet.wallet.address.toString({
        bounceable: false,
        urlSafe: true,
        testOnly: true
    });
    const balance = await l25WithRpcRetry(
        () => tonService.getBalance(playerWallet.address),
        { operationName: "getBalance/stake" }
    );

    if (balance < amount + 50_000_000n) {

        return {
            ok: false,
            reason: "insufficient_balance",
            seat: playerIndex,
            sender: playerWallet.addressCanonical,
            balanceNano: balance.toString(),
            requiredNano: amount.toString()
        };

    }

    let seqno = await l25WithRpcRetry(
        () => tonService.getSeqno(walletAddress),
        { operationName: "getSeqno/stake" }
    );

    if (!Number.isInteger(seqno) || seqno < 0) {

        seqno = 0;

    }

    const body = serializeGameEscrowStakeBody({ playerIndex });
    const transfer = playerWallet.wallet.createTransfer({
        seqno,
        secretKey: playerWallet.keyPair.secretKey,
        sendMode: PLAYER_SEND_MODE,
        messages: [
            internal({
                to: Address.parse(contractAddress),
                value: amount,
                body,
                bounce: true
            })
        ]
    });
    const externalMessage = external({
        to: playerWallet.wallet.address,
        init: seqno === 0 ? playerWallet.wallet.init : undefined,
        body: transfer
    });
    const bocBase64 = beginCell()
        .store(storeMessage(externalMessage))
        .endCell()
        .toBoc()
        .toString("base64");
    const broadcast = await l25WithRpcRetry(
        () => tonService.broadcastTransaction(bocBase64),
        { operationName: "broadcastTransaction/stake" }
    );

    return {
        ok: true,
        seat: playerIndex,
        sender: playerWallet.addressCanonical,
        requiredGram,
        valueNano: amount.toString(),
        transactionHash: broadcast?.hash ?? null,
        sentSeqno: seqno
    };

}

async function readIntGetter(tonService, address, method) {

    const result = await tonService.runGetMethod(address, method, []);
    const stack = result?.stack;

    if (stack && typeof stack.readNumber === "function") {

        return stack.readNumber();

    }

    const item = Array.isArray(stack) ? stack[0] : stack?.items?.[0];

    if (item == null) {

        return null;

    }

    if (typeof item === "bigint" || typeof item === "number") {

        return Number(item);

    }

    if (Array.isArray(item)) {

        return Number(item[1]);

    }

    return Number(item.value ?? item.num ?? null);

}

function spawnProductionServer(scanner) {

    const child = spawn(process.execPath, ["app.js"], {
        cwd: SERVER_DIR,
        env: {
            ...process.env,
            TON_NETWORK: "testnet",
            TON_DEPLOY_MODE: "live"
        },
        stdio: ["ignore", "pipe", "pipe"]
    });

    const write = (prefix, chunk) => {

        const text = chunk.toString();

        scanner?.push(text);
        process.stdout.write(`${prefix}${chunk}`);

    };

    child.stdout.on("data", (chunk) => write("[APP] ", chunk));
    child.stderr.on("data", (chunk) => write("[APP ERR] ", chunk));

    return child;

}

function readDepositSessionRecord(depositId) {

    const filePath = join(
        SERVER_DIR,
        "data",
        "ton-financial",
        "active",
        "deposit_session",
        `${depositId}.json`
    );

    if (!existsSync(filePath)) {

        return null;

    }

    try {

        return JSON.parse(readFileSync(filePath, "utf8"));

    } catch {

        return null;

    }

}

async function waitForEventBusType(scanner, eventType, timeoutMs) {

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {

        if (scanner.hasEventBusType(eventType)) {

            return { eventType, at: Date.now() };

        }

        await l25Sleep(250);

    }

    throw new Error(`timeout waiting for ${eventType}`);

}

async function waitForMatchingActivationVerified({
    scanner,
    expected,
    timeoutMs
}) {

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {

        if (scanner.hasEventBusType(DEPOSIT_ACTIVATION_VERIFIED)) {

            const record = readDepositSessionRecord(expected.depositId);

            if (isPersistedActivationVerified(record, expected)) {

                return {
                    depositId: expected.depositId,
                    roomId: expected.roomId,
                    gameId: expected.gameId,
                    at: Date.now()
                };

            }

        }

        await l25Sleep(250);

    }

    throw new Error(
        "timeout waiting for DEPOSIT_ACTIVATION_VERIFIED"
        + ` depositId=${expected.depositId}`
    );

}

async function main() {

    const env = process.env;

    if (String(env.TON_NETWORK || "").toLowerCase() === "mainnet") {

        publicLog("status", "STOP");
        publicLog("reason", "MAINNET");
        process.exit(2);

    }

    env.TON_NETWORK = "testnet";

    const tonConfig = loadTonConfig(env);

    if (tonConfig.network !== "testnet" || /mainnet/i.test(tonConfig.endpoint || "")) {

        publicLog("status", "STOP");
        publicLog("reason", "not_testnet");
        process.exit(2);

    }

    if (tonConfig.deployMode !== "live") {

        publicLog("status", "STOP");
        publicLog("reason", "deploy_mode_not_live");
        publicLog("deployMode", tonConfig.deployMode);
        process.exit(2);

    }

    const botToken = String(env.TELEGRAM_BOT_TOKEN || "").trim();

    if (!botToken) {

        publicLog("status", "BLOCKED");
        publicLog("blocker", "configuration");
        publicLog("reason", "TELEGRAM_BOT_TOKEN missing; CREATE_ROOM requires Telegram");
        process.exit(3);

    }

    const port = Number(env.PORT || 3001);
    const origin = String(env.CLIENT_ORIGIN || "http://127.0.0.1:5173")
        .split(",")[0]
        .trim();
    const url = `http://127.0.0.1:${port}`;

    publicLog("composition", "WheelWinApplication app.js");
    publicLog("tonNetwork", tonConfig.network);
    publicLog("tonEndpoint", tonConfig.endpoint);
    publicLog("deployMode", tonConfig.deployMode);
    publicLog("serverUrl", url);

    const events = [];
    const appLogScanner = createProductionLogScanner();
    const child = spawnProductionServer(appLogScanner);
    let shuttingDown = false;

    const shutdown = () => {

        if (shuttingDown) {

            return;

        }

        shuttingDown = true;
        child.kill("SIGTERM");

    };

    process.on("exit", shutdown);

    publicLog("phase", "START_PRODUCTION_SERVER");

    const ready = await waitHealth(`${url}/health`, 180_000);

    if (!ready) {

        publicLog("status", "BLOCKED");
        publicLog("blocker", "environment");
        publicLog("reason", "production app.js did not become /health ready");
        shutdown();
        process.exit(4);

    }

    publicLog("productionServerReady", true);

    const playerWallets = await loadL25PlayerWallets(env);

    publicLog("players", toPublicPlayerSnapshot(playerWallets));

    const telegramIds = [
        871000001 + Math.floor(Date.now() % 1000),
        871000101 + Math.floor(Date.now() % 1000),
        871000201 + Math.floor(Date.now() % 1000)
    ];

    const sockets = [];

    for (let index = 0; index < 3; index += 1) {

        const socket = await connectSeat({
            url,
            origin,
            initData: signTelegramInitData(botToken, telegramIds[index], `P${index}`),
            label: `p${index}`,
            bag: events
        });

        sockets.push(socket);

    }

    publicLog("phase", "CREATE_ROOM");

    const createdPromise = waitFor(sockets[0], "roomCreated", 15_000);

    sockets[0].emit("createRoom");

    let created;

    try {

        created = await createdPromise;

    } catch (error) {

        publicLog("status", "BLOCKED");
        publicLog("lastVerified", "production_server_ready");
        publicLog("nextExpected", "roomCreated");
        publicLog("blocker", "application_code");
        publicLog("reason", error.message);
        publicLog("hint", "CREATE_ROOM requires authenticated Telegram socket identity");
        shutdown();
        process.exit(6);

    }

    publicLog("roomId", created.roomId);
    publicLog("creatorPlayerId", created.playerId);

    publicLog("phase", "JOIN_ROOM");

    const joined1Promise = waitFor(sockets[1], "roomJoined", 15_000);
    const joined2Promise = waitFor(sockets[2], "roomJoined", 15_000);
    const startGamePromise = waitFor(sockets[0], "startGame", 20_000);

    sockets[1].emit("joinRoom", created.roomId);
    sockets[2].emit("joinRoom", created.roomId);

    const [joined1, joined2, startGame] = await Promise.all([
        joined1Promise,
        joined2Promise,
        startGamePromise
    ]);

    const playerIds = [
        created.playerId,
        joined1.playerId,
        joined2.playerId
    ];
    const gameId = startGame?.gameId ?? null;

    publicLog("playerIds", playerIds);
    publicLog("gameId", gameId);
    publicLog("startGamePlayers", startGame?.players?.length ?? 0);

    publicLog("phase", "PROFILES");

    const profiles = [
        { nickname: "P0", age: 30, color: "Red", sectorCount: 1, baseStake: 1 },
        { nickname: "P1", age: 25, color: "Green", sectorCount: 1, baseStake: 1 },
        { nickname: "P2", age: 28, color: "Blue", sectorCount: 1, baseStake: 1 }
    ];

    for (let index = 0; index < 3; index += 1) {

        const ack = waitFor(
            sockets[index],
            "PLAYER_UPDATE",
            10_000,
            (payload) => payload?.playerId === playerIds[index]
        );

        sockets[index].emit("updatePlayerProfile", profiles[index]);
        await ack;

    }

    publicLog("phase", "SECRET_MATRIX");

    const matrix = ["A", "1", "B", "2", "C", "3", "D", "4", "E"];
    const matrixAcks = sockets.map((socket) =>
        waitFor(socket, "SECRET_MATRIX_ACCEPTED", 15_000)
    );

    for (const socket of sockets) {

        socket.emit("submitSecretMatrix", matrix);

    }

    await Promise.all(matrixAcks);

    publicLog("phase", "VERIFY");

    const verifyDone = waitFor(sockets[0], "VERIFY_COMPLETED", 15_000);

    for (const socket of sockets) {

        socket.emit("confirmVerify");

    }

    await verifyDone;

    publicLog("phase", "VERIFY_NEXT_WALLETS");

    const paymentReady = waitFor(sockets[0], "PAYMENT_STAGE_READY", 20_000);

    for (let index = 0; index < 3; index += 1) {

        sockets[index].emit("VERIFY_NEXT_REQUEST", {
            roomId: created.roomId,
            playerId: playerIds[index],
            walletAddress: playerWallets[index].addressCanonical
        });

    }

    await paymentReady;
    publicLog("paymentStageReady", true);

    publicLog("phase", "WALLET_CONNECT");

    const connectionReady = waitFor(sockets[0], "PAYMENT_CONNECTION_READY", 20_000);
    const depositBySeat = [null, null, null];
    const packagePromises = sockets.map((socket, index) =>
        waitFor(socket, "DEPOSIT_PACKAGE_PUBLISHED", 30_000).then((payload) => {

            depositBySeat[index] = payload.deposit ?? payload;

            return depositBySeat[index];

        })
    );
    const sessionCreated = waitFor(sockets[0], "PAYMENT_SESSION_CREATED", 20_000)
        .catch(() => null);

    for (let index = 0; index < 3; index += 1) {

        sockets[index].emit("WALLET_CONNECT_STARTED");
        sockets[index].emit("WALLET_CONNECT_REPORT", {
            connectedWallet: playerWallets[index].addressCanonical
        });

    }

    await connectionReady;
    publicLog("paymentConnectionReady", true);

    const paymentSessionCreated = await sessionCreated;

    publicLog("paymentSessionCreated", Boolean(paymentSessionCreated));
    publicLog(
        "paymentSessionId",
        paymentSessionCreated?.paymentSessionId
            ?? paymentSessionCreated?.session?.paymentSessionId
            ?? null
    );

    let deposit;

    try {

        const packages = await Promise.all(packagePromises);

        deposit = packages[0];

    } catch (error) {

        publicLog("status", "BLOCKED");
        publicLog("lastVerified", "PAYMENT_CONNECTION_READY");
        publicLog("nextExpected", "DEPOSIT_PACKAGE_PUBLISHED");
        publicLog("blocker", "application_code");
        publicLog("reason", error.message);
        publicLog("gameIdAtBlocker", gameId);
        shutdown();
        process.exit(7);

    }

    publicLog("depositId", deposit.depositId ?? null);
    publicLog("depositAddress", deposit.depositAddress ?? null);
    publicLog("depositPhase", deposit.phase ?? null);
    publicLog("hasCreatorPackage", Boolean(deposit.package?.stateInit));
    publicLog("depositAddress", deposit.depositAddress ?? null);
    publicLog("depositPhase", deposit.phase ?? null);
    publicLog("hasCreatorPackage", Boolean(deposit.package?.stateInit));

    if (!deposit.package?.stateInit || !deposit.depositAddress) {

        publicLog("status", "BLOCKED");
        publicLog("lastVerified", "DEPOSIT_PACKAGE_PUBLISHED");
        publicLog("nextExpected", "creator deposit package StateInit");
        publicLog("blocker", "application_code");
        shutdown();
        process.exit(8);

    }

    const logger = {
        info() {},
        warn() {},
        error(...args) {

            process.stderr.write(`${args.join(" ")}\n`);

        },
        debug() {},
        startupLine() {},
        decisionTrace() {}
    };
    const tonService = new TonService({ logger, tonConfig });

    tonService.initialize();

    const depositBlockchainSource = new RealTonDepositBlockchainSource({
        logger,
        tonService,
        network: "testnet"
    });

    publicLog("phase", "DEPOSIT_DEPLOY");

    let deployResult;

    try {

        deployResult = await deployDepositContractAsPlayer({
            depositPackage: {
                depositAddress: deposit.depositAddress,
                stateInit: deposit.package.stateInit
            },
            playerWallet: playerWallets[0],
            tonService,
            getContractState: (address) => l25WithRpcRetry(
                () => depositBlockchainSource.getContractState(address),
                { operationName: "getContractState/depositDeploy" }
            ),
            env
        });

    } catch (error) {

        publicLog("status", "BLOCKED");
        publicLog("lastVerified", "DEPOSIT_PACKAGE_PUBLISHED");
        publicLog("nextExpected", "Deposit ACTIVE");
        publicLog("blocker", "test_driver");
        publicLog("reason", error.message);
        publicLog("depositAddress", deposit.depositAddress);
        shutdown();
        process.exit(18);

    }

    publicLog("depositDeployTx", deployResult.transactionHash ?? null);
    publicLog("depositDeploySender", deployResult.senderAddress ?? null);

    const expectedActivation = {
        roomId: created.roomId,
        gameId,
        depositId: deposit.depositId
    };

    publicLog("phase", "WAIT_ACTIVATION_WAITING");

    try {

        const waiting = await waitForEventBusType(
            appLogScanner,
            DEPOSIT_ACTIVATION_WAITING,
            120_000
        );

        publicLog("depositActivationWaitingAt", waiting.at);
        publicLog("depositActivationWaiting", DEPOSIT_ACTIVATION_WAITING);

    } catch (error) {

        publicLog("status", "BLOCKED");
        publicLog("lastVerified", "Deposit deploy");
        publicLog("nextExpected", "DEPOSIT_ACTIVATION_WAITING");
        publicLog("blocker", "application_code");
        publicLog("reason", error.message);
        shutdown();
        process.exit(19);

    }

    publicLog("phase", "WAIT_ACTIVATION_VERIFIED");

    let verifiedActivation;

    try {

        verifiedActivation = await waitForMatchingActivationVerified({
            scanner: appLogScanner,
            expected: expectedActivation,
            timeoutMs: 180_000
        });

    } catch (error) {

        publicLog("status", "BLOCKED");
        publicLog("lastVerified", "DEPOSIT_ACTIVATION_WAITING");
        publicLog("nextExpected", "DEPOSIT_ACTIVATION_VERIFIED");
        publicLog("blocker", "application_code");
        publicLog("reason", error.message);
        publicLog("depositId", deposit.depositId);
        shutdown();
        process.exit(20);

    }

    publicLog("depositActivationVerifiedAt", verifiedActivation.at);
    publicLog("depositActivationVerified", DEPOSIT_ACTIVATION_VERIFIED);
    publicLog("depositActivationVerifiedDepositId", verifiedActivation.depositId);
    publicLog("depositActivationVerifiedRoomId", verifiedActivation.roomId);
    publicLog("depositActivationVerifiedGameId", verifiedActivation.gameId);

    assertFundSeatAllowedAfterVerified({
        expected: expectedActivation,
        verifiedPayload: verifiedActivation,
        fundSeatStarted: false
    });

    publicLog("phase", "FUNDSEAT");
    publicLog("fundSeatAfterVerified", true);
    publicLog("fundSeatStartedAt", Date.now());

    const seatProjections = depositBySeat.map((row) => row || deposit);

    for (let seatIndex = 0; seatIndex < 3; seatIndex += 1) {

        const projection = seatProjections[seatIndex] ?? deposit;
        const expectedAmount = projection.myExpectedAmountNanotons;

        const bindings = [0, 1, 2].map((index) => ({
            wallet: playerWallets[index].addressCanonical,
            expectedAmount: seatProjections[index]?.myExpectedAmountNanotons
                ?? expectedAmount
        }));

        const fund = await fundSeatAsPlayer({
            session: {
                depositAddress: deposit.depositAddress,
                bindings
            },
            playerWallet: playerWallets[seatIndex],
            seatIndex,
            tonService,
            env,
            expectedAmountNano: expectedAmount
        });

        publicLog(`fundSeat${seatIndex}`, {
            valueNano: fund.valueNano,
            transactionHash: fund.transactionHash ?? null,
            expectedAmount
        });

    }

    publicLog("phase", "WAIT_DEPOSIT_FULL");

    try {

        const full = await waitForEventBusType(
            appLogScanner,
            DEPOSIT_FULL_ONCHAIN,
            180_000
        );

        publicLog("depositFullOnchainAt", full.at);
        publicLog("depositFullOnchain", DEPOSIT_FULL_ONCHAIN);

    } catch (error) {

        publicLog("status", "BLOCKED");
        publicLog("lastVerified", "Deposit FundSeat broadcast");
        publicLog("nextExpected", "DEPOSIT_FULL_ONCHAIN");
        publicLog("blocker", "application_code");
        publicLog("reason", error.message);
        shutdown();
        process.exit(21);

    }

    publicLog("phase", "WAIT_DEPLOY_AUTHORIZATION");

    try {

        const valid = await waitForEventBusType(
            appLogScanner,
            DEPLOY_AUTHORIZATION_VALID,
            120_000
        );

        publicLog("deployAuthorizationValidAt", valid.at);
        publicLog("deployAuthorizationValid", DEPLOY_AUTHORIZATION_VALID);

    } catch (error) {

        publicLog("status", "BLOCKED");
        publicLog("lastVerified", "DEPOSIT_FULL_ONCHAIN");
        publicLog("nextExpected", "DEPLOY_AUTHORIZATION_VALID");
        publicLog("blocker", "application_code");
        publicLog("reason", error.message);
        shutdown();
        process.exit(22);

    }

    publicLog("phase", "WAIT_GAMEESCROW");

    const deployedEvent = await waitFor(
        sockets[0],
        "GAME_CONTRACT_DEPLOYED",
        180_000
    ).catch((error) => {

        publicLog("status", "BLOCKED");
        publicLog("lastVerified", "DEPLOY_AUTHORIZATION_VALID");
        publicLog("nextExpected", "GAME_CONTRACT_DEPLOYED");
        publicLog("blocker", "application_code");
        publicLog("reason", error.message);
        shutdown();
        process.exit(9);

    });

    publicLog("gameEscrowAddress", deployedEvent.contractAddress ?? null);
    publicLog("gameEscrowDeployTx", deployedEvent.deploymentTxId ?? null);

    const paymentRequests = [];

    const onRequest = (payload) => {

        paymentRequests.push(payload);

    };

    sockets[0].on("PAYMENT_REQUEST", onRequest);

    const requestDeadline = Date.now() + 120_000;

    while (paymentRequests.length < 3 && Date.now() < requestDeadline) {

        await l25Sleep(2_000);

    }

    publicLog("paymentRequestCount", paymentRequests.length);

    if (paymentRequests.length < 3) {

        publicLog("status", "BLOCKED");
        publicLog("lastVerified", "GAME_CONTRACT_DEPLOYED");
        publicLog("nextExpected", "PAYMENT_REQUEST x3");
        publicLog("blocker", "application_code");
        shutdown();
        process.exit(10);

    }

    publicLog("phase", "STAKE");

    const openPage5 = waitFor(sockets[0], "OPEN_PAGE5", 180_000);
    const paymentCompleted = waitFor(sockets[0], "PAYMENT_SESSION_COMPLETED", 180_000)
        .catch(() => null);
    const startAuthorized = waitFor(sockets[0], "GAME_START_AUTHORIZED", 180_000)
        .catch(() => null);
    const bootstrapReady = waitFor(sockets[0], "GAME_INITIALIZING", 180_000)
        .catch(() => null);
    const entryCompleted = waitFor(sockets[0], "ENTRY_PAYMENT_COMPLETED", 180_000)
        .catch(() => null);

    const stakeResults = [];

    for (let seatIndex = 0; seatIndex < 3; seatIndex += 1) {

        const request = paymentRequests.find(
            (row) => Number(row.playerIndex) === seatIndex
            || row.playerId === playerIds[seatIndex]
        ) ?? paymentRequests[seatIndex];

        sockets[seatIndex].emit("PAYMENT_CONFIRM_INTENT");

        const stake = await sendStake({
            playerWallet: playerWallets[seatIndex],
            contractAddress: request.contractAddress || deployedEvent.contractAddress,
            playerIndex: seatIndex,
            requiredGram: request.requiredGram,
            tonService
        });

        stakeResults.push(stake);
        publicLog(`stake${seatIndex}`, stake);

        if (!stake.ok) {

            publicLog("status", "BLOCKED");
            publicLog("failedStakeSeat", seatIndex);
            publicLog("blocker", "wallet_balance");
            shutdown();
            process.exit(11);

        }

        await l25Sleep(8_000);

    }

    await l25Sleep(15_000);

    const escrow = deployedEvent.contractAddress;
    const paidMask = await readIntGetter(tonService, escrow, "get_paid_mask");
    const status = await readIntGetter(tonService, escrow, "get_status");

    publicLog("onChainPaidMask", paidMask);
    publicLog("onChainStatus", status);

    const completed = await paymentCompleted;
    const authorized = await startAuthorized;
    const initializing = await bootstrapReady;
    const entry = await entryCompleted;

    publicLog("PAYMENT_SESSION_COMPLETED", Boolean(completed));
    publicLog("GAME_START_AUTHORIZED", Boolean(authorized));
    publicLog("GAME_INITIALIZING", Boolean(initializing));
    publicLog("ENTRY_PAYMENT_COMPLETED", Boolean(entry));

    let page5 = null;

    try {

        page5 = await openPage5;

    } catch (error) {

        publicLog("status", "BLOCKED");
        publicLog("page5Reached", false);
        publicLog("lastVerified", paidMask === 7 ? "on-chain paidMask=7" : "STAKE broadcast");
        publicLog("nextExpected", "OPEN_PAGE5");
        publicLog("reason", error.message);
        shutdown();
        process.exit(12);

    }

    publicLog("OPEN_PAGE5", page5);
    publicLog("page5Reached", true);
    publicLog("finalRoomId", created.roomId);
    publicLog("finalGameId", gameId);
    publicLog("status", "OPEN_PAGE5");

    for (const socket of sockets) {

        socket.close();

    }

    shutdown();

}

main().catch((error) => {

    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(1);

});
