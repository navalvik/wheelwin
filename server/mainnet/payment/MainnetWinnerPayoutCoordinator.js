import { createHash } from "node:crypto";
import { MAINNET_GLOBAL_ID } from "../config/MainnetRuntimeConfig.js";
import { mainnetAddressIdentity } from "./MainnetAddress.js";

function require(condition, code) {
    if (!condition) throw new Error(code);
}

/** Build the Mainnet payout plan from the same authoritative result/payment inputs as Testnet. */
export class MainnetWinnerPayoutCoordinator {
    constructor({ paymentRuntime, walletPool, roomManager, playerManager, contextResolver,
        winnerEngine, ownerWalletProvider = () => process.env.OWNER_WALLET_MAINNET } = {}) {
        if (paymentRuntime?.network !== "mainnet" || paymentRuntime?.globalId !== MAINNET_GLOBAL_ID
            || paymentRuntime?.liveOperationsEnabled !== false
            || paymentRuntime?.incomingLedger?.network !== "mainnet"
            || paymentRuntime?.incomingLedger?.globalId !== MAINNET_GLOBAL_ID
            || paymentRuntime?.financialLedger?.network !== "mainnet"
            || paymentRuntime?.financialLedger?.globalId !== MAINNET_GLOBAL_ID
            || typeof paymentRuntime?.payoutLifecycle?.createPayout !== "function"
            || walletPool?.network !== "mainnet"
            || typeof walletPool?.getReservationForRoom !== "function"
            || typeof roomManager?.getRoom !== "function"
            || typeof playerManager?.getIdentity !== "function"
            || typeof contextResolver?.resolveRoomByGameId !== "function"
            || typeof winnerEngine?.getResult !== "function"
            || typeof ownerWalletProvider !== "function") {
            throw new Error("MAINNET_WINNER_PAYOUT_COORDINATOR_CONFIG_INVALID");
        }
        this._payment = paymentRuntime;
        this._walletPool = walletPool;
        this._rooms = roomManager;
        this._players = playerManager;
        this._context = contextResolver;
        this._winners = winnerEngine;
        this._ownerWallet = ownerWalletProvider;
    }

    onGameResult({ gameId } = {}) {
        const roomId = this._context.resolveRoomByGameId(gameId);
        require(roomId && typeof gameId === "string" && gameId.length > 0,
            "PAYOUT_GAME_ROOM_UNAVAILABLE");
        const room = this._rooms.getRoom(roomId);
        require(room?.players?.length === 3 && new Set(room.players).size === 3,
            "PAYOUT_THREE_PLAYERS_REQUIRED");

        const result = this._winners.getResult(gameId);
        const winnerId = result?.winnerPlayerId;
        require(winnerId && room.players.includes(winnerId), "PAYOUT_WINNER_UNVERIFIED");

        const incoming = this._payment.incomingLedger;
        const intents = incoming.listRoomIntents(roomId);
        const paymentStatus = incoming.getRoomPaymentStatus(roomId);
        require(Array.isArray(intents) && intents.length === 3
            && new Set(intents.map(item => item.playerId)).size === 3
            && new Set(intents.map(item => item.destinationWalletId)).size === 1
            && room.players.every(playerId => intents.some(item => item.playerId === playerId
                && item.network === "mainnet" && item.globalId === MAINNET_GLOBAL_ID
                && item.state === "SETTLED"
                && typeof item.confirmedTransactionId === "string"
                && item.confirmedTransactionId.length > 0))
            && paymentStatus?.network === "mainnet"
            && paymentStatus?.globalId === MAINNET_GLOBAL_ID
            && paymentStatus?.confirmedCount === 3
            && paymentStatus?.financialReady === true,
        "PAYOUT_THREE_SETTLED_PAYMENTS_REQUIRED");

        const receipts = incoming.listReceipts(roomId)
            .filter(receipt => receipt.status === "CONFIRMED");
        const observations = incoming.listObservations(roomId);
        require(receipts.length === 3, "PAYOUT_LEDGER_PRINCIPAL_MISMATCH");
        const receiptByReference = new Map();
        let intentPrincipal = 0n;
        let receiptPrincipal = 0n;
        const transactionIds = new Set();
        for (const intent of intents) {
            const receipt = receipts.find(item => item.paymentReference === intent.paymentReference);
            const observation = receipt
                ? observations.find(item => item.transactionId === receipt.transactionId) : null;
            require(receipt && observation
                && !receiptByReference.has(intent.paymentReference)
                && !transactionIds.has(receipt.transactionId)
                && receipt.network === "mainnet" && receipt.globalId === MAINNET_GLOBAL_ID
                && receipt.roomId === roomId && receipt.status === "CONFIRMED" && receipt.reason === null
                && receipt.transactionId === intent.confirmedTransactionId
                && receipt.playerId === intent.playerId && receipt.amountAtomic === intent.amountAtomic
                && receipt.asset === "TON"
                && observation.network === "mainnet" && observation.globalId === MAINNET_GLOBAL_ID
                && observation.roomId === roomId && observation.transactionId === receipt.transactionId
                && observation.asset === "TON" && observation.amountAtomic === receipt.amountAtomic
                && observation.transactionTime === receipt.transactionTime
                && mainnetAddressIdentity(receipt.sourceAddress) === mainnetAddressIdentity(intent.expectedSender)
                && mainnetAddressIdentity(receipt.destinationAddress)
                    === mainnetAddressIdentity(intent.destinationWalletAddress)
                && mainnetAddressIdentity(observation.sourceAddress)
                    === mainnetAddressIdentity(receipt.sourceAddress)
                && mainnetAddressIdentity(observation.destinationAddress)
                    === mainnetAddressIdentity(receipt.destinationAddress),
            "PAYOUT_LEDGER_PRINCIPAL_MISMATCH");
            receiptByReference.set(intent.paymentReference, receipt);
            transactionIds.add(receipt.transactionId);
            intentPrincipal += BigInt(intent.amountAtomic);
            receiptPrincipal += BigInt(receipt.amountAtomic);
        }
        require(intentPrincipal > 0n && intentPrincipal === receiptPrincipal
            && intentPrincipal <= BigInt(Number.MAX_SAFE_INTEGER),
        "PAYOUT_LEDGER_PRINCIPAL_MISMATCH");
        const principalAtomic = Number(intentPrincipal);

        const winnerIntent = intents.find(item => item.playerId === winnerId);
        const winnerWallet = mainnetAddressIdentity(this._players.getIdentity(winnerId)?.wallet);
        require(winnerWallet === mainnetAddressIdentity(winnerIntent.expectedSender),
            "PAYOUT_WINNER_WALLET_MISMATCH");
        const ownerWallet = mainnetAddressIdentity(this._ownerWallet());
        require(ownerWallet !== winnerWallet, "PAYOUT_OWNER_WINNER_SAME_WALLET");

        const roomWallet = this._walletPool.getReservationForRoom(roomId);
        require(roomWallet?.reservedByRoomId === roomId
            && roomWallet.network === "mainnet" && roomWallet.roomNumber !== 1
            && intents.every(intent => intent.destinationWalletId === roomWallet.walletId
                && mainnetAddressIdentity(intent.destinationWalletAddress)
                    === mainnetAddressIdentity(roomWallet.address)),
        "PAYOUT_ROOM_WALLET_UNAVAILABLE");
        const sourceWalletAddress = mainnetAddressIdentity(roomWallet.address);
        require(sourceWalletAddress !== ownerWallet && sourceWalletAddress !== winnerWallet,
            "PAYOUT_ROOM_WALLET_UNAVAILABLE");

        const financial = this._payment.financialLedger;
        require(financial.getOutcome(roomId)?.kind !== "REFUND"
            && financial.listRefunds(roomId).length === 0,
        "PAYOUT_REFUND_CONFLICT");
        const payoutId = "payout_" + createHash("sha256")
            .update(JSON.stringify([roomId, gameId]))
            .digest("hex").slice(0, 32);
        const payout = this._payment.payoutLifecycle.createPayout({
            payoutId, roomId, roomNumber: roomWallet.roomNumber, sourceWalletAddress,
            principalAtomic, winner: { recipientId: winnerId, address: winnerWallet },
            owner: { recipientId: "WheelWin", address: ownerWallet }
        });
        return Object.freeze({
            status: payout.replay ? "ALREADY_PLANNED_NEEDS_RECONCILIATION"
                : "PAYOUT_PLANNED_EXECUTOR_UNAVAILABLE",
            payoutId, roomId, payout
        });
    }

    /** Read persisted unfinished plans only; never plan, sign, submit, or settle during recovery. */
    recoverPendingResults() {
        const payouts = this._payment.financialLedger.listPayouts();
        return Object.freeze(payouts.filter(payout => payout.state !== "COMPLETE").map(payout =>
            Object.freeze({
                status: "PAYOUT_RECOVERY_PENDING",
                payoutId: payout.payoutId,
                roomId: payout.roomId,
                state: payout.state,
                principalAtomic: payout.principalAtomic,
                sourceWalletAddress: payout.sourceWalletAddress,
                allocation: Object.freeze({ ...payout.allocation }),
                winner: Object.freeze({ ...payout.winner }),
                owner: Object.freeze({ ...payout.owner })
            })
        ));
    }
}
