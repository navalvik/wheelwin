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
        logger = null,
        gasReserveNano = ROOM_WALLET_POLICY.initialRoomReserveNano,
        seqnoConfirmTimeoutMs = 90_000,
        seqnoConfirmPollMs = 2_000,
        now = () => Date.now(),
        sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    } = {}) {
        if (!tonService) {
            throw new Error("RoomWalletAdapter requires tonService");
        }

        if (typeof walletResolver !== "function") {
            throw new TypeError("RoomWalletAdapter requires walletResolver");
        }

        assertNonNegativeNano(gasReserveNano, "gasReserveNano");

        if (!Number.isFinite(seqnoConfirmTimeoutMs) || seqnoConfirmTimeoutMs <= 0) {
            throw new TypeError("seqnoConfirmTimeoutMs must be a positive finite number");
        }

        if (!Number.isFinite(seqnoConfirmPollMs) || seqnoConfirmPollMs < 0) {
            throw new TypeError("seqnoConfirmPollMs must be a non-negative finite number");
        }

        if (typeof now !== "function") {
            throw new TypeError("now must be a function");
        }

        if (typeof sleep !== "function") {
            throw new TypeError("sleep must be a function");
        }

        this._tonService = tonService;
        this._walletResolver = walletResolver;
        this._logger = logger;
        this._gasReserveNano = gasReserveNano;
        this._seqnoConfirmTimeoutMs = seqnoConfirmTimeoutMs;
        this._seqnoConfirmPollMs = seqnoConfirmPollMs;
        this._now = now;
        this._sleep = sleep;

        /**
         * SEQNO SAFETY (production incident game_8b040e1c-1007-463f-bde7-8056c6dd3124).
         *
         * A Room Wallet must never sign two independent external messages with
         * the same seqno. TON accepts the first message and silently rejects
         * the duplicate, so the second transfer (for example the Owner payout)
         * never lands.
         *
         * Two structural guards are enforced here:
         *
         * 1. `_outboundQueues` serializes all sendTransfer calls per wallet
         *    address so two concurrent callers cannot interleave their seqno
         *    reads and broadcasts.
         *
         * 2. `_pendingOutboundSeqno` records the seqno of every successful
         *    broadcast. Before the next send on the same address, the adapter
         *    waits for the AUTHORITATIVE chain seqno (getSeqno get-method read)
         *    to advance past that value — positive on-chain evidence that the
         *    previous external message was accepted. It does not rely on
         *    process timing, fixed delays, or locally incremented counters.
         *    If the chain does not advance within the bounded window, the send
         *    fails closed with a retryable code instead of reusing the seqno.
         */
        this._outboundQueues = new Map();
        this._pendingOutboundSeqno = new Map();
    }

    getGasReserveNano() {
        return this._gasReserveNano;
    }

    async getBalance(roomNumber) {
        const identity = await this._resolveAddress(roomNumber);
        return this._tonService.getBalance(identity.address);
    }

    async getWalletAddress(roomNumber) {
        const identity = await this._resolveAddress(roomNumber);
        return identity.address;
    }

    async getTransactions(roomNumber, query = {}) {
        const identity = await this._resolveAddress(roomNumber);
        if (typeof this._tonService.getTransactions !== "function") {
            return [];
        }
        return this._tonService.getTransactions(identity.address, query);
    }

    /**
     * Read-only lookup of an arbitrary TON address transaction history.
     * Used by refund reconciliation to inspect a destination player wallet.
     * The address is passed through untouched: no wallet resolution, no
     * signing material access, never broadcasts anything.
     */
    async getAddressTransactions(address, query = {}) {
        if (typeof this._tonService.getTransactions !== "function") {
            return [];
        }
        return this._tonService.getTransactions(address, query);
    }

    async getSeqno(roomNumber) {
        const identity = await this._resolveAddress(roomNumber);
        if (typeof this._tonService.getSeqno !== "function") {
            return null;
        }
        return this._tonService.getSeqno(identity.address);
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

        // SEQNO SAFETY: all broadcasts from one Room Wallet are serialized per
        // address and gated on the authoritative confirmation of the previous
        // broadcast before the next seqno is read.
        return this._enqueueOutbound(identity.address, () =>
            this._sendTransferLocked({
                identity,
                destinationAddress,
                amountNano,
                bounce,
                queryId,
                reserveNano
            })
        );
    }

    /**
     * Serializes outbound work per wallet address. Each queued task runs only
     * after the previous task for the same address has fully settled, so two
     * concurrent sendTransfer calls can never interleave their seqno reads.
     */
    _enqueueOutbound(addressKey, task) {
        const previous = this._outboundQueues.get(addressKey) ?? Promise.resolve();
        const run = previous.then(() => task());
        this._outboundQueues.set(
            addressKey,
            run.then(
                () => {},
                () => {}
            )
        );
        return run;
    }

    /**
     * Waits for positive on-chain evidence that the previously broadcast
     * external message from this wallet was accepted: the authoritative chain
     * seqno (get-method read) must advance past the pending broadcast seqno.
     *
     * This is not a timing assumption and not a locally incremented counter:
     * a TON wallet seqno only advances when its external message is accepted.
     * Fails closed when the chain does not advance in time or when the seqno
     * read is unavailable — a possibly-reused seqno is never signed.
     */
    async _awaitOutboundSequenceSafety(identity) {
        const pending = this._pendingOutboundSeqno.get(identity.address);

        if (pending == null) {
            return Object.freeze({ ok: true });
        }

        if (typeof this._tonService.getSeqno !== "function") {
            this._logger?.warn?.(
                `RoomWalletAdapter seqno safety hold | room=${identity.roomNumber} | `
                    + `pendingSeqno=${pending.seqno} | reason=GET_SEQNO_UNAVAILABLE`
            );

            return Object.freeze({
                ok: false,
                code: "SEQNO_CONFIRMATION_UNAVAILABLE",
                pendingSeqno: pending.seqno,
                observedSeqno: null
            });
        }

        const deadline = this._now() + this._seqnoConfirmTimeoutMs;
        let observedSeqno = null;

        while (this._now() < deadline) {
            try {
                observedSeqno = await this._tonService.getSeqno(identity.address);
            } catch {
                // A fresh/uninitialized wallet or a transient RPC failure is
                // treated as "not yet confirmed" and re-polled.
                observedSeqno = null;
            }

            if (Number.isInteger(observedSeqno) && observedSeqno > pending.seqno) {
                this._pendingOutboundSeqno.delete(identity.address);

                return Object.freeze({
                    ok: true,
                    confirmedSeqno: pending.seqno,
                    observedSeqno
                });
            }

            await this._sleep(this._seqnoConfirmPollMs);
        }

        this._logger?.warn?.(
            `RoomWalletAdapter seqno safety hold expired | room=${identity.roomNumber} | `
                + `pendingSeqno=${pending.seqno} | observedSeqno=${observedSeqno ?? "unknown"}`
        );

        return Object.freeze({
            ok: false,
            code: "SEQNO_CONFIRMATION_TIMEOUT",
            pendingSeqno: pending.seqno,
            observedSeqno: Number.isInteger(observedSeqno) ? observedSeqno : null
        });
    }

    async _sendTransferLocked({
        identity,
        destinationAddress,
        amountNano,
        bounce,
        queryId,
        reserveNano
    }) {
        const sequenceSafety = await this._awaitOutboundSequenceSafety(identity);

        if (!sequenceSafety.ok) {
            return Object.freeze({
                ok: false,
                code: sequenceSafety.code,
                roomNumber: identity.roomNumber,
                address: identity.address,
                destination: configuredDestination(destinationAddress),
                amountNano,
                pendingSeqno: sequenceSafety.pendingSeqno ?? null,
                observedSeqno: sequenceSafety.observedSeqno ?? null,
                txHash: null
            });
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

        const broadcast = await this._tonService.broadcastTransaction(bocBase64);
        const txHash = extractBroadcastTxHash(broadcast);

        // The transport accepted the broadcast: this seqno is consumed as soon
        // as the message is processed. Hold it until the next send observes
        // the authoritative seqno advance. A broadcast that threw is not
        // recorded here; the settlement layer re-inspects chain history before
        // any retry and the duplicate-payout evidence scan stays fail-closed.
        this._pendingOutboundSeqno.set(identity.address, { seqno });

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

    async _resolveAddress(roomNumber) {
        const identity = await this._walletResolver(roomNumber);

        if (!identity || identity.roomNumber == null || !identity.address) {
            throw new Error(`invalid wallet identity for room ${roomNumber}`);
        }

        return identity;
    }

    async _resolve(roomNumber) {
        const identity = await this._resolveAddress(roomNumber);

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
