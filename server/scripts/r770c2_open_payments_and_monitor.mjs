/**
 * R7.70C2 — OPEN_PAYMENTS (oracle) + STAKE monitor for GameEscrow.
 *
 * Prerequisite: GameEscrow must be DEPLOYED (after INIT_GAME).
 * Player STAKEs must be sent via TonConnect from the registered wallets.
 *
 * Usage:
 *   node server/scripts/r770c2_open_payments_and_monitor.mjs \
 *     --escrow EQCtpt... \
 *     --p0 <playerA> --p1 <playerB> --p2 <playerC>
 *
 * Optional:
 *   --stake 1
 *   --open-only
 *   --monitor-only
 *   --timeout-ms 600000
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Address, beginCell, toNano } from "@ton/core";

import { loadTonConfig } from "../config/ton.js";
import { deriveDeployerWalletIdentity } from "../payment/ton/deriveDeployerWalletIdentity.js";
import { TonGameContractAdapter } from "../payment/TonGameContractAdapter.js";
import { TonService } from "../services/TonService.js";

const DEFAULT_ESCROW =
    "EQCtptpd5CJbJFHzXsNVnyK0xpD3owAGjVKGh1Cp23AUqXMC";
const GAME_ESCROW_STAKE_OPCODE = 0x5354414B;
const STATUS = Object.freeze({
    0: "UNINITIALIZED",
    1: "DEPLOYED",
    2: "WAITING_PAYMENTS",
    3: "PAYMENTS_OPEN",
    5: "READY"
});

function buildStakeTonConnectTx(contractAddress, playerIndex, requiredGram = 1) {

    const payload = beginCell()
        .storeUint(GAME_ESCROW_STAKE_OPCODE, 32)
        .storeUint(Number(playerIndex), 8)
        .endCell()
        .toBoc()
        .toString("base64");

    return {
        validUntil: Math.floor(Date.now() / 1000) + 600,
        messages: [
            {
                address: String(contractAddress).trim(),
                amount: toNano(String(requiredGram)).toString(),
                payload
            }
        ]
    };

}
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

function parseArgs(argv) {

    const out = {
        escrow: process.env.R770C2_ESCROW || DEFAULT_ESCROW,
        stake: Number(process.env.R770C2_STAKE || 1),
        p0: process.env.R770C2_P0 || null,
        p1: process.env.R770C2_P1 || null,
        p2: process.env.R770C2_P2 || null,
        openOnly: false,
        monitorOnly: false,
        timeoutMs: 600000
    };

    for (let i = 0; i < argv.length; i += 1) {

        const arg = argv[i];
        const next = argv[i + 1];

        if (arg === "--escrow") {

            out.escrow = next;
            i += 1;

        } else if (arg === "--p0") {

            out.p0 = next;
            i += 1;

        } else if (arg === "--p1") {

            out.p1 = next;
            i += 1;

        } else if (arg === "--p2") {

            out.p2 = next;
            i += 1;

        } else if (arg === "--stake") {

            out.stake = Number(next);
            i += 1;

        } else if (arg === "--open-only") {

            out.openOnly = true;

        } else if (arg === "--monitor-only") {

            out.monitorOnly = true;

        } else if (arg === "--timeout-ms") {

            out.timeoutMs = Number(next);
            i += 1;

        }

    }

    return out;

}

function mask(value) {

    const text = String(value ?? "");

    if (text.length < 12) {

        return text || null;

    }

    return `${text.slice(0, 6)}....${text.slice(-4)}`;

}

function friendly(value) {

    return Address.parse(String(value)).toString({
        bounceable: true,
        urlSafe: true
    });

}

function readIntFromStack(result) {

    const item = Array.isArray(result?.stack)
        ? result.stack[0]
        : result?.stack?.items?.[0];

    if (item == null) {

        return NaN;

    }

    if (typeof item === "number" || typeof item === "bigint") {

        return Number(item);

    }

    if (Array.isArray(item)) {

        return Number(item[1]);

    }

    return Number(item.value ?? item.num ?? NaN);

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

async function readEscrowSnapshot(tonService, escrow) {

    const account = await tonService.getAccount(escrow);
    const balanceTon = Number(await tonService.getBalance(escrow)) / 1e9;
    const status = readIntFromStack(
        await tonService.runGetMethod(escrow, "get_status", [])
    );
    const paidMask = readIntFromStack(
        await tonService.runGetMethod(escrow, "get_paid_mask", [])
    );
    let requiredTotal = null;
    let totalPaid = null;

    try {

        requiredTotal = readIntFromStack(
            await tonService.runGetMethod(escrow, "get_required_total", [])
        );

    } catch {

        requiredTotal = null;

    }

    try {

        totalPaid = readIntFromStack(
            await tonService.runGetMethod(escrow, "get_total_paid", [])
        );

    } catch {

        totalPaid = null;

    }

    return {
        state: account.state,
        balanceTon,
        status,
        statusName: STATUS[status] ?? `UNKNOWN(${status})`,
        paidMask,
        requiredTotal,
        totalPaid
    };

}

async function main() {

    const args = parseArgs(process.argv.slice(2));
    const tonConfig = loadTonConfig(process.env);

    console.log("=== R7.70C2 Preflight ===");

    if (tonConfig.network !== "testnet") {

        throw new Error(`STOP: wrong network=${tonConfig.network}`);

    }

    if (tonConfig.gameEscrowMode !== "game") {

        throw new Error(`STOP: wrong mode=${tonConfig.gameEscrowMode}`);

    }

    const escrow = friendly(args.escrow);
    const stake = Number(args.stake);

    if (!Number.isFinite(stake) || stake !== 1) {

        throw new Error(`STOP: stake must be 1 Gram | got=${args.stake}`);

    }

    const logger = createLogger();
    const tonService = new TonService({
        logger,
        tonConfig: {
            ...tonConfig,
            pollIntervalMs: 2500
        }
    });

    tonService.initialize();
    await tonService.connect();

    const before = await readEscrowSnapshot(tonService, escrow);

    console.log(`escrow=${mask(escrow)}`);
    console.log(`network=${tonConfig.network}`);
    console.log(`mode=${tonConfig.gameEscrowMode}`);
    console.log(`state=${before.state}`);
    console.log(`status=${before.statusName}`);
    console.log(`paidMask=${before.paidMask}`);
    console.log(`balanceTon=${before.balanceTon}`);

    if (before.state !== "active") {

        throw new Error("STOP: escrow not active");

    }

    if (![1, 3, 5].includes(before.status)) {

        throw new Error(
            `STOP: unexpected status=${before.statusName} (need DEPLOYED/PAYMENTS_OPEN/READY)`
        );

    }

    if (!args.p0 || !args.p1 || !args.p2) {

        console.log("");
        console.log("BLOCKED: three player wallets required for OPEN_PAYMENTS + STAKE.");
        console.log("Provide:");
        console.log("  --p0 <PlayerA> --p1 <PlayerB> --p2 <PlayerC>");
        console.log("or env R770C2_P0 / R770C2_P1 / R770C2_P2");
        console.log("");
        console.log("Note: STAKE requires TonConnect signatures from those wallets.");
        console.log("Oracle OPEN_PAYMENTS must run before any STAKE.");
        process.exit(2);

    }

    const players = [
        { playerId: "p0", wallet: friendly(args.p0), requiredGram: stake },
        { playerId: "p1", wallet: friendly(args.p1), requiredGram: stake },
        { playerId: "p2", wallet: friendly(args.p2), requiredGram: stake }
    ];

    console.log("players:");

    for (let i = 0; i < players.length; i += 1) {

        console.log(`  [${i}] ${mask(players[i].wallet)}`);

    }

    // Print TonConnect payloads for operators (no signing here).
    console.log("");
    console.log("=== TonConnect STAKE payloads (for wallet UI) ===");

    for (let i = 0; i < players.length; i += 1) {

        const tx = buildStakeTonConnectTx(escrow, i, stake);

        console.log(`playerIndex=${i} wallet=${mask(players[i].wallet)}`);
        console.log(JSON.stringify(tx));

    }

    const identity = await deriveDeployerWalletIdentity({
        mnemonic: tonConfig.deployerMnemonic,
        network: "testnet"
    });

    const adapter = new TonGameContractAdapter({
        tonService,
        tonConfig,
        logger
    });

    if (!args.monitorOnly && before.status === 1) {

        console.log("");
        console.log("=== OPEN_PAYMENTS (oracle) ===");
        console.log(`oracle=${mask(identity.address)}`);

        const open = await adapter.openPayments({
            contractAddress: escrow,
            players
        });

        if (!open?.ok) {

            throw new Error(`STOP: OPEN_PAYMENTS failed | ${open?.reason}`);

        }

        if (String(open.txId ?? "").startsWith("ton_open_")) {

            throw new Error("STOP: placeholder OPEN_PAYMENTS hash");

        }

        console.log(`openTx=${open.txId}`);

        // Wait for PAYMENTS_OPEN
        const deadline = Date.now() + 120000;

        while (Date.now() < deadline) {

            const snap = await readEscrowSnapshot(tonService, escrow);

            if (snap.status === 3) {

                console.log("status=PAYMENTS_OPEN");
                break;

            }

            await sleep(2500);

        }

        const afterOpen = await readEscrowSnapshot(tonService, escrow);

        if (afterOpen.status !== 3) {

            throw new Error(
                `STOP: expected PAYMENTS_OPEN | got=${afterOpen.statusName}`
                + " (if still DEPLOYED, OPEN_PAYMENTS body likely aborted —"
                + " check Tact ref layout for player2/stake2)"
            );

        }

    }

    if (args.openOnly) {

        console.log("OPEN_PAYMENTS complete (--open-only). Waiting for TonConnect STAKEs.");
        process.exit(0);

    }

    console.log("");
    console.log("=== Monitoring STAKE confirmations (blockchain source of truth) ===");
    console.log("Approve 3 TonConnect STAKE txs from the registered player wallets.");

    const started = Date.now();
    let lastMask = -1;

    while (Date.now() - started < args.timeoutMs) {

        const snap = await readEscrowSnapshot(tonService, escrow);

        if (snap.paidMask !== lastMask) {

            lastMask = snap.paidMask;
            console.log(
                `paidMask=${snap.paidMask} (${snap.paidMask.toString(2).padStart(3, "0")}) `
                    + `status=${snap.statusName} balanceTon=${snap.balanceTon}`
            );

        }

        if (snap.paidMask === 7 && snap.status === 5) {

            console.log("");
            console.log("=== READY ===");
            console.log(JSON.stringify({
                escrow,
                paidMask: snap.paidMask,
                status: snap.statusName,
                balanceTon: snap.balanceTon,
                totalPaid: snap.totalPaid,
                requiredTotal: snap.requiredTotal
            }, null, 2));
            process.exit(0);

        }

        await sleep(3000);

    }

    const finalSnap = await readEscrowSnapshot(tonService, escrow);

    console.log("BLOCKED: timeout waiting for paidMask=7 / READY");
    console.log(JSON.stringify(finalSnap, null, 2));
    process.exit(1);

}

main().catch((error) => {

    console.error("BLOCKED");
    console.error(error);
    process.exit(1);

});
