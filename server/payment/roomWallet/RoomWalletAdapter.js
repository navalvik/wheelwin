/**
 * TON transport adapter for persistent Room Wallets.
 *
 * The adapter is intentionally independent from WheelWin gameplay and
 * settlement calculations. It accepts an already-resolved wallet identity
 * and signs a plain TON transfer. Recipient value is never reduced by gas;
 * the source Room Wallet must have enough balance for value plus the configured
 * source-wallet reserve.
 */

import {
    Address,
    beginCell,
    external,
    internal,
    storeMessage
} from "@ton/core";
import { WalletContractV4 } from "@ton/ton";

import {
    ROOM_WALLET_POLICY,
    assertNonNegativeNano
} from "./RoomWalletFinancialPolicy.js";

export class RoomWalletAdapter {
    constructor({
        tonService,
        walletResolver,
        logger = null,
        gasReserveNano = ROOM_WALLET_POLICY.initialRoomReserveNano
    } = {}) {
        if (!tonService) {
            throw new Error("RoomWalletAdapter requires tonService");
        }

        if (typeof walletResolver !== "function") {
            throw new TypeError("RoomWalletAdapter requires walletResolver");
        }

        assertNonNegativeNano(gasReserveNano, "gasReserveNano");

        this._tonService = tonService;
        this._walletResolver = walletResolver;
        this._logger = logger;
        this._gasReserveNano = gasReserveNano;
    }

    getGasReserveNano() {
        return this._gasReserveNano;
    }

    async getBalance(roomNumber) {
        const identity = await this._resolve(roomNumber);
        return this._tonService.getBalance(identity.address);
    }

    async canFundTransfer({ roomNumber, amountNano, sourceReserveNano = null } = {}) {
        assertNonNegativeNano(amountNano, "amountNano");

        const reserveNano = resolveSourceReserveNano(
            sourceReserveNano,
            this._gasReserveNano
        );
        const identity = await this._resolve(roomNumber);
        const balanceNano = await this._tonService.getBalance(identity.address);
        const requiredNano = amountNano + reserveNano;

        return Object.freeze({
            ok: balanceNano >= requiredNano,
            roomNumber: identity.roomNumber,
            address: identity.address,
            balanceNano,
            amountNano,
            gasReserveNano: reserveNano,
            requiredNano,
            shortfallNano: balanceNano >= requiredNano
                ? 0n
                : requiredNano - balanceNano
        });
    }

    async sendTransfer({
        roomNumber,
        destination,
        amountNano,
        bounce = true,
        queryId = null,
        sourceReserveNano = null
    } = {}) {
        assertNonNegativeNano(amountNano, "amountNano");

        if (amountNano <= 0n) {
            throw new RangeError("amountNano must be greater than zero");
        }

        const reserveNano = resolveSourceReserveNano(
            sourceReserveNano,
            this._gasReserveNano
        );
        const identity = await this._resolve(roomNumber);
        const destinationAddress = Address.parse(String(destination ?? "").trim());

        if (identity.workchain != null && Number(identity.workchain) !== 0) {
            throw new Error("Room Wallet workchain must be 0 for WalletContractV4");
        }

        const balanceNano = await this._tonService.getBalance(identity.address);
        const requiredNano = amountNano + reserveNano;

        if (balanceNano < requiredNano) {
            return Object.freeze({
                ok: false,
                code: "INSUFFICIENT_BALANCE",
                roomNumber: identity.roomNumber,
                address: identity.address,
                balanceNano,
                requiredNano,
                shortfallNano: requiredNano - balanceNano,
                txHash: null
            });
        }

        const wallet = WalletContractV4.create({
            workchain: Number(identity.workchain ?? 0),
            publicKey: identity.publicKey
        });

        const derivedAddress = wallet.address.toString({ bounceable: true, urlSafe: true });
        const configuredAddress = Address.parse(identity.address)
            .toString({ bounceable: true, urlSafe: true });

        if (derivedAddress !== configuredAddress) {
            throw new Error("room wallet identity drift");
        }

        let seqno = 0;
        try {
            seqno = await this._tonService.getSeqno(identity.address);
        } catch {
            // A fresh/uninitialized V4 wallet has no readable seqno. Its first
            // outbound transaction must include StateInit and use seqno 0.
            seqno = 0;
        }

        if (!Number.isInteger(seqno) || seqno < 0) {
            throw new Error("invalid room wallet seqno");
        }

        const transfer = wallet.createTransfer({
            seqno,
            secretKey: identity.secretKey,
            messages: [
                internal({
                    to: destinationAddress,
                    value: amountNano,
                    bounce,
                    ...(queryId == null ? {} : { body: beginCell().storeUint(BigInt(queryId), 64).endCell() })
                })
            ]
        });

        const externalMessage = external({
            to: wallet.address,
            init: seqno === 0 ? wallet.init : undefined,
            body: transfer
        });

        const bocBase64 = beginCell()
            .store(storeMessage(externalMessage))
            .endCell()
            .toBoc()
            .toString("base64");

        const broadcast = await this._tonService.broadcastTransaction(bocBase64);
        const txHash = extractBroadcastTxHash(broadcast);

        this._logger?.info?.(
            `RoomWalletAdapter transfer broadcast | room=${identity.roomNumber} | `
            + `to=${configuredDestination(destinationAddress)} | amountNano=${amountNano} | seqno=${seqno}`
        );

        return Object.freeze({
            ok: true,
            code: txHash ? "SENT" : "AWAITING_TRANSACTION_HASH",
            roomNumber: identity.roomNumber,
            address: identity.address,
            destination: configuredDestination(destinationAddress),
            amountNano,
            gasReserveNano: reserveNano,
            seqno,
            txHash
        });
    }

    async _resolve(roomNumber) {
        const identity = await this._walletResolver(roomNumber);

        if (!identity || identity.roomNumber == null || !identity.address) {
            throw new Error(`invalid wallet identity for room ${roomNumber}`);
        }

        if (!identity.publicKey || !identity.secretKey) {
            throw new Error(`signing material is unavailable for room ${roomNumber}`);
        }

        return identity;
    }
}

function resolveSourceReserveNano(sourceReserveNano, defaultReserveNano) {
    if (sourceReserveNano == null) {
        return defaultReserveNano;
    }

    return assertNonNegativeNano(sourceReserveNano, "sourceReserveNano");
}

function configuredDestination(address) {
    return address.toString({ bounceable: true, urlSafe: true });
}

function extractBroadcastTxHash(broadcast) {
    if (!broadcast || typeof broadcast !== "object") {
        return null;
    }

    for (const value of [
        broadcast.hash,
        broadcast.txHash,
        broadcast.transactionHash,
        broadcast.result?.hash
    ]) {
        if (typeof value === "string" && value.trim()) {
            return value.trim();
        }
    }

    return null;
}
