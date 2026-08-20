/**
 * R17.9L.25.D — TEST-ONLY read-only player wallet readiness (zero transactions).
 */

import { Address } from "@ton/core";

import { loadTonConfig } from "../../../config/ton.js";
import { TonService } from "../../../services/TonService.js";
import {
    assertExpectedPlayerAddresses,
    loadL25PlayerWallets,
    L25_PLAYER_ADDRESS_ENV_KEYS,
    L25_PLAYER_MNEMONIC_ENV_KEYS,
    resolveRawAddressIdentity,
    toPublicPlayerSnapshot
} from "./l25PlayerWallets.js";
import { L25_ERROR_CODES, L25TestError } from "./l25Errors.js";
import { l25WithRpcRetry } from "./l25RpcRetry.js";

const SECRET_PATTERN = /mnemonic|privateKey|secretKey|seed|keyPair/i;

function createSilentLogger() {

    return {
        info() {},
        warn() {},
        error() {}
    };

}

function requireReadinessEnv(env = process.env) {

    const missingMnemonics = L25_PLAYER_MNEMONIC_ENV_KEYS.filter(
        (key) => !String(env[key] ?? "").trim()
    );
    const missingAddresses = L25_PLAYER_ADDRESS_ENV_KEYS.filter(
        (key) => !String(env[key] ?? "").trim()
    );

    if (missingMnemonics.length || missingAddresses.length) {

        throw new L25TestError(
            "Player wallet readiness requires all L25_PLAYER_*_MNEMONIC and L25_PLAYER_*_ADDRESS values",
            L25_ERROR_CODES.READINESS_BLOCKED,
            {
                missingMnemonics,
                missingAddresses
            }
        );

    }

}

function formatTon(nano) {

    return (Number(nano) / 1e9).toFixed(6);

}

async function readAccountState(tonService, address) {

    try {

        const account = await l25WithRpcRetry(
            () => tonService.getAccount(address),
            { operationName: "getAccount/readiness" }
        );

        return account?.state
            ?? account?.status
            ?? account?.account?.state?.type
            ?? "UNKNOWN";

    } catch {

        return "UNKNOWN";

    }

}

/**
 * Read-only readiness verification. Never broadcasts transactions.
 */
export async function runL25PlayerWalletReadiness({
    env = process.env,
    tonService = null
} = {}) {

    if (String(env.TON_NETWORK || "testnet").toLowerCase() === "mainnet") {

        throw new L25TestError(
            "Refusing L25 wallet readiness on mainnet",
            L25_ERROR_CODES.ENV_DISABLED
        );

    }

    requireReadinessEnv(env);

    const localEnv = {
        ...env,
        TON_NETWORK: "testnet"
    };

    const service = tonService ?? new TonService({
        logger: createSilentLogger(),
        tonConfig: loadTonConfig(localEnv)
    });

    if (!tonService) {

        service.initialize();

    }

    const wallets = await loadL25PlayerWallets(localEnv, {
        requireExpectedAddresses: true
    });

    assertExpectedPlayerAddresses(wallets, localEnv);

    const reports = [];

    for (const wallet of wallets) {

        const expected = localEnv[L25_PLAYER_ADDRESS_ENV_KEYS[wallet.seatIndex]];
        const balanceNano = await l25WithRpcRetry(
            () => service.getBalance(wallet.addressCanonical),
            { operationName: "getBalance/readiness" }
        );
        const state = await readAccountState(service, wallet.addressCanonical);
        const normalizedState = String(state).toLowerCase();
        const funded = balanceNano > 0n;
        const active = normalizedState === "active";
        const addressMatch = resolveRawAddressIdentity(wallet.addressCanonical)
            === resolveRawAddressIdentity(expected);
        const ready = addressMatch && funded && active;

        reports.push(Object.freeze({
            seatIndex: wallet.seatIndex,
            label: wallet.label,
            walletContractType: wallet.walletContractType,
            keyDerivationMethod: wallet.keyDerivationMethod,
            address: wallet.addressCanonical,
            expectedAddress: Address.parse(expected).toString({
                bounceable: true,
                urlSafe: true
            }),
            rawIdentity: wallet.rawAddressIdentity,
            addressMatch,
            state: normalizedState.toUpperCase(),
            balanceNano: balanceNano.toString(),
            balanceTon: formatTon(balanceNano),
            reserved: false,
            ready
        }));

    }

    const allReady = reports.every((report) => report.ready);

    return Object.freeze({
        verdict: allReady ? "PLAYER_WALLETS_READY" : "BLOCKED",
        players: Object.freeze(reports),
        transactionsSent: 0,
        snapshot: toPublicPlayerSnapshot(wallets)
    });

}

/**
 * Print human-readable readiness report without secrets.
 */
export function printL25PlayerWalletReadinessReport(result) {

    const serialized = JSON.stringify(result);

    if (SECRET_PATTERN.test(serialized)) {

        throw new L25TestError(
            "Readiness report attempted to serialize secret material",
            L25_ERROR_CODES.PHASE_FAILED
        );

    }

    process.stdout.write("R17.9L.25.D PLAYER WALLET READINESS\n\n");

    for (const player of result.players) {

        process.stdout.write(`PLAYER ${player.seatIndex}\n`);
        process.stdout.write(`  Wallet: ${player.walletContractType}\n`);
        process.stdout.write(`  Derivation: ${player.keyDerivationMethod}\n`);
        process.stdout.write(`  Address: ${player.address}\n`);
        process.stdout.write(`  Expected: ${player.expectedAddress}\n`);
        process.stdout.write(`  Raw Identity: ${player.rawIdentity}\n`);
        process.stdout.write(`  Address Match: ${player.addressMatch ? "PASS" : "FAIL"}\n`);
        process.stdout.write(`  State: ${player.state}\n`);
        process.stdout.write(`  Balance: ${player.balanceTon} TON\n`);
        process.stdout.write(`  Reserved: ${player.reserved ? "YES" : "NO"}\n`);
        process.stdout.write(`  Ready: ${player.ready ? "YES" : "NO"}\n\n`);

    }

    process.stdout.write("Transactions sent: 0\n\n");
    process.stdout.write(`VERDICT:\n${result.verdict}\n`);

}
