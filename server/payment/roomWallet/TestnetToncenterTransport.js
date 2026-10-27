/**
 * Minimal TON Testnet transport for the restored native room-wallet adapter.
 *
 * The old settlement code expects balance, seqno, fee estimate, broadcast and
 * Toncenter v2-shaped transaction history. @ton/ton provides the first four;
 * the last is read as v2 JSON (not TonClient's incompatible parsed Dictionary).
 *
 * No polling, background workers, secret-key access, or automatic transfers.
 * Broadcast is denied by default and must be explicitly enabled by a trusted
 * server caller. This module does not itself authorize any payment.
 */
import { Address, Cell } from "@ton/core";
import { TonClient } from "@ton/ton";

const TESTNET_RPC = "https://testnet.toncenter.com/api/v2/jsonRPC";
const TESTNET_API = "https://testnet.toncenter.com/api/v2";

function requireAddress(value) {
    const address = Address.parse(String(value ?? "").trim());
    if (address.workChain !== 0) {
        throw new Error("room-wallet transport requires workchain 0");
    }
    return address;
}

function nano(value, label) {
    if (typeof value !== "bigint" &&
        !(typeof value === "number" && Number.isSafeInteger(value)) &&
        !(typeof value === "string" && /^\d+$/.test(value))) {
        throw new Error(`invalid Testnet fee component: ${label}`);
    }
    const result = BigInt(value);
    if (result < 0n) throw new Error(`negative Testnet fee component: ${label}`);
    return result;
}

export class TestnetToncenterTransport {
    constructor({
        network = "testnet",
        client = null,
        fetchImpl = globalThis.fetch,
        apiKey = process.env.TON_API_KEY ?? null,
        enableBroadcast = false
    } = {}) {
        if (network !== "testnet") {
            throw new Error("room-wallet transport is Testnet only");
        }
        if (typeof fetchImpl !== "function") {
            throw new Error("Testnet transaction history requires fetch");
        }
        this._client = client ?? new TonClient({
            endpoint: TESTNET_RPC,
            ...(apiKey ? { apiKey } : {})
        });
        this._fetch = fetchImpl;
        this._apiKey = apiKey;
        this._broadcastEnabled = enableBroadcast === true;
    }

    async getBalance(address) {
        return nano(await this._client.getBalance(requireAddress(address)), "balance");
    }

    async getSeqno(address) {
        const account = requireAddress(address);
        const state = await this._client.getContractState(account);
        if (state?.state === "uninitialized") {
            // This is positive chain evidence that WalletV4 must deploy at seqno 0.
            return 0;
        }
        if (state?.state !== "active") {
            throw new Error("room wallet is not active or uninitialized");
        }
        const result = await this._client.runMethod(account, "seqno");
        const seqno = result?.stack?.readNumber?.();
        if (!Number.isSafeInteger(seqno) || seqno < 0) {
            throw new Error("invalid Testnet wallet seqno");
        }
        return seqno;
    }

    async estimateExternalMessageFee(address, { body, initCode = null, initData = null, ignoreSignature = true } = {}) {
        if (!(body instanceof Cell)) {
            throw new Error("fee estimation requires a TON Cell body");
        }
        const result = await this._client.estimateExternalMessageFee(requireAddress(address), {
            body, initCode, initData, ignoreSignature
        });
        const fees = result?.source_fees;
        if (!fees) throw new Error("Toncenter fee response lacks source fees");
        const inFwdFeeNano = nano(fees.in_fwd_fee, "in_fwd_fee");
        const storageFeeNano = nano(fees.storage_fee, "storage_fee");
        const gasFeeNano = nano(fees.gas_fee, "gas_fee");
        const fwdFeeNano = nano(fees.fwd_fee, "fwd_fee");
        return Object.freeze({
            inFwdFeeNano, storageFeeNano, gasFeeNano, fwdFeeNano,
            totalFeeNano: inFwdFeeNano + storageFeeNano + gasFeeNano + fwdFeeNano
        });
    }

    async getTransactions(address, { limit = 40, archival = true } = {}) {
        const account = requireAddress(address);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
            throw new Error("invalid transaction history limit");
        }
        const params = new URLSearchParams({
            address: account.toRawString(),
            limit: String(limit),
            archival: archival === true ? "true" : "false"
        });
        const response = await this._fetch(`${TESTNET_API}/getTransactions?${params}`, {
            headers: this._apiKey ? { "X-API-Key": this._apiKey } : {}
        });
        if (!response?.ok) {
            throw new Error("Toncenter Testnet transaction history unavailable");
        }
        const body = await response.json();
        if (body?.ok !== true || !Array.isArray(body.result)) {
            throw new Error("Toncenter Testnet transaction history is invalid");
        }
        // Preserve v2 transaction_id, in_msg and out_msgs, which the existing
        // payout/refund reconciliation helpers parse directly.
        return body.result;
    }

    async broadcastTransaction(bocBase64) {
        if (!this._broadcastEnabled) {
            throw new Error("Testnet room-wallet broadcast is disabled");
        }
        if (typeof bocBase64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(bocBase64)) {
            throw new Error("invalid external message BOC");
        }
        const bytes = Buffer.from(bocBase64, "base64");
        if (bytes.toString("base64") !== bocBase64 || Cell.fromBoc(bytes).length !== 1) {
            throw new Error("invalid external message BOC");
        }
        await this._client.sendFile(bytes);
        // Toncenter sendFile acknowledges submission only, not chain finality.
        // The caller must inspect history and verify before marking paid.
        return Object.freeze({ status: "BROADCAST_ACCEPTED_NO_TX_HASH" });
    }
}
