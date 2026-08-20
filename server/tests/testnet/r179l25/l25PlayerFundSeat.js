/**
 * R17.9L.25 — TEST-ONLY player-signed FundSeat helper.
 * Uses encodeFundSeatBody from RealTonDepositBlockchainSource (no opcode duplication).
 */

import {
    Address,
    beginCell,
    external,
    internal,
    SendMode,
    storeMessage
} from "@ton/core";

import {
    encodeFundSeatBody
} from "../../../deposit/RealTonDepositBlockchainSource.js";
import { canonicalizeTonWalletAddress } from "../../../models/TonWalletAddress.js";
import { L25_ERROR_CODES, L25TestError } from "./l25Errors.js";
import { assertPlayerSenderAllowed } from "./l25PlayerDepositDeploy.js";
import { l25Sleep, l25WithRpcRetry } from "./l25RpcRetry.js";

const PLAYER_SEND_MODE = SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS;

const ACTIVE_WAIT_TIMEOUT_MS = 90_000;
const ACTIVE_WAIT_INTERVAL_MS = 2_500;

/**
 * Resolve authoritative FundSeat nanoton amount for a seat from session/package.
 */
export function resolveSeatExpectedAmountNano(session, seatIndex) {

    const index = Number(seatIndex);

    if (!Number.isInteger(index) || index < 0 || index > 2) {

        throw new L25TestError(
            "seatIndex must be 0, 1, or 2",
            L25_ERROR_CODES.SEAT_MISMATCH,
            { seatIndex }
        );

    }

    const binding = session?.bindings?.[index] ?? null;
    const metadata = session?.metadata ?? {};
    const packageBinding = session?.metadata?.depositPackage?.bindings?.[index]
        ?? null;

    if (binding?.expectedAmount != null) {

        const amount = BigInt(String(binding.expectedAmount));

        if (amount > 0n) {

            return amount;

        }

    }

    if (packageBinding?.expectedAmount != null) {

        const amount = BigInt(String(packageBinding.expectedAmount));

        if (amount > 0n) {

            return amount;

        }

    }

    const stakeRaw = metadata[`expectedStake${index}`]
        ?? packageBinding?.expectedStake
        ?? null;

    const feeRaw = metadata.creationFeePerSeat
        ?? session?.metadata?.depositPackage?.creationFeePerSeat
        ?? null;

    if (stakeRaw == null || feeRaw == null) {

        throw new L25TestError(
            "Authoritative expectedAmount nano is missing for seat",
            L25_ERROR_CODES.AMOUNT_MISMATCH,
            { seatIndex }
        );

    }

    const amount = BigInt(String(stakeRaw)) + BigInt(String(feeRaw));

    if (amount <= 0n) {

        throw new L25TestError(
            "Computed expectedAmount must be positive",
            L25_ERROR_CODES.AMOUNT_MISMATCH,
            { seatIndex, amount: amount.toString() }
        );

    }

    return amount;

}

/**
 * Assert playerN → FundSeat(N) ownership.
 */
export function assertSeatOwnership(playerWallet, seatIndex, session) {

    const index = Number(seatIndex);

    if (playerWallet?.seatIndex !== index) {

        throw new L25TestError(
            "Player seatIndex does not match FundSeat seat",
            L25_ERROR_CODES.SEAT_MISMATCH,
            {
                playerSeat: playerWallet?.seatIndex ?? null,
                fundSeat: index
            }
        );

    }

    const binding = session?.bindings?.[index] ?? null;
    const playerCanonical = canonicalizeTonWalletAddress(
        playerWallet.addressCanonical ?? playerWallet.address
    );
    const bindingCanonical = canonicalizeTonWalletAddress(binding?.wallet);

    if (!playerCanonical || !bindingCanonical || playerCanonical !== bindingCanonical) {

        throw new L25TestError(
            "FundSeat player wallet does not match DepositSession binding",
            L25_ERROR_CODES.SEAT_MISMATCH,
            {
                seatIndex: index,
                player: playerCanonical,
                binding: bindingCanonical
            }
        );

    }

    return true;

}

/**
 * Sign and broadcast FundSeat from the seat-owning player wallet.
 */
export async function fundSeatAsPlayer({
    session,
    playerWallet,
    seatIndex,
    tonService,
    env = process.env,
    send = true,
    expectedAmountNano = null
} = {}) {

    assertSeatOwnership(playerWallet, seatIndex, session);
    assertPlayerSenderAllowed(
        playerWallet.addressCanonical ?? playerWallet.address,
        env
    );

    const depositAddress = canonicalizeTonWalletAddress(session.depositAddress);

    if (!depositAddress) {

        throw new L25TestError(
            "session.depositAddress is required for FundSeat",
            L25_ERROR_CODES.PHASE_FAILED
        );

    }

    const amount = expectedAmountNano != null
        ? BigInt(String(expectedAmountNano))
        : resolveSeatExpectedAmountNano(session, seatIndex);

    const authoritative = resolveSeatExpectedAmountNano(session, seatIndex);

    if (amount !== authoritative) {

        throw new L25TestError(
            "FundSeat value must equal authoritative expectedAmountNano",
            L25_ERROR_CODES.AMOUNT_MISMATCH,
            {
                seatIndex,
                amount: amount.toString(),
                authoritative: authoritative.toString()
            }
        );

    }

    if (!send) {

        return Object.freeze({
            sent: false,
            action: "dry_run",
            seatIndex: Number(seatIndex),
            senderAddress: playerWallet.addressCanonical,
            depositAddress,
            valueNano: amount.toString(),
            transactionHash: null
        });

    }

    const balance = await l25WithRpcRetry(
        () => tonService.getBalance(playerWallet.address),
        { operationName: "getBalance/fundSeat" }
    );

    // Require amount + small gas cushion.
    const required = amount + 50_000_000n;

    if (balance < required) {

        throw new L25TestError(
            "Player wallet underfunded for FundSeat",
            L25_ERROR_CODES.WALLET_UNDERFUNDED,
            {
                seatIndex,
                address: playerWallet.addressCanonical,
                balanceNano: balance.toString(),
                requiredNano: required.toString()
            }
        );

    }

    const walletAddress = playerWallet.wallet.address.toString({
        bounceable: false,
        urlSafe: true,
        testOnly: true
    });

    let seqno = await l25WithRpcRetry(
        () => tonService.getSeqno(walletAddress),
        { operationName: "getSeqno/fundSeat" }
    );

    if (!Number.isInteger(seqno) || seqno < 0) {

        seqno = 0;

    }

    const body = encodeFundSeatBody(seatIndex);

    const transfer = playerWallet.wallet.createTransfer({
        seqno,
        secretKey: playerWallet.keyPair.secretKey,
        sendMode: PLAYER_SEND_MODE,
        messages: [
            internal({
                to: Address.parse(depositAddress),
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
        { operationName: "broadcastTransaction/fundSeat" }
    );
    const broadcastHash = broadcast?.hash
        ?? broadcast?.result?.hash
        ?? null;

    const seqnoDeadline = Date.now() + ACTIVE_WAIT_TIMEOUT_MS;

    while (Date.now() < seqnoDeadline) {

        try {

            const nextSeqno = await l25WithRpcRetry(
                () => tonService.getSeqno(walletAddress),
                { operationName: "getSeqno/fundSeatConfirm" }
            );

            if (nextSeqno > seqno) {

                break;

            }

        } catch {

            // ignore transient

        }

        await l25Sleep(ACTIVE_WAIT_INTERVAL_MS);

    }

    return Object.freeze({
        sent: true,
        action: "fund_seat",
        seatIndex: Number(seatIndex),
        senderAddress: playerWallet.addressCanonical,
        depositAddress,
        valueNano: amount.toString(),
        transactionHash: broadcastHash,
        sentSeqno: seqno,
        timestamp: Date.now()
    });

}
