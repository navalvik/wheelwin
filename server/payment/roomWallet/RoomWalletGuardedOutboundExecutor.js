/**
 * Guarded native-GRAM outbound transfer executor (NOT connected to gameplay).
 *
 * This module is disabled unless explicitly constructed with enabled=true.
 * It requires an atomic shared-filesystem wallet gate, immutable on-disk
 * payment intent and an injected signer/broadcaster. It is for isolated
 * verification until ALL historical sendTransfer paths are routed through
 * the same signer and a single Railway financial writer is guaranteed.
 *
 * Rules:
 *  1. Atomic wallet gate acquired before signing/seqno read.
 *  2. Validate signed BOC against wallet, seqno, expiry and actual message hash.
 *  3. Persist SIGNED_HELD BEFORE the ONE allowed broadcast invocation.
 *  4. A success or error response is CONFIRMATION_UNKNOWN until both chain
 *     indexers agree and the wallet seqno advanced.
 *  5. Never auto-retry an uncertain broadcast or auto-expire the signed hold.
 *  6. On confirmed chain proof, release only the gate of this exact intent.
 *
 * WARNING: this is not a live release toggle and MUST NOT be enabled while
 * legacy adapters may broadcast outside the durable wallet gate.
 */
import { Cell, loadMessage, loadMessageRelaxed, SendMode } from "@ton/core";
import { verifyOutgoingPaymentFromBothProviders } from "./RoomWalletDualSourceOutgoingReceipt.js";

export class RoomWalletOutboundExecutionError extends Error {
    constructor(code) {
        super(code);
        this.name = "RoomWalletOutboundExecutionError";
        this.code = code;
    }
}
const fail = code => { throw new RoomWalletOutboundExecutionError(code); };

function parsePrepared(prepared, intent, nowSeconds) {
    if (!prepared || typeof prepared.bocBase64 !== "string"
        || !/^[a-zA-Z0-9+/]+={0,2}$/.test(prepared.bocBase64)
        || !Number.isSafeInteger(prepared.seqno) || prepared.seqno < 0
        || !Number.isSafeInteger(prepared.validUntil)
        || prepared.validUntil <= nowSeconds
        || prepared.validUntil > nowSeconds + 300
        || !/^[a-f0-9]{64}$/i.test(String(prepared.externalHash))) {
        fail("OUTBOUND_PREPARED_MESSAGE_INVALID");
    }
    let root;
    let message;
    try {
        const cells = Cell.fromBoc(Buffer.from(prepared.bocBase64, "base64"));
        if (cells.length !== 1) fail("OUTBOUND_BOC_ROOT_COUNT_INVALID");
        root = cells[0];
        message = loadMessage(root.beginParse());
    } catch (err) {
        if (err instanceof RoomWalletOutboundExecutionError) throw err;
        fail("OUTBOUND_BOC_DECODE_INVALID");
    }
    if (root.hash().toString("hex") !== prepared.externalHash.toLowerCase()) {
        fail("OUTBOUND_SIGNED_HASH_MISMATCH");
    }
    if (message.info.type !== "external-in"
        || message.info.dest.toRawString().toLowerCase() !== intent.roomWallet) {
        fail("OUTBOUND_EXTERNAL_WALLET_MISMATCH");
    }
    // TON V4 signed external body layout:
    // ed25519 signature (512 bits), wallet_id (32 bits),
    // valid_until (32 bits), seqno (32 bits), opcode (8 bits), messages.
    // Checking the real serialized BOC prevents an untrusted callback from
    // supplying a different seqno or expiry than the one signed.
    try {
        const body = message.body.beginParse();
        body.skip(512);
        const walletId = body.loadUint(32);
        const signedUntil = body.loadUint(32);
        const signedSeqno = body.loadUint(32);
        if (!Number.isInteger(walletId)
            || signedUntil !== prepared.validUntil
            || signedSeqno !== prepared.seqno) {
            fail("OUTBOUND_BOC_SEQNO_OR_EXPIRY_MISMATCH");
        }

        // V4 extended action type 0 = sendMsg. The real signed body must
        // contain EXACTLY one internal message to the frozen beneficiary,
        // with the frozen nanogram transfer amount; never trust a caller
        // that only supplies matching recipient/amount metadata.
        if (body.loadUint(8) !== 0 || body.remainingRefs !== 1
            || body.remainingBits !== 8) {
            fail("OUTBOUND_BOC_ACTION_NOT_SINGLE_SEND");
        }
        const sendMode = body.loadUint(8);
        if (sendMode !== SendMode.PAY_GAS_SEPARATELY) {
            fail("OUTBOUND_BOC_SEND_MODE_INVALID");
        }
        const outCell = body.loadRef();
        const output = loadMessageRelaxed(outCell.beginParse());
        if (output.info?.type !== "internal"
            || output.info.dest?.toRawString().toLowerCase() !== intent.destinationWallet
            || output.info.value?.coins !== BigInt(intent.transferNano)) {
            fail("OUTBOUND_BOC_RECIPIENT_OR_AMOUNT_MISMATCH");
        }
    } catch (err) {
        if (err instanceof RoomWalletOutboundExecutionError) throw err;
        fail("OUTBOUND_BOC_WALLET_V4_LAYOUT_INVALID");
    }

    if (prepared.roomWallet !== intent.roomWallet
        || prepared.recipientWallet !== intent.destinationWallet
        || String(prepared.amountNano) !== intent.transferNano) {
        fail("OUTBOUND_PREPARED_PLAN_MISMATCH");
    }

    return Object.freeze({
        seqno: prepared.seqno,
        validUntil: prepared.validUntil,
        externalHash: prepared.externalHash.toLowerCase(),
        bocBase64: prepared.bocBase64
    });
}

export class RoomWalletGuardedOutboundExecutor {
    constructor({
        intentJournal, walletGate, signer, broadcaster, chain,
        enabled = false, nowSeconds = () => Math.floor(Date.now() / 1000)
    } = {}) {
        if (!intentJournal || typeof intentJournal.load !== "function"
            || typeof intentJournal.holdSignedMessage !== "function"
            || typeof intentJournal.markConfirmationUnknown !== "function"
            || typeof intentJournal.confirmWithChainProof !== "function"
            || typeof walletGate?.acquire !== "function"
            || typeof walletGate?.assertOwnership !== "function"
            || typeof walletGate?.releaseConfirmed !== "function"
            || typeof signer?.prepareSignedTransfer !== "function"
            || typeof broadcaster?.broadcastSignedBoc !== "function"
            || typeof chain?.getSeqno !== "function"
            || typeof nowSeconds !== "function") {
            throw new TypeError("Guarded executor dependencies are required");
        }
        this._journal = intentJournal;
        this._gate = walletGate;
        this._signer = signer;
        this._broadcaster = broadcaster;
        this._chain = chain;
        this._enabled = enabled === true;
        this._nowSeconds = nowSeconds;
    }

    async execute({ intentId } = {}) {
        if (!this._enabled) fail("OUTBOUND_EXECUTOR_DISABLED");
        const record = this._journal.load(intentId);
        if (record.status === "SETTLED" && record.payload?.state === "CHAIN_CONFIRMED") {
            return Object.freeze({ state: "CHAIN_CONFIRMED", broadcasted: false });
        }
        if (record.payload?.state !== "PLANNED" || record.status !== "ACTIVE") {
            return Object.freeze({
                state: "CONFIRMATION_UNKNOWN",
                reason: "PREVIOUS_ATTEMPT_NEEDS_CHAIN_PROOF",
                broadcasted: false
            });
        }
        // Atomic lock across ALL signers using same durable volume; no expiry.
        const lease = this._gate.acquire({ intentId });
        const p = record.payload;
        // The injected signer is PREPARE-ONLY. Any callback that also
        // broadcasts violates this interface and must never be configured.
        const proposed = await this._signer.prepareSignedTransfer({
            roomNumber: p.roomNumber,
            roomWallet: p.roomWallet,
            recipientWallet: p.destinationWallet,
            amountNano: p.transferNano,
            role: p.role
        });
        const prepared = parsePrepared(proposed, p, this._nowSeconds());
        this._gate.assertOwnership(lease);

        // No signed intent persistence -> NO broadcast. A crash after this
        // call leaves the exact signed hash/seqno durably held.
        this._journal.holdSignedMessage({
            intentId,
            seqno: prepared.seqno,
            signedExternalMessageHash: prepared.externalHash,
            validUntil: prepared.validUntil
        });
        this._gate.assertOwnership(lease);

        let rpcOutcome = "RPC_ACKNOWLEDGED";
        try {
            // Exactly ONE attempt. Do not retry even if provider reports 542,
            // returns an empty hash, or the request times out.
            await this._broadcaster.broadcastSignedBoc(prepared.bocBase64);
        } catch {
            rpcOutcome = "RPC_RESULT_AMBIGUOUS";
        }

        // A successful RPC response cannot prove the recipient got funds.
        // Persist UNKNOWN even after an explicit success return.
        this._journal.markConfirmationUnknown(intentId);
        return Object.freeze({
            state: "CONFIRMATION_UNKNOWN",
            reason: rpcOutcome,
            broadcasted: true,
            intentId,
            signedExternalMessageHash: prepared.externalHash
        });
    }

    /**
     * Read-only reconciliation input comes from two independent providers.
     * NO automatic signed BOC replay, even if both providers are unavailable.
     */
    async reconcile({ intentId, tonapiTransactions, toncenterTransactions } = {}) {
        const record = this._journal.load(intentId);
        const p = record.payload;
        if (record.status === "SETTLED" && p.state === "CHAIN_CONFIRMED") {
            return Object.freeze({ state: "CHAIN_CONFIRMED", changed: false });
        }
        if (!["SIGNED_HELD", "CONFIRMATION_UNKNOWN"].includes(p.state)) {
            fail("OUTBOUND_RECONCILIATION_NOT_SIGNED");
        }
        const evidence = verifyOutgoingPaymentFromBothProviders({
            tonapiTransactions,
            toncenterTransactions,
            roomWallet: p.roomWallet,
            recipientWallet: p.destinationWallet,
            valueNano: p.transferNano,
            signedExternalMessageHash: p.signedExternalMessageHash
        });
        if (evidence.state !== "CHAIN_CONFIRMED") {
            return Object.freeze({
                state: "CONFIRMATION_UNKNOWN",
                changed: false,
                broadcastAuthorized: false
            });
        }
        const observedSeqno = await this._chain.getSeqno(p.roomWallet);
        const result = this._journal.confirmWithChainProof({
            intentId, evidence, observedSeqno
        });
        this._gate.releaseConfirmed({ intentId });
        return Object.freeze({
            state: "CHAIN_CONFIRMED",
            changed: result.changed,
            txHash: result.transactionHash,
            broadcastAuthorized: false
        });
    }
}
