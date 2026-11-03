import { createHash } from "node:crypto";
import { MAINNET_GLOBAL_ID } from "../config/MainnetRuntimeConfig.js";
import { mainnetAddressIdentity } from "./MainnetAddress.js";
import { MainnetIncomingPaymentLedger } from "./MainnetIncomingPaymentLedger.js";
import { MainnetToncenterReadClient } from "./MainnetToncenterReadClient.js";
import { IncomingTransfer } from "../../payment/incoming/IncomingTransfer.js";
import { deriveIncomingTransactionId } from "../../payment/incoming/IncomingTransferIdentity.js";
import { matchIncomingTransferToIntent } from "../../payment/incoming/IncomingTransferMatcher.js";

function fingerprint(record) {
    const stable = {
        transactionId: record.transactionId,
        providerTransactionId: record.providerTransactionId,
        accountId: record.accountId,
        sourceAddress: record.sourceAddress,
        destinationAddress: record.destinationAddress,
        amountAtomic: record.amountAtomic,
        asset: record.asset,
        transactionTime: record.transactionTime,
        paymentReference: record.paymentReference,
        malformedComment: record.malformedComment
    };
    return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function sameAddress(left, right) {
    try { return mainnetAddressIdentity(left) === mainnetAddressIdentity(right); }
    catch { return false; }
}

export class MainnetIncomingPaymentService {
    constructor({ config, client, ledger, nowProvider = Date.now, minimumMasterchainDepth = 1 } = {}) {
        if (config?.network !== "mainnet" || config?.globalId !== MAINNET_GLOBAL_ID
            || !(client instanceof MainnetToncenterReadClient)
            || !(ledger instanceof MainnetIncomingPaymentLedger)
            || client?.network !== "mainnet" || client?.globalId !== MAINNET_GLOBAL_ID
            || client?.baseUrl !== config?.toncenterBaseUrl
            || ledger?.network !== "mainnet" || ledger?.globalId !== MAINNET_GLOBAL_ID
            || typeof ledger.listRoomIntents !== "function"
            || typeof client.listIncomingTransactions !== "function"
            || typeof client.getMasterchainInfo !== "function"
            || typeof nowProvider !== "function"
            || !Number.isSafeInteger(minimumMasterchainDepth) || minimumMasterchainDepth < 1) {
            throw new Error("MAINNET_INCOMING_PAYMENT_SERVICE_CONFIG_INVALID");
        }
        this._config = config;
        this._client = client;
        this._ledger = ledger;
        this._now = nowProvider;
        this._depth = minimumMasterchainDepth;
    }

    createRoomPaymentIntents(input) {
        return this._ledger.createRoomPaymentIntents(input);
    }

    getRoomPaymentStatus(roomId) {
        return this._ledger.getRoomPaymentStatus(roomId);
    }

    /** One explicit read-only history pass; no polling, retry, Page5, or outgoing capability. */
    async observeRoom(roomId, { limit = 100 } = {}) {
        const intents = this._ledger.listRoomIntents(roomId);
        if (intents.length !== 3) throw new Error("MAINNET_ROOM_REQUIRES_EXACTLY_THREE_PAYMENT_INTENTS");
        const floorMs = Math.min(...intents.map((item) => item.createdAt));
        const ceilingMs = Math.min(this._now(), Math.max(...intents.map((item) => item.expiresAt)));
        if (ceilingMs < floorMs) {
            return Object.freeze({ status: "WINDOW_NOT_OPEN", resultWindowComplete: true,
                observed: 0, confirmed: 0, extra: 0, unresolved: 0, duplicates: 0,
                paymentStatus: this.getRoomPaymentStatus(roomId) });
        }
        const walletAddress = intents[0].destinationWalletAddress;
        if (intents.some((intent) => intent.destinationWalletId !== intents[0].destinationWalletId
            || !sameAddress(intent.destinationWalletAddress, walletAddress))) {
            throw new Error("MAINNET_ROOM_WALLET_IDENTITY_CONFLICT");
        }
        const batch = await this._client.listIncomingTransactions({
            account: walletAddress, floorMs, ceilingMs, limit
        });
        if (batch.resultWindowComplete !== true) {
            return Object.freeze({ status: "INCOMPLETE_WINDOW", resultWindowComplete: false,
                observed: batch.records.length, confirmed: 0, extra: 0, unresolved: 0, duplicates: 0,
                paymentStatus: this.getRoomPaymentStatus(roomId) });
        }

        const counts = { observed: 0, confirmed: 0, extra: 0, unresolved: 0, duplicates: 0 };
        let chainHead = null;
        for (const record of batch.records) {
            const observation = Object.freeze({
                network: "mainnet", globalId: MAINNET_GLOBAL_ID, roomId,
                transactionId: record.transactionId,
                providerTransactionId: record.providerTransactionId,
                accountId: record.accountId,
                sourceAddress: record.sourceAddress,
                destinationAddress: record.destinationAddress,
                amountAtomic: record.amountAtomic,
                asset: record.asset,
                transactionTime: record.transactionTime,
                payloadFingerprint: fingerprint(record),
                observedAt: this._now()
            });
            const prior = this._ledger.ensureObservationConsistent(observation);
            const priorReceipt = this._ledger.getReceipt(record.transactionId);
            if (priorReceipt && ["CONFIRMED", "EXTRA_PAYMENT", "UNRESOLVED", "AMBIGUOUS"].includes(priorReceipt.status)) {
                counts.duplicates += 1;
                continue;
            }

            const match = this._resolveMatch(roomId, intents, record);
            if (!match.intent) {
                const receipt = this._receipt(record, roomId, match.status, match.reason, null);
                const result = this._ledger.recordTransfer({ observation, receipt });
                if (result.duplicate) counts.duplicates += 1;
                else { counts.observed += 1; counts.unresolved += 1; }
                continue;
            }

            const currentIntent = this._ledger.getIntent(match.intent.paymentReference);
            if (!currentIntent) throw new Error("MAINNET_MATCHED_INTENT_DISAPPEARED");

            if (chainHead === null) {
                const chain = await this._client.getMasterchainInfo();
                chainHead = chain?.last;
                if (chainHead?.global_id !== MAINNET_GLOBAL_ID) {
                    throw new Error("MAINNET_MASTERCHAIN_GLOBAL_ID_MISMATCH");
                }
                if (!Number.isSafeInteger(chainHead.seqno) || chainHead.seqno < 0) {
                    throw new Error("MAINNET_MASTERCHAIN_HEAD_INVALID");
                }
            }

            const finalized = this._isFinalized(record.indexedTransaction, chainHead, record);
            if (!finalized) {
                const receipt = this._receipt(record, roomId, "PENDING_FINALITY", "INDEXED_FINALITY_NOT_YET_PROVEN",
                    currentIntent);
                const result = this._ledger.recordTransfer({ observation, receipt });
                if (result.duplicate) counts.duplicates += 1;
                else { counts.observed += 1; counts.unresolved += 1; }
                continue;
            }

            if (currentIntent.state === "SETTLED") {
                const receipt = this._receipt(record, roomId, "EXTRA_PAYMENT", "PAYMENT_ALREADY_SETTLED",
                    currentIntent);
                const result = this._ledger.recordTransfer({ observation, receipt });
                if (result.duplicate) counts.duplicates += 1;
                else { counts.observed += 1; counts.extra += 1; }
                continue;
            }

            const receipt = this._receipt(record, roomId, "CONFIRMED", null, currentIntent, chainHead.seqno);
            const result = this._ledger.recordTransfer({
                observation,
                receipt,
                settleReference: currentIntent.paymentReference
            });
            if (result.duplicate) counts.duplicates += 1;
            else { counts.observed += 1; counts.confirmed += 1; }
        }
        return Object.freeze({
            status: "OBSERVED",
            resultWindowComplete: true,
            ...counts,
            paymentStatus: this.getRoomPaymentStatus(roomId)
        });
    }

    _resolveMatch(roomId, intents, record) {
        if (record.network !== "mainnet" || record.globalId !== MAINNET_GLOBAL_ID) {
            return { status: "UNRESOLVED", reason: "NETWORK_IDENTITY_MISMATCH", intent: null };
        }
        if (record.malformedComment) {
            return { status: "UNRESOLVED", reason: "MALFORMED_PAYMENT_REFERENCE", intent: null };
        }
        let candidates;
        if (record.paymentReference !== null) {
            const intent = this._ledger.getIntent(record.paymentReference);
            if (!intent || intent.roomId !== roomId) {
                return { status: "UNRESOLVED", reason: "PAYMENT_REFERENCE_UNKNOWN", intent: null };
            }
            candidates = [intent];
        } else if (record.hasComment) {
            return { status: "UNRESOLVED", reason: "PAYMENT_REFERENCE_INVALID", intent: null };
        } else {
            candidates = intents;
        }

        const transfer = new IncomingTransfer({
            network: "mainnet",
            transactionId: deriveIncomingTransactionId({
                network: "mainnet",
                providerId: "toncenter-mainnet",
                accountId: record.accountId,
                transactionId: record.providerTransactionId
            }),
            providerTransactionIdentity: {
                providerId: "toncenter-mainnet",
                accountId: record.accountId,
                transactionId: record.providerTransactionId
            },
            destinationWalletAddress: record.destinationAddress,
            senderAddress: record.sourceAddress,
            amountAtomic: record.amountAtomic,
            asset: record.asset,
            transactionTime: record.transactionTime,
            paymentReference: record.paymentReference,
            paymentComment: record.hasComment ? "present" : null,
            observedAt: this._now()
        });
        const exact = candidates.filter((intent) => {
            if (intent.roomId !== roomId
                || record.transactionTime < intent.createdAt
                || record.transactionTime > intent.expiresAt) return false;
            const amountAtomic = Number(BigInt(intent.amountAtomic));
            if (!Number.isSafeInteger(amountAtomic) || amountAtomic <= 0) return false;
            // The shared matcher is the authority for network, addresses,
            // amount, asset and reference. Mainnet's settled intent may still
            // receive an EXTRA_PAYMENT, so matching uses a read-only
            // matchable projection; settlement remains governed by this
            // service and the Mainnet ledger below.
            const result = matchIncomingTransferToIntent(transfer, {
                ...intent,
                amountAtomic,
                state: "PENDING",
                transactionId: null,
                paymentReference: record.paymentReference === null
                    ? null : intent.paymentReference
            });
            return result.matched;
        });
        if (exact.length === 1) return { status: "MATCHED", reason: null, intent: exact[0] };
        if (exact.length > 1) return { status: "AMBIGUOUS", reason: "MULTIPLE_INTENTS_MATCH", intent: null };
        if (record.paymentReference !== null) {
            return { status: "UNRESOLVED", reason: this._mismatchReason(candidates[0], roomId, record), intent: null };
        }
        const knownSender = intents.some((intent) => sameAddress(intent.expectedSender, record.sourceAddress));
        if (!knownSender) return { status: "UNRESOLVED", reason: "UNKNOWN_SENDER", intent: null };
        const senderMatches = intents.filter((intent) => sameAddress(intent.expectedSender, record.sourceAddress));
        if (senderMatches.every((intent) => intent.amountAtomic !== record.amountAtomic)) {
            return { status: "UNRESOLVED", reason: "AMOUNT_MISMATCH", intent: null };
        }
        if (senderMatches.every((intent) => record.transactionTime < intent.createdAt
            || record.transactionTime > intent.expiresAt)) {
            return { status: "UNRESOLVED", reason: "OUTSIDE_PAYMENT_WINDOW", intent: null };
        }
        return { status: "UNRESOLVED", reason: "PAYMENT_FIELDS_MISMATCH", intent: null };
    }

    _mismatchReason(intent, roomId, record) {
        if (intent.roomId !== roomId) return "ROOM_MISMATCH";
        if (intent.network !== "mainnet" || intent.globalId !== MAINNET_GLOBAL_ID) return "NETWORK_IDENTITY_MISMATCH";
        if (!sameAddress(intent.destinationWalletAddress, record.destinationAddress)) return "RECIPIENT_MISMATCH";
        if (!sameAddress(intent.expectedSender, record.sourceAddress)) return "SENDER_MISMATCH";
        if (intent.amountAtomic !== record.amountAtomic) return "AMOUNT_MISMATCH";
        if (intent.asset !== record.asset) return "ASSET_MISMATCH";
        if (record.transactionTime < intent.createdAt || record.transactionTime > intent.expiresAt) return "OUTSIDE_PAYMENT_WINDOW";
        return "PAYMENT_FIELDS_MISMATCH";
    }

    _isFinalized(indexed, head, record) {
        if (!indexed || indexed.emulated !== false
            || indexed.transactionId !== record.providerTransactionId
            || !sameAddress(indexed.accountId, record.accountId)
            || !sameAddress(record.accountId, record.destinationAddress)
            || !indexed.block || !Number.isSafeInteger(indexed.block.workchain)
            || typeof indexed.block.shard !== "string" || !indexed.block.shard
            || !Number.isSafeInteger(indexed.block.seqno) || indexed.block.seqno <= 0
            || !Number.isSafeInteger(indexed.mcBlockSeqno) || indexed.mcBlockSeqno <= 0) return false;
        return head.seqno >= indexed.mcBlockSeqno + this._depth;
    }

    _receipt(record, roomId, status, reason, intent, masterchainHeadSeqno = null) {
        return Object.freeze({
            network: "mainnet",
            globalId: MAINNET_GLOBAL_ID,
            roomId,
            transactionId: record.transactionId,
            providerTransactionId: record.providerTransactionId,
            paymentReference: intent?.paymentReference ?? record.paymentReference ?? null,
            playerId: intent?.playerId ?? null,
            status,
            reason,
            amountAtomic: record.amountAtomic,
            sourceAddress: record.sourceAddress,
            destinationAddress: record.destinationAddress,
            transactionTime: record.transactionTime,
            asset: "TON",
            masterchainHeadSeqno,
            updatedAt: this._now()
        });
    }
}
