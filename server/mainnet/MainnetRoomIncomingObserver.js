/**
 * Phase 2 Mainnet: active-room, read-only incoming TON observation.
 *
 * This is NOT a payment runtime or settlement attestation. An authoritative
 * caller must supply an active room reservation; inactive and foreign wallets
 * are rejected before any RPC. A fresh masterchain global-ID -239 read gates
 * each on-demand account history query. An indexed transaction alone does
 * not authorize Page5, payouts or refunds.
 *
 * No interval, 64-wallet sweep, signing, broadcast, wallet key access,
 * payment intent mutation, or incoming settlement is implemented here.
 */
import { ToncenterTransactionsClient } from "../payment/toncenter/ToncenterTransactionsClient.js";
import { ToncenterIncomingProvider } from "../payment/toncenter/ToncenterIncomingProvider.js";
import { mapToncenterTransactionsResponse } from "../payment/toncenter/ToncenterTransactionsMapper.js";
import { parseTonAddress, tonAddressIdentitiesEqual } from "../payment/incoming/TonAddressIdentity.js";
import { MAINNET_GLOBAL_ID, MAINNET_TONCENTER_URL } from "./MainnetReadOnlyPreflight.js";

function reject(code) {
    throw new Error(code);
}

function mainnetAccount(address) {
    try {
        const parsed = parseTonAddress(address);
        // Raw addresses are network-neutral; verified Mainnet RPC identity
        // is authoritative. Explicit test-only display tags are rejected.
        return parsed.workchain === 0 && parsed.testOnly !== true;
    } catch {
        return false;
    }
}

function validMainnetClient(client) {
    if (!(client instanceof ToncenterTransactionsClient)) return false;
    try {
        const url = new URL(client.baseUrl);
        return url.origin === MAINNET_TONCENTER_URL
            && url.pathname === "/"
            && !url.search && !url.hash
            && !url.username && !url.password;
    } catch {
        return false;
    }
}

export class MainnetRoomIncomingObserver {
    constructor({
        env = process.env,
        client = null,
        resolveActiveRoomWallet
    } = {}) {
        if (String(env?.TON_NETWORK ?? "").trim().toLowerCase() !== "mainnet") {
            reject("MAINNET_INCOMING_NETWORK_MISMATCH");
        }
        if (String(env?.ROOM_WALLET_PAYMENTS_ENABLED ?? "").trim() === "true") {
            reject("MAINNET_INCOMING_PAYMENTS_NOT_ALLOWED");
        }
        if (typeof resolveActiveRoomWallet !== "function") {
            reject("MAINNET_INCOMING_ACTIVE_ROOM_RESOLVER_REQUIRED");
        }
        const rpc = client ?? new ToncenterTransactionsClient({
            baseUrl: MAINNET_TONCENTER_URL,
            apiKeyProvider: () => env.TON_API_KEY
        });
        if (!validMainnetClient(rpc)) {
            reject("MAINNET_INCOMING_RPC_ENDPOINT_MISMATCH");
        }
        this._client = rpc;
        this._resolveActiveRoomWallet = resolveActiveRoomWallet;
        this._incoming = new ToncenterIncomingProvider({
            client: rpc,
            mapper: (response, query) => mapToncenterTransactionsResponse(
                response,
                { ...query, network: "mainnet" }
            )
        });
    }

    async observeRoom({
        roomId,
        walletAddress,
        floorMs,
        ceilingMs,
        limit = 50
    } = {}) {
        if (typeof roomId !== "string" || !roomId.trim()
            || !mainnetAccount(walletAddress)) {
            reject("MAINNET_INCOMING_ROOM_QUERY_INVALID");
        }

        // Never ask Toncenter about a wallet without an authoritative
        // reservation for this exact active room. No wallet pool scanning.
        let reservation;
        try {
            reservation = await this._resolveActiveRoomWallet(roomId);
        } catch {
            reject("MAINNET_INCOMING_RESERVATION_UNAVAILABLE");
        }
        if (reservation?.reservedByRoomId !== roomId
            || !Number.isInteger(reservation?.roomNumber)
            || reservation.roomNumber < 1 || reservation.roomNumber > 64
            || !mainnetAccount(reservation?.address)
            || !tonAddressIdentitiesEqual(reservation.address, walletAddress)) {
            reject("MAINNET_INCOMING_WALLET_NOT_ACTIVE");
        }

        // Check the real chain identity before receiving ANY transaction.
        // Do not infer the network from URL, wallet prefix or record claims.
        let chain;
        try {
            chain = await this._client.getMasterchainInfo();
        } catch {
            reject("MAINNET_INCOMING_CHAIN_IDENTITY_UNAVAILABLE");
        }
        if (chain?.last?.global_id !== MAINNET_GLOBAL_ID
            || !Number.isSafeInteger(chain?.last?.seqno)
            || chain.last.seqno < 1) {
            reject("MAINNET_INCOMING_CHAIN_IDENTITY_INVALID");
        }

        try {
            return await this._incoming.listIncomingTransactions({
                account: walletAddress,
                floorMs,
                ceilingMs,
                limit,
                priority: "foreground",
                destinationWalletId: String(reservation.roomNumber)
            });
        } catch {
            reject("MAINNET_INCOMING_TRANSACTION_READ_FAILED");
        }
    }
}
