/**
 * WheelWin Mainnet phase 3: on-demand indexed receipt finality INSPECTION.
 *
 * The same Mainnet Toncenter client must first verify global ID -239,
 * retrieve transactions for one server-reserved active wallet, and then
 * re-check the Mainnet masterchain head. A transaction gets a positive
 * read-only status only when its indexed masterchain watermark and actual
 * shard-block reference are present, non-emulated and sufficiently deep.
 *
 * This is provider-reported finality, NOT independently authenticated TON
 * block proof or a payment settlement capability. Nothing in this module
 * matches player intents, moves money, writes ledgers, or opens Page5.
 */
import { ToncenterTransactionsClient } from "../payment/toncenter/ToncenterTransactionsClient.js";
import { tonAddressIdentitiesEqual, parseTonAddress } from "../payment/incoming/TonAddressIdentity.js";
import { MAINNET_GLOBAL_ID, MAINNET_TONCENTER_URL } from "./MainnetReadOnlyPreflight.js";
import { MainnetRoomIncomingObserver } from "./MainnetRoomIncomingObserver.js";

export const MAINNET_INDEXED_RECEIPT_STATUS = Object.freeze({
    INDEXED_DEPTH_OK: "INDEXED_MASTERCHAIN_DEPTH_OK",
    NOT_INDEXED: "NOT_INDEXED",
    DEPTH_PENDING: "MASTERCHAIN_DEPTH_PENDING",
    INVALID_ACCOUNT: "ACCOUNT_MISMATCH",
    INVALID_TRANSACTION: "INVALID_TRANSACTION",
    DUPLICATE_TRANSACTION: "DUPLICATE_TRANSACTION",
    WINDOW_INCOMPLETE: "WINDOW_INCOMPLETE"
});

function fail(code) { throw new Error(code); }

function canonical(address) {
    try {
        const parsed = parseTonAddress(address);
        return parsed.workchain === 0 && parsed.testOnly !== true
            ? parsed.identity
            : null;
    } catch {
        return null;
    }
}

function validBlock(block) {
    return block !== null && typeof block === "object"
        && !Array.isArray(block)
        && block.workchain === 0
        && typeof block.shard === "string"
        && /^[0-9a-fA-F]{16}$/.test(block.shard)
        && Number.isSafeInteger(block.seqno) && block.seqno > 0;
}

function readonlyResult({ roomId, observation, chainHead, minimumMasterchainDepth }) {
    const expected = canonical(observation.walletAddress);
    const records = observation.response.records;
    const seen = new Set();
    const duplicated = new Set();
    for (const record of records) {
        if (typeof record?.transactionId === "string") {
            if (seen.has(record.transactionId)) duplicated.add(record.transactionId);
            seen.add(record.transactionId);
        }
    }

    const receipts = records.map(record => {
        const hash = record?.transactionId;
        const indexed = record?.indexedTransaction;
        let status = MAINNET_INDEXED_RECEIPT_STATUS.INVALID_TRANSACTION;

        if (!observation.response.resultWindowComplete) {
            status = MAINNET_INDEXED_RECEIPT_STATUS.WINDOW_INCOMPLETE;
        } else if (typeof hash !== "string" || !hash.trim()
            || duplicated.has(hash)
            || record?.network !== "mainnet"
            || record?.direction !== "incoming"
            || record?.asset !== "TON"
            || typeof record?.amountAtomic !== "string"
            || !/^[0-9]+$/.test(record.amountAtomic)
            || BigInt(record.amountAtomic) <= 0n) {
            status = duplicated.has(hash)
                ? MAINNET_INDEXED_RECEIPT_STATUS.DUPLICATE_TRANSACTION
                : MAINNET_INDEXED_RECEIPT_STATUS.INVALID_TRANSACTION;
        } else if (!expected
            || canonical(record.accountId) !== expected
            || canonical(record.destinationAddress) !== expected
            || canonical(record.sourceAddress) === null) {
            status = MAINNET_INDEXED_RECEIPT_STATUS.INVALID_ACCOUNT;
        } else if (!indexed
            || indexed.emulated !== false
            || indexed.transactionId !== hash
            || canonical(indexed.accountId) !== expected
            || !validBlock(indexed.block)
            || !Number.isSafeInteger(indexed.mcBlockSeqno)
            || indexed.mcBlockSeqno <= 0) {
            status = MAINNET_INDEXED_RECEIPT_STATUS.NOT_INDEXED;
        } else if (chainHead < indexed.mcBlockSeqno + minimumMasterchainDepth) {
            status = MAINNET_INDEXED_RECEIPT_STATUS.DEPTH_PENDING;
        } else {
            status = MAINNET_INDEXED_RECEIPT_STATUS.INDEXED_DEPTH_OK;
        }

        // The network, hash and indexed coordinates are public transaction
        // metadata. No wallet keys, API tokens or private configuration.
        return Object.freeze({
            transactionId: typeof hash === "string" ? hash : null,
            status,
            network: "mainnet",
            accountId: expected,
            sourceAddress: status === MAINNET_INDEXED_RECEIPT_STATUS.INDEXED_DEPTH_OK
                ? canonical(record.sourceAddress) : null,
            amountAtomic: status === MAINNET_INDEXED_RECEIPT_STATUS.INDEXED_DEPTH_OK
                ? record.amountAtomic : null,
            paymentReference: status === MAINNET_INDEXED_RECEIPT_STATUS.INDEXED_DEPTH_OK
                ? (record.comment ?? null) : null,
            masterchainInclusionSeqno: status === MAINNET_INDEXED_RECEIPT_STATUS.INDEXED_DEPTH_OK
                ? indexed.mcBlockSeqno : null,
            providerReportedFinality: status === MAINNET_INDEXED_RECEIPT_STATUS.INDEXED_DEPTH_OK,
            // Deliberately never grant a finance capability.
            settlementAuthorized: false,
            gameStartAuthorized: false
        });
    });

    return Object.freeze({
        roomId,
        network: "mainnet",
        globalId: MAINNET_GLOBAL_ID,
        provider: "toncenter-mainnet-indexed-v3",
        masterchainHeadSeqno: chainHead,
        minimumMasterchainDepth,
        resultWindowComplete: observation.response.resultWindowComplete === true,
        receipts: Object.freeze(receipts),
        readOnly: true,
        settlementAuthorized: false,
        gameStartAuthorized: false
    });
}

export class MainnetIndexedReceiptFinalityInspector {
    constructor({
        env = process.env,
        client = null,
        resolveActiveRoomWallet,
        minimumMasterchainDepth = 1
    } = {}) {
        if (!Number.isSafeInteger(minimumMasterchainDepth)
            || minimumMasterchainDepth < 1 || minimumMasterchainDepth > 100) {
            fail("MAINNET_FINALITY_DEPTH_INVALID");
        }
        const rpc = client ?? new ToncenterTransactionsClient({
            baseUrl: MAINNET_TONCENTER_URL,
            apiKeyProvider: () => env.TON_API_KEY
        });
        // Observer enforces exact Mainnet URL, TON_NETWORK, disabled live
        // payments and one active server-owned room reservation.
        this._observer = new MainnetRoomIncomingObserver({
            env, client: rpc, resolveActiveRoomWallet
        });
        this._client = rpc;
        this._resolveActiveRoomWallet = resolveActiveRoomWallet;
        this._depth = minimumMasterchainDepth;
    }

    async inspectRoom(options = {}) {
        // Observer performs authenticated Mainnet chain check before account
        // query. No public caller can inject arbitrary provider records.
        const response = await this._observer.observeRoom(options);
        const walletAddress = options.walletAddress;

        // Re-check network and depth after the indexed transactions request;
        // refuse to return positively marked receipts on network/API failure.
        let chain;
        try {
            chain = await this._client.getMasterchainInfo();
        } catch {
            fail("MAINNET_FINALITY_HEAD_UNAVAILABLE");
        }
        const head = chain?.last;
        if (head?.global_id !== MAINNET_GLOBAL_ID
            || !Number.isSafeInteger(head.seqno)
            || head.seqno < 1) {
            fail("MAINNET_FINALITY_CHAIN_IDENTITY_INVALID");
        }

        // A room may expire or be destroyed while Toncenter is reading.
        // Recheck the authoritative reservation before reporting any
        // positive indexed receipt. Do not permit an already-freed wallet
        // to produce evidence for an obsolete room.
        let currentReservation;
        try {
            currentReservation = await this._resolveActiveRoomWallet(options.roomId);
        } catch {
            fail("MAINNET_FINALITY_RESERVATION_UNAVAILABLE");
        }
        if (currentReservation?.reservedByRoomId !== options.roomId
            || !Number.isInteger(currentReservation?.roomNumber)
            || currentReservation.roomNumber < 1
            || currentReservation.roomNumber > 64
            || canonical(currentReservation.address) === null
            || canonical(currentReservation.address) !== canonical(walletAddress)) {
            fail("MAINNET_FINALITY_ROOM_NO_LONGER_ACTIVE");
        }

        return readonlyResult({
            roomId: options.roomId,
            observation: { walletAddress, response },
            chainHead: head.seqno,
            minimumMasterchainDepth: this._depth
        });
    }
}
