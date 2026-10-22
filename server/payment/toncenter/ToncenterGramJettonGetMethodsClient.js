/**
 * Authenticated, Testnet-only read-only Jetton get-method transport.
 *
 * Toncenter v3 /runGetMethod exposes indexed contract state; it does NOT
 * independently authenticate state roots and grants NO payment authority.
 * Getter stack decoding and address correlation are separate advisory-only
 * modules; this transport does not authenticate chain state.
 */
import { tonAddressIdentityOrNull } from "../incoming/TonAddressIdentity.js";
import { TONCENTER_TESTNET_BASE_URL } from "./ToncenterConstants.js";
import { defaultApiKeyProvider } from "./ToncenterTransactionsClient.js";

function encodeOwnerSlice(address) {
    const raw = tonAddressIdentityOrNull(address);
    if (!raw) throw new Error("Invalid owner TON address");
    const [workchainText, hash] = raw.split(":");
    const wc = Number(workchainText);
    const bits = [1, 0, 0]; // TL-B addr_std$10 followed by anycast absent$0
    const append = (n, length) => {
        const big = BigInt(n);
        for (let i = length - 1; i >= 0; i--) bits.push(Number((big >> BigInt(i)) & 1n));
    };
    append(wc & 255, 8);
    for (const byte of Buffer.from(hash, "hex")) append(byte, 8);
    const data = Buffer.alloc(Math.ceil(bits.length / 8));
    bits.forEach((b, i) => { if (b) data[i >> 3] |= 1 << (7 - (i % 8)); });
    if (bits.length % 8) data[data.length - 1] |= 1 << (7 - (bits.length % 8));
    // Single-root, single-cell, non-indexed BOC.
    return Buffer.from([
        0xb5, 0xee, 0x9c, 0x72, 1, 1, 1, 1, 0, data.length + 2, 0,
        0, Math.floor(bits.length / 8) + Math.ceil(bits.length / 8),
        ...data
    ]).toString("base64");
}

export class ToncenterGramJettonGetMethodsClient {
    #fetch;
    #key;
    #timeoutMs;
    constructor({ fetchImpl = globalThis.fetch, apiKeyProvider = defaultApiKeyProvider,
        timeoutMs = 15000 } = {}) {
        if (typeof fetchImpl !== "function" || typeof apiKeyProvider !== "function"
            || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
            throw new Error("Invalid Testnet getter client configuration");
        }
        this.#fetch = fetchImpl;
        this.#key = apiKeyProvider;
        this.#timeoutMs = timeoutMs;
    }

    async #call({ contractAddress, method, stack }) {
        const account = tonAddressIdentityOrNull(contractAddress);
        if (!account || !["get_wallet_address", "get_wallet_data"].includes(method)
            || !Array.isArray(stack)) throw new Error("Invalid GRAM getter arguments");
        const key = this.#key();
        if (typeof key !== "string" || !key.trim()) {
            throw new Error("TON_API_KEY required before GRAM getter network request");
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
        let envelope;
        try {
            const response = await this.#fetch(TONCENTER_TESTNET_BASE_URL + "/api/v3/runGetMethod", {
                method: "POST",
                headers: { "X-API-Key": key.trim(), "Content-Type": "application/json" },
                body: JSON.stringify({ address: account, method, stack }),
                signal: controller.signal
            });
            if (response?.status !== 200) {
                throw new Error(`Toncenter GRAM get-method HTTP ${response?.status}`);
            }
            // Keep the abort timer alive through the body read, not just the
            // fetch() headers. A stalled JSON body must not hang diagnostics.
            envelope = await response.json();
            if (controller.signal.aborted) {
                throw new Error("Toncenter GRAM get-method timed out");
            }
        } catch (error) {
            // Do not echo raw provider errors: they can contain request
            // metadata. Only preserve safe HTTP status messages.
            if (controller.signal.aborted)
                throw new Error("Toncenter GRAM get-method timed out");
            if (error instanceof Error && /^Toncenter GRAM get-method HTTP (?:[0-9]{3}|undefined)$/.test(error.message))
                throw error;
            throw new Error("Toncenter GRAM get-method request or JSON body failed");
        } finally {
            clearTimeout(timer);
        }
        // Toncenter v3 OpenAPI permits only num, cell and slice TVM entries.
        // Fail closed on unknown types and unexpected getter arity before
        // forwarding any indexed observations to the address decoder.
        const expectedTypes = method === "get_wallet_address"
            ? [["cell", "slice"]]
            : [["num"], ["cell", "slice"], ["cell", "slice"], ["cell"]];
        if (!envelope || Array.isArray(envelope) || envelope.exit_code !== 0
            || !Array.isArray(envelope.stack)
            || envelope.stack.length !== expectedTypes.length
            || !envelope.stack.every((item, index) =>
                item && typeof item === "object" && !Array.isArray(item)
                && expectedTypes[index].includes(item.type)
                && typeof item.value === "string"
                && item.value.length > 0 && item.value.length <= 12000)) {
            throw new Error("Toncenter GRAM get-method result is invalid or unsuccessful");
        }
        return Object.freeze({
            method,
            contractAddress: account,
            resultStack: Object.freeze(envelope.stack.map(entry => Object.freeze({
                type: entry.type, value: entry.value
            }))),
            exitCode: 0,
            indexedStateOnly: true,
            getterChainStateAuthenticated: false,
            paymentCreditAuthorized: false
        });
    }

    async getWalletAddress({ jettonMaster, ownerWallet } = {}) {
        const master = tonAddressIdentityOrNull(jettonMaster);
        if (!master) throw new Error("Invalid GRAM master address");
        return this.#call({
            contractAddress: master,
            method: "get_wallet_address",
            stack: [{ type: "slice", value: encodeOwnerSlice(ownerWallet) }]
        });
    }

    async getWalletData({ jettonWallet } = {}) {
        const address = tonAddressIdentityOrNull(jettonWallet);
        if (!address) throw new Error("Invalid GRAM jetton wallet address");
        return this.#call({
            contractAddress: address,
            method: "get_wallet_data",
            stack: []
        });
    }
}
