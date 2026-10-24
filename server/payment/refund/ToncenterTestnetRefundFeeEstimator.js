/**
 * Read-only native TON (displayed as GRAM) WalletV4R2 fee emulation.
 *
 * estimateRefundFee implements the execution-provider interface, but fails
 * closed: TON Center estimateFee cannot certify a future exact fee / upper
 * bound. inspectRefundFee exposes explicitly non-authorizing diagnostics.
 * No keys, signing, sendBoc, retries, plan writes, or environment reads here.
 */
import { Address, beginCell, Cell, contractAddress, internal, storeMessageRelaxed } from "@ton/core";
import { parseTonAddress } from "../incoming/TonAddressIdentity.js";
import {
    TONCENTER_TESTNET_BASE_URL, TONCENTER_MASTERCHAIN_INFO_PATH,
    TONCENTER_DEFAULT_TIMEOUT_MS
} from "../toncenter/ToncenterConstants.js";

const V4R2_CODE_HASH = "feb5ff6820e2ff0d9483e7e0d62c817d846789fb4ae580c878866d959dabd5c0";
const FEE_FIELDS = ["in_fwd_fee", "storage_fee", "gas_fee", "fwd_fee"];
const MAX_ATOMIC = BigInt(Number.MAX_SAFE_INTEGER);
const fail = code => { throw new Error(code); };

function atomic(value) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
    if (typeof value === "string" && /^(0|[1-9][0-9]{0,15})$/.test(value)) {
        const result = BigInt(value);
        if (result <= MAX_ATOMIC) return result;
    }
    return fail("REFUND_FEE_INVALID_ATOMIC_UNITS");
}

function account(value) {
    let parsed;
    try { parsed = parseTonAddress(value); } catch { fail("REFUND_FEE_INVALID_ADDRESS"); }
    if (parsed.workchain !== 0 || parsed.testOnly === false) fail("REFUND_FEE_ADDRESS_NETWORK_MISMATCH");
    return parsed.identity;
}

function requestIdentity(input) {
    if (input?.networkName !== "TESTNET" || input?.globalId !== -3) fail("REFUND_FEE_NETWORK_MISMATCH");
    if (typeof input.obligationId !== "string" || !input.obligationId.trim() || input.obligationId.length > 256)
        fail("REFUND_FEE_OBLIGATION_REQUIRED");
    if (typeof input.paidAmountAtomic !== "string" || atomic(input.paidAmountAtomic) <= 0n)
        fail("REFUND_FEE_INVALID_ATOMIC_UNITS");
    const sourceWalletAddress = account(input.sourceWalletAddress);
    const destinationAddress = account(input.destinationAddress);
    if (sourceWalletAddress === destinationAddress) fail("REFUND_FEE_SELF_TRANSFER");
    return Object.freeze({
        networkName: "TESTNET", globalId: -3, obligationId: input.obligationId,
        sourceWalletAddress, destinationAddress, paidAmountAtomic: input.paidAmountAtomic
    });
}

function cellFromBase64(value) {
    if (typeof value !== "string" || value.length > 65536) fail("REFUND_FEE_INVALID_WALLET_BOC");
    try {
        const bytes = Buffer.from(value, "base64");
        if (!bytes.length || bytes.toString("base64") !== value) throw new Error();
        const cells = Cell.fromBoc(bytes);
        if (cells.length !== 1 || cells[0].isExotic) throw new Error();
        return cells[0];
    } catch { fail("REFUND_FEE_INVALID_WALLET_BOC"); }
}

function walletState(result, source, now) {
    if (result?.state !== "active" || !Number.isSafeInteger(result.sync_utime) ||
        result.sync_utime > now || now - result.sync_utime > 60) fail("REFUND_FEE_WALLET_STATE_UNAVAILABLE");
    const code = cellFromBase64(result.code);
    if (code.hash().toString("hex") !== V4R2_CODE_HASH) fail("REFUND_FEE_WALLET_CODE_MISMATCH");
    const data = cellFromBase64(result.data);
    let seqno, walletId, publicKey;
    try {
        const slice = data.beginParse();
        seqno = slice.loadUint(32);
        walletId = slice.loadUint(32);
        publicKey = slice.loadBuffer(32);
        // No plugin-enabled wallets: another authority could alter the balance.
        if (slice.loadBit() || slice.remainingBits || slice.remainingRefs) throw new Error();
    } catch { fail("REFUND_FEE_WALLET_DATA_UNSUPPORTED"); }
    const initialData = beginCell().storeUint(0, 32).storeUint(walletId, 32)
        .storeBuffer(publicKey).storeBit(false).endCell();
    if (contractAddress(0, { code, data: initialData }).toRawString() !== source)
        fail("REFUND_FEE_SOURCE_WALLET_MISMATCH");
    if (seqno === 0xffffffff) fail("REFUND_FEE_SEQNO_EXHAUSTED");
    const balance = atomic(result.balance);
    const last = result.last_transaction_id;
    if (!last || typeof last.lt !== "string" || !/^[0-9]{1,20}$/.test(last.lt) ||
        typeof last.hash !== "string" || Buffer.from(last.hash, "base64").length !== 32 ||
        Buffer.from(last.hash, "base64").toString("base64") !== last.hash)
        fail("REFUND_FEE_WALLET_TRANSACTION_UNAVAILABLE");
    return { seqno, walletId, balance, fingerprint: `${data.hash().toString("hex")}:${balance}:${last.lt}:${last.hash}` };
}

function simulationBody(state, destination, amount, validUntil) {
    const message = internal({ to: Address.parseRaw(destination), value: amount, bounce: true });
    // WalletV4's simple-send opcode is EIGHT bits. The zero signature is only
    // for ignore_chksig emulation and must never enter a broadcast path.
    return beginCell().storeBuffer(Buffer.alloc(64))
        .storeUint(state.walletId, 32).storeUint(validUntil, 32).storeUint(state.seqno, 32)
        .storeUint(0, 8).storeUint(1, 8)
        .storeRef(beginCell().store(storeMessageRelaxed(message)).endCell()).endCell();
}

export class ToncenterTestnetRefundFeeEstimator {
    constructor({
        networkName = "TESTNET", globalId = -3,
        baseUrl = TONCENTER_TESTNET_BASE_URL, fetchImpl = globalThis.fetch,
        apiKeyProvider = () => "", nowSeconds = () => Math.floor(Date.now() / 1000),
        timeoutMs = TONCENTER_DEFAULT_TIMEOUT_MS
    } = {}) {
        if (networkName !== "TESTNET" || globalId !== -3 || baseUrl !== TONCENTER_TESTNET_BASE_URL)
            fail("REFUND_FEE_NETWORK_MISMATCH");
        if (typeof fetchImpl !== "function" || typeof apiKeyProvider !== "function" ||
            typeof nowSeconds !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
            fail("REFUND_FEE_CONFIGURATION_INVALID");
        this._fetch = fetchImpl;
        this._apiKey = apiKeyProvider;
        this._now = nowSeconds;
        this._timeoutMs = timeoutMs;
    }

    async _request(path, body) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this._timeoutMs);
        try {
            const key = this._apiKey();
            if (typeof key !== "string" || !key.trim()) fail("REFUND_FEE_API_KEY_REQUIRED");
            const response = await this._fetch(TONCENTER_TESTNET_BASE_URL + path, {
                method: body ? "POST" : "GET", redirect: "error", signal: controller.signal,
                headers: { "X-API-Key": key, ...(body ? { "Content-Type": "application/json" } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {})
            });
            if (response?.status !== 200) fail("REFUND_FEE_RPC_UNAVAILABLE");
            const payload = await response.json();
            if (controller.signal.aborted || !payload || typeof payload !== "object" || Array.isArray(payload))
                fail("REFUND_FEE_RPC_UNAVAILABLE");
            return payload;
        } catch {
            // Never expose transport exceptions, response text, headers or keys.
            fail("REFUND_FEE_RPC_UNAVAILABLE");
        } finally { clearTimeout(timer); }
    }

    async _network() {
        const { last } = await this._request(TONCENTER_MASTERCHAIN_INFO_PATH);
        if (last?.global_id !== -3 || !Number.isSafeInteger(last.seqno) || last.seqno < 0)
            fail("REFUND_FEE_NETWORK_UNVERIFIED");
        return last.seqno;
    }

    async _wallet(source, now) {
        const response = await this._request("/api/v2/getAddressInformation?address=" + encodeURIComponent(source));
        if (response.ok !== true) fail("REFUND_FEE_WALLET_STATE_UNAVAILABLE");
        return walletState(response.result, source, now);
    }

    /** Diagnostic only. All bindings come from the request and encoded bytes. */
    async inspectRefundFee(input) {
        const identity = requestIdentity(input); // snapshot before the first await
        const now = this._now();
        if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffff - 60) fail("REFUND_FEE_CLOCK_INVALID");
        const head = await this._network();
        const state = await this._wallet(identity.sourceWalletAddress, now);
        const paid = atomic(identity.paidAmountAtomic);
        if (state.balance < paid) fail("REFUND_FEE_INSUFFICIENT_PRINCIPAL");
        const validUntil = now + 60;
        let candidate = paid;
        // Fee depends on serialized amount. Re-emulate the net amount until
        // paid - fee equals the exact simulated amount, or refuse to quote.
        for (let iteration = 0; iteration < 4; iteration += 1) {
            const body = simulationBody(state, identity.destinationAddress, candidate, validUntil);
            const response = await this._request("/api/v2/estimateFee", {
                address: identity.sourceWalletAddress, body: body.toBoc().toString("base64"),
                ignore_chksig: true
            });
            if (response.ok !== true || response.result?.["@type"] !== "query.fees" ||
                response.result.source_fees?.["@type"] !== "fees") fail("REFUND_FEE_RESPONSE_INVALID");
            const breakdown = Object.freeze(Object.fromEntries(FEE_FIELDS.map(field =>
                [field, atomic(response.result.source_fees[field]).toString()])));
            const fee = FEE_FIELDS.reduce((sum, field) => sum + BigInt(breakdown[field]), 0n);
            if (fee <= 0n || fee >= paid) fail("REFUND_FEE_NONPOSITIVE_NET_REFUND");
            const net = paid - fee;
            if (candidate === net) {
                const end = this._now();
                if (!Number.isSafeInteger(end) || end < now || end >= validUntil) fail("REFUND_FEE_ESTIMATE_EXPIRED");
                const current = await this._wallet(identity.sourceWalletAddress, end);
                if (current.fingerprint !== state.fingerprint) fail("REFUND_FEE_WALLET_STATE_CHANGED");
                if (await this._network() < head) fail("REFUND_FEE_NETWORK_UNVERIFIED");
                if (this._now() >= validUntil) fail("REFUND_FEE_ESTIMATE_EXPIRED");
                return Object.freeze({
                    ...identity, denomination: "TON", estimatedFeeAtomic: fee.toString(),
                    refundAmountAtomic: net.toString(), sourceFees: breakdown,
                    walletId: state.walletId, seqno: state.seqno, validUntil,
                    simulationBodyHash: body.hash().toString("hex"), sendMode: 1,
                    sendRemainingBalance: false, estimateSource: "testnet-network-estimator",
                    finalized: false, executionEligible: false,
                    blocker: "REFUND_FEE_NOT_GUARANTEED"
                });
            }
            candidate = net;
        }
        fail("REFUND_FEE_DID_NOT_CONVERGE");
    }

    /** Existing TestnetOutgoingRefundProvider feeEstimator interface. */
    async estimateRefundFee(input) {
        await this.inspectRefundFee(input);
        // Never relabel an RPC estimate as finalized or a guaranteed maxFee.
        fail("REFUND_FEE_NOT_GUARANTEED");
    }
}