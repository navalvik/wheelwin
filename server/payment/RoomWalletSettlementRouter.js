/**
 * Payment architecture migration boundary.
 *
 * Keeps the existing ContractSettlementManager contract stable while allowing
 * the new Room Wallet settlement path to be enabled explicitly.
 *
 * This router does not calculate game results or amounts. The caller supplies
 * the already-authoritative settlement request produced by the existing game
 * settlement flow.
 */
export class RoomWalletSettlementRouter {
    constructor({
        roomWalletSettlementAdapter = null,
        enabled = false
    }) {
        if (enabled === true && !roomWalletSettlementAdapter) {
            throw new Error(
                "RoomWalletSettlementRouter requires roomWalletSettlementAdapter when enabled"
            );
        }

        this._roomWalletSettlementAdapter = roomWalletSettlementAdapter;
        this._enabled = enabled === true;
    }

    isEnabled() {
        return this._enabled;
    }

    setEnabled(enabled) {
        const next = enabled === true;

        if (next && !this._roomWalletSettlementAdapter) {
            throw new Error(
                "RoomWalletSettlementRouter cannot enable ROOM_WALLET without an adapter"
            );
        }

        this._enabled = next;
        return this._enabled;
    }

    get activeAdapter() {
        return this._roomWalletSettlementAdapter;
    }

    async settleContract(request) {
        const adapter = this.activeAdapter;

        if (!adapter || typeof adapter.settleContract !== "function") {
            return Object.freeze({
                ok: false,
                retryable: false,
                code: "ROOM_WALLET_SETTLEMENT_UNAVAILABLE"
            });
        }

        return adapter.settleContract(request);
    }

    /**
     * PAYOUT GAS PLAN — compute-only passthrough. The caller (Contract
     * SettlementManager) freezes the returned plan into the persisted
     * settlement session BEFORE the first payout broadcast so recovery
     * reuses the exact persisted net amounts.
     *
     * When the wrapped adapter has no planning capability the result is
     * flagged `capabilityUnavailable` (not a failure): the caller skips plan
     * freezing and the adapter computes its own plan for the pass.
     */
    async planSettlement(request) {
        const adapter = this.activeAdapter;

        if (!adapter || typeof adapter.planSettlement !== "function") {
            return Object.freeze({
                ok: false,
                retryable: true,
                capabilityUnavailable: true,
                code: "ROOM_WALLET_SETTLEMENT_UNAVAILABLE"
            });
        }

        return adapter.planSettlement(request);
    }

    /**
     * PAYOUT GAS PLAN for refunds — compute-only passthrough. The caller
     * (PaymentSessionManager) freezes the returned plan into the persisted
     * session recoveryMetadata BEFORE the first refund broadcast.
     *
     * `capabilityUnavailable` semantics as in planSettlement.
     */
    async planRefunds(request) {
        const adapter = this.activeAdapter;

        if (!adapter || typeof adapter.planRefunds !== "function") {
            return Object.freeze({
                ok: false,
                retryable: true,
                capabilityUnavailable: true,
                code: "ROOM_WALLET_REFUND_UNSUPPORTED"
            });
        }

        return adapter.planRefunds(request);
    }

    async refundPayments(request) {
        const adapter = this.activeAdapter;

        if (typeof adapter.refundPayments !== "function") {
            return Object.freeze({
                ok: false,
                retryable: false,
                code: "ROOM_WALLET_REFUND_UNSUPPORTED"
            });
        }

        return adapter.refundPayments(request);
    }

    async inspectSettlement(request) {
        const adapter = this.activeAdapter;

        if (typeof adapter.inspectSettlement === "function") {
            return adapter.inspectSettlement(request);
        }

        return null;
    }

    async getSettlementState(address) {
        const adapter = this.activeAdapter;

        if (typeof adapter.getSettlementState !== "function") {
            return null;
        }

        return adapter.getSettlementState(address);
    }
}
