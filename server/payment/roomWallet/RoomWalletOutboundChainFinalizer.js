/**
 * Read-only finalization of a previously signed Room Wallet transfer.
 *
 * The live sender and the post-restart recovery worker MUST use the SAME
 * finalization rule; neither can rebroadcast a signed external message.
 * Chain confirmation is an exact two-indexer signed-message/recipient/value
 * proof PLUS a fresh authoritative wallet seqno advance.
 */
import {
    verifyOutgoingPaymentFromBothProviders
} from "./RoomWalletDualSourceOutgoingReceipt.js";

export class RoomWalletOutboundChainFinalizer {
    constructor({ intentJournal, walletGate, chain } = {}) {
        if (typeof intentJournal?.load !== "function"
            || typeof intentJournal?.confirmWithChainProof !== "function"
            || typeof walletGate?.releaseConfirmed !== "function"
            || typeof walletGate?.isLocked !== "function"
            || typeof chain?.getSeqno !== "function") {
            throw new TypeError("Outbound chain finalizer requires journal, gate and chain reader");
        }
        this._journal = intentJournal;
        this._gate = walletGate;
        this._chain = chain;
    }

    async reconcile({
        intentId, tonapiTransactions, toncenterTransactions
    } = {}) {
        const record = this._journal.load(intentId);
        const p = record.payload;
        if (record.status === "SETTLED" && p.state === "CHAIN_CONFIRMED") {
            // Crash window: persistence may have SETTLED but the process died
            // before removing the physical signer lock. Recovery is safe only
            // for THIS exact immutable, already chain-confirmed intent.
            let releasedRecoveredLock = false;
            if (this._gate.isLocked(p.roomWallet)) {
                this._gate.releaseConfirmed({ intentId });
                releasedRecoveredLock = true;
            }
            return Object.freeze({
                state: "CHAIN_CONFIRMED", changed: false,
                releasedRecoveredLock, broadcastAuthorized: false
            });
        }
        if (record.status !== "ACTIVE"
            || !["SIGNED_HELD", "CONFIRMATION_UNKNOWN"].includes(p.state)) {
            throw new Error("OUTBOUND_RECONCILIATION_NOT_SIGNED");
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
        // The source wallet seqno is read by a genuine blockchain provider,
        // never inferred or incremented from the server's own memory.
        const observedSeqno = await this._chain.getSeqno(p.roomWallet);
        const result = this._journal.confirmWithChainProof({
            intentId, evidence, observedSeqno
        });
        // Even if power is lost right here, the already durable confirmed
        // journal entry permits safe recovery of ONLY this lock.
        if (this._gate.isLocked(p.roomWallet)) {
            this._gate.releaseConfirmed({ intentId });
        }
        return Object.freeze({
            state: "CHAIN_CONFIRMED",
            changed: result.changed,
            txHash: result.transactionHash,
            broadcastAuthorized: false
        });
    }
}
