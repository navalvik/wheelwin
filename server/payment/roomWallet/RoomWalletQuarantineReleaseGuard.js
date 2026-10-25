/**
 * Testnet-only, fail-closed Room Wallet quarantine closure.
 *
 * This is a deliberately stricter gate than "payment state = refunded".
 * A numbered wallet may re-enter the 64-wallet pool ONLY after:
 * - room is gone and a quiet/late-payment grace period has elapsed;
 * - both independent chain indexers agree on the latest account tx tip;
 * - every transaction since session start was scanned and has matched evidence;
 * - every independently verified paid player's refund has a matching
 *   immutable CHAIN_CONFIRMED outbound intent, or both WINNER and OWNER
 *   intents are CHAIN_CONFIRMED after a completed Page5 settlement;
 * - no pending, failed or ambiguous sweep, or any other signed/outbound debt
 *   remains with this same source wallet;
 * - closure is written durably before in-memory allocation is unblocked.
 *
 * No signing, no broadcasting and no timed release of uncertain transfers.
 * The historical Oct 25 Olga refund has NO new signed intent and therefore
 * does not make old room oj7v automatically releasable.
 */
import { createHash } from "node:crypto";
import { Address } from "@ton/core";
import { TON_FINANCIAL_RECORD_TYPES } from "../../persistence/TonFinancialRecordTypes.js";
import { normalizeTonTransactionHash } from "./RoomWalletDualSourceEvidence.js";
import { fetchExpiredRoomWalletHistory } from "./RoomWalletExpiredChainScanner.js";
import { fetchDualSourceRoomWalletTip } from "./RoomWalletDualSourceAccountTip.js";
import { buildExpiredRoomWalletRefundObligations } from "./RoomWalletExpiredRefundObligations.js";

export class RoomWalletQuarantineReleaseError extends Error {
    constructor(code) { super(code); this.name = "RoomWalletQuarantineReleaseError"; this.code = code; }
}
function guard(value, code) {
    if (!value) throw new RoomWalletQuarantineReleaseError(code);
}
function raw(value) {
    try { return Address.parse(value).toRawString().toLowerCase(); }
    catch { return null; }
}
function txIdentity(tx) {
    const lt = String(tx?.lt ?? tx?.transaction_id?.lt ?? "");
    const hash = normalizeTonTransactionHash(tx?.hash ?? tx?.transaction_id?.hash);
    guard(/^\d+$/.test(lt) && hash, "QUARANTINE_RELEASE_CHAIN_TX_INVALID");
    return lt + ":" + hash;
}

export class RoomWalletQuarantineReleaseGuard {
    constructor({
        repository, financialPersistence, residualSweepRepository,
        historyScanner = fetchExpiredRoomWalletHistory,
        accountTipReader = fetchDualSourceRoomWalletTip,
        isRoomActive,
        requestBudget = null,
        fetchImpl = globalThis.fetch,
        now = () => Date.now(),
        minimumQuietMs = 15 * 60 * 1000
    } = {}) {
        if (typeof repository?.closeWithChainEvidence !== "function"
            || typeof financialPersistence?.loadRecoveryDataRecord !== "function"
            || typeof financialPersistence?.loadPaymentSession !== "function"
            || typeof financialPersistence?.findByRoom !== "function"
            || typeof financialPersistence?.listActiveRecoveryDataRecords !== "function"
            || typeof residualSweepRepository?.listActive !== "function"
            || typeof historyScanner !== "function"
            || typeof accountTipReader !== "function"
            || typeof isRoomActive !== "function"
            || typeof now !== "function"
            || typeof fetchImpl !== "function"
            || (requestBudget !== null && typeof requestBudget?.schedule !== "function")
            || !Number.isSafeInteger(minimumQuietMs)
            || minimumQuietMs < 10 * 60 * 1000) {
            throw new TypeError("RoomWallet quarantine release needs all authoritative readers");
        }
        this._repo = repository;
        this._db = financialPersistence;
        this._sweep = residualSweepRepository;
        this._scan = historyScanner;
        this._head = accountTipReader;
        this._roomActive = isRoomActive;
        this._budget = requestBudget;
        this._fetch = fetchImpl;
        this._now = now;
        this._quiet = minimumQuietMs;
    }

    /**
     * Only the server's single financial writer calls this. Any uncertainty
     * throws and leaves the persistent wallet block unchanged.
     */
    async tryRelease({ recordId } = {}) {
        guard(typeof recordId === "string" && recordId.length > 0,
            "QUARANTINE_RELEASE_ID_REQUIRED");
        const hold = this._db.loadRecoveryDataRecord(recordId);
        const marker = hold.payload;
        const isRefund = marker?.kind === "ROOM_WALLET_REFUND_QUARANTINE";
        const isSettlement = marker?.kind === "ROOM_WALLET_SETTLEMENT_QUARANTINE";
        guard((isRefund || isSettlement)
            && hold.status === "ACTIVE"
            && marker.state === (isRefund
                ? "RECONCILIATION_REQUIRED"
                : "SETTLEMENT_CHAIN_RECONCILIATION_REQUIRED")
            && marker.network === "testnet"
            && Number.isInteger(marker.roomNumber)
            && raw(marker.roomWallet), "QUARANTINE_RELEASE_MARKER_UNVERIFIED");
        guard(!this._roomActive(marker.roomId),
            "QUARANTINE_RELEASE_ROOM_STILL_ACTIVE");
        const records = this._db.findByRoom(marker.roomId);
        const paymentRecords = records.filter(x =>
            x.recordType === TON_FINANCIAL_RECORD_TYPES.PAYMENT_SESSION);
        guard(paymentRecords.length === 1
            && (isSettlement || paymentRecords[0].recordId === marker.paymentSessionId),
            "QUARANTINE_RELEASE_PAYMENT_IDENTITY_UNVERIFIED");
        const session = paymentRecords[0].payload;
        guard(session?.network === "testnet"
            && session.roomId === marker.roomId
            && session.gameId === marker.gameId
            && Number(session.roomNumber) === Number(marker.roomNumber)
            && raw(session.roomWalletAddress) === raw(marker.roomWallet)
            && (!isRefund || session.paymentSessionId === marker.paymentSessionId)
            && Number.isSafeInteger(Number(session.createdAt))
            && Array.isArray(session.participants)
            && session.participants.length === 3,
            "QUARANTINE_RELEASE_PAYMENT_SESSION_MISMATCH");

        const expiry = Number(session.paymentDeadline ?? session.expiresAt);
        guard(Number.isSafeInteger(expiry) && expiry > Number(session.createdAt),
            "QUARANTINE_RELEASE_PAYMENT_DEADLINE_UNKNOWN");
        const lastRiskTime = Math.max(expiry, Number(hold.createdAt));
        guard(this._now() >= lastRiskTime + this._quiet,
            "QUARANTINE_RELEASE_QUIET_WINDOW_NOT_ELAPSED");
        // Never release while any operational sweep is planned/failed/in
        // flight. Historical sweep results with missing chain evidence also
        // remain manual-review items until ledger migration.
        const sweeps = this._sweep.listActive().filter(x =>
            Number(x.payload?.roomNumber) === marker.roomNumber);
        guard(sweeps.length === 0, "QUARANTINE_RELEASE_RESIDUAL_SWEEP_PENDING");

        // Also block unrelated pending funds transfers from the SAME wallet,
        // even if they refer to another game on that numbered wallet.
        const inFlight = this._db.listActiveRecoveryDataRecords().filter(x =>
            x.payload?.kind === "ROOM_WALLET_OUTBOUND_INTENT"
            && raw(x.payload?.roomWallet) === raw(marker.roomWallet));
        guard(inFlight.length === 0,
            "QUARANTINE_RELEASE_OUTBOUND_INTENT_UNRESOLVED");

        const chain = await this._scan({
            address: marker.roomWallet,
            sessionStartMs: Number(session.createdAt),
            fetchImpl: this._fetch,
            requestBudget: this._budget
        });
        guard(chain?.source === "tonapi+toncenter-v3"
            && chain.historyComplete === true
            && chain.awaitingSecondProvider === 0
            && Array.isArray(chain.transactions)
            && /^\d+$/.test(String(chain.accountTip?.lt ?? ""))
            && /^[0-9a-f]{64}$/.test(String(chain.accountTip?.hash ?? ""))
            && raw(chain.rawAddress) === raw(marker.roomWallet),
            "QUARANTINE_RELEASE_CHAIN_HISTORY_UNPROVEN");
        const head = await this._head({
            roomWallet: marker.roomWallet,
            requestBudget: this._budget,
            fetchImpl: this._fetch
        });
        guard(head?.providersAgree === true
            && raw(head.roomWallet) === raw(marker.roomWallet)
            && head.headLt === chain.accountTip.lt
            && head.headHash === chain.accountTip.hash, "QUARANTINE_RELEASE_INDEXER_HEAD_NOT_FRESH");

        const receipts = records.filter(x =>
            x.recordType === TON_FINANCIAL_RECORD_TYPES.RECOVERY_DATA
            && x.payload?.kind === "ROOM_WALLET_OUTBOUND_INTENT");
        const settled = [];
        if (isRefund) {
            const plan = buildExpiredRoomWalletRefundObligations({
                session,
                chainEvidence: chain,
                gameReachedPage5: false,
                historyComplete: true
            });
            guard(plan.manualReview.length === 0,
                "QUARANTINE_RELEASE_UNEXPLAINED_PAYMENT");
            const planned = plan.obligations;
            const stored = records.filter(x =>
                x.recordType === TON_FINANCIAL_RECORD_TYPES.RECOVERY_DATA
                && x.payload?.kind === "ROOM_WALLET_REFUND_OBLIGATION");
            guard(stored.length === planned.length
                && planned.every(o => stored.some(x =>
                    x.recordId === o.obligationId
                    && x.payload?.inboundTxHash === o.inboundTxHash
                    && String(x.payload?.grossRefundNano) === String(o.grossRefundNano))),
                "QUARANTINE_RELEASE_INBOUND_LEDGER_INCOMPLETE");
            for (const obligation of planned) {
                guard(obligation.executionAllowed === true,
                    "QUARANTINE_RELEASE_UNEXPECTED_DEPOSIT");
                const matches = receipts.filter(x =>
                    x.payload.authorizationId === obligation.obligationId
                    && x.payload.role === "REFUND"
                    && x.payload.gameId === marker.gameId
                    && x.payload.paymentSessionId === marker.paymentSessionId
                    && raw(x.payload.destinationWallet) === raw(obligation.recipientWallet)
                    && raw(x.payload.roomWallet) === raw(marker.roomWallet));
                guard(matches.length === 1 && this._confirmed(matches[0]),
                    "QUARANTINE_RELEASE_REFUND_UNPAID");
                guard(BigInt(matches[0].payload.grossNano) ===
                    BigInt(obligation.grossRefundNano),
                    "QUARANTINE_RELEASE_REFUND_AMOUNT_MISMATCH");
                settled.push(matches[0].recordId);
            }
        } else {
            const sessions = records.filter(x =>
                x.recordType === TON_FINANCIAL_RECORD_TYPES.SETTLEMENT);
            guard(sessions.length === 1
                && sessions[0].payload?.status === "SETTLEMENT_COMPLETED"
                && sessions[0].payload?.gameId === marker.gameId
                && sessions[0].payload?.request?.payoutPlan,
                "QUARANTINE_RELEASE_SETTLEMENT_NOT_COMPLETED");
            const payoutPlanHash = createHash("sha256")
                .update(JSON.stringify(sessions[0].payload.request.payoutPlan))
                .digest("hex");
            for (const role of ["WINNER", "OWNER"]) {
                const matches = receipts.filter(x =>
                    x.payload.role === role
                    && x.payload.gameId === marker.gameId
                    && raw(x.payload.roomWallet) === raw(marker.roomWallet)
                    && x.payload.frozenGasPlanHash === payoutPlanHash
                    && x.payload.authorizationId ===
                        sessions[0].payload.settlementSessionId + ":" + role);
                guard(matches.length === 1 && this._confirmed(matches[0]),
                    "QUARANTINE_RELEASE_SETTLEMENT_OUTBOUND_UNPAID");
                settled.push(matches[0].recordId);
            }
            // A completed game must not also have unresolved refund debts.
            guard(!records.some(x =>
                x.recordType === TON_FINANCIAL_RECORD_TYPES.RECOVERY_DATA
                && x.payload?.kind === "ROOM_WALLET_REFUND_OBLIGATION"),
                "QUARANTINE_RELEASE_REFUND_CONFLICT");
        }
        // Even a third party's extra deposit must not be silently cleared.
        // A matched participant's payment is already in the authoritative
        // ledger; any additional successful inbound value needs manual review.
        const acceptedInbound = chain.transactions.filter(tx =>
            tx.success === true
            && raw(tx.in_msg?.destination) === raw(marker.roomWallet)
            && Number(tx.utime) * 1000 >= Number(session.createdAt) - 15_000
            && BigInt(String(tx.in_msg?.value ?? "0")) > 0n);
        const maxExpected = isRefund
            ? settled.length
            : session.participants.length;
        guard(acceptedInbound.length === maxExpected,
            "QUARANTINE_RELEASE_UNTRACKED_INCOMING");

        const historyHash = createHash("sha256")
            .update(chain.transactions.map(txIdentity).join("|")).digest("hex");
        return this._repo.closeWithChainEvidence({
            recordId,
            evidence: {
                kind: "DOUBLE_SOURCE_ROOM_WALLET_CLOSURE_V1",
                complete: true,
                network: "testnet",
                roomId: marker.roomId,
                gameId: marker.gameId,
                roomNumber: marker.roomNumber,
                roomWallet: marker.roomWallet,
                headLt: head.headLt,
                headHash: head.headHash,
                historyHash,
                verifiedAtMs: this._now(),
                settledIntents: settled
            }
        });
    }

    _confirmed(record) {
        const p = record.payload;
        return record.status === "SETTLED"
            && p.status === "SETTLED"
            && p.state === "CHAIN_CONFIRMED"
            && !!p.chainReceipt?.walletTxHash
            && !!p.chainReceipt?.walletTxLt
            && !!p.chainReceipt?.outboundMessageHash
            && Number.isSafeInteger(p.chainReceipt.confirmedObservedSeqno);
    }
}
