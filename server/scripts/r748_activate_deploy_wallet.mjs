/**
 * R7.48 — One-time WheelWin deploy wallet activation (ops only).
 *
 * Activates WalletContractV4R2 from TON_DEPLOYER_MNEMONIC on testnet.
 * Does NOT use TonService.getSeqno / runMethod on inactive wallets.
 *
 * Usage (from server/):
 *   node ./scripts/r748_activate_deploy_wallet.mjs
 *
 * Never prints mnemonic or private keys.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beginCell, internal, toNano } from "@ton/core";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { Address, TonClient, WalletContractV4 } from "@ton/ton";

const EXPECTED_DEPLOY_WALLET = "0QB83s9XMOMseDFxyXxj4hrC0sS4FB4xhdNiUPkl_3zx3Baf";
const ACTIVATION_VALUE_TON = "0.001";
const CONFIRM_POLL_MS = 2000;
const CONFIRM_TIMEOUT_MS = 120_000;

function loadEnvFile(filePath) {
    if (!existsSync(filePath)) {
        return;
    }
    const text = readFileSync(filePath, "utf8");
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            continue;
        }
        const index = trimmed.indexOf("=");
        if (index <= 0) {
            continue;
        }
        const key = trimmed.slice(0, index).trim();
        let value = trimmed.slice(index + 1).trim();
        if (
            (value.startsWith("\"") && value.endsWith("\""))
            || (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}

for (const candidate of [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), ".env.local"),
    resolve(process.cwd(), "../.env"),
    resolve(process.cwd(), "../.env.local")
]) {
    loadEnvFile(candidate);
}

function sleep(ms) {
    return new Promise((resolveSleep) => {
        setTimeout(resolveSleep, ms);
    });
}

async function withRetry(label, operation, {
    attempts = 6,
    delayMs = 2000
} = {}) {
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            const status = error?.response?.status ?? error?.status ?? null;
            const retryable = status === 429 || status === 503 || status === 504;

            if (!retryable || attempt === attempts) {
                throw error;
            }

            await sleep(delayMs * attempt);
        }
    }

    throw lastError;
}

function formatAddress(address) {
    return address.toString({
        bounceable: false,
        urlSafe: true,
        testOnly: true
    });
}

function snapshotState(contractState) {
    return {
        state: contractState.state,
        balanceTon: Number(contractState.balance) / 1e9,
        code: contractState.code ? "present" : "absent",
        data: contractState.data ? "present" : "absent",
        lastTransactionLt: contractState.lastTransaction?.lt ?? null,
        lastTransactionHash: contractState.lastTransaction?.hash ?? null
    };
}

function transactionHashHex(transaction) {
    if (!transaction?.hash) {
        return null;
    }
    if (typeof transaction.hash === "function") {
        return transaction.hash().toString("hex");
    }
    if (Buffer.isBuffer(transaction.hash)) {
        return transaction.hash.toString("hex");
    }
    return String(transaction.hash);
}

const mnemonic = process.env.TON_DEPLOYER_MNEMONIC?.trim();
const network = (process.env.TON_NETWORK || "testnet").trim().toLowerCase();
const endpoint = process.env.TON_ENDPOINT?.trim()
    || (network === "mainnet"
        ? "https://toncenter.com/api/v2/jsonRPC"
        : "https://testnet.toncenter.com/api/v2/jsonRPC");
const apiKey = process.env.TON_API_KEY || undefined;

if (!mnemonic) {
    console.error(JSON.stringify({
        ok: false,
        reason: "TON_DEPLOYER_MNEMONIC not set"
    }, null, 2));
    process.exit(1);
}

if (network !== "testnet") {
    console.error(JSON.stringify({
        ok: false,
        reason: "Refusing activation: TON_NETWORK must be testnet for this ops script",
        network
    }, null, 2));
    process.exit(3);
}

const expectedAddress = Address.parse(EXPECTED_DEPLOY_WALLET);
const words = mnemonic.split(/\s+/).filter(Boolean);
const keyPair = await mnemonicToPrivateKey(words);
const wallet = WalletContractV4.create({
    workchain: 0,
    publicKey: keyPair.publicKey
});

const derivedAddress = formatAddress(wallet.address);

if (!wallet.address.equals(expectedAddress)) {
    console.error(JSON.stringify({
        ok: false,
        reason: "Derived deploy wallet does not match expected WheelWin deploy address",
        derivedAddress,
        expectedAddress: EXPECTED_DEPLOY_WALLET
    }, null, 2));
    process.exit(2);
}

const client = new TonClient({ endpoint, apiKey });
const contract = client.open(wallet);

if (!apiKey) {
    console.warn(JSON.stringify({
        warning: "TON_API_KEY not set; toncenter may rate-limit this script"
    }));
}

const initialContractState = await withRetry(
    "getContractState(initial)",
    () => client.getContractState(wallet.address)
);
const initialState = snapshotState(initialContractState);
const initialSeqno = await contract.getSeqno();

const report = {
    ok: true,
    derivedAddress,
    walletContract: "WalletContractV4R2",
    walletId: wallet.walletId,
    workchain: 0,
    network,
    endpoint,
    initialState,
    initialSeqno,
    transactionHash: null,
    finalState: null,
    finalSeqno: null,
    activated: false,
    skipped: false
};

if (initialContractState.state === "active") {
    report.skipped = true;
    report.activated = true;
    report.finalState = initialState;
    report.finalSeqno = initialSeqno;
    report.note = "Wallet already active; no transaction sent.";
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
}

if (initialContractState.balance <= 0n) {
    console.error(JSON.stringify({
        ok: false,
        reason: "Deploy wallet has zero balance; fund on testnet before activation",
        derivedAddress,
        initialState
    }, null, 2));
    process.exit(4);
}

const beforeLt = initialContractState.lastTransaction?.lt ?? null;

await withRetry(
    "sendTransfer(activation)",
    () => contract.sendTransfer({
        seqno: initialSeqno,
        secretKey: keyPair.secretKey,
        messages: [
            internal({
                to: wallet.address,
                value: toNano(ACTIVATION_VALUE_TON),
                bounce: false,
                body: beginCell().endCell()
            })
        ]
    })
);

const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
let finalContractState = initialContractState;

while (Date.now() < deadline) {
    await sleep(CONFIRM_POLL_MS);
    finalContractState = await withRetry(
        "getContractState(confirm)",
        () => client.getContractState(wallet.address)
    );
    if (finalContractState.state === "active") {
        break;
    }
}

if (finalContractState.state !== "active") {
    console.error(JSON.stringify({
        ok: false,
        reason: "Activation timed out waiting for active contract state",
        derivedAddress,
        initialState,
        lastObservedState: snapshotState(finalContractState),
        timeoutMs: CONFIRM_TIMEOUT_MS
    }, null, 2));
    process.exit(5);
}

let transactionHash = null;

try {
    const transactions = await client.getTransactions(wallet.address, {
        limit: 5,
        archival: true
    });
    const activationTx = transactions.find((tx) => {
        if (beforeLt === null) {
            return true;
        }
        return BigInt(tx.lt) > BigInt(beforeLt);
    }) ?? transactions[0] ?? null;

    transactionHash = activationTx
        ? transactionHashHex(activationTx)
        : finalContractState.lastTransaction?.hash ?? null;
} catch {
    transactionHash = finalContractState.lastTransaction?.hash ?? null;
}

report.transactionHash = transactionHash;
report.finalState = snapshotState(finalContractState);
report.finalSeqno = await contract.getSeqno();
report.activated = true;

console.log(JSON.stringify(report, null, 2));
