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
    SendMode,
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
        tonNetworkServiceRegistry = null,
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
        this._tonNetworkServiceRegistry = tonNetworkServiceRegistry;
        this._walletResolver = walletResolver;
        this._logger = logger;
        this._gasReserveNano = gasReserveNano;
    }

    getGasReserveNano() {
        return this._gasReserveNano;
    }

    async getBalance(roomNumber, network = null) {
        const identity = await this._resolveAddress(roomNumber, network);
        return this._service(network).getBalance(identity.address);
    }

    async getWalletAddress(roomNumber, network = null) {
        const identity = await this._resolveAddress(roomNumber, network);
        return identity.address;
    }

    async getTransactions(roomNumber, query = {}, network = null) {
        const identity = await this._resolveAddress(roomNumber, network);
        const service = this._service(network);
        if (typeof service.getTransactions !== "function") {
            return [];
        }
        return service.getTransactions(identity.address, query);
    }

    async getSeqno(roomNumber, network = null) {
        const identity = await this._resolveAddress(roomNumber, network);
        const service = this._service(network);
        if (typeof service.getSeqno !== "function") {
            return null;
        }
        return service.getSeqno(identity.address);
    }

    async canFundTransfer({ roomNumber, network = null, amountNano, sourceReserveNano = null } = {}) {
        assertNonNegativeNano(amountNano, "amountNano");

        const reserveNano = resolveSourceReserveNano(
            sourceReserveNano,
            this._gasReserveNano
        );
        const identity = await this._resolve(roomNumber, network);
        const service = this._service(network);
        const balanceNano = await service.getBalance(identity.address);
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
        network = null,
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
        const identity = await this._resolve(roomNumber, network);
        const service = this._service(network);
        const destinationAddress = Address.parse(String(destination ?? "").trim());

        if (identity.workchain != null && Number(identity.workchain) !== 0) {
            throw new Error("Room Wallet workchain must be 0 for WalletContractV4");
        }

        const balanceNano = await service.getBalance(identity.address);
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

        const publicKey = toSigningBuffer(identity.publicKey, "publicKey");
        const secretKey = toSigningBuffer(identity.secretKey, "secretKey");

        const wallet = WalletContractV4.create({
            workchain: Number(identity.workchain ?? 0),
            publicKey
        });

        const derivedAddress = wallet.address.toString({ bounceable: true, urlSafe: true });
        const configuredAddress = Address.parse(identity.address)
            .toString({ bounceable: true, urlSafe: true });

        if (derivedAddress !== configuredAddress) {
            throw new Error("room wallet identity drift");
        }

        let seqno = 0;
        try {
            seqno = await service.getSeqno(identity.address);
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
            secretKey,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
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

        const broadcast = await service.broadcastTransaction(bocBase64);
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

    _service(network = null) {
        const normalized = String(network ?? "").trim().toLowerCase();
        if (normalized && typeof this._tonNetworkServiceRegistry?.get === "function") {
            const service = this._tonNetworkServiceRegistry.get(normalized);
            if (!service) {
                throw new Error("TON service is unavailable for network " + normalized);
            }
            return service;
        }

        return this._tonService;
    }

    async _resolveAddress(roomNumber, network = null) {
        const identity = await this._walletResolver(roomNumber, network);

        if (!identity || identity.roomNumber == null || !identity.address) {
            throw new Error(`invalid wallet identity for room ${roomNumber}`);
        }

        return identity;
    }

    async _resolve(roomNumber, network = null) {
        const identity = await this._resolveAddress(roomNumber, network);

        if (!identity.publicKey || !identity.secretKey) {
            throw new Error(`signing material is unavailable for room ${roomNumber}`);
        }

        return identity;
    }
}

function toSigningBuffer(value, label) {
    if (Buffer.isBuffer(value)) {
        return value;
    }

    if (value instanceof Uint8Array) {
        return Buffer.from(value);
    }

    throw new TypeError(`${label} must be a Buffer or Uint8Array`);
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
