/**
 * R17.9L.25 — TEST-ONLY player-signed DepositContract deployment.
 *
 * Consumes authoritative package StateInit BOCs. Never uses
 * TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC or TON_DEPLOYER_MNEMONIC.
 */

import {
    Address,
    Cell,
    beginCell,
    contractAddress,
    external,
    internal,
    SendMode,
    storeMessage,
    toNano
} from "@ton/core";

import {
    DEPOSIT_ACCOUNT_STATE
} from "../../../deposit/RealTonDepositBlockchainSource.js";
import { canonicalizeTonWalletAddress } from "../../../models/TonWalletAddress.js";
import {
    FROZEN_TESTNET_DEPOSIT_DEPLOYER_ADDRESS,
    PRODUCTION_DEPLOY_WALLET
} from "../../../payment/ton/depositTestnetFixture.js";
import { L25_ERROR_CODES, L25TestError } from "./l25Errors.js";
import {
    isL25TransientRpcError,
    l25Sleep,
    l25WithRpcRetry
} from "./l25RpcRetry.js";

export const L25_DEFAULT_DEPLOY_VALUE_TON = "0.05";

export const L25_DEPLOY_MIN_SENDER_NANO = toNano("0.08");

/** R17.9L.25.I.2.A — longer ACTIVE wait; transient RPC no longer aborts immediately. */
const ACTIVE_WAIT_TIMEOUT_MS = 300_000;
const ACTIVE_WAIT_INTERVAL_MS = 3_000;

const PLAYER_SEND_MODE = SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS;

function loadCellFromBoc(bocBase64, label) {

    if (typeof bocBase64 !== "string" || !bocBase64.trim()) {

        throw new L25TestError(
            `${label} BOC is missing from deposit package`,
            L25_ERROR_CODES.STATEINIT_MISMATCH,
            { field: label }
        );

    }

    try {

        const cells = Cell.fromBoc(Buffer.from(bocBase64, "base64"));

        if (!cells.length) {

            throw new Error("empty boc");

        }

        return cells[0];

    } catch (error) {

        throw new L25TestError(
            `Unable to decode ${label} BOC`,
            L25_ERROR_CODES.STATEINIT_MISMATCH,
            { field: label, cause: error?.message ?? String(error) }
        );

    }

}

/**
 * Reconstruct StateInit from authoritative package BOCs and assert address.
 */
export function reconstructPackageStateInit(depositPackage) {

    const code = loadCellFromBoc(depositPackage?.stateInit?.codeBoc, "code");
    const data = loadCellFromBoc(depositPackage?.stateInit?.dataBoc, "data");
    const stateInit = { code, data };
    const address = contractAddress(0, stateInit);
    const addressFriendly = address.toString({
        bounceable: true,
        urlSafe: true
    });

    const packageAddress = canonicalizeTonWalletAddress(
        depositPackage.depositAddress ?? depositPackage.address
    );

    const derivedCanonical = canonicalizeTonWalletAddress(addressFriendly);

    if (!packageAddress || packageAddress !== derivedCanonical) {

        throw new L25TestError(
            "Reconstructed StateInit address does not match package DepositAddress",
            L25_ERROR_CODES.STATEINIT_MISMATCH,
            {
                packageAddress,
                derivedAddress: derivedCanonical
            }
        );

    }

    return Object.freeze({
        code,
        data,
        stateInit,
        address,
        addressFriendly,
        addressCanonical: derivedCanonical
    });

}

function assertPlayerSenderAllowed(senderAddress, env = process.env) {

    const sender = canonicalizeTonWalletAddress(senderAddress);

    if (!sender) {

        throw new L25TestError(
            "Deploy sender address is invalid",
            L25_ERROR_CODES.SENDER_FORBIDDEN
        );

    }

    const forbidden = [
        env.TON_DEPLOYER_WALLET,
        PRODUCTION_DEPLOY_WALLET,
        env.TON_TESTNET_DEPOSIT_DEPLOYER_ADDRESS,
        FROZEN_TESTNET_DEPOSIT_DEPLOYER_ADDRESS
    ];

    for (const raw of forbidden) {

        const canonical = canonicalizeTonWalletAddress(raw);

        if (canonical && canonical === sender) {

            throw new L25TestError(
                "Deploy sender is a forbidden WheelWin / historical deployer wallet",
                L25_ERROR_CODES.SENDER_FORBIDDEN,
                { sender }
            );

        }

    }

    return sender;

}

async function waitUntilActive(getContractState, address) {

    const deadline = Date.now() + ACTIVE_WAIT_TIMEOUT_MS;

    let last = null;

    while (Date.now() < deadline) {

        try {

            last = await l25WithRpcRetry(
                () => getContractState(address),
                { operationName: "getContractState/waitUntilActive" }
            );

        } catch (error) {

            if (!isL25TransientRpcError(error)) {

                throw error;

            }

            // Exhausted inner retries; keep waiting until ACTIVE deadline.
            await l25Sleep(ACTIVE_WAIT_INTERVAL_MS);
            continue;

        }

        if (last.state === DEPOSIT_ACCOUNT_STATE.ACTIVE) {

            return last;

        }

        if (last.state === DEPOSIT_ACCOUNT_STATE.FROZEN) {

            throw new L25TestError(
                "Deployed account became FROZEN",
                L25_ERROR_CODES.PHASE_FAILED,
                { state: last.state }
            );

        }

        await l25Sleep(ACTIVE_WAIT_INTERVAL_MS);

    }

    throw new L25TestError(
        "Deposit contract did not become ACTIVE within timeout",
        L25_ERROR_CODES.TIMEOUT,
        { lastState: last?.state ?? null }
    );

}

/**
 * Sign and broadcast DepositContract deployment from a player test wallet.
 *
 * @param {{
 *   depositPackage: object,
 *   playerWallet: object,
 *   tonService: object,
 *   getContractState: (address: string) => Promise<object>,
 *   deployValueTon?: string,
 *   env?: object,
 *   send?: boolean
 * }} params
 */
export async function deployDepositContractAsPlayer({
    depositPackage,
    playerWallet,
    tonService,
    getContractState,
    deployValueTon = L25_DEFAULT_DEPLOY_VALUE_TON,
    env = process.env,
    send = true
} = {}) {

    if (!playerWallet?.wallet || !playerWallet?.keyPair) {

        throw new L25TestError(
            "playerWallet with wallet + keyPair is required",
            L25_ERROR_CODES.WALLET_INVALID
        );

    }

    const reconstructed = reconstructPackageStateInit(depositPackage);
    const senderCanonical = assertPlayerSenderAllowed(
        playerWallet.addressCanonical ?? playerWallet.address,
        env
    );

    const walletCanonical = canonicalizeTonWalletAddress(playerWallet.address);

    if (walletCanonical !== senderCanonical) {

        throw new L25TestError(
            "Configured player wallet does not match asserted sender",
            L25_ERROR_CODES.SENDER_FORBIDDEN
        );

    }

    const balance = await l25WithRpcRetry(
        () => tonService.getBalance(playerWallet.address),
        { operationName: "getBalance/deploy" }
    );

    if (balance < L25_DEPLOY_MIN_SENDER_NANO) {

        throw new L25TestError(
            "Player deploy wallet has insufficient testnet TON",
            L25_ERROR_CODES.WALLET_UNDERFUNDED,
            {
                address: playerWallet.addressCanonical,
                balanceNano: balance.toString(),
                requiredNano: L25_DEPLOY_MIN_SENDER_NANO.toString()
            }
        );

    }

    if (!send) {

        return Object.freeze({
            sent: false,
            action: "dry_run",
            senderAddress: playerWallet.addressCanonical,
            depositAddress: reconstructed.addressCanonical,
            deployValueTon,
            transactionHash: null
        });

    }

    const walletAddress = playerWallet.wallet.address.toString({
        bounceable: false,
        urlSafe: true,
        testOnly: true
    });

    let seqno = 0;

    try {

        seqno = await l25WithRpcRetry(
            () => tonService.getSeqno(walletAddress),
            { operationName: "getSeqno/deploy" }
        );

    } catch {

        seqno = 0;

    }

    if (!Number.isInteger(seqno) || seqno < 0) {

        seqno = 0;

    }

    const transfer = playerWallet.wallet.createTransfer({
        seqno,
        secretKey: playerWallet.keyPair.secretKey,
        sendMode: PLAYER_SEND_MODE,
        messages: [
            internal({
                to: reconstructed.address,
                value: toNano(String(deployValueTon)),
                init: {
                    code: reconstructed.code,
                    data: reconstructed.data
                },
                bounce: false
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
        { operationName: "broadcastTransaction/deploy" }
    );
    const broadcastHash = broadcast?.hash
        ?? broadcast?.result?.hash
        ?? null;

    const seqnoDeadline = Date.now() + ACTIVE_WAIT_TIMEOUT_MS;

    while (Date.now() < seqnoDeadline) {

        try {

            const nextSeqno = await l25WithRpcRetry(
                () => tonService.getSeqno(walletAddress),
                { operationName: "getSeqno/deployConfirm" }
            );

            if (nextSeqno > seqno) {

                break;

            }

        } catch {

            // Wallet may still be UNINIT until first external applies.

        }

        await l25Sleep(ACTIVE_WAIT_INTERVAL_MS);

    }

    const active = await waitUntilActive(
        getContractState,
        reconstructed.addressCanonical
    );

    return Object.freeze({
        sent: true,
        action: "deployed",
        senderAddress: playerWallet.addressCanonical,
        depositAddress: reconstructed.addressCanonical,
        transactionHash: active.lastHash ?? broadcastHash,
        logicalTime: active.lastLt ?? null,
        accountState: active.state,
        deployValueTon,
        sentSeqno: seqno,
        timestamp: Date.now()
    });

}

export { assertPlayerSenderAllowed };
