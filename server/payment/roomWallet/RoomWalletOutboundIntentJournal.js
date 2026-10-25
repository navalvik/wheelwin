/**
 * Durable outbound intent journal — NO BROADCASTS.
 *
 * A Room Wallet may send a REFUND/WINNER/OWNER transfer only through a
 * subsequent signer/executor that has persisted the exact signed message
 * BEFORE the first RPC broadcast. A process crash after signing is
 * CONFIRMATION_UNKNOWN; this journal never clears a hold by timeout.
 *
 * The existing TonFinancialPersistence is a SINGLE-WRITER volume. This
 * journal does not claim that a JavaScript Map is a distributed lock; an
 * actual cross-process signer lease must be added before enabling any send.
 */
import { createHash } from "node:crypto";
import { Address } from "@ton/core";
import { normalizeTonTransactionHash } from "./RoomWalletDualSourceEvidence.js";
import { validatePersistedPayoutPlan } from "./RoomWalletSettlementAdapter.js";
import { ROOM_WALLET_POLICY, buildResidualSweep } from "./RoomWalletFinancialPolicy.js";

const KIND = "ROOM_WALLET_OUTBOUND_INTENT";
const HELD = new Set(["SIGNED_HELD", "CONFIRMATION_UNKNOWN"]);
const STATES = Object.freeze({
    PLANNED: "PLANNED",
    SIGNED_HELD: "SIGNED_HELD",
    CONFIRMATION_UNKNOWN: "CONFIRMATION_UNKNOWN",
    CHAIN_CONFIRMED: "CHAIN_CONFIRMED"
});

export class RoomWalletOutboundIntentError extends Error {
    constructor(code) {
        super(code);
        this.name = "RoomWalletOutboundIntentError";
        this.code = code;
    }
}

function ensure(value, code) {
    if (!value) throw new RoomWalletOutboundIntentError(code);
}

function raw(address) {
    try {
        const result = Address.parse(address);
        ensure(result.workChain === 0, "OUTBOUND_WORKCHAIN_NOT_ZERO");
        return result.toRawString().toLowerCase();
    } catch (err) {
        if (err instanceof RoomWalletOutboundIntentError) throw err;
        throw new RoomWalletOutboundIntentError("OUTBOUND_ADDRESS_INVALID");
    }
}

function positiveNano(value) {
    ensure(typeof value === "string" || typeof value === "bigint",
        "OUTBOUND_NANO_TYPE_INVALID");
    const text = String(value);
    ensure(/^[1-9][0-9]*$/.test(text), "OUTBOUND_NANO_INVALID");
    return BigInt(text).toString();
}

function externalHash(value) {
    const hash = normalizeTonTransactionHash(value);
    ensure(hash !== null, "OUTBOUND_EXTERNAL_HASH_INVALID");
    return hash;
}

function toAuthoritativeGramNano(value) {
    ensure(typeof value === "string" || typeof value === "number", "OUTBOUND_SETTLEMENT_GROSS_UNAVAILABLE");
    const text = String(value);
    const m = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,9}))?$/.exec(text);
    ensure(m != null, "OUTBOUND_SETTLEMENT_GRAM_FORMAT_INVALID");
    return BigInt(m[1]) * 1_000_000_000n
        + BigInt((m[2] ?? "").padEnd(9, "0"));
}

function deterministicId(values) {
    return "rwout_" + createHash("sha256").update(values.join("|")).digest("hex");
}

export class RoomWalletOutboundIntentJournal {
    constructor({ financialPersistence, roomWalletRegistry = null } = {}) {
        if (typeof financialPersistence?.loadRecoveryDataRecord !== "function"
            || typeof financialPersistence?.createRecoveryDataRecord !== "function"
            || typeof financialPersistence?.updateRecoveryDataRecord !== "function"
            || typeof financialPersistence?.listActiveRecoveryDataRecords !== "function") {
            throw new TypeError("Financial recovery persistence required");
        }
        this._persistence = financialPersistence;
        this._roomWalletRegistry = roomWalletRegistry;
    }

    /**
     * Settlement intents derive amounts/destinations EXCLUSIVELY from a frozen
     * payout plan persisted by ContractSettlementManager BEFORE broadcasts.
     * This method NEVER authorizes a transfer or creates an outbound message.
     */
    createSettlementPlan({ gameId, role } = {}) {
        ensure(typeof gameId === "string" && gameId.length > 0,
            "OUTBOUND_SETTLEMENT_GAME_ID_REQUIRED");
        ensure(role === "WINNER" || role === "OWNER", "OUTBOUND_SETTLEMENT_ROLE_INVALID");
        ensure(typeof this._persistence.loadSettlementRecord === "function"
            && typeof this._roomWalletRegistry?.get === "function",
            "OUTBOUND_SETTLEMENT_SOURCE_NOT_CONFIGURED");

        const record = this._persistence.loadSettlementRecord(gameId);
        const session = record?.payload;
        const request = session?.request;
        const plan = request?.payoutPlan;
        ensure(session?.network === "testnet" && session.gameId === gameId
            && request?.gameId === gameId && request?.roomId === session.roomId
            && Number.isInteger(request?.roomNumber)
            && plan && plan.mode === "RECIPIENT_PAYS_GAS",
            "OUTBOUND_SETTLEMENT_FROZEN_PLAN_REQUIRED");

        const walletCatalogEntry = this._roomWalletRegistry.get(request.roomNumber);
        ensure(walletCatalogEntry?.address, "OUTBOUND_SETTLEMENT_ROOM_WALLET_MISSING");
        const wallet = raw(walletCatalogEntry.address);
        const winnerWallet = raw(session.winnerWallet);
        const ownerWallet = raw(session.ownerWallet);
        ensure(raw(request.winnerWallet) === winnerWallet
            && raw(request.ownerWallet) === ownerWallet,
            "OUTBOUND_SETTLEMENT_DESTINATION_CONFLICT");

        const winnerGross = toAuthoritativeGramNano(session.prizeAmount);
        const ownerGross = toAuthoritativeGramNano(session.organizerAmount);
        const retained = BigInt(String(plan.owner?.ownerRetainedNano ?? "-1"));
        ensure(winnerGross > 0n && ownerGross > retained && retained === 10_000_000n,
            "OUTBOUND_SETTLEMENT_RETENTION_INVALID");
        const validation = validatePersistedPayoutPlan(plan, {
            winnerAmountNano: winnerGross,
            ownerGrossNano: ownerGross,
            ownerPayoutNano: ownerGross - retained,
            ownerRetainedNano: retained,
            winnerWallet,
            ownerWallet
        });
        ensure(validation.ok === true, "OUTBOUND_SETTLEMENT_FROZEN_PLAN_INVALID");

        const entry = role === "WINNER" ? validation.plan.winner : validation.plan.owner;
        const destination = role === "WINNER" ? winnerWallet : ownerWallet;
        const gas = entry.recipientGasChargeNano.toString();
        const gross = entry.grossPayoutNano.toString();
        const amount = entry.recipientTransferAmountNano.toString();
        ensure(BigInt(amount) + BigInt(gas) === BigInt(gross),
            "OUTBOUND_SETTLEMENT_GAS_MISMATCH");

        const frozenHash = createHash("sha256")
            .update(JSON.stringify(plan)).digest("hex");
        const authorizationId = String(session.settlementSessionId ?? "") + ":" + role;
        ensure(authorizationId.length > role.length + 1,
            "OUTBOUND_SETTLEMENT_SESSION_ID_REQUIRED");
        const intentId = deterministicId([
            "testnet", String(request.roomNumber), session.roomId, gameId,
            role, authorizationId
        ]);
        const intent = {
            recoveryRecordId: intentId,
            kind: KIND,
            status: "ACTIVE",
            state: STATES.PLANNED,
            network: "testnet",
            role,
            roomNumber: request.roomNumber,
            roomId: session.roomId,
            gameId,
            paymentSessionId: null,
            roomWallet: wallet,
            destinationWallet: destination,
            grossNano: gross,
            gasChargeNano: gas,
            transferNano: amount,
            frozenGasPlanHash: frozenHash,
            authorizationId,
            seqno: null,
            signedExternalMessageHash: null,
            signedValidUntil: null,
            chainReceipt: null,
            broadcastingEnabled: false
        };
        const prior = this._tryLoad(intentId);
        if (prior) {
            ensure(prior.payload.kind === KIND, "OUTBOUND_INTENT_KIND_CONFLICT");
            for (const field of [
                "network", "role", "roomNumber", "roomId", "gameId", "paymentSessionId",
                "roomWallet", "destinationWallet", "grossNano", "gasChargeNano",
                "transferNano", "frozenGasPlanHash", "authorizationId"
            ]) ensure(prior.payload[field] === intent[field], "OUTBOUND_INTENT_PLAN_CONFLICT");
            return Object.freeze({ created: false, intentId, state: prior.payload.state });
        }
        this._persistence.createRecoveryDataRecord(intent, {
            recoveryRecordId: intentId, status: "ACTIVE",
            roomId: session.roomId, gameId, tonNetwork: "testnet"
        });
        return Object.freeze({ created: true, intentId, state: STATES.PLANNED });
    }

    /**
     * Prepare (NEVER send) an operational SOURCE_PAYS_GAS sweep.
     * A balance or a generic SETTLEMENT_CONFIRMED event alone cannot
     * authorize this: require its durable, game-bound sweep record and TWO
     * independently chain-confirmed WINNER / OWNER payment intentions.
     *
     * Old sweep records without a gameId are intentionally not adopted.
     * Residual sweeps remain disabled until their worker is migrated to the
     * same guarded signer and its independent confirmation pipeline.
     */
    createResidualSweepPlan({ sweepRecordId } = {}) {
        ensure(typeof sweepRecordId === "string"
            && /^rwsweep_[0-9a-f-]{36}$/i.test(sweepRecordId),
            "OUTBOUND_SWEEP_RECORD_ID_REQUIRED");
        ensure(typeof this._persistence.loadResidualSweepRecord === "function"
            && typeof this._persistence.loadSettlementRecord === "function"
            && typeof this._roomWalletRegistry?.get === "function",
            "OUTBOUND_SWEEP_AUTHORITIES_UNAVAILABLE");
        const record = this._persistence.loadResidualSweepRecord(sweepRecordId);
        const p = record?.payload;
        ensure(record?.tonNetwork === "testnet" && p?.id === sweepRecordId
            && p.status === "PENDING"
            && typeof p.gameId === "string" && p.gameId.length > 0
            && Number.isInteger(p.roomNumber)
            && p.roomNumber >= 1 && p.roomNumber <= 64,
            "OUTBOUND_SWEEP_FROZEN_GAME_ID_REQUIRED");
        const wallet = raw(p.sourceAddress);
        const destination = raw(p.destinationAddress);
        ensure(wallet !== destination
            && raw(this._roomWalletRegistry.get(p.roomNumber)?.address) === wallet,
            "OUTBOUND_SWEEP_WALLET_IDENTITY_CONFLICT");
        // Do not change the historical 0.50 threshold, 0.49 destination
        // transfer or 0.01 residual envelope (0.006 gas + 0.004 safety).
        ensure(String(p.amountNano) === String(ROOM_WALLET_POLICY.residualSweepNano)
            && String(p.sweepGasNano) === String(ROOM_WALLET_POLICY.residualSweepGasNano)
            && String(p.retainedFloorNano) === String(ROOM_WALLET_POLICY.residualRetainedFloorNano)
            && String(p.safetyMarginNano) === String(ROOM_WALLET_POLICY.residualSafetyMarginNano),
            "OUTBOUND_SWEEP_POLICY_MISMATCH");
        const eligibility = buildResidualSweep({
            balanceNano: BigInt(p.observedBalanceNano)
        });
        ensure(eligibility.eligible === true
            && BigInt(p.observedBalanceNano) >= ROOM_WALLET_POLICY.residualTriggerNano,
            "OUTBOUND_SWEEP_BALANCE_BELOW_THRESHOLD");

        let settlement;
        try {
            settlement = this._persistence.loadSettlementRecord(p.gameId)?.payload;
        } catch (error) {
            if (error?.name !== "RecordNotFoundError") throw error;
            throw new RoomWalletOutboundIntentError("OUTBOUND_SWEEP_SETTLEMENT_NOT_FINAL");
        }
        ensure(settlement?.network === "testnet"
            && settlement.gameId === p.gameId
            && settlement.status === "SETTLEMENT_COMPLETED"
            && settlement.request?.roomNumber === p.roomNumber
            && typeof settlement.roomId === "string"
            && settlement.roomId.length > 0
            && settlement.request?.payoutPlan?.mode === "RECIPIENT_PAYS_GAS",
            "OUTBOUND_SWEEP_SETTLEMENT_NOT_FINAL");
        const entries = this._persistence.listActiveRecoveryDataRecords();
        const payouts = entries.filter(item =>
            item.payload?.kind === KIND && item.status === "SETTLED"
            && item.payload.state === "CHAIN_CONFIRMED"
            && item.payload.gameId === p.gameId
            && item.payload.roomId === settlement.roomId
            && item.payload.roomNumber === p.roomNumber
            && item.payload.roomWallet === wallet
            && item.payload.chainReceipt?.walletTxHash);
        for (const role of ["WINNER", "OWNER"]) {
            ensure(payouts.filter(item => item.payload.role === role).length === 1,
                "OUTBOUND_SWEEP_WINNER_OR_OWNER_UNPAID");
        }
        ensure(!entries.some(item =>
            item.payload?.kind === "ROOM_WALLET_REFUND_OBLIGATION"
            && item.payload.roomId === settlement.roomId
            && item.status === "ACTIVE"),
            "OUTBOUND_SWEEP_REFUND_DEBT_PRESENT");
        ensure(!entries.some(item =>
            item.payload?.kind === KIND && item.status === "ACTIVE"
            && item.payload.roomWallet === wallet
            && item.payload.role !== "SWEEP"),
            "OUTBOUND_SWEEP_WALLET_PAYMENT_PENDING");

        const policySnapshot = {
            sweepRecordId, gameId: p.gameId, roomNumber: p.roomNumber,
            sourceAddress: wallet, destinationAddress: destination,
            amountNano: String(p.amountNano),
            observedBalanceNano: String(p.observedBalanceNano),
            sweepGasNano: String(p.sweepGasNano),
            retainedFloorNano: String(p.retainedFloorNano),
            safetyMarginNano: String(p.safetyMarginNano)
        };
        const frozenGasPlanHash = createHash("sha256")
            .update(JSON.stringify(policySnapshot)).digest("hex");
        const intentId = deterministicId([
            "testnet", String(p.roomNumber), settlement.roomId,
            p.gameId, "SWEEP", sweepRecordId
        ]);
        const intent = {
            recoveryRecordId: intentId,
            kind: KIND,
            status: "ACTIVE",
            state: STATES.PLANNED,
            network: "testnet",
            role: "SWEEP",
            feePaymentMode: "SOURCE_PAYS_GAS",
            roomNumber: p.roomNumber,
            roomId: settlement.roomId,
            gameId: p.gameId,
            paymentSessionId: null,
            roomWallet: wallet,
            destinationWallet: destination,
            grossNano: (BigInt(p.amountNano) + BigInt(p.sweepGasNano)).toString(),
            gasChargeNano: String(p.sweepGasNano),
            sourceRetainedFloorNano: String(p.retainedFloorNano),
            transferNano: String(p.amountNano),
            frozenGasPlanHash,
            authorizationId: sweepRecordId,
            seqno: null,
            signedExternalMessageHash: null,
            signedValidUntil: null,
            chainReceipt: null,
            broadcastingEnabled: false
        };
        const prior = this._tryLoad(intentId);
        if (prior) {
            ensure(prior.payload.kind === KIND
                && prior.payload.role === "SWEEP",
                "OUTBOUND_SWEEP_INTENT_KIND_CONFLICT");
            for (const field of [
                "network", "role", "feePaymentMode", "roomNumber", "roomId",
                "gameId", "roomWallet", "destinationWallet", "grossNano",
                "gasChargeNano", "sourceRetainedFloorNano", "transferNano",
                "frozenGasPlanHash", "authorizationId"
            ]) ensure(prior.payload[field] === intent[field],
                "OUTBOUND_SWEEP_INTENT_PLAN_CONFLICT");
            return Object.freeze({
                created: false, intentId, state: prior.payload.state
            });
        }
        this._persistence.createRecoveryDataRecord(intent, {
            recoveryRecordId: intentId,
            roomId: settlement.roomId,
            gameId: p.gameId,
            status: "ACTIVE",
            tonNetwork: "testnet"
        });
        return Object.freeze({
            created: true, intentId, state: STATES.PLANNED
        });
    }

    /**
     * Only an already-persisted chain-backed refund obligation can authorize
     * a REFUND PLAN. Planning itself CANNOT authorize a broadcast.
     */
    createRefundPlan({
        obligationId,
        netRefundNano,
        recipientGasChargeNano,
        frozenGasPlanHash
    } = {}) {
        ensure(/^rwrefund_[0-9a-f]{64}$/.test(String(obligationId)),
            "OUTBOUND_REFUND_PROOF_ID_REQUIRED");

        const proof = this._persistence.loadRecoveryDataRecord(obligationId);
        const p = proof?.payload;
        ensure(p?.kind === "ROOM_WALLET_REFUND_OBLIGATION"
            && p.network === "testnet"
            && p.executionAllowed === true
            && p.state === "REFUND_RECONCILIATION_REQUIRED",
            "OUTBOUND_REFUND_NOT_CHAIN_AUTHORIZED");

        const wallet = raw(p.fromRoomWallet);
        const recipient = raw(p.recipientWallet);
        const net = positiveNano(netRefundNano);
        const charge = positiveNano(recipientGasChargeNano);
        const gross = positiveNano(p.grossRefundNano);
        ensure(BigInt(net) + BigInt(charge) === BigInt(gross),
            "OUTBOUND_RECIPIENT_GAS_MISMATCH");
        const planHash = externalHash(frozenGasPlanHash);

        const intentId = deterministicId([
            "testnet", String(p.roomNumber), p.roomId, p.gameId,
            p.paymentSessionId, "REFUND", obligationId
        ]);
        const intent = {
            recoveryRecordId: intentId,
            kind: KIND,
            status: "ACTIVE",
            state: STATES.PLANNED,
            network: "testnet",
            role: "REFUND",
            roomNumber: Number(p.roomNumber),
            roomId: p.roomId,
            gameId: p.gameId,
            paymentSessionId: p.paymentSessionId,
            roomWallet: wallet,
            destinationWallet: recipient,
            grossNano: gross,
            gasChargeNano: charge,
            transferNano: net,
            frozenGasPlanHash: planHash,
            authorizationId: obligationId,
            seqno: null,
            signedExternalMessageHash: null,
            signedValidUntil: null,
            chainReceipt: null,
            // Intents never contain signing material, BOC, credentials, or mnemonics.
            broadcastingEnabled: false
        };

        const previous = this._tryLoad(intentId);
        if (previous) {
            ensure(previous.payload.kind === KIND, "OUTBOUND_INTENT_KIND_CONFLICT");
            for (const field of [
                "network", "role", "roomNumber", "roomId", "gameId",
                "paymentSessionId", "roomWallet", "destinationWallet",
                "grossNano", "gasChargeNano", "transferNano",
                "frozenGasPlanHash", "authorizationId"
            ]) {
                ensure(previous.payload[field] === intent[field],
                    "OUTBOUND_INTENT_PLAN_CONFLICT");
            }
            return Object.freeze({ created: false, intentId, state: previous.payload.state });
        }

        this._persistence.createRecoveryDataRecord(intent, {
            recoveryRecordId: intentId,
            status: "ACTIVE",
            roomId: p.roomId,
            gameId: p.gameId,
            tonNetwork: "testnet"
        });
        return Object.freeze({ created: true, intentId, state: STATES.PLANNED });
    }

    /** Only introspection; planning must NOT be mistaken for send approval. */
    load(intentId) {
        const record = this._persistence.loadRecoveryDataRecord(intentId);
        ensure(record.payload?.kind === KIND, "OUTBOUND_INTENT_KIND_CONFLICT");
        return record;
    }

    listPendingForWallet(walletAddress) {
        const address = raw(walletAddress);
        return Object.freeze(
            this._persistence.listActiveRecoveryDataRecords()
                .filter(r => r.payload?.kind === KIND
                    && r.status === "ACTIVE"
                    && r.payload.roomWallet === address)
        );
    }

    /**
     * Active signed or broadcast-uncertain operations, restored from the
     * authoritative durable recovery store. This is NOT an authorization
     * list: the read-only confirmation worker may only verify past sends.
     */
    listUnresolvedSignedIntents() {
        return Object.freeze(
            this._persistence.listActiveRecoveryDataRecords()
                .filter(record =>
                    record.status === "ACTIVE"
                    && record.payload?.kind === KIND
                    && record.payload?.network === "testnet"
                    && HELD.has(record.payload?.state)
                    && typeof record.payload?.signedExternalMessageHash === "string"
                    && Number.isSafeInteger(record.payload?.seqno)
                )
                .sort((a, b) => a.recordId.localeCompare(b.recordId))
        );
    }

    hasUnresolvedSignedAttempt(walletAddress) {
        return this.listPendingForWallet(walletAddress)
            .some(r => HELD.has(r.payload.state));
    }

    /**
     * Executed by future SINGLE-OWNER signer after it constructs a signed
     * external message, but BEFORE invoking any broadcast transport.
     *
     * A process crash now holds the wallet. The same intent cannot be
     * overwritten or signed twice, even if a new seqno is read.
     */
    holdSignedMessage({
        intentId, seqno, signedExternalMessageHash, validUntil
    } = {}) {
        const record = this.load(intentId);
        ensure(record.status === "ACTIVE" && record.payload.state === STATES.PLANNED,
            "OUTBOUND_INTENT_ALREADY_ATTEMPTED");

        ensure(Number.isSafeInteger(seqno) && seqno >= 0, "OUTBOUND_SEQNO_INVALID");
        ensure(Number.isSafeInteger(validUntil) && validUntil > 0,
            "OUTBOUND_SIGNED_EXPIRY_INVALID");
        const hash = externalHash(signedExternalMessageHash);
        const conflicts = this.listPendingForWallet(record.payload.roomWallet)
            .filter(r => r.recordId !== intentId && HELD.has(r.payload.state));
        ensure(conflicts.length === 0, "OUTBOUND_WALLET_ALREADY_HELD");

        const next = {
            ...record.payload,
            state: STATES.SIGNED_HELD,
            seqno,
            signedExternalMessageHash: hash,
            signedValidUntil: validUntil,
            broadcastingEnabled: false
        };
        this._persistence.updateRecoveryDataRecord(intentId, next, {
            status: "ACTIVE"
        });
        return Object.freeze({
            intentId,
            state: STATES.SIGNED_HELD,
            seqno,
            signedExternalMessageHash: hash,
            broadcastAuthorized: false
        });
    }

    /**
     * The response might be blank even when TON accepted the transfer.
     * Called in finally/catch by a future executor; restarting does not
     * permit another send and cannot silently clear a signed hold.
     */
    markConfirmationUnknown(intentId) {
        const record = this.load(intentId);
        ensure(record.status === "ACTIVE"
            && [STATES.SIGNED_HELD, STATES.CONFIRMATION_UNKNOWN].includes(record.payload.state),
            "OUTBOUND_NOT_SIGNED_OR_ALREADY_FINAL");
        if (record.payload.state === STATES.CONFIRMATION_UNKNOWN) {
            return Object.freeze({ changed: false, state: STATES.CONFIRMATION_UNKNOWN });
        }
        this._persistence.updateRecoveryDataRecord(intentId, {
            ...record.payload, state: STATES.CONFIRMATION_UNKNOWN
        }, { status: "ACTIVE" });
        return Object.freeze({ changed: true, state: STATES.CONFIRMATION_UNKNOWN });
    }

    /**
     * ONLY authoritative external dual-provider proof plus an observed
     * chain seqno advance marks a transfer confirmed. Confirmation NEVER
     * releases the room-wallet quarantine or schedules another transfer.
     */
    confirmWithChainProof({ intentId, evidence, observedSeqno } = {}) {
        const record = this.load(intentId);
        const p = record.payload;
        if (record.status === "SETTLED" && p.state === STATES.CHAIN_CONFIRMED) {
            return Object.freeze({ changed: false, state: STATES.CHAIN_CONFIRMED });
        }
        ensure(record.status === "ACTIVE" && HELD.has(p.state),
            "OUTBOUND_CANNOT_CONFIRM_UNSIGNED");
        ensure(evidence?.confirmed === true && evidence?.state === STATES.CHAIN_CONFIRMED
            && evidence.receipt, "OUTBOUND_CHAIN_EVIDENCE_REQUIRED");
        const receipt = evidence.receipt;
        ensure(
            raw(receipt.account) === p.roomWallet
            && raw(receipt.recipient) === p.destinationWallet
            && positiveNano(receipt.valueNano) === p.transferNano
            && externalHash(receipt.signedExternalMessageHash) === p.signedExternalMessageHash
            && normalizeTonTransactionHash(receipt.roomWalletTxHash) != null
            && /^[1-9][0-9]*$/.test(String(receipt.roomWalletTxLt))
            && normalizeTonTransactionHash(receipt.outboundMessageHash) != null,
            "OUTBOUND_PROOF_INTENT_MISMATCH"
        );
        ensure(Number.isSafeInteger(observedSeqno) && observedSeqno > p.seqno,
            "OUTBOUND_SEQNO_NOT_ADVANCED");

        this._persistence.updateRecoveryDataRecord(intentId, {
            ...p,
            status: "SETTLED",
            state: STATES.CHAIN_CONFIRMED,
            chainReceipt: Object.freeze({
                walletTxHash: receipt.roomWalletTxHash,
                walletTxLt: String(receipt.roomWalletTxLt),
                outboundMessageHash: receipt.outboundMessageHash,
                confirmedObservedSeqno: observedSeqno
            }),
            broadcastingEnabled: false
        }, { status: "SETTLED" });
        return Object.freeze({
            changed: true,
            state: STATES.CHAIN_CONFIRMED,
            transactionHash: receipt.roomWalletTxHash
        });
    }

    _tryLoad(id) {
        try {
            return this._persistence.loadRecoveryDataRecord(id);
        } catch (error) {
            if (error?.name === "RecordNotFoundError") return null;
            throw error;
        }
    }
}

export { STATES as ROOM_WALLET_OUTBOUND_INTENT_STATES };
