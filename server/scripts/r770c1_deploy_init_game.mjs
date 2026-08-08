/**
 * R7.70C1 — Real Testnet GameEscrow deploy + INIT_GAME validation.
 *
 * Uses existing TonGameContractAdapter / TonService only.
 * No fake hashes. No Mainnet. No STAKE.
 *
 * Usage (from repo root or server/):
 *   node server/scripts/r770c1_deploy_init_game.mjs
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Address, Cell } from "@ton/core";

import { OwnerConfiguration } from "../config/OwnerConfiguration.js";
import { loadTonConfig } from "../config/ton.js";
import { deriveDeployerWalletIdentity } from "../payment/ton/deriveDeployerWalletIdentity.js";
import { TonGameContractAdapter } from "../payment/TonGameContractAdapter.js";
import { hashGameContractSnapshot } from "../payment/ton/buildGameEscrowStateInit.js";
import { verifyGameEscrowArtifact } from "../payment/ton/verifyGameEscrowArtifact.js";
import { TonService } from "../services/TonService.js";

const EXPECTED_ARTIFACT_SHA256 =
    "d215a1b5087ccdf7e490d5f43426b05db904bf5697173b082967e3859beddaaf";
const EXPECTED_CODE_HASH =
    "28f9d0bd138e38510f9d824143cd217cf0f74c647d05451b87e90f8a71996192";
const EXPECTED_DEPLOY =
    "EQB83s9XMOMseDFxyXxj4hrC0sS4FB4xhdNiUPkl_3zx3PDQ";
const EXPECTED_OWNER =
    "0QBaklBYMdMsuq7a2eTYhMkz1OF7ZSHaO1mnFd1MZd3YjC5t";

function cellHashHex(cell) {

    if (!cell) {

        return null;

    }

    return Buffer.from(cell.hash()).toString("hex");

}

function cellFromAccountField(value) {

    if (!value) {

        return null;

    }

    if (typeof value === "string") {

        // TonCenter may return hex or base64.
        try {

            return Cell.fromBase64(value);

        } catch {

            return Cell.fromBoc(Buffer.from(value, "hex"))[0];

        }

    }

    if (Buffer.isBuffer(value)) {

        return Cell.fromBoc(value)[0];

    }

    return value;

}
const STATUS_BY_CODE = Object.freeze({
    0: "UNINITIALIZED",
    1: "DEPLOYED",
    2: "WAITING_PAYMENTS",
    3: "PAYMENTS_OPEN",
    5: "READY",
    7: "SETTLING",
    8: "SETTLED",
    9: "CANCELLED"
});

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

function mask(value) {

    const text = String(value ?? "");

    if (text.length < 12) {

        return text || null;

    }

    return `${text.slice(0, 6)}....${text.slice(-4)}`;

}

function addrEq(left, right) {

    try {

        return Address.parse(String(left)).equals(Address.parse(String(right)));

    } catch {

        return false;

    }

}

function friendly(value) {

    return Address.parse(String(value)).toString({
        bounceable: true,
        urlSafe: true
    });

}

function sleep(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

function createLogger() {

    return {
        info(message) {

            console.log(`[info] ${message}`);

        },
        warn(message) {

            console.warn(`[warn] ${message}`);

        },
        error(message) {

            console.error(`[error] ${message}`);

        },
        debug() {},
        startupLine(message) {

            console.log(`[startup] ${message}`);

        }
    };

}

/**
 * Parse GameEscrow data cell (loaded=1 layout from buildGameEscrowDataCell).
 */
function parseGameEscrowData(dataCell) {

    const slice = dataCell.beginParse();
    const loaded = slice.loadBit();

    if (!loaded) {

        throw new Error("GameEscrow data not loaded (empty init state)");

    }

    const version = slice.loadUint(16);
    const statusCode = slice.loadUint(8);
    const oracle = slice.loadAddress();
    const owner = slice.loadAddress();
    const contractIdHash = slice.loadUintBig(256);
    const tail = slice.loadRef().beginParse();
    const snapshotHash = tail.loadUintBig(256);
    const winner = tail.loadAddress();
    const winnerAmount = tail.loadCoins();
    const ownerAmount = tail.loadCoins();
    const settled = tail.loadBit();
    const paidMask = tail.loadUint(8);
    const totalPaid = tail.loadCoins();
    const roster = tail.loadRef().beginParse();
    const requiredTotal = roster.loadCoins();
    const player0 = roster.loadAddress();
    const stake0 = roster.loadCoins();
    const player1 = roster.loadAddress();
    const stake1 = roster.loadCoins();
    const rosterTail = roster.loadRef().beginParse();
    const player2 = rosterTail.loadAddress();
    const stake2 = rosterTail.loadCoins();

    return {
        version,
        statusCode,
        status: STATUS_BY_CODE[statusCode] ?? `UNKNOWN(${statusCode})`,
        oracle: oracle.toString({ bounceable: true, urlSafe: true }),
        owner: owner.toString({ bounceable: true, urlSafe: true }),
        contractIdHash: contractIdHash.toString(16).padStart(64, "0"),
        snapshotHash: snapshotHash.toString(16).padStart(64, "0"),
        winner: winner?.toString({ bounceable: true, urlSafe: true }) ?? null,
        winnerAmount: winnerAmount.toString(),
        ownerAmount: ownerAmount.toString(),
        settled,
        paidMask,
        totalPaid: totalPaid.toString(),
        requiredTotal: requiredTotal.toString(),
        players: [
            player0.toString({ bounceable: true, urlSafe: true }),
            player1.toString({ bounceable: true, urlSafe: true }),
            player2.toString({ bounceable: true, urlSafe: true })
        ],
        stakes: [stake0.toString(), stake1.toString(), stake2.toString()]
    };

}

function readIntFromGetMethodStack(result) {

    const stack = result?.stack;
    const item = Array.isArray(stack)
        ? stack[0]
        : (Array.isArray(stack?.items) ? stack.items[0] : null);

    if (item == null) {

        return NaN;

    }

    if (typeof item === "number" || typeof item === "bigint") {

        return Number(item);

    }

    if (Array.isArray(item) && item.length >= 2) {

        return Number(item[1]);

    }

    if (typeof item === "object") {

        const value = item.value ?? item.num ?? null;

        if (value == null) {

            return NaN;

        }

        return Number(value);

    }

    return Number(item);

}

async function waitForStatus(adapter, address, expectedCodes, timeoutMs = 90000) {

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {

        try {

            const stack = await adapter._service().runGetMethod(
                address,
                "get_status"
            );
            const statusCode = readIntFromGetMethodStack(stack);

            if (expectedCodes.includes(statusCode)) {

                return statusCode;

            }

        } catch {

            // contract may still be indexing
        }

        await sleep(2500);

    }

    throw new Error(
        `Timed out waiting for status in [${expectedCodes.join(",")}]`
    );

}

async function resolveDeployerOutboundHash(tonService, deployer, destination) {

    const txs = await tonService.getTransactions(deployer, { limit: 12 });

    for (const tx of txs) {

        const outs = tx.out_msgs || [];
        const matched = outs.some((message) => {

            const dest = message.destination
                ?? message.msg_data?.destination
                ?? null;

            if (!dest) {

                return false;

            }

            try {

                return Address.parse(String(dest)).equals(
                    Address.parse(String(destination))
                );

            } catch {

                return false;

            }

        });

        if (matched) {

            return tx.transaction_id?.hash ?? tx.hash ?? null;

        }

    }

    return null;

}

async function main() {

    console.log("=== R7.70C1 Preflight ===");

    const tonConfig = loadTonConfig(process.env);

    if (tonConfig.network !== "testnet") {

        throw new Error(`STOP: wrong network=${tonConfig.network}`);

    }

    if (tonConfig.gameEscrowMode !== "game") {

        throw new Error(`STOP: wrong mode=${tonConfig.gameEscrowMode}`);

    }

    if (!tonConfig.deployerMnemonic) {

        throw new Error("STOP: TON_DEPLOYER_MNEMONIC missing");

    }

    if (tonConfig.deployMode !== "live") {

        throw new Error(`STOP: TON_DEPLOY_MODE must be live | got=${tonConfig.deployMode}`);

    }

    OwnerConfiguration.resetForTests();
    const ownerCfg = OwnerConfiguration.load({ env: process.env });
    const ownerAddress = ownerCfg.ownerWallet;

    if (!addrEq(ownerAddress, EXPECTED_OWNER)) {

        throw new Error(
            `STOP: wrong owner | got=${friendly(ownerAddress)} | expected=${friendly(EXPECTED_OWNER)}`
        );

    }

    if (!tonConfig.oracleAddress || !addrEq(tonConfig.oracleAddress, EXPECTED_DEPLOY)) {

        throw new Error(
            `STOP: wrong oracle | got=${tonConfig.oracleAddress}`
        );

    }

    const identity = await deriveDeployerWalletIdentity({
        mnemonic: tonConfig.deployerMnemonic,
        network: "testnet"
    });

    if (!addrEq(identity.address, EXPECTED_DEPLOY)) {

        throw new Error(
            `STOP: wrong deploy wallet | got=${identity.address}`
        );

    }

    if (Number(identity.walletId) !== 698983191) {

        throw new Error(`STOP: wrong walletId=${identity.walletId}`);

    }

    const artifact = verifyGameEscrowArtifact({
        expectedSha256: EXPECTED_ARTIFACT_SHA256,
        requirePresent: true,
        requireLoadable: true
    });

    if (!artifact.ok || artifact.match !== true) {

        throw new Error(
            `STOP: artifact mismatch | ${artifact.reasons?.join("; ")}`
        );

    }

    console.log("READY");
    console.log(`network=${tonConfig.network}`);
    console.log(`mode=${tonConfig.gameEscrowMode}`);
    console.log(`deploy=${mask(identity.address)} walletId=${identity.walletId}`);
    console.log(`oracle=${mask(tonConfig.oracleAddress)} source=${tonConfig.oracleSource}`);
    console.log(`owner=${mask(friendly(ownerAddress))} source=${ownerCfg.configPath}`);
    console.log(`artifactSha=${artifact.actualSha256}`);

    const logger = createLogger();
    const tonService = new TonService({
        logger,
        tonConfig: {
            ...tonConfig,
            escrowActivationTimeoutMs: 120000,
            pollIntervalMs: 2500
        }
    });

    tonService.initialize();

    const adapter = new TonGameContractAdapter({
        tonService,
        tonConfig: {
            ...tonConfig,
            ownerWallet: ownerAddress,
            escrowActivationTimeoutMs: 120000,
            pollIntervalMs: 2500
        },
        logger
    });

    const stamp = Date.now();
    const gameId = `r770c1_${stamp}`;
    const roomId = `room_r770c1_${stamp}`;
    const contractId = `contract_r770c1_${stamp}`;

    // Test identities for seats (no STAKE in this stage).
    const players = [
        {
            playerId: "p1",
            wallet: "EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j",
            requiredGram: 1
        },
        {
            playerId: "p2",
            wallet: "EQACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAsoi",
            requiredGram: 1
        },
        {
            playerId: "p3",
            wallet: "EQADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDD8UH",
            requiredGram: 1
        }
    ];

    const snapshot = Object.freeze({
        gameId,
        roomId,
        ownerWallet: ownerAddress,
        oracleWallet: tonConfig.oracleAddress,
        totalPot: 3,
        payoutAmount: 2.85,
        organizerFee: 0.15,
        organizerFeeRate: 0.05,
        players: Object.freeze(players.map((player) => Object.freeze(player))),
        stake: 1
    });

    console.log("");
    console.log("=== Deploy GameEscrow ===");

    const deploy = await adapter.deployContract({
        contractId,
        snapshot
    });

    if (!deploy?.ok) {

        throw new Error(`STOP: deploy failed | ${deploy?.reason ?? "unknown"}`);

    }

    const escrowAddress = deploy.contractAddress;
    let deployTx = deploy.deploymentTxId;
    const deployedAt = deploy.deployedAt;

    if (String(deployTx ?? "").startsWith("ton_addr_")
        || String(deployTx ?? "").startsWith("ton_oracle_seq_")) {

        const resolved = await resolveDeployerOutboundHash(
            tonService,
            identity.address,
            escrowAddress
        );

        if (resolved) {

            deployTx = resolved;
            console.log(`deployTxResolved=${resolved}`);

        } else {

            throw new Error(
                "STOP: could not resolve real deploy transaction hash from chain"
            );

        }

    }

    console.log(`deployTx=${deployTx}`);
    console.log(`escrow=${escrowAddress}`);
    console.log(`deployedAt=${new Date(deployedAt).toISOString()}`);

    // Verify account active + code hash.
    const account = await tonService.getAccount(escrowAddress);

    if (account?.state !== "active") {

        throw new Error(`STOP: escrow not active | state=${account?.state}`);

    }

    const balanceNano = await tonService.getBalance(escrowAddress);
    const balanceTon = Number(balanceNano) / 1e9;

    let onChainCodeHash = null;

    if (account?.code) {

        const codeCell = cellFromAccountField(account.code);
        onChainCodeHash = cellHashHex(codeCell);

    }

    if (
        onChainCodeHash
        && onChainCodeHash.toLowerCase() !== EXPECTED_CODE_HASH.toLowerCase()
    ) {

        throw new Error(
            `STOP: on-chain codeHash mismatch | got=${onChainCodeHash}`
        );

    }

    console.log("");
    console.log("=== Contract Verification ===");
    console.log(`state=${account.state}`);
    console.log(`balanceTon=${balanceTon}`);
    console.log(`codeHash=${onChainCodeHash}`);
    console.log(`artifactSha=${artifact.actualSha256}`);

    const snapshotHash = hashGameContractSnapshot(snapshot).toString("hex");
    const contractIdHash = createHash("sha256")
        .update(String(contractId))
        .digest("hex");

    console.log("");
    console.log("=== INIT_GAME ===");

    const init = await adapter.initGame({
        contractAddress: escrowAddress,
        oracle: tonConfig.oracleAddress,
        owner: ownerAddress,
        contractIdHash,
        snapshotHash
    });

    if (!init?.ok) {

        throw new Error(`STOP: INIT_GAME failed | ${init?.reason ?? "unknown"}`);

    }

    if (String(init.txId ?? "").startsWith("ton_init_")) {

        throw new Error(
            "STOP: fake/placeholder INIT_GAME hash detected — broadcast did not run"
        );

    }

    console.log(`initTx=${init.txId}`);

    // Wait until status == DEPLOYED (1).
    const statusCode = await waitForStatus(adapter, escrowAddress, [1], 120000);
    console.log(`statusAfterInit=${STATUS_BY_CODE[statusCode]} (${statusCode})`);

    let paidMask = null;

    try {

        paidMask = await adapter.getPaidMask(escrowAddress);

    } catch (error) {

        console.warn(`paidMask getter warn: ${error?.message ?? error}`);

    }

    // Parse storage for oracle/owner (no dedicated getters on contract).
    const accountAfter = await tonService.getAccount(escrowAddress);
    let storage = null;

    if (accountAfter?.data) {

        const dataCell = cellFromAccountField(accountAfter.data);
        storage = parseGameEscrowData(dataCell);

    }

    if (!storage) {

        throw new Error("STOP: could not parse on-chain GameEscrow data");

    }

    if (!addrEq(storage.oracle, EXPECTED_DEPLOY)) {

        throw new Error(`STOP: on-chain oracle wrong | ${storage.oracle}`);

    }

    if (!addrEq(storage.owner, EXPECTED_OWNER)) {

        throw new Error(`STOP: on-chain owner wrong | ${storage.owner}`);

    }

    if (Number(storage.paidMask) !== 0) {

        throw new Error(`STOP: paidMask expected 0 | got=${storage.paidMask}`);

    }

    if (storage.status !== "DEPLOYED") {

        throw new Error(`STOP: unexpected status=${storage.status}`);

    }

    console.log("");
    console.log("=== On-chain Getter / Storage Verification ===");
    console.log(`status=${storage.status}`);
    console.log(`oracle=${mask(storage.oracle)}`);
    console.log(`owner=${mask(storage.owner)}`);
    console.log(`paidMask=${storage.paidMask}`);
    console.log(`gameId=${gameId}`);
    console.log(`snapshotHash=${storage.snapshotHash.slice(0, 16)}...`);

    const report = {
        deployment: {
            transactionHash: deployTx,
            gameEscrowAddress: escrowAddress,
            network: "testnet",
            timestamp: deployedAt
        },
        contractVerification: {
            artifactSha256: artifact.actualSha256,
            codeHash: onChainCodeHash,
            state: account.state,
            balanceTon
        },
        initGame: {
            transactionHash: init.txId,
            status: storage.status,
            oracle: storage.oracle,
            owner: storage.owner,
            gameId
        },
        onChain: {
            oracle: storage.oracle,
            owner: storage.owner,
            status: storage.status,
            paidMask: storage.paidMask,
            players: storage.players.map(mask)
        },
        backendConfirmation: {
            deployOk: true,
            initOk: true,
            fakeHashRejected: true,
            blockchainSourceOfTruth: true
        },
        verdict: "READY FOR R7.70C2"
    };

    console.log("");
    console.log("=== R7.70C1 RESULT ===");
    console.log(JSON.stringify({
        ...report,
        deployment: {
            ...report.deployment,
            gameEscrowAddress: mask(escrowAddress)
        },
        initGame: {
            ...report.initGame,
            oracle: mask(storage.oracle),
            owner: mask(storage.owner)
        },
        onChain: {
            ...report.onChain,
            oracle: mask(storage.oracle),
            owner: mask(storage.owner)
        }
    }, null, 2));

    // Persist unmasked report for operator follow-up (local only).
    const outPath = resolve(currentDir, "../../_audit_tmp/r770c1-report.json");

    try {

        const { mkdirSync, writeFileSync } = await import("node:fs");
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
        console.log(`reportWritten=${outPath}`);

    } catch (error) {

        console.warn(`report write skipped: ${error?.message ?? error}`);

    }

    try {

        tonService.shutdown?.();

    } catch {

        // ignore
    }

    console.log("READY FOR R7.70C2");

}

main().catch((error) => {

    console.error("BLOCKED");
    console.error(error);
    process.exit(1);

});
