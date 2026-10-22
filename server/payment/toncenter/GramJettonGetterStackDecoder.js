/**
 * Decode the minimal TEP-74 Jetton getter stack supported by Toncenter v3.
 *
 * Values are untrusted indexed observations. This module has NO authority to
 * verify account state, derive wallet authenticity, settle or credit GRAM.
 *
 * Supported BOC: exact, canonical, ordinary single-root/single-cell encoding,
 * without CRC/index/refs/exotic cells. All other forms fail closed.
 */
import { tonAddressIdentityOrNull } from "../incoming/TonAddressIdentity.js";
import { inspectGramGetterCodeBoc } from "./GramGetterBocStructure.js";

function invalid(reason) { throw new Error("Invalid GRAM getter TVM stack: " + reason); }

function oneCellBits(base64) {
    if (typeof base64 !== "string" || base64.length > 2048 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) invalid("invalid BOC base64");
    const b = Buffer.from(base64, "base64");
    if (b.toString("base64") !== base64 || b.length < 14 || b.length > 1024 ||
        b.subarray(0, 4).toString("hex") !== "b5ee9c72") invalid("invalid BOC");
    const sizeBytes = b[4] & 7;
    if (b[4] !== 1 || b[5] !== 1 || sizeBytes !== 1 ||
        b[6] !== 1 || b[7] !== 1 || b[8] !== 0 || b[10] !== 0)
        invalid("unsupported BOC header");
    const size = b[9];
    if (size + 11 !== b.length || size < 2) invalid("incorrect BOC size");
    const descriptor = b[11], bitsDescriptor = b[12];
    if (descriptor !== 0) invalid("BOC must have one ordinary cell without references");
    const byteLength = Math.ceil(bitsDescriptor / 2);
    if (13 + byteLength !== b.length || byteLength === 0)
        invalid("invalid cell bit descriptor");
    const data = b.subarray(13);
    let bitLength = byteLength * 8;
    if (bitsDescriptor % 2) {
        let trailing = data[byteLength - 1];
        if (!trailing) invalid("missing BOC top-up");
        let paddingZeros = 0;
        while ((trailing & 1) === 0) {
            paddingZeros++;
            trailing >>= 1;
        }
        bitLength -= paddingZeros + 1;
        if (bitLength % 8 === 0) invalid("non-canonical top-up");
    } else if (bitsDescriptor !== 2 * byteLength) invalid("invalid cell length");
    return { data, bitLength };
}

function addressFromSlice(stackEntry) {
    if (!stackEntry || stackEntry.type !== "slice")
        invalid("address must be a TVM slice");
    const cell = oneCellBits(stackEntry.value);
    // addr_std$10 anycast:(Maybe Anycast)$0 workchain_id:int8
    // address:bits256. Exactly 267 bits; never accept extra payload.
    if (cell.bitLength !== 267) invalid("address slice must contain exactly 267 bits");
    let index = 0;
    const bits = n => {
        let result = 0n;
        for (let i = 0; i < n; i++) {
            const bit = (cell.data[index >> 3] >> (7 - (index & 7))) & 1;
            result = (result << 1n) | BigInt(bit);
            index++;
        }
        return result;
    };
    if (bits(2) !== 2n || bits(1) !== 0n)
        invalid("unsupported address tag or anycast");
    const workchainByte = Number(bits(8));
    const workchain = workchainByte > 127 ? workchainByte - 256 : workchainByte;
    const address = `${workchain}:${bits(256).toString(16).padStart(64, "0")}`;
    if (tonAddressIdentityOrNull(address) !== address)
        invalid("invalid address identity");
    return address;
}

function unsignedBalance(entry) {
    if (!entry || entry.type !== "num" ||
        typeof entry.value !== "string" ||
        !/^(?:0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(entry.value))
        invalid("invalid wallet balance");
    const amount = BigInt(entry.value);
    if (amount < 0n || amount >= 1n << 120n)
        invalid("wallet balance out of range");
    return amount.toString();
}

export function decodeGramMasterWalletAddressStack(result) {
    if (!result || result.method !== "get_wallet_address" ||
        result.exitCode !== 0 || !Array.isArray(result.resultStack) ||
        result.resultStack.length !== 1)
        invalid("unexpected get_wallet_address result");
    return Object.freeze({
        walletAddress: addressFromSlice(result.resultStack[0]),
        indexedStateOnly: true,
        getterChainStateAuthenticated: false,
        paymentCreditAuthorized: false
    });
}

export function decodeGramWalletDataStack(result) {
    if (!result || result.method !== "get_wallet_data" ||
        result.exitCode !== 0 || !Array.isArray(result.resultStack) ||
        result.resultStack.length !== 4 ||
        result.resultStack[3]?.type !== "cell" ||
        typeof result.resultStack[3]?.value !== "string")
        invalid("unexpected get_wallet_data result");
    // Require valid Jetton Wallet code cell instead of trusting an arbitrary
    // stack placeholder; the contract-code hash is NOT authenticated here.
    inspectGramGetterCodeBoc(result.resultStack[3].value);
    return Object.freeze({
        balanceAtomic: unsignedBalance(result.resultStack[0]),
        ownerAddress: addressFromSlice(result.resultStack[1]),
        jettonMasterAddress: addressFromSlice(result.resultStack[2]),
        indexedStateOnly: true,
        getterChainStateAuthenticated: false,
        paymentCreditAuthorized: false
    });
}
