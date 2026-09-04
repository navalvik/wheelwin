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
        legacySettlementAdapter,
        roomWalletSettlementAdapter,
        enabled = false
    }) {
        if (!legacySettlementAdapter) {
            throw new Error("RoomWalletSettlementRouter requires legacySettlementAdapter");
        }

        if (!roomWalletSettlementAdapter) {
            throw new Error("RoomWalletSettlementRouter requires roomWalletSettlementAdapter");
        }

        this._legacySettlementAdapter = legacySettlementAdapter;
        this._roomWalletSettlementAdapter = roomWalletSettlementAdapter;
        this._enabled = enabled === true;
    }

    isEnabled() {
        return this._enabled;
    }

    setEnabled(enabled) {
        this._enabled = enabled === true;
        return this._enabled;
    }

    get activeAdapter() {
        return this._enabled
            ? this._roomWalletSettlementAdapter
            : this._legacySettlementAdapter;
    }

    async settleContract(request) {
        return this.activeAdapter.settleContract(request);
    }

    async getSettlementState(address) {
        const adapter = this.activeAdapter;

        if (typeof adapter.getSettlementState !== "function") {
            return null;
        }

        return adapter.getSettlementState(address);
    }
}
