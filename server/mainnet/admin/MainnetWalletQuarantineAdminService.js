import { existsSync } from "node:fs";
import { join } from "node:path";
import { Address } from "@ton/core";
import { MAINNET_GLOBAL_ID } from "../config/MainnetRuntimeConfig.js";
import { mainnetAddressIdentity } from "../payment/MainnetAddress.js";

const WALLET_NUMBER_PATTERN = /^(?:[1-9]|[1-5][0-9]|6[0-4])$/;

function requiredRoomNumber(value) {
    const text = String(value ?? "");
    if (!WALLET_NUMBER_PATTERN.test(text)) throw new Error("WALLET_NUMBER_MUST_BE_1_TO_64");
    return Number(text);
}

function rawMainnetAddress(value) {
    mainnetAddressIdentity(value);
    return Address.parse(String(value).trim()).toRawString();
}

function matchingAddress(left, right) {
    try { return mainnetAddressIdentity(left) === mainnetAddressIdentity(right); }
    catch { return false; }
}

/** Mainnet-only administrator inspection and manual wallet quarantine/sweep. */
export class MainnetWalletQuarantineAdminService {
    constructor({ getRuntime, getWalletPool, getRoomManager = () => null,
        getAdapter = runtime => runtime?.outgoingAdapter, isInitialized = () => false,
        env = process.env, logger = null } = {}) {
        this.getRuntime = getRuntime;
        this.getWalletPool = getWalletPool;
        this.getRoomManager = getRoomManager;
        this.getAdapter = getAdapter;
        this.isInitialized = isInitialized;
        this.env = env;
        this.logger = logger;
        this.busy = new Set();
    }

    runtime() {
        const runtime = this.getRuntime?.();
        if (this.env.TON_NETWORK !== "mainnet" || this.isInitialized?.() !== true
            || runtime?.network !== "mainnet"
            || runtime?.globalId !== MAINNET_GLOBAL_ID
            || runtime?.financialLedger?.network !== "mainnet"
            || runtime?.financialLedger?.globalId !== MAINNET_GLOBAL_ID
            || runtime?.incomingLedger?.network !== "mainnet"
            || runtime?.incomingLedger?.globalId !== MAINNET_GLOBAL_ID
            || runtime?.client?.network !== "mainnet"
            || runtime?.client?.globalId !== MAINNET_GLOBAL_ID) {
            throw new Error("MAINNET_PAYMENT_RUNTIME_UNAVAILABLE");
        }
        const pool = this.getWalletPool?.();
        if (pool?.network !== "mainnet" || typeof pool.getWalletByRoomNumber !== "function"
            || typeof pool.listWallets !== "function"
            || typeof pool.listQuarantinedWallets !== "function"
            || typeof pool.manuallyQuarantine !== "function"
            || typeof pool.manuallyReleaseQuarantine !== "function"
            || typeof pool.listReservationHistoryForWallet !== "function") {
            throw new Error("MAINNET_WALLET_POOL_UNAVAILABLE");
        }
        return { runtime, pool };
    }

    wallet(pool, roomNumber) {
        const number = requiredRoomNumber(roomNumber);
        const wallet = pool.getWalletByRoomNumber(number);
        if (!wallet || wallet.network !== "mainnet") throw new Error("MAINNET_WALLET_NOT_FOUND");
        mainnetAddressIdentity(wallet.address);
        return wallet;
    }

    residuesAddress() {
        const configured = String(this.env.MAINNET_TON_RESIDUES_EXPECTED_ADDRESS ?? "").trim();
        if (!configured) return null;
        try { return rawMainnetAddress(configured); }
        catch { throw new Error("MAINNET_TON_RESIDUES_ADDRESS_INVALID"); }
    }

    async chainBalance(runtime, address) {
        try {
            const response = await runtime.client.getAddressInformation(rawMainnetAddress(address));
            const balance = response?.result?.balance;
            if (response?.ok === false || !/^[0-9]+$/.test(String(balance))) {
                throw new Error("response");
            }
            return Object.freeze({ balanceNano: String(balance),
                accountState: String(response.result.state ?? "unknown"),
                updatedAt: new Date().toISOString() });
        } catch {
            throw new Error("MAINNET_BALANCE_PROVIDER_UNAVAILABLE");
        }
    }

    /** Count every known room interval for this wallet; uncertain accounting holds it. */
    outstanding(runtime, pool, wallet) {
        const incoming = runtime.incomingLedger;
        const financial = runtime.financialLedger;
        const intents = incoming.listAllIntents().filter(item =>
            item.destinationWalletId === wallet.walletId
            || matchingAddress(item.destinationWalletAddress, wallet.address));
        const walletHistory = pool.listReservationHistoryForWallet(wallet.walletId);
        const rooms = new Set([
            ...intents.map(item => item.roomId),
            ...walletHistory.map(item => item.roomId)
        ].filter(Boolean));
        if (wallet.reservedByRoomId) rooms.add(wallet.reservedByRoomId);

        let open = 0;
        for (const roomId of rooms) {
            if (wallet.reservedByRoomId === roomId || this.getRoomManager?.()?.getRoom?.(roomId)) open += 1;
            open += financial.countWalletBlockingObligations(roomId);

            const roomIntents = intents.filter(item => item.roomId === roomId);
            const receipts = incoming.listReceipts(roomId).filter(receipt =>
                matchingAddress(receipt.destinationAddress, wallet.address));
            const observations = incoming.listObservations(roomId).filter(observation =>
                matchingAddress(observation.destinationAddress, wallet.address));

            // Unsettled requests may still receive a late on-chain payment.
            open += roomIntents.filter(item => item.state === "PENDING").length;

            const receiptTransactions = new Set(receipts.map(item => item.transactionId));
            open += observations.filter(item => !receiptTransactions.has(item.transactionId)).length;
            for (const receipt of receipts) {
                if (["UNRESOLVED", "AMBIGUOUS", "PENDING_FINALITY"].includes(receipt.status)) {
                    open += 1;
                    continue;
                }
                const intent = roomIntents.find(item => item.paymentReference === receipt.paymentReference);
                const refundComplete = financial.listRefunds(roomId).some(item =>
                    item.state === "COMPLETE" && item.incomingTransactionId === receipt.transactionId);
                const outcome = financial.getOutcome(roomId);
                const payout = financial.listPayouts().find(item => item.roomId === roomId
                    && matchingAddress(item.sourceWalletAddress, wallet.address));
                const payoutComplete = outcome?.kind === "PAYOUT" && payout
                    && payout.winner.state === "CONFIRMED"
                    && ["CONFIRMED", "UNPAID_INSUFFICIENT_GAS"].includes(payout.owner.state);
                const principalCoveredByPayout = receipt.status === "CONFIRMED"
                    && intent?.state === "SETTLED"
                    && intent.confirmedTransactionId === receipt.transactionId
                    && payoutComplete;
                const coveredByRefund = refundComplete && (receipt.status === "CONFIRMED"
                    || receipt.status === "EXTRA_PAYMENT");
                if (!principalCoveredByPayout && !coveredByRefund) open += 1;
            }
        }
        return Object.freeze({ open, knownRooms: rooms.size });
    }

    sweepClaimPath(runtime, roomNumber) {
        return join(runtime.stateDirectories.outgoing, "admin-sweeps", `${roomNumber}.json`);
    }

    async status(roomNumber = null) {
        const { runtime, pool } = this.runtime();
        const selected = roomNumber == null || roomNumber === "" ? null : this.wallet(pool, roomNumber);
        const residues = this.residuesAddress();
        const quarantineList = pool.listQuarantinedWallets();
        const selectedHold = selected ? quarantineList.find(item => item.roomNumber === selected.roomNumber) : null;
        const catalog = pool.listWallets()
            .filter(wallet => wallet.network === "mainnet")
            .sort((left, right) => left.roomNumber - right.roomNumber);
        if (catalog.length !== 64 || catalog.some((wallet, index) => wallet.roomNumber !== index + 1)) {
            throw new Error("MAINNET_WALLET_CATALOG_INCOMPLETE");
        }
        const holdsByNumber = new Map(quarantineList.map(item => [item.roomNumber, item]));
        const result = await Promise.allSettled([
            selected ? this.chainBalance(runtime, selected.address) : Promise.resolve(null),
            residues ? this.chainBalance(runtime, residues) : Promise.resolve(null)
        ]);
        const walletChain = result[0].status === "fulfilled" ? result[0].value
            : { balanceNano: null, error: "MAINNET_BALANCE_PROVIDER_UNAVAILABLE" };
        const residueChain = residues
            ? result[1].status === "fulfilled" ? result[1].value
                : { balanceNano: null, error: "MAINNET_BALANCE_PROVIDER_UNAVAILABLE" }
            : { balanceNano: null, error: "MAINNET_TON_RESIDUES_ADDRESS_NOT_CONFIGURED" };
        return Object.freeze({ network: "mainnet", updatedAt: new Date().toISOString(),
            wallets: Object.freeze(catalog.map(wallet => {
                const hold = holdsByNumber.get(wallet.roomNumber);
                return Object.freeze({
                    roomNumber: wallet.roomNumber,
                    walletId: wallet.walletId,
                    address: wallet.address,
                    reservedByRoomId: wallet.reservedByRoomId,
                    quarantined: Boolean(hold),
                    quarantineReason: hold?.reason ?? null
                });
            })),
            quarantined: quarantineList,
            selected: selected ? Object.freeze({
                roomNumber: selected.roomNumber, walletId: selected.walletId, address: selected.address,
                reservedByRoomId: selected.reservedByRoomId,
                quarantined: pool.isQuarantined(selected.roomNumber),
                quarantineReason: selectedHold?.reason ?? null,
                quarantineNote: selectedHold?.quarantineNote ?? null,
                quarantinedAt: selectedHold?.quarantinedAt ?? null,
                quarantinedBy: selectedHold?.quarantinedBy ?? null,
                outstanding: this.outstanding(runtime, pool, selected),
                sweepClaimExists: existsSync(this.sweepClaimPath(runtime, selected.roomNumber)),
                ...walletChain
            }) : null,
            residues: Object.freeze({ address: residues, ...residueChain }),
            sweepEnabled: this.env.TON_NETWORK === "mainnet"
                && this.env.MAINNET_ADMIN_WALLET_SWEEP_ENABLED === "true"
                && runtime.liveOperationsEnabled === true && Boolean(residues)
        });
    }

    quarantine({ roomNumber, confirmation, note = "", actor = "Administrator" }) {
        const { pool } = this.runtime();
        const wallet = this.wallet(pool, roomNumber);
        const number = wallet.roomNumber;
        if (confirmation !== `QUARANTINE ${number}`) throw new Error("QUARANTINE_CONFIRMATION_REQUIRED");
        if (this.busy.has(number)) throw new Error("WALLET_ADMIN_OPERATION_IN_PROGRESS");
        if (typeof note !== "string" || note.length > 200) throw new Error("QUARANTINE_NOTE_TOO_LONG");
        this.busy.add(number);
        try {
            const result = pool.manuallyQuarantine(number, { note, actor });
            this.logger?.warn?.(`ADMIN_MAINNET_MANUAL_QUARANTINE wallet=${number}`
                + ` reservedRoom=${result.reservedByRoomId ?? "none"}`
                + ` actor=${String(actor).slice(0, 80)}`);
            return result;
        } finally { this.busy.delete(number); }
    }

    async release({ roomNumber, confirmation }) {
        const { runtime, pool } = this.runtime();
        const wallet = this.wallet(pool, roomNumber);
        const number = wallet.roomNumber;
        if (confirmation !== `RELEASE ${number}`) throw new Error("RELEASE_CONFIRMATION_REQUIRED");
        if (this.busy.has(number)) throw new Error("WALLET_ADMIN_OPERATION_IN_PROGRESS");
        this.busy.add(number);
        try {
            if (wallet.reservedByRoomId || this.outstanding(runtime, pool, wallet).open > 0) {
                throw new Error("WALLET_HAS_OPEN_FINANCIAL_OBLIGATIONS");
            }
            const state = await this.chainBalance(runtime, wallet.address);
            if (BigInt(state.balanceNano) !== 0n) throw new Error("WALLET_BALANCE_NOT_EMPTY");
            const current = pool.getWalletByRoomNumber(number);
            if (!current || current.reservedByRoomId || this.outstanding(runtime, pool, current).open > 0) {
                throw new Error("WALLET_HAS_OPEN_FINANCIAL_OBLIGATIONS");
            }
            return pool.manuallyReleaseQuarantine({ roomNumber: number, verifiedSafe: true });
        } finally { this.busy.delete(number); }
    }

    async sweep({ roomNumber, confirmation }) {
        const { runtime, pool } = this.runtime();
        const wallet = this.wallet(pool, roomNumber);
        const number = wallet.roomNumber;
        if (confirmation !== `SWEEP ${number} TO TON_RESIDUES`) throw new Error("SWEEP_CONFIRMATION_REQUIRED");
        if (this.env.TON_NETWORK !== "mainnet"
            || this.env.MAINNET_ADMIN_WALLET_SWEEP_ENABLED !== "true"
            || runtime.liveOperationsEnabled !== true) throw new Error("MAINNET_ADMIN_SWEEP_DISABLED");
        const destination = this.residuesAddress();
        if (!destination) throw new Error("MAINNET_TON_RESIDUES_ADDRESS_NOT_CONFIGURED");
        if (matchingAddress(wallet.address, destination)) throw new Error("SWEEP_SELF_TRANSFER_FORBIDDEN");
        if (this.busy.has(number)) throw new Error("WALLET_ADMIN_OPERATION_IN_PROGRESS");
        this.busy.add(number);
        try {
            if (wallet.reservedByRoomId || this.outstanding(runtime, pool, wallet).open > 0) {
                throw new Error("WALLET_HAS_OPEN_FINANCIAL_OBLIGATIONS");
            }
            if (existsSync(this.sweepClaimPath(runtime, number))) {
                throw new Error("SWEEP_PREVIOUS_ATTEMPT_REQUIRES_RECONCILIATION");
            }
            const adapter = this.getAdapter?.(runtime);
            if (adapter !== runtime.outgoingAdapter
                || typeof adapter?.sendAllBalance !== "function"
                || typeof adapter?.getWalletAddress !== "function") {
                throw new Error("MAINNET_SWEEP_SIGNER_UNAVAILABLE");
            }
            if (!matchingAddress(await adapter.getWalletAddress(number), wallet.address)) {
                throw new Error("SWEEP_SIGNER_CATALOG_ADDRESS_MISMATCH");
            }
            const current = pool.getWalletByRoomNumber(number);
            if (!current || current.reservedByRoomId || this.outstanding(runtime, pool, current).open > 0) {
                throw new Error("WALLET_HAS_OPEN_FINANCIAL_OBLIGATIONS");
            }
            pool.manuallyQuarantine(number);
            const state = await this.chainBalance(runtime, wallet.address);
            if (BigInt(state.balanceNano) <= 0n) throw new Error("SWEEP_BALANCE_EMPTY");
            if (this.outstanding(runtime, pool, pool.getWalletByRoomNumber(number)).open > 0) {
                throw new Error("WALLET_HAS_OPEN_FINANCIAL_OBLIGATIONS");
            }
            const result = await adapter.sendAllBalance({ roomNumber: number, destination });
            this.logger?.warn?.(`ADMIN_MAINNET_RESIDUE_SWEEP wallet=${number} code=${result?.code ?? "UNKNOWN"}`);
            return result;
        } finally { this.busy.delete(number); }
    }
}
