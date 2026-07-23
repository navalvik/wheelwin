/**
 * P6.1 — Session-scoped Telegram wallet addresses.
 *
 * Wallets belong to the current room / setup session only.
 * Never written to PlayerIdentity or other permanent profile storage.
 * Cleared when the room / result session ends.
 */
export class SessionWalletStore {

    constructor() {

        // roomId → Map(playerId → walletAddress)
        this._walletsByRoom = new Map();

    }

    setWallet(roomId, playerId, wallet) {

        if (!roomId || !playerId || typeof wallet !== "string") {

            return false;

        }

        let roomWallets = this._walletsByRoom.get(roomId);

        if (!roomWallets) {

            roomWallets = new Map();

            this._walletsByRoom.set(roomId, roomWallets);

        }

        roomWallets.set(playerId, wallet);

        return true;

    }

    getWallet(roomId, playerId) {

        if (!roomId || !playerId) {

            return null;

        }

        return this._walletsByRoom.get(roomId)?.get(playerId) ?? null;

    }

    /**
     * @returns {Record<string, string>}
     */
    getRoomWallets(roomId) {

        const roomWallets = this._walletsByRoom.get(roomId);

        if (!roomWallets) {

            return {};

        }

        return Object.fromEntries(roomWallets.entries());

    }

    clearRoom(roomId) {

        if (!roomId) {

            return;

        }

        this._walletsByRoom.delete(roomId);

    }

    clearAll() {

        this._walletsByRoom.clear();

    }

}
