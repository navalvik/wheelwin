/**
 * Administrator-only quarantine and residual-funds inspection.
 * Scoped to the active native TON Testnet runtime. No bulk wallet polling.
 * Financial obligations are NEVER cancelled or marked paid by a sweep.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Address } from "@ton/core";
import { countUnsettledRoomFinancialObligations } from "../payment/runtime/countUnsettledRoomFinancialObligations.js";

function requiredRoomNumber(value) {
    const valueText = String(value ?? "");
    if (!/^(?:[1-9]|[1-5][0-9]|6[0-4])$/.test(valueText))
        throw new Error("WALLET_NUMBER_MUST_BE_1_TO_64");
    return Number(valueText);
}

function publicAddress(value) {
    return Address.parse(String(value ?? "").trim()).toRawString();
}

export class WalletQuarantineAdminService {
    constructor({getRuntime, getAdapter = () => null, env = process.env,
        fetchImpl = globalThis.fetch, logger = null} = {}) {
        this.getRuntime = getRuntime;
        this.getAdapter = getAdapter;
        this.env = env;
        this.fetchImpl = fetchImpl;
        this.logger = logger;
        this.busy = new Set();
    }

    runtime() {
        const runtime = this.getRuntime?.();
        if (!runtime?.initialized || runtime.network !== "testnet"
            || runtime.globalId !== -3 || !runtime.walletPool)
            throw new Error("TESTNET_PAYMENT_RUNTIME_UNAVAILABLE");
        return runtime;
    }

    wallet(runtime, roomNumber) {
        const number = requiredRoomNumber(roomNumber);
        const wallet = runtime.walletPool.getWalletByRoomNumber(number);
        if (!wallet || wallet.network !== "testnet")
            throw new Error("TESTNET_WALLET_NOT_FOUND");
        return wallet;
    }

    residuesAddress() {
        const address = String(this.env.TON_RESIDUES_EXPECTED_ADDRESS ?? "").trim();
        return address ? publicAddress(address) : null;
    }

    async chainBalance(address) {
        const url = new URL("https://testnet.toncenter.com/api/v2/getAddressInformation");
        url.searchParams.set("address", publicAddress(address));
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
            const key = this.env.TONCENTER_TESTNET_API_KEY || this.env.TON_API_KEY;
            const headers = {Accept:"application/json"};
            if (key) headers["X-API-Key"] = key;
            const response = await this.fetchImpl(url, {headers,signal:controller.signal});
            const data = await response.json();
            if (!response.ok || data?.ok === false || !data?.result
                || !/^[0-9]+$/.test(String(data.result.balance)))
                throw new Error("TESTNET_BALANCE_PROVIDER_UNAVAILABLE");
            return {
                balanceNano:String(data.result.balance),
                accountState:String(data.result.state ?? "unknown"),
                updatedAt:new Date().toISOString()
            };
        } catch {
            throw new Error("TESTNET_BALANCE_PROVIDER_UNAVAILABLE");
        } finally {
            clearTimeout(timeout);
        }
    }

    outstanding(runtime, wallet) {
        // Reconstruct every historical room known to have used this wallet,
        // including closed rooms. A settled incoming intent alone is NOT proof
        // that the prize or refund was paid.
        const intents = runtime.intentStore.list().filter(intent => {
            if (intent.destinationWalletId === wallet.walletId) return true;
            try {
                return intent.destinationWalletAddress
                    && publicAddress(intent.destinationWalletAddress) === publicAddress(wallet.address);
            } catch { return false; }
        });
        const rooms = new Set(intents.map(intent => intent.roomId).filter(Boolean));
        if (wallet.reservedByRoomId) rooms.add(wallet.reservedByRoomId);
        let open = 0;
        for (const roomId of rooms) {
            open += countUnsettledRoomFinancialObligations({
                roomId, ledger:runtime.ledger, refundStore:runtime.refundStore,
                receiptStore:runtime.receiptStore
            });
            // Missing or unverified incoming receipts block administrative moves.
            open += intents.filter(i => i.roomId === roomId
                && ["PENDING","MATCHED"].includes(i.state)).length;
        }
        // A refund debt with no matching wallet intent is a broken accounting
        // linkage; fail closed instead of treating it as safely paid.
        if (runtime.refundStore.list().some(debt =>
            rooms.has(debt.roomId) && debt.state !== "COMPLETE")) open += 1;
        return {open, knownRooms:rooms.size};
    }

    sweepClaimPath(runtime, roomNumber) {
        return join(runtime.networkDataDir,"outbound-sequences","admin-sweeps",
            String(roomNumber) + ".json");
    }

    async status(roomNumber = null) {
        const runtime = this.runtime();
        const pool = runtime.walletPool;
        const selected = roomNumber == null || roomNumber === "" ? null
            : this.wallet(runtime, roomNumber);
        const residues = this.residuesAddress();
        const [walletResult, residuesResult] = await Promise.allSettled([
            selected ? this.chainBalance(selected.address) : Promise.resolve(null),
            residues ? this.chainBalance(residues) : Promise.resolve(null)
        ]);
        const walletChain = walletResult.status === "fulfilled" ? walletResult.value
            : {balanceNano:null, error:"TESTNET_BALANCE_PROVIDER_UNAVAILABLE"};
        const residuesChain = residuesResult.status === "fulfilled" ? residuesResult.value
            : {balanceNano:null, error:"TESTNET_BALANCE_PROVIDER_UNAVAILABLE"};
        return {
            network:"testnet", updatedAt:new Date().toISOString(),
            quarantined:pool.listQuarantinedWallets(),
            selected:selected ? {
                roomNumber:selected.roomNumber, walletId:selected.walletId,
                address:selected.address, reservedByRoomId:selected.reservedByRoomId,
                quarantined:pool.isQuarantined(selected.roomNumber),
                outstanding:this.outstanding(runtime,selected),
                sweepClaimExists:existsSync(this.sweepClaimPath(runtime,selected.roomNumber)),
                ...walletChain
            } : null,
            residues:residues ? {address:residues,...residuesChain} : null,
            sweepEnabled:this.env.ADMIN_WALLET_SWEEP_ENABLED === "true"
                && this.env.TON_NETWORK === "testnet"
        };
    }

    async release({roomNumber, confirmation}) {
        const runtime = this.runtime();
        const wallet = this.wallet(runtime, roomNumber);
        const number = wallet.roomNumber;
        if (confirmation !== `RELEASE ${number}`) throw new Error("RELEASE_CONFIRMATION_REQUIRED");
        if (this.busy.has(number)) throw new Error("WALLET_ADMIN_OPERATION_IN_PROGRESS");
        this.busy.add(number);
        try {
            if (wallet.reservedByRoomId || this.outstanding(runtime,wallet).open > 0)
                throw new Error("WALLET_HAS_OPEN_FINANCIAL_OBLIGATIONS");
            // A prior sweep claim can remain forever for audit. Administrator
            // release is safe after independent zero-balance/ledger checks.
            const state = await this.chainBalance(wallet.address);
            if (BigInt(state.balanceNano) !== 0n) throw new Error("WALLET_BALANCE_NOT_EMPTY");
            // Recheck reservations after external I/O, while quarantine still
            // prevents a concurrent room assignment.
            if (runtime.walletPool.getWalletByRoomNumber(number).reservedByRoomId
                || this.outstanding(runtime,wallet).open > 0)
                throw new Error("WALLET_HAS_OPEN_FINANCIAL_OBLIGATIONS");
            const result = runtime.walletPool.manuallyReleaseQuarantine({
                roomNumber:number, verifiedSafe:true
            });
            this.logger?.warn?.(`ADMIN_QUARANTINE_RELEASE wallet=${number}`);
            return result;
        } finally {
            this.busy.delete(number);
        }
    }

    async sweep({roomNumber, confirmation}) {
        const runtime = this.runtime();
        const wallet = this.wallet(runtime, roomNumber);
        const number = wallet.roomNumber;
        if (confirmation !== `SWEEP ${number} TO TON_RESIDUES`)
            throw new Error("SWEEP_CONFIRMATION_REQUIRED");
        if (this.env.ADMIN_WALLET_SWEEP_ENABLED !== "true"
            || this.env.TON_NETWORK !== "testnet")
            throw new Error("ADMIN_TESTNET_SWEEP_DISABLED");
        const destination = this.residuesAddress();
        if (!destination) throw new Error("TON_RESIDUES_ADDRESS_NOT_CONFIGURED");
        if (publicAddress(wallet.address) === destination)
            throw new Error("SWEEP_SELF_TRANSFER_FORBIDDEN");
        if (this.busy.has(number)) throw new Error("WALLET_ADMIN_OPERATION_IN_PROGRESS");
        this.busy.add(number);
        try {
            if (wallet.reservedByRoomId || this.outstanding(runtime,wallet).open > 0)
                throw new Error("WALLET_HAS_OPEN_FINANCIAL_OBLIGATIONS");
            if (existsSync(this.sweepClaimPath(runtime,number)))
                throw new Error("SWEEP_PREVIOUS_ATTEMPT_REQUIRES_RECONCILIATION");
            // Synchronous durable quarantine BEFORE the first awaited RPC.
            // A newly created room can no longer take this wallet.
            runtime.walletPool.manuallyQuarantine(number);
            const state = await this.chainBalance(wallet.address);
            if (BigInt(state.balanceNano) <= 0n)
                throw new Error("SWEEP_BALANCE_EMPTY");
            if (this.outstanding(runtime,wallet).open > 0)
                throw new Error("WALLET_HAS_OPEN_FINANCIAL_OBLIGATIONS");
            const adapter = this.getAdapter();
            if (!adapter?.sendAllBalance) throw new Error("TESTNET_SWEEP_SIGNER_UNAVAILABLE");
            const result = await adapter.sendAllBalance({
                roomNumber:number,destination
            });
            this.logger?.warn?.(`ADMIN_RESIDUE_SWEEP wallet=${number} code=${result.code}`);
            return result;
        } finally {
            // Quarantine is intentionally NOT removed after submission.
            this.busy.delete(number);
        }
    }
}
