/**
 * R7.41 temporary diagnostic — derive deployer Wallet V4 address from env.
 * Does NOT print the mnemonic.
 *
 * From server/:
 *   node ./scripts/r741_derive_deployer_address.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV4, TonClient } from "@ton/ton";

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

const mnemonic = process.env.TON_DEPLOYER_MNEMONIC?.trim();
const network = (process.env.TON_NETWORK || "testnet").trim().toLowerCase();
const endpoint = process.env.TON_ENDPOINT?.trim()
    || (network === "mainnet"
        ? "https://toncenter.com/api/v2/jsonRPC"
        : "https://testnet.toncenter.com/api/v2/jsonRPC");
const apiKey = process.env.TON_API_KEY || null;

if (!mnemonic) {
    console.log(JSON.stringify({
        ok: false,
        reason: "TON_DEPLOYER_MNEMONIC not set in this process env"
    }, null, 2));
    process.exit(1);
}

const words = mnemonic.split(/\s+/).filter(Boolean);
const keyPair = await mnemonicToPrivateKey(words);
const wallet = WalletContractV4.create({
    workchain: 0,
    publicKey: keyPair.publicKey
});

const bounceable = wallet.address.toString({ bounceable: true, urlSafe: true });
const nonBounceable = wallet.address.toString({ bounceable: false, urlSafe: true });

const client = new TonClient({
    endpoint,
    apiKey: apiKey || undefined
});

let accountState = null;
let seqnoExit = null;
let seqno = null;
let balance = null;

try {
    const state = await client.getContractState(wallet.address);
    accountState = state?.state ?? null;
    balance = state?.balance?.toString?.() ?? String(state?.balance ?? null);
} catch (error) {
    accountState = `getContractState_error: ${error?.message ?? error}`;
}

try {
    const res = await client.runMethodWithError(wallet.address, "seqno", []);
    seqnoExit = res.exit_code;
    if (res.exit_code === 0) {
        try {
            seqno = res.stack.readNumber();
        } catch {
            seqno = null;
        }
    }
} catch (error) {
    seqnoExit = `runMethodWithError_threw: ${error?.message ?? error}`;
}

console.log(JSON.stringify({
    ok: true,
    network,
    endpoint,
    apiKeyConfigured: Boolean(apiKey),
    walletContract: "WalletContractV4 (@ton/ton 16.x)",
    walletId: wallet.walletId,
    workchain: 0,
    addressBounceable: bounceable,
    addressNonBounceable: nonBounceable,
    accountState,
    balanceNano: balance,
    seqnoExitCode: seqnoExit,
    seqno,
    note: "exit_code -13 => null code/data (uninit/nonexist) per ton-org/ton#66; "
        + "WheelWin getSeqno uses runMethod directly and throws (unlike WalletContractV4.getSeqno which returns 0 when inactive)"
}, null, 2));
