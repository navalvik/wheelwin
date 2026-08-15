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

import {
    Address,
    beginCell,
    external,
    internal,
    SendMode,
    storeMessage,
    toNano
} from "@ton/core";
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

/**
 * Wallet V4 defaults sendMode to NONE (0). GameEscrow STAKE requires
 * context().value == required exactly, so gas must be paid separately.
 */
const PLAYER_SEND_MODE = SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS;

function buildSignedBoc(
    wallet,
    keyPair,
    seqno,
    messages,
    {
        includeInit = false,
        sendMode = PLAYER_SEND_MODE
    } = {}
) {

    const transfer = wallet.createTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages,
        sendMode
    });

    const externalMessage = external({
        to: wallet.address,
        init: includeInit ? wallet.init : undefined,
        body: transfer
    });

    return beginCell()
        .store(storeMessage(externalMessage))
        .endCell()
        .toBoc()
        .toString("base64");

}

function isDuplicateBocError(error) {

    const text = String(error?.message ?? error ?? "").toLowerCase();

    return text.includes("duplicate message")
        || text.includes("duplicate");

}

function normalizeAccountState(account) {

    const raw = String(
        account?.state
            ?? account?.account_state
            ?? account?.status
            ?? ""
    ).toLowerCase();

    if (raw.includes("active")) {

        return "active";

    }

    if (raw.includes("uninit") || raw.includes("nonexist") || raw === "") {

        return "uninitialized";

    }

    if (raw.includes("frozen")) {

        return "frozen";

    }

    return raw || "unknown";

}

async function readPlayerWalletStatus(tonService, address) {

    let state = "unknown";
    let balanceTon = null;
    let seqno = null;
    let seqnoError = null;

    try {

        const account = await tonService.getAccount(address);
        state = normalizeAccountState(account);

    } catch (error) {

        state = "unknown";
        seqnoError = error?.message ?? String(error);

    }

    try {

        balanceTon = await readBalanceTon(tonService, address);

    } catch {

        balanceTon = null;

    }

    if (state === "active") {

        try {

            seqno = await tonService.getSeqno(address);

        } catch (error) {

            seqnoError = error?.message ?? String(error);

        }

    } else {

        // Uninitialized wallets have no seqno getter — first outbound uses 0.
        seqno = 0;

    }

    return {
        address,
        state,
        active: state === "active",
        balanceTon,
        seqno,
        seqnoError
    };

}

async function waitUntilPlayerWalletActive(tonService, address, {
    timeoutMs = 60_000,
    pollMs = 2000,
    logger
} = {}) {

    const started = Date.now();

    while (Date.now() - started < timeoutMs) {

        const status = await readPlayerWalletStatus(tonService, address);

        logger.info(
            `player wallet wait address=${status.address} state=${status.state} `
                + `balance=${status.balanceTon}`
        );

        if (status.active) {

            return status;

        }

        await sleep(pollMs);

    }

    return readPlayerWalletStatus(tonService, address);

}

/**
 * R17.8V.2C — Deploy ephemeral Wallet V4 with StateInit before STAKE.
 */
async function ensurePlayerWalletDeployed({
    tonService,
    player,
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

    let status = await readPlayerWalletStatus(tonService, address);

    logger.info(
        `player wallet precheck label=${player.label} address=${address} `
            + `state=${status.state} balance=${status.balanceTon}`
    );

    if (status.active) {

        return {
            ok: true,
            address,
            status,
            deploymentStatus: "already_active"
        };

    }

    if (status.balanceTon == null || status.balanceTon < 0.02) {

        return {
            ok: false,
            address,
            status,
            deploymentStatus: "insufficient_balance_for_deploy",
            error: `Player wallet ${address} needs balance before StateInit deploy `
                + `(balance=${status.balanceTon})`
        };

    }

    const boc = buildSignedBoc(
        wallet,
        player.keyPair,
        0,
        [
            internal({
                to: wallet.address,
                value: toNano("0.001"),
                body: beginCell().endCell(),
                bounce: false
            })
        ],
        { includeInit: true }
    );

    logger.info(`player wallet DEPLOY StateInit address=${address}`);

    try {

        await tonService.broadcastTransaction(boc);

    } catch (error) {

        // First send often lands; TonCenter retries may report duplicate.
        if (!isDuplicateBocError(error)) {

            return {
                ok: false,
                address,
                status,
                deploymentStatus: "deploy_broadcast_failed",
                error: error?.message ?? String(error)
            };

        }

        logger.info(
            `player wallet DEPLOY duplicate ignored address=${address} `
                + `(waiting for active)`
        );

    }

    status = await waitUntilPlayerWalletActive(tonService, address, { logger });

    if (!status.active) {

        return {
            ok: false,
            address,
            status,
            deploymentStatus: "deploy_timeout",
            error: `Player wallet ${address} not active after StateInit deploy`
        };

    }

    // First outbound (deploy) must have consumed seqno 0.
    if (!Number.isFinite(status.seqno) || Number(status.seqno) < 1) {

        const started = Date.now();

        while (Date.now() - started < 30_000) {

            await sleep(1500);
            status = await readPlayerWalletStatus(tonService, address);

            if (Number.isFinite(status.seqno) && Number(status.seqno) >= 1) {

                break;

            }

        }

    }

    if (!Number.isFinite(status.seqno) || Number(status.seqno) < 1) {

        return {
            ok: false,
            address,
            status,
            deploymentStatus: "seqno_not_advanced",
            error: `Player wallet ${address} active but seqno not advanced `
                + `(seqno=${status.seqno})`
        };

    }

    logger.info(
        `player wallet ACTIVE address=${address} balance=${status.balanceTon} `
            + `seqno=${status.seqno} sendMode=${PLAYER_SEND_MODE}`
    );

    return {
        ok: true,
        address,
        status,
        deploymentStatus: "deployed"
    };

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

    const status = await readPlayerWalletStatus(tonService, address);

    logger.info(
        `STAKE precheck playerIndex=${playerIndex} address=${address} `
            + `active=${status.active} state=${status.state} `
            + `balanceBefore=${status.balanceTon}`
    );

    if (!status.active) {

        return {
            ok: false,
            txId: null,
            seqno: null,
            error: `STOP: player wallet not active before STAKE `
                + `(address=${address} state=${status.state})`,
            balanceBefore: status.balanceTon,
            walletActive: false
        };

    }

    if (status.balanceTon == null || status.balanceTon < Number(stakeTon)) {

        return {
            ok: false,
            txId: null,
            seqno: status.seqno,
            error: `STOP: insufficient balance for STAKE `
                + `(balance=${status.balanceTon} stake=${stakeTon})`,
            balanceBefore: status.balanceTon,
            walletActive: true
        };

    }

    const seqno = Number.isFinite(status.seqno)
        ? status.seqno
        : await tonService.getSeqno(address);

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
        ],
        { includeInit: false }
    );

    logger.info(
        `STAKE send playerIndex=${playerIndex} from=${address} value=${stakeTon} `
            + `seqno=${seqno} sendMode=${PLAYER_SEND_MODE}`
    );

    let result;

    try {

        result = await tonService.broadcastTransaction(boc);

    } catch (error) {

        if (!isDuplicateBocError(error)) {

            return {
                ok: false,
                txId: null,
                seqno,
                error: error?.message ?? String(error),
                balanceBefore: status.balanceTon,
                walletActive: true
            };

        }

        logger.info(
            `STAKE duplicate ignored playerIndex=${playerIndex} `
                + `address=${address} (waiting seqno advance)`
        );
        result = { ok: true };

    }

    try {

        await waitForSeqnoAdvance(tonService, address, seqno, { logger });

    } catch (error) {

        return {
            ok: false,
            txId: result?.hash ?? result?.txHash ?? null,
            seqno,
            error: `STAKE seqno did not advance: ${error?.message ?? error}`,
            balanceBefore: status.balanceTon,
            walletActive: true
        };

    }

    const after = await readPlayerWalletStatus(tonService, address);

    logger.info(
        `STAKE confirmed playerIndex=${playerIndex} address=${address} `
            + `balanceAfter=${after.balanceTon} seqno=${after.seqno}`
    );

    return {
        ok: result?.ok !== false,
        txId: result?.hash ?? result?.txHash ?? null,
        seqno,
        balanceBefore: status.balanceTon,
        balanceAfter: after.balanceTon,
        walletActive: true
    };

}

async function waitForSeqnoAdvance(tonService, address, sentSeqno, {
    timeoutMs = 45_000,
    pollMs = 1500,
    logger
} = {}) {

    const started = Date.now();
    let lastSeen = sentSeqno;

    while (Date.now() - started < timeoutMs) {

        try {

            lastSeen = await tonService.getSeqno(address);

            if (Number(lastSeen) > Number(sentSeqno)) {

                logger.info(
                    `seqno advanced address=${address} sent=${sentSeqno} `
                        + `confirmed=${lastSeen}`
                );

                return Number(lastSeen);

            }

        } catch (error) {

            logger.warn(
                `seqno poll failed address=${address} `
                    + `${error?.message ?? error}`
            );

        }

        await sleep(pollMs);

    }

    throw new Error(
        `seqno confirmation timeout address=${address} sent=${sentSeqno} `
            + `lastSeen=${lastSeen}`
    );

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

        // Non-bounceable so funds land on uninitialized accounts.
        const nonBounceable = Address.parse(player.address).toString({
            bounceable: false,
            urlSafe: true
        });

        const boc = buildSignedBoc(
            deployerWallet,
            keyPair,
            seqno,
            [
                internal({
                    to: Address.parse(nonBounceable),
                    value: toNano(String(amountTon)),
                    body: beginCell().endCell(),
                    bounce: false
                })
            ]
        );

        logger.info(
            `FUND ${player.label} → ${player.address} (non-bounceable) `
                + `amount=${amountTon} deployerSeqno=${seqno}`
        );

        await tonService.broadcastTransaction(boc);
        await waitForSeqnoAdvance(tonService, deployerAddress, seqno, { logger });
        await sleep(3000);

        const status = await readPlayerWalletStatus(tonService, player.address);

        logger.info(
            `FUND settled address=${player.address} state=${status.state} `
                + `balance=${status.balanceTon}`
        );

        if (status.balanceTon == null || status.balanceTon <= 0) {

            throw new Error(
                `FUND failed to credit player ${player.address} `
                    + `(balance=${status.balanceTon})`
            );

        }

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

            const fundEach = Number(stakeTon) + 0.08;

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

            const deployWallet = await ensurePlayerWalletDeployed({
                tonService,
                player: players[index],
                logger
            });

            push("PLAYER_WALLET_DEPLOY", {
                ok: deployWallet.ok === true,
                playerIndex: index,
                address: deployWallet.address,
                deploymentStatus: deployWallet.deploymentStatus,
                walletState: deployWallet.status?.state ?? null,
                balanceTon: deployWallet.status?.balanceTon ?? null,
                reason: deployWallet.error ?? null
            });

            if (deployWallet.ok !== true) {

                record.failureReason = deployWallet.error
                    ?? "player_wallet_deploy_failed";

                return record;

            }

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
                valueTon: stakeTon,
                walletActive: stakeResult.walletActive === true,
                balanceBefore: stakeResult.balanceBefore ?? null,
                balanceAfter: stakeResult.balanceAfter ?? null,
                reason: stakeResult.error ?? null
            });

            if (stakeResult.ok !== true) {

                record.failureReason = stakeResult.error ?? "stake_failed";

                return record;

            }

        }

        if (paidCount > 0 && typeof adapter.getPaidMask === "function") {

            try {

                const expectedMask = (1 << paidCount) - 1;
                let paidMask = null;
                const maskStarted = Date.now();

                while (Date.now() - maskStarted < 60_000) {

                    paidMask = Number(
                        await adapter.getPaidMask(record.contractAddress)
                    );

                    logger.info(
                        `paidMask poll contract=${record.contractAddress} `
                            + `got=${paidMask} expected=${expectedMask}`
                    );

                    if (paidMask === expectedMask) {

                        break;

                    }

                    await sleep(3000);

                }

                push("PAID_MASK_CHECK", {
                    ok: paidMask === expectedMask,
                    paidMask,
                    expectedMask
                });

                if (paidMask !== expectedMask) {

                    record.failureReason = `paidMask mismatch got=${paidMask} `
                        + `expected=${expectedMask}`;

                    return record;

                }

            } catch (error) {

                push("PAID_MASK_CHECK", {
                    ok: false,
                    reason: error?.message ?? String(error)
                });

                record.failureReason = `paidMask read failed: `
                    + `${error?.message ?? error}`;

                return record;

            }

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
