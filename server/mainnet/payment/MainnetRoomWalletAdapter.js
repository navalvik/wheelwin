import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { durableWriteJson } from "../../payment/DurableJson.js";
import { Address, beginCell, external, internal, SendMode, storeMessage } from "@ton/core";
import { WalletContractV4 } from "@ton/ton";
import { MAINNET_GLOBAL_ID } from "../config/MainnetRuntimeConfig.js";
import { mainnetAddressIdentity } from "./MainnetAddress.js";

const DEFAULT_GAS_RESERVE_NANO = 10_000_000n;
const nonNegativeNano = (value, name) => {
    if (typeof value !== "bigint" || value < 0n) {
        throw new TypeError(`${name} must be a non-negative bigint`);
    }
    return value;
};

/**
 * Mainnet-only copy of the Testnet RoomWalletAdapter outbound seqno/outbox
 * path. The transfer, serialization, hold and retry algorithms are unchanged;
 * identity and persistent storage are bound to the Mainnet runtime.
 */
export class MainnetRoomWalletAdapter {
    constructor({ config, tonService, walletResolver, logger = null,
        gasReserveNano = DEFAULT_GAS_RESERVE_NANO,
        seqnoConfirmTimeoutMs = 90_000,
        seqnoConfirmPollMs = 2_000,
        now = () => Date.now(),
        sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
        if (config?.network !== "mainnet" || config?.globalId !== MAINNET_GLOBAL_ID
            || typeof config?.dataDir !== "string" || !config.dataDir
            || typeof tonService?.getSeqno !== "function"
            || typeof tonService?.broadcastTransaction !== "function") {
            throw new Error("MAINNET_ROOM_WALLET_ADAPTER_CONFIG_INVALID");
        }
        if (typeof walletResolver !== "function") throw new TypeError("MAINNET_WALLET_RESOLVER_REQUIRED");
        nonNegativeNano(gasReserveNano, "gasReserveNano");
        if (!Number.isFinite(seqnoConfirmTimeoutMs) || seqnoConfirmTimeoutMs <= 0) {
            throw new TypeError("seqnoConfirmTimeoutMs must be a positive finite number");
        }
        if (!Number.isFinite(seqnoConfirmPollMs) || seqnoConfirmPollMs < 0) {
            throw new TypeError("seqnoConfirmPollMs must be a non-negative finite number");
        }
        if (typeof now !== "function" || typeof sleep !== "function") {
            throw new TypeError("MAINNET_ROOM_WALLET_ADAPTER_CLOCK_INVALID");
        }
        this._sequenceStateDir = join(config.dataDir, "outgoing-seqno");
        this._tonService = tonService;
        this._walletResolver = walletResolver;
        this._logger = logger;
        this._gasReserveNano = gasReserveNano;
        this._seqnoConfirmTimeoutMs = seqnoConfirmTimeoutMs;
        this._seqnoConfirmPollMs = seqnoConfirmPollMs;
        this._now = now;
        this._sleep = sleep;
        this._outboundQueues = new Map();
        this._pendingOutboundSeqno = new Map();
    }

    supportsDurableTransferRetry() { return Boolean(this._sequenceStateDir); }

    async estimateOutboundTransferFee({ roomNumber, destination, amountNano, bounce = true, queryId = null } = {}) {
        nonNegativeNano(amountNano, "amountNano");
        const identity = await this._resolve(roomNumber);
        const destinationAddress = Address.parse(String(destination ?? "").trim());
        mainnetAddressIdentity(destinationAddress.toRawString());
        const { wallet, seqno, externalMessage } = await this._buildSignedExternalMessage({
            identity, destinationAddress, amountNano, bounce, queryId
        });
        if (typeof this._tonService.estimateExternalMessageFee !== "function") {
            return Object.freeze({ ok: false, code: "FEE_ESTIMATION_UNAVAILABLE", roomNumber });
        }
        try {
            const estimate = await this._tonService.estimateExternalMessageFee(wallet.address, {
                body: externalMessage.body,
                initCode: externalMessage.init?.code ?? null,
                initData: externalMessage.init?.data ?? null,
                ignoreSignature: true
            });
            if (typeof estimate?.totalFeeNano !== "bigint" || estimate.totalFeeNano < 0n) {
                return Object.freeze({ ok: false, code: "FEE_ESTIMATION_UNAVAILABLE", roomNumber });
            }
            return Object.freeze({ ok: true, feeSource: "estimateExternalMessageFee", roomNumber,
                destination: configuredDestination(destinationAddress), amountNano, seqno,
                inFwdFeeNano: estimate.inFwdFeeNano, storageFeeNano: estimate.storageFeeNano,
                gasFeeNano: estimate.gasFeeNano, fwdFeeNano: estimate.fwdFeeNano,
                totalNano: estimate.totalFeeNano });
        } catch {
            return Object.freeze({ ok: false, code: "FEE_ESTIMATION_UNAVAILABLE", roomNumber });
        }
    }

    _sequencePath(address) {
        return join(this._sequenceStateDir, createHash("sha256").update(address).digest("hex") + ".json");
    }

    _holdSequence(address, seqno, transfer = null) {
        const path = this._sequencePath(address);
        mkdirSync(this._sequenceStateDir, { recursive: true, mode: 0o700 });
        if (existsSync(path)) {
            const previous = JSON.parse(readFileSync(path, "utf8"));
            const sameTransfer = transfer && previous.transferKey === transfer.transferKey
                && seqno === previous.seqno
                && (previous.bocHash === transfer.bocHash
                    || previous.validUntil <= Math.floor(this._now() / 1000));
            if (previous.address !== address || !Number.isSafeInteger(previous.seqno)
                || (seqno <= previous.seqno && !sameTransfer)) {
                throw new Error("MAINNET_OUTBOUND_SEQNO_NOT_ADVANCED");
            }
        }
        durableWriteJson(path, { address, seqno, ...(transfer ?? {}) });
        this._pendingOutboundSeqno.set(address, { seqno });
    }

    async sendTransfer({ roomNumber, destination, amountNano, bounce = true,
        queryId = null, sourceReserveNano = null, idempotencyKey = null } = {}) {
        nonNegativeNano(amountNano, "amountNano");
        if (amountNano <= 0n) throw new RangeError("amountNano must be greater than zero");
        const reserveNano = sourceReserveNano == null
            ? this._gasReserveNano : nonNegativeNano(sourceReserveNano, "sourceReserveNano");
        const identity = await this._resolve(roomNumber);
        const destinationAddress = Address.parse(String(destination ?? "").trim());
        mainnetAddressIdentity(destinationAddress.toRawString());
        if (identity.workchain != null && Number(identity.workchain) !== 0) {
            throw new Error("Mainnet Room Wallet workchain must be 0 for WalletContractV4");
        }
        return this._enqueueOutbound(identity.address, () => {
            const request = { identity, destinationAddress, amountNano, bounce, queryId, reserveNano };
            return idempotencyKey === null
                ? this._sendTransferLocked(request)
                : this._sendDurableTransferLocked({ ...request, idempotencyKey });
        });
    }

    async _sendDurableTransferLocked(request) {
        const { identity, destinationAddress, amountNano, bounce, queryId, idempotencyKey } = request;
        if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9:_-]{1,160}$/.test(idempotencyKey)) {
            throw new Error("MAINNET_DURABLE_TRANSFER_KEY_REQUIRED");
        }
        const transferKey = createHash("sha256").update(idempotencyKey).digest("hex");
        const path = join(this._sequenceStateDir, "transfers", transferKey + ".json");
        const expected = { transferKey, roomNumber: identity.roomNumber,
            source: identity.address, destination: configuredDestination(destinationAddress),
            amountNano: amountNano.toString(), bounce, queryId: queryId == null ? null : String(queryId) };
        let record = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
        if (record) {
            for (const [key, value] of Object.entries(expected)) {
                if (record[key] !== value) throw new Error("MAINNET_DURABLE_TRANSFER_IDENTITY_MISMATCH");
            }
            if (!Number.isSafeInteger(record.seqno) || record.seqno < 0
                || !Number.isSafeInteger(record.validUntil) || typeof record.boc !== "string"
                || createHash("sha256").update(record.boc).digest("hex") !== record.bocHash) {
                throw new Error("MAINNET_DURABLE_TRANSFER_PAYLOAD_INVALID");
            }
            const observedSeqno = await this._tonService.getSeqno(identity.address);
            if (!Number.isSafeInteger(observedSeqno) || observedSeqno < record.seqno) {
                throw new Error("MAINNET_DURABLE_TRANSFER_SEQNO_UNAVAILABLE");
            }
            if (observedSeqno > record.seqno) {
                return Object.freeze({ ok: true, code: "ACCEPTED_AWAITING_CREDIT", seqno: record.seqno, txHash: null });
            }
        } else {
            const safety = await this._awaitOutboundSequenceSafety(identity);
            if (!safety.ok) return Object.freeze({ ...safety, txHash: null });
        }
        if (!record || record.validUntil <= Math.floor(this._now() / 1000)) {
            const signed = await this._buildSignedExternalMessage(request);
            if (record && signed.seqno !== record.seqno) {
                return Object.freeze({ ok: true, code: "ACCEPTED_AWAITING_CREDIT", seqno: record.seqno, txHash: null });
            }
            const boc = beginCell().store(storeMessage(signed.externalMessage)).endCell().toBoc().toString("base64");
            record = { ...expected, seqno: signed.seqno, validUntil: signed.validUntil,
                boc, bocHash: createHash("sha256").update(boc).digest("hex") };
            mkdirSync(join(this._sequenceStateDir, "transfers"), { recursive: true, mode: 0o700 });
            durableWriteJson(path, record);
        }
        this._holdSequence(identity.address, record.seqno, {
            transferKey, bocHash: record.bocHash, validUntil: record.validUntil
        });
        const broadcast = await this._tonService.broadcastTransaction(record.boc);
        return Object.freeze({ ok: true, code: "SUBMITTED_UNCONFIRMED",
            seqno: record.seqno, txHash: extractBroadcastTxHash(broadcast) });
    }

    _enqueueOutbound(addressKey, task) {
        const previous = this._outboundQueues.get(addressKey) ?? Promise.resolve();
        const run = previous.then(() => task());
        this._outboundQueues.set(addressKey, run.then(() => {}, () => {}));
        return run;
    }

    async _awaitOutboundSequenceSafety(identity) {
        const sequencePath = this._sequencePath(identity.address);
        if (!this._pendingOutboundSeqno.has(identity.address) && existsSync(sequencePath)) {
            const record = JSON.parse(readFileSync(sequencePath, "utf8"));
            if (record.address !== identity.address || !Number.isSafeInteger(record.seqno) || record.seqno < 0) {
                throw new Error("MAINNET_INVALID_DURABLE_SEQNO_HOLD");
            }
            this._pendingOutboundSeqno.set(identity.address, { seqno: record.seqno });
        }
        const pending = this._pendingOutboundSeqno.get(identity.address);
        if (pending == null) return Object.freeze({ ok: true });
        const deadline = this._now() + this._seqnoConfirmTimeoutMs;
        let observedSeqno = null;
        while (this._now() < deadline) {
            try { observedSeqno = await this._tonService.getSeqno(identity.address); }
            catch { observedSeqno = null; }
            if (Number.isInteger(observedSeqno) && observedSeqno > pending.seqno) {
                this._pendingOutboundSeqno.delete(identity.address);
                return Object.freeze({ ok: true, confirmedSeqno: pending.seqno, observedSeqno });
            }
            await this._sleep(this._seqnoConfirmPollMs);
        }
        this._logger?.warn?.(`Mainnet RoomWalletAdapter seqno safety hold expired | room=${identity.roomNumber}`
            + ` | pendingSeqno=${pending.seqno} | observedSeqno=${observedSeqno ?? "unknown"}`);
        return Object.freeze({ ok: false, code: "SEQNO_CONFIRMATION_TIMEOUT",
            pendingSeqno: pending.seqno, observedSeqno: Number.isInteger(observedSeqno) ? observedSeqno : null });
    }

    async _sendTransferLocked({ identity, destinationAddress, amountNano, bounce, queryId, reserveNano }) {
        const sequenceSafety = await this._awaitOutboundSequenceSafety(identity);
        if (!sequenceSafety.ok) return Object.freeze({ ok: false, code: sequenceSafety.code,
            roomNumber: identity.roomNumber, address: identity.address,
            destination: configuredDestination(destinationAddress), amountNano,
            pendingSeqno: sequenceSafety.pendingSeqno ?? null,
            observedSeqno: sequenceSafety.observedSeqno ?? null, txHash: null });
        const { seqno, externalMessage } = await this._buildSignedExternalMessage({
            identity, destinationAddress, amountNano, bounce, queryId
        });
        const boc = beginCell().store(storeMessage(externalMessage)).endCell().toBoc().toString("base64");
        this._holdSequence(identity.address, seqno);
        const broadcast = await this._tonService.broadcastTransaction(boc);
        const txHash = extractBroadcastTxHash(broadcast);
        this._logger?.info?.(`Mainnet RoomWalletAdapter transfer broadcast | room=${identity.roomNumber}`
            + ` | amountNano=${amountNano} | seqno=${seqno}`);
        return Object.freeze({ ok: true, code: txHash ? "SENT" : "AWAITING_TRANSACTION_HASH",
            roomNumber: identity.roomNumber, address: identity.address,
            destination: configuredDestination(destinationAddress), amountNano,
            gasReserveNano: reserveNano, seqno, txHash });
    }

    async _buildSignedExternalMessage({ identity, destinationAddress, amountNano, bounce, queryId,
        sendMode = SendMode.PAY_GAS_SEPARATELY } = {}) {
        const publicKey = toSigningBuffer(identity.publicKey, "publicKey");
        const secretKey = toSigningBuffer(identity.secretKey, "secretKey");
        const wallet = WalletContractV4.create({
            workchain: Number(identity.workchain ?? 0), publicKey
        });
        const derivedAddress = wallet.address.toString({ bounceable: true, urlSafe: true });
        const configuredAddress = Address.parse(identity.address).toString({ bounceable: true, urlSafe: true });
        if (derivedAddress !== configuredAddress) throw new Error("Mainnet room wallet identity drift");
        const seqno = await this._tonService.getSeqno(identity.address);
        if (!Number.isInteger(seqno) || seqno < 0) throw new Error("invalid Mainnet room wallet seqno");
        const validUntil = seqno === 0 ? 0xffffffff : Math.floor(this._now() / 1000) + 120;
        const transfer = wallet.createTransfer({ seqno, secretKey, timeout: validUntil, sendMode,
            messages: [internal({ to: destinationAddress, value: amountNano, bounce,
                ...(queryId == null ? {} : { body: beginCell().storeUint(BigInt(queryId), 64).endCell() }) })] });
        const externalMessage = external({ to: wallet.address, init: seqno === 0 ? wallet.init : undefined, body: transfer });
        return Object.freeze({ wallet, seqno, externalMessage, validUntil });
    }

    async _resolve(roomNumber) {
        const identity = await this._walletResolver(roomNumber);
        if (!identity || identity.roomNumber == null || !identity.address
            || identity.network !== "mainnet" || identity.globalId !== MAINNET_GLOBAL_ID) {
            throw new Error("MAINNET_WALLET_IDENTITY_INVALID");
        }
        mainnetAddressIdentity(identity.address);
        if (!identity.publicKey || !identity.secretKey) {
            throw new Error("Mainnet wallet signing material is unavailable for this room");
        }
        return identity;
    }
}

function toSigningBuffer(value, label) {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    throw new TypeError(`${label} must be a Buffer or Uint8Array`);
}

function configuredDestination(address) {
    return address.toString({ bounceable: true, urlSafe: true });
}

function extractBroadcastTxHash(broadcast) {
    if (!broadcast || typeof broadcast !== "object") return null;
    for (const value of [broadcast.hash, broadcast.txHash, broadcast.transactionHash, broadcast.result?.hash]) {
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
}
