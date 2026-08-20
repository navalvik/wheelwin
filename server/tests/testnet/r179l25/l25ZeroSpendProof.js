/**
 * R17.9L.25 — TEST-ONLY on-chain zero-spend evidence collector.
 * Proves WheelWin wallets did not deploy DepositContract or FundSeat.
 */

import { canonicalizeTonWalletAddress } from "../../../models/TonWalletAddress.js";
import {
    FROZEN_TESTNET_DEPOSIT_DEPLOYER_ADDRESS,
    PRODUCTION_DEPLOY_WALLET
} from "../../../payment/ton/depositTestnetFixture.js";
import {
    decodeFundSeatBody
} from "../../../deposit/RealTonDepositBlockchainSource.js";
import { L25_ERROR_CODES, L25TestError } from "./l25Errors.js";

function inboundDestination(tx) {

    const inMsg = tx?.in_msg ?? tx?.inMessage ?? null;

    return canonicalizeTonWalletAddress(
        inMsg?.destination
            ?? inMsg?.dest
            ?? ""
    );

}

function outboundMessages(tx) {

    const list = tx?.out_msgs ?? tx?.outMessages ?? [];

    return Array.isArray(list) ? list : [];

}

function messageValueNano(msg) {

    const raw = msg?.value ?? msg?.info?.value?.coins ?? null;

    if (raw == null) {

        return 0n;

    }

    try {

        return BigInt(String(raw));

    } catch {

        return 0n;

    }

}

function messageDestination(msg) {

    return canonicalizeTonWalletAddress(
        msg?.destination
            ?? msg?.dest
            ?? msg?.info?.dest
            ?? ""
    );

}

function messageBody(msg) {

    return msg?.msg_data?.body ?? msg?.body ?? null;

}

function transactionHash(tx) {

    return tx?.transaction_id?.hash
        ?? tx?.hash
        ?? null;

}

function transactionUtime(tx) {

    const utime = Number(tx?.utime ?? tx?.now ?? 0);

    return Number.isFinite(utime) && utime > 0 ? utime * 1000 : null;

}

/**
 * Resolve WheelWin / historical wallets that must show zero spend.
 */
export function resolveWheelWinWatchAddresses(env = process.env) {

    const addresses = new Set();

    for (const raw of [
        env.TON_DEPLOYER_WALLET,
        PRODUCTION_DEPLOY_WALLET,
        env.TON_TESTNET_DEPOSIT_DEPLOYER_ADDRESS,
        FROZEN_TESTNET_DEPOSIT_DEPLOYER_ADDRESS
    ]) {

        const canonical = canonicalizeTonWalletAddress(raw);

        if (canonical) {

            addresses.add(canonical);

        }

    }

    return Object.freeze([...addresses]);

}

/**
 * Inspect a wallet's recent transactions for outbound spend to DepositAddress
 * or FundSeat bodies within the test window.
 */
export async function collectWalletSpendEvidence({
    tonService,
    walletAddress,
    depositAddress,
    windowStartMs,
    windowEndMs = Date.now(),
    limit = 40
} = {}) {

    const wallet = canonicalizeTonWalletAddress(walletAddress);
    const deposit = canonicalizeTonWalletAddress(depositAddress);
    const transactions = await tonService.getTransactions(wallet, { limit });

    const relevant = [];

    for (const tx of transactions ?? []) {

        const ts = transactionUtime(tx);

        if (ts != null && (ts < windowStartMs || ts > windowEndMs)) {

            continue;

        }

        for (const msg of outboundMessages(tx)) {

            const dest = messageDestination(msg);
            const value = messageValueNano(msg);
            const body = messageBody(msg);
            const fundSeat = body ? decodeFundSeatBody(body) : null;
            const targetsDeposit = Boolean(deposit && dest === deposit);

            if (!targetsDeposit && !fundSeat) {

                continue;

            }

            relevant.push(Object.freeze({
                wallet,
                sender: wallet,
                destination: dest,
                valueNano: value.toString(),
                transactionHash: transactionHash(tx),
                timestamp: ts,
                isFundSeat: Boolean(fundSeat),
                seatIndex: fundSeat?.seatIndex ?? null,
                targetsDeposit
            }));

        }

    }

    return Object.freeze(relevant);

}

/**
 * Prove no WheelWin wallet spent TON to deploy/fund the deposit in the window.
 */
export async function assertZeroWheelWinSpend({
    tonService,
    depositAddress,
    windowStartMs,
    windowEndMs = Date.now(),
    env = process.env
} = {}) {

    const watchAddresses = resolveWheelWinWatchAddresses(env);
    const violations = [];
    const evidence = [];

    for (const wallet of watchAddresses) {

        const rows = await collectWalletSpendEvidence({
            tonService,
            walletAddress: wallet,
            depositAddress,
            windowStartMs,
            windowEndMs
        });

        evidence.push(...rows);

        for (const row of rows) {

            if (row.targetsDeposit || row.isFundSeat) {

                violations.push(row);

            }

        }

    }

    if (violations.length > 0) {

        throw new L25TestError(
            "WheelWin / historical deployer wallet spent TON toward Deposit before DEPOSIT_FULL",
            L25_ERROR_CODES.ZERO_SPEND_VIOLATION,
            {
                violationCount: violations.length,
                sample: violations.slice(0, 3)
            }
        );

    }

    return Object.freeze({
        ok: true,
        watchedWallets: watchAddresses,
        depositAddress: canonicalizeTonWalletAddress(depositAddress),
        windowStartMs,
        windowEndMs,
        relevantOutboundCount: evidence.length,
        violations: Object.freeze([])
    });

}
