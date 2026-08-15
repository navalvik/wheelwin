/**
 * R17.8V.1C — Testnet ValueTon sweep harness (measurement only).
 *
 * NOT part of production startup. NOT picked up by `npm test` (subdir).
 *
 * Usage (testnet only):
 *
 *   TON_NETWORK=testnet
 *   TON_DEPLOY_MODE=live
 *   TON_DEPLOYER_MNEMONIC="..."
 *   TEST_VALUETON_OVERRIDE=true
 *   RUN_TESTNET_VALUETON_SWEEP=true
 *   node server/scripts/run-testnet-valueton-sweep.js
 *
 * Optional:
 *   TEST_VALUETON_SWEEP_VALUES=0.05,0.04,0.03
 *   TEST_VALUETON_STAKE_TON=0.05
 *   TEST_VALUETON_SCENARIOS=A,B,C
 *
 * Dry / CI (no chain):
 *   node server/tests/testnet/runValueTonSweep.js --dry-run
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Address, beginCell, external, internal, storeMessage, toNano } from "@ton/core";
import { mnemonicToPrivateKey, keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import { loadTonConfig } from "../../config/ton.js";
import { TonGameContractAdapter } from "../../payment/TonGameContractAdapter.js";
import {
    GAME_ESCROW_MODE_GAME,
    hashGameContractSnapshot
} from "../../payment/ton/buildGameEscrowStateInit.js";
import { serializeGameEscrowStakeBody } from "../../payment/ton/gameContract/GameContractSerializer.js";
import {
    PRODUCTION_ORACLE_VALUE_TON,
    resolveOracleValueTon
} from "../../payment/ton/testValueTonOverride.js";
import { TonService } from "../../services/TonService.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_SWEEP = [
    "0.05",
    "0.04",
    "0.03",
    "0.025",
    "0.02",
    "0.015",
    "0.01"
];

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

function loadEnvCandidates() {

    for (const candidate of [
        resolve(__dirname, "../../.env"),
        resolve(__dirname, "../../../.env"),
        resolve(process.cwd(), ".env"),
        resolve(process.cwd(), "server/.env")
    ]) {

        loadEnvFile(candidate);

    }

}

function createLogger() {

    return {
        info(...args) {

            console.log("[V1C]", ...args);

        },
        warn(...args) {

            console.warn("[V1C]", ...args);

        },
        error(...args) {

            console.error("[V1C]", ...args);

        },
        debug() {},
        startupLine() {},
        decisionTrace() {}
    };

}

function sleep(ms) {

    return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

}

function parseSweepValues(raw) {

    if (!raw || !String(raw).trim()) {

        return [...DEFAULT_SWEEP];

    }

    return String(raw)
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);

}

function parseScenarios(raw) {

    const list = String(raw || "A,B,C")
        .split(",")
        .map((part) => part.trim().toUpperCase())
        .filter(Boolean);

    return new Set(list.length ? list : ["A", "B", "C"]);

}

function applyUniformValueTon(valueTon) {

    process.env.TEST_VALUETON_OVERRIDE = "true";
    process.env.TEST_VALUETON_DEPLOY = valueTon;
    process.env.TEST_VALUETON_INIT = valueTon;
    process.env.TEST_VALUETON_OPEN = valueTon;
    process.env.TEST_VALUETON_CANCEL = valueTon;
    process.env.TEST_VALUETON_SETTLE = valueTon;

}

function friendlyFromKeyPair(keyPair) {

    return WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey
    }).address.toString({ bounceable: true, urlSafe: true });

}

function createPlayerWallet(label) {

    const seed = createHash("sha256")
        .update(`r178v1c:${label}:${randomBytes(16).toString("hex")}`)
        .digest();

    const keyPair = keyPairFromSeed(seed);

    return {
        label,
        keyPair,
        address: friendlyFromKeyPair(keyPair)
    };

}

function buildSnapshot({ oracle, owner, players, stakeTon, tag }) {

    const stake = Number(stakeTon);

    return Object.freeze({
        gameId: `game_v1c_${tag}`,
        roomId: `room_v1c_${tag}`,
        ownerWallet: owner,
        oracleWallet: oracle,
        totalPot: stake * 3,
        organizerFee: stake * 3 * 0.05,
        organizerFeeRate: 0.05,
        players: Object.freeze(players.map((player, index) => Object.freeze({
            playerId: `p${index}`,
            wallet: player.address,
            requiredGram: stake
        })))
    });

}

async function readStatus(adapter, contractAddress) {

    try {

        if (typeof adapter.getStatus === "function") {

            return await adapter.getStatus(contractAddress);

        }

        if (typeof adapter.getContractState === "function") {

            return await adapter.getContractState(contractAddress);

        }

    } catch (error) {

        return { error: error?.message ?? String(error) };

    }

    return null;

}

async function readBalanceTon(tonService, address) {

    try {

        const nano = await tonService.getBalance(address);

        return Number(nano) / 1e9;

    } catch {

        return null;

    }

}

function buildSignedBoc(wallet, keyPair, seqno, messages) {

    const transfer = wallet.createTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages
    });

    const externalMessage = external({
        to: wallet.address,
        body: transfer
    });

    return beginCell()
        .store(storeMessage(externalMessage))
        .endCell()
        .toBoc()
        .toString("base64");

}

async function sendPlayerStake({
    tonService,
    player,
    contractAddress,
    playerIndex,
    stakeTon,
    logger
}) {

    const wallet = WalletContractV4.create({
        workchain: 0,
        publicKey: player.keyPair.publicKey
    });

    const address = wallet.address.toString({
        bounceable: true,
        urlSafe: true
    });

    const seqno = await tonService.getSeqno(address);

    const body = serializeGameEscrowStakeBody({ playerIndex });

    const boc = buildSignedBoc(
        wallet,
        player.keyPair,
        seqno,
        [
            internal({
                to: Address.parse(contractAddress),
                value: toNano(String(stakeTon)),
                body,
                bounce: true
            })
        ]
    );

    logger.info(`STAKE playerIndex=${playerIndex} from=${address} value=${stakeTon}`);

    const result = await tonService.broadcastTransaction(boc);

    return {
        ok: result?.ok !== false,
        txId: result?.hash ?? result?.txHash ?? null,
        seqno
    };

}

async function fundPlayers({
    adapter,
    players,
    amountTon,
    logger
}) {

    const tonConfig = adapter._tonConfig;
    const tonService = adapter._service();
    const keyPair = await mnemonicToPrivateKey(
        tonConfig.deployerMnemonic.split(/\s+/).filter(Boolean)
    );

    const deployerWallet = WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey
    });

    const deployerAddress = deployerWallet.address.toString({
        bounceable: true,
        urlSafe: true
    });

    for (const player of players) {

        const seqno = await tonService.getSeqno(deployerAddress);

        const boc = buildSignedBoc(
            deployerWallet,
            keyPair,
            seqno,
            [
                internal({
                    to: Address.parse(player.address),
                    value: toNano(String(amountTon)),
                    body: beginCell().endCell(),
                    bounce: false
                })
            ]
        );

        logger.info(`FUND ${player.label} → ${player.address} amount=${amountTon}`);

        await tonService.broadcastTransaction(boc);
        await sleep(8000);

    }

}

/**
 * @returns {Promise<object>}
 */
async function runScenario({
    adapter,
    tonService,
    valueTon,
    scenario,
    stakeTon,
    logger
}) {

    const record = {
        scenario,
        valueTon,
        stakeTon,
        success: false,
        steps: [],
        contractAddress: null,
        failureReason: null,
        finalStatus: null,
        remainingBalanceTon: null,
        refundMask: null
    };

    const push = (step, patch = {}) => {

        record.steps.push({ step, ...patch, at: new Date().toISOString() });

    };

    try {

        applyUniformValueTon(valueTon);

        const players = [
            createPlayerWallet(`${scenario}-0-${valueTon}`),
            createPlayerWallet(`${scenario}-1-${valueTon}`),
            createPlayerWallet(`${scenario}-2-${valueTon}`)
        ];

        const oracle = adapter._tonConfig.oracleAddress
            ?? (await deriveOracleFromMnemonic(adapter._tonConfig.deployerMnemonic));

        const owner = oracle;

        const tag = `${scenario}_${String(valueTon).replace(/\./g, "p")}_${Date.now()}`;

        const snapshot = buildSnapshot({
            oracle,
            owner,
            players,
            stakeTon,
            tag
        });

        const contractId = `contract_v1c_${tag}`;

        // Fund players before OPEN when stakes are needed.
        const paidCount = scenario === "A" ? 0 : scenario === "B" ? 1 : 3;

        if (paidCount > 0) {

            const fundEach = Number(stakeTon) + 0.05;

            await fundPlayers({
                adapter,
                players: players.slice(0, paidCount),
                amountTon: fundEach,
                logger
            });

        }

        const deploy = await adapter.deployContract({
            contractId,
            snapshot
        });

        push("DEPLOY", {
            ok: deploy?.ok === true,
            txId: deploy?.deploymentTxId ?? deploy?.txId ?? null,
            configuredValueTon: resolveOracleValueTon("DEPLOY"),
            reason: deploy?.reason ?? null
        });

        if (deploy?.ok !== true) {

            record.failureReason = deploy?.reason ?? "deploy_failed";

            return record;

        }

        record.contractAddress = deploy.contractAddress
            ?? deploy.address
            ?? null;

        // Adapter returns contractAddress on success path — also from build.
        if (!record.contractAddress) {

            const { buildGameEscrowWallet } = await import(
                "../../payment/ton/buildGameEscrowStateInit.js"
            );

            record.contractAddress = buildGameEscrowWallet({
                contractId,
                snapshot,
                mode: GAME_ESCROW_MODE_GAME,
                oracle,
                owner
            }).addressFriendly;

        }

        await sleep(5000);

        const snapshotHash = hashGameContractSnapshot(snapshot).toString("hex");
        const contractIdHash = createHash("sha256")
            .update(String(contractId))
            .digest("hex");

        const init = await adapter.initGame({
            contractAddress: record.contractAddress,
            oracle,
            owner,
            contractIdHash,
            snapshotHash
        });

        push("INIT_GAME", {
            ok: init?.ok === true,
            txId: init?.txId ?? null,
            configuredValueTon: resolveOracleValueTon("INIT_GAME"),
            reason: init?.reason ?? null
        });

        if (init?.ok !== true) {

            record.failureReason = init?.reason ?? "init_failed";

            return record;

        }

        await sleep(5000);

        const open = await adapter.openPayments({
            contractAddress: record.contractAddress,
            players: snapshot.players.map((player) => ({
                playerId: player.playerId,
                wallet: player.wallet,
                requiredGram: player.requiredGram
            }))
        });

        push("OPEN_PAYMENTS", {
            ok: open?.ok === true,
            txId: open?.txId ?? null,
            configuredValueTon: resolveOracleValueTon("OPEN_PAYMENTS"),
            reason: open?.reason ?? null
        });

        if (open?.ok !== true) {

            record.failureReason = open?.reason ?? "open_failed";

            return record;

        }

        await sleep(5000);

        for (let index = 0; index < paidCount; index += 1) {

            const stakeResult = await sendPlayerStake({
                tonService,
                player: players[index],
                contractAddress: record.contractAddress,
                playerIndex: index,
                stakeTon,
                logger
            });

            push("STAKE", {
                ok: stakeResult.ok,
                playerIndex: index,
                txId: stakeResult.txId,
                valueTon: stakeTon
            });

            await sleep(8000);

        }

        const cancel = await adapter.cancel({
            contractAddress: record.contractAddress,
            reasonCode: 17
        });

        push("CANCEL", {
            ok: cancel?.ok === true,
            txId: cancel?.txId ?? null,
            configuredValueTon: resolveOracleValueTon("CANCEL"),
            reason: cancel?.reason ?? null
        });

        await sleep(10000);

        record.finalStatus = await readStatus(adapter, record.contractAddress);
        record.remainingBalanceTon = await readBalanceTon(
            tonService,
            record.contractAddress
        );

        try {

            if (typeof adapter.getRefundMask === "function") {

                record.refundMask = await adapter.getRefundMask(
                    record.contractAddress
                );

            }

        } catch {

            record.refundMask = null;

        }

        if (cancel?.ok !== true) {

            record.failureReason = cancel?.reason ?? "cancel_failed";

            return record;

        }

        record.success = true;

        return record;

    } catch (error) {

        record.failureReason = error?.message ?? String(error);
        push("EXCEPTION", { ok: false, reason: record.failureReason });

        return record;

    }

}

async function deriveOracleFromMnemonic(mnemonic) {

    const keyPair = await mnemonicToPrivateKey(
        mnemonic.split(/\s+/).filter(Boolean)
    );

    return friendlyFromKeyPair(keyPair);

}

function printDryRunPlan(values, scenarios) {

    console.log("R17.8V.1C dry-run — no chain broadcasts");
    console.log(`Production baseline: ${PRODUCTION_ORACLE_VALUE_TON} TON`);
    console.log(`Sweep values: ${values.join(", ")}`);
    console.log(`Scenarios: ${[...scenarios].join(", ")}`);
    console.log("Enable live run with RUN_TESTNET_VALUETON_SWEEP=true + testnet mnemonic.");

}

export async function main(argv = process.argv.slice(2)) {

    loadEnvCandidates();

    const dryRun = argv.includes("--dry-run")
        || String(process.env.RUN_TESTNET_VALUETON_SWEEP || "")
            .toLowerCase() !== "true";

    const values = parseSweepValues(process.env.TEST_VALUETON_SWEEP_VALUES);
    const scenarios = parseScenarios(process.env.TEST_VALUETON_SCENARIOS);
    const stakeTon = process.env.TEST_VALUETON_STAKE_TON || "0.05";
    const logger = createLogger();

    if (dryRun) {

        printDryRunPlan(values, scenarios);

        const report = {
            mode: "dry-run",
            executedAt: new Date().toISOString(),
            productionBaselineTon: PRODUCTION_ORACLE_VALUE_TON,
            values,
            scenarios: [...scenarios],
            results: []
        };

        const outDir = resolve(__dirname, "./artifacts");

        mkdirSync(outDir, { recursive: true });

        const outPath = join(outDir, "valueton-sweep-last-run.json");

        writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
        console.log(`Wrote ${outPath}`);

        return report;

    }

    if (String(process.env.TON_NETWORK || "").toLowerCase() === "mainnet") {

        throw new Error("R17.8V.1C refuses to run on mainnet");

    }

    process.env.TON_NETWORK = process.env.TON_NETWORK || "testnet";
    process.env.TON_DEPLOY_MODE = "live";
    process.env.GAME_ESCROW_MODE = process.env.GAME_ESCROW_MODE || "game";

    const tonConfig = loadTonConfig(process.env);

    if (!tonConfig.deployerMnemonic) {

        throw new Error("TON_DEPLOYER_MNEMONIC required for live sweep");

    }

    if (tonConfig.network !== "testnet") {

        throw new Error(`Expected testnet, got ${tonConfig.network}`);

    }

    const tonService = new TonService({
        logger,
        tonConfig
    });

    tonService.initialize();

    const adapter = new TonGameContractAdapter({
        logger,
        tonConfig: {
            ...tonConfig,
            gameEscrowMode: GAME_ESCROW_MODE_GAME
        },
        tonService
    });

    const results = [];
    const failedScenarios = new Set();

    for (const valueTon of values) {

        for (const scenario of ["A", "B", "C"]) {

            if (!scenarios.has(scenario)) {

                continue;

            }

            if (failedScenarios.has(scenario)) {

                logger.warn(
                    `Skip scenario ${scenario} at ${valueTon} (already failed higher)`
                );

                continue;

            }

            logger.info(`=== valueTon=${valueTon} scenario=${scenario} ===`);

            const record = await runScenario({
                adapter,
                tonService,
                valueTon,
                scenario,
                stakeTon,
                logger
            });

            results.push(record);
            logger.info(
                `scenario=${scenario} value=${valueTon} success=${record.success} `
                    + `reason=${record.failureReason ?? "ok"}`
            );

            if (!record.success) {

                failedScenarios.add(scenario);
                logger.warn(
                    `Mark scenario ${scenario} failed at ${valueTon}; `
                        + "lower values for this scenario will be skipped"
                );

            }

        }

    }

    const report = {
        mode: "live",
        executedAt: new Date().toISOString(),
        network: tonConfig.network,
        endpoint: tonConfig.endpoint,
        productionBaselineTon: PRODUCTION_ORACLE_VALUE_TON,
        stakeTon,
        values,
        scenarios: [...scenarios],
        results
    };

    const outDir = resolve(__dirname, "./artifacts");

    mkdirSync(outDir, { recursive: true });

    const outPath = join(outDir, "valueton-sweep-last-run.json");

    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`Wrote ${outPath}`);
    console.log(
        "Copy measured rows into docs/R17.8V1B_TESTNET_VALUETON_MATRIX.md after review."
    );

    try {

        tonService.shutdown?.();

    } catch {

        // ignore
    }

    return report;

}

const isDirect = process.argv[1]
    && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirect) {

    main().catch((error) => {

        console.error(error);
        process.exit(1);

    });

}
