import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { durableWriteJson } from '../DurableJson.js';
/**
 * Connect the authoritative WINNER_DETERMINED result to the existing
 * room-ledger payout obligations. No contract, legacy escrow, keys, signer,
 * broadcast or fabricated settlement is available here.
 */
import { createHash } from "node:crypto";
import { deriveTonAddressIdentity } from "../incoming/TonAddressIdentity.js";
import { PAYMENT_INTENT_STATE } from "../PaymentIntentStatus.js";

export const TESTNET_ROOM_RETAINED_ATOMIC = 0;

function validAddress(value) {
    const address = deriveTonAddressIdentity(value);
    if (!address.startsWith("0:")) throw new Error("PAYOUT_ADDRESS_INVALID");
    return address;
}
function ensure(condition, code) {
    if (!condition) throw new Error(code);
}

export class TestnetWinnerPayoutCoordinator {
    constructor({
        paymentRuntime, roomManager, playerManager, contextResolver,
        winnerEngine, ownerWalletProvider = () => process.env.OWNER_WALLET,
        feeQuotesProvider = null, payoutSubmitter = null
    }) {
        this._payment = paymentRuntime;
        this._resultsDir = paymentRuntime.networkDataDir ? join(paymentRuntime.networkDataDir, 'payout-results') : null;
        if (this._resultsDir) mkdirSync(this._resultsDir, {recursive: true});
        this._activeResults = new Map();
        this._recoveryCursor = 0;
        this._rooms = roomManager;
        this._players = playerManager;
        this._context = contextResolver;
        this._winners = winnerEngine;
        this._ownerWallet = ownerWalletProvider;
        this._fees = feeQuotesProvider;
        this._submitter = payoutSubmitter;
    }

    async onGameResult({ gameId } = {}) {
        const roomId = this._context?.resolveRoomByGameId(gameId);
        ensure(roomId && gameId, "PAYOUT_GAME_ROOM_UNAVAILABLE");
        const room = this._rooms?.getRoom(roomId);
        ensure(room?.players?.length === 3
            && new Set(room.players).size === 3,
            "PAYOUT_THREE_PLAYERS_REQUIRED");

        const result = this._winners?.getResult(gameId);
        const winnerId = result?.winnerPlayerId;
        ensure(winnerId && room.players.includes(winnerId),
            "PAYOUT_WINNER_UNVERIFIED");
        const intents = this._payment?.paymentService?.listPaymentIntentsForRoom(roomId);
        ensure(Array.isArray(intents) && intents.length === 3
            && new Set(intents.map(x => x.playerId)).size === 3
            && room.players.every(id => intents.some(x => x.playerId === id
                && x.state === PAYMENT_INTENT_STATE.SETTLED
                && typeof x.transactionId === "string"
                && x.transactionId.length > 0)),
            "PAYOUT_THREE_SETTLED_PAYMENTS_REQUIRED");

        const principal = intents.reduce((sum, item) => sum + item.amountAtomic, 0);
        ensure(Number.isSafeInteger(principal) && principal > 0
            && this._payment.ledger.getConfirmedPrincipalAtomic(roomId) === principal,
            "PAYOUT_LEDGER_PRINCIPAL_MISMATCH");

        const winnerWallet = validAddress(this._players.getIdentity(winnerId)?.wallet);
        const winnerIntent = intents.find(x => x.playerId === winnerId);
        ensure(validAddress(winnerIntent.expectedSender) === winnerWallet,
            "PAYOUT_WINNER_WALLET_MISMATCH");
        const ownerWallet = validAddress(this._ownerWallet());
        ensure(ownerWallet !== winnerWallet, "PAYOUT_OWNER_WINNER_SAME_WALLET");
        const roomWallet = this._payment.walletPool.getReservationForRoom(roomId);
        ensure(roomWallet?.reservedByRoomId === roomId
            && roomWallet.roomNumber !== 1
            && validAddress(roomWallet.address) !== ownerWallet
            && validAddress(roomWallet.address) !== winnerWallet,
            "PAYOUT_ROOM_WALLET_UNAVAILABLE");

        const payoutId = "payout_" + createHash("sha256")
            .update(JSON.stringify([roomId,gameId]))
            .digest("hex").slice(0,32);
        ensure(!this._payment.refundStore?.list().some(x => x.roomId === roomId), 'PAYOUT_REFUND_CONFLICT');
        const snapshot = {roomId, gameId, payoutId, winnerId, winnerWallet, ownerWallet, roomWallet, principal};
        this._payment.outcomeStore?.claim(roomId, 'PAYOUT', snapshot);
        if (this._resultsDir) {
            const path = join(this._resultsDir, payoutId + '.json');
            if (!existsSync(path)) durableWriteJson(path, snapshot, {exclusive: true});
            else ensure(JSON.stringify(JSON.parse(readFileSync(path, 'utf8'))) === JSON.stringify(snapshot), 'PAYOUT_RESULT_CONFLICT');
        }
        return this._executeResult(snapshot);
    }

    async recoverPendingResults() {
        if (!this._resultsDir) return [];
        const results = [];
        const pending = new Map((this._payment.outcomeStore?.list() ?? []).filter(x => x.kind === 'PAYOUT' && x.context).map(x => [x.context.payoutId, x.context]));
        for (const name of readdirSync(this._resultsDir).filter(n => /^payout_[a-f0-9]{32}\.json$/.test(n))) {
            const snapshot = JSON.parse(readFileSync(join(this._resultsDir, name), 'utf8'));
            if (!pending.has(snapshot.payoutId)) pending.set(snapshot.payoutId, snapshot);
        }
        const tasks = [...pending.values()].filter(snapshot => {
            const planned = this._payment.ledger.store?.findByIdempotencyKey(snapshot.payoutId + ':plan');
            return !planned || this._payment.ledger.countOpenObligations(snapshot.roomId) > 0;
        });
        for (let i = 0; i < Math.min(3, tasks.length); i++) {
            const snapshot = tasks[(this._recoveryCursor + i) % tasks.length];
            try { results.push(await this._executeResult(snapshot)); }
            catch { results.push({payoutId:snapshot.payoutId, status:'PAYOUT_RECOVERY_PENDING'}); }
        }
        this._recoveryCursor = tasks.length ? (this._recoveryCursor + 3) % tasks.length : 0;
        return results;
    }

    _executeResult(snapshot) {
        if (this._activeResults.has(snapshot.payoutId)) return this._activeResults.get(snapshot.payoutId);
        const task = this._executeResultOnce(snapshot).finally(() => this._activeResults.delete(snapshot.payoutId));
        this._activeResults.set(snapshot.payoutId, task);
        return task;
    }

    async _executeResultOnce({roomId, gameId, payoutId, winnerId, winnerWallet, ownerWallet, roomWallet, principal}) {
        ensure(this._payment.outcomeStore?.get(roomId)?.kind !== 'REFUND', 'PAYOUT_REFUND_CONFLICT');
        // A fee quote must come from an actual provider; never manufacture a
        // zero-fee payment merely to mark payout as completed.
        if (!this._fees?.quote) {
            return Object.freeze({status:"WAITING_FOR_FEE_QUOTES",payoutId,roomId});
        }
        const networkFees = await this._fees.quote({
            roomId, roomWallet: roomWallet.address,
            winnerWallet, ownerWallet, principalAtomic: principal
        });
        ensure(Number.isSafeInteger(networkFees?.winner?.feeAtomic)
            && networkFees.winner.feeAtomic >= 0
            && Number.isSafeInteger(networkFees?.owner?.feeAtomic)
            && networkFees.owner.feeAtomic >= 0,
            "PAYOUT_FEE_QUOTES_INVALID");

        const payout = this._payment.ledger.planPayout({
            payoutId, roomId, safetyMarginAtomic:TESTNET_ROOM_RETAINED_ATOMIC,
            winner:{recipientId:winnerId,address:winnerWallet},
            owner:{recipientId:"WheelWin",address:ownerWallet},
            networkFees, nowMs:Date.now()
        });
        // Idempotent ledger plan prevents repeated result events making a
        // second submission. Existing plans require separate reconciliation.
        if (payout.replay) {
            // A repeated result can ONLY observe the previous payout.
            // Its ledger identity remains the same and no send is retried.
            const readOnlyReconcile=this._submitter?.resumeUnattempted
                ?? this._submitter?.reconcileAndSettle ?? this._submitter?.reconcile;
            if (typeof readOnlyReconcile === "function") {
                return readOnlyReconcile.call(this._submitter,{
                    roomId,payoutId,roomWalletAddress:roomWallet.address,
                    winnerWallet,ownerWallet,plan:payout.plan
                });
            }
            return Object.freeze({status:"ALREADY_PLANNED_NEEDS_RECONCILIATION",payoutId,roomId});
        }
        if (!this._submitter?.submit) {
            return Object.freeze({status:"PAYOUT_PLANNED_EXECUTOR_UNAVAILABLE",payoutId,roomId});
        }
        // Only an injected Testnet room-wallet executor can move funds. Its
        // contract must persist intent before sending and confirm both outputs.
        return this._submitter.submit({
            roomId, gameId, payoutId,
            roomWalletAddress:roomWallet.address,
            winnerWallet, ownerWallet, plan:payout.plan
        });
    }
}
