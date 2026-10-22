/**
 * Decode the minimal TEP-74 Jetton getter stack supported by Toncenter v3.
 *
 * Values are untrusted indexed observations. This module has NO authority to
 * verify account state, derive wallet authenticity, settle or credit GRAM.
 *
 * Supported BOC: exact, canonical, ordinary single-root/single-cell encoding,
 * with optional BOC index/CRC32C, but no refs/exotic cells. Other forms fail closed.
 */
import { tonAddressIdentityOrNull } from "../incoming/TonAddressIdentity.js";
import { inspectGramGetterCodeBoc } from "./GramGetterBocStructure.js";

function invalid(reason) { throw new Error("Invalid GRAM getter TVM stack: " + reason); }

function oneCellBits(base64) {
    // Validate the complete BOC envelope, CRC, optional index, root and cell
    // reachability before reading any bits as an address. No optimistic parse.
    let structure;
    try { structure = inspectGramGetterCodeBoc(base64); }
    catch { invalid("invalid address BOC envelope or CRC32C"); }
    if (structure.cellCount !== 1 || structure.referenceCount !== 0) {
        invalid("address must be stored in one ordinary reference-free cell");
    }
    const b = Buffer.from(base64, "base64");
    const sizeBytes = b[4] & 7;
    const offsetBytes = b[5];
    // Single-cell BOC: only the root index (0) and optional one-cell offset
    // precede the cell; generic parser has already checked both.
    let at = 6 + sizeBytes * 3 + offsetBytes + sizeBytes;
    if (structure.hasIndex) at += offsetBytes;
    if (b[at] !== 0) invalid("address cell must have no references");
    const bitsDescriptor = b[at + 1];
    const byteLength = Math.ceil(bitsDescriptor / 2);
    const data = b.subarray(at + 2, at + 2 + byteLength);
    if (data.length !== byteLength || byteLength === 0)
        invalid("truncated address cell data");
    let bitLength = byteLength * 8;
    if (bitsDescriptor % 2) {
        let tail = data[data.length - 1];
        let paddingZeros = 0;
        while ((tail & 1) === 0 && paddingZeros < 8) {
            paddingZeros++;
            tail >>= 1;
        }
        if (paddingZeros === 8) invalid("invalid BOC top-up");
        bitLength -= paddingZeros + 1;
    }
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
