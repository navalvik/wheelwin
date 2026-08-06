/**
 * R7.44 — Verify intended GRAM Wallet mnemonic vs OWNER_WALLET.
 * Prints public address / MATCH only. Never prints mnemonic or keys.
 *
 * Provide phrase via env (preferred):
 *   $env:GRAM_WALLET_MNEMONIC="word1 word2 ..."
 *   node ./scripts/r744_verify_gram_mnemonic.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { Address, TonClient, WalletContractV4 } from "@ton/ton";

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
            (value.startsWith('"') && value.endsWith('"'))
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

const OWNER_WALLET = "0QBaklBYMdMsuq7a2eTYhMkz1OF7ZSHaO1mnFd1MZd3YjC5t";
const CANDIDATE_KEYS = [
    "GRAM_WALLET_MNEMONIC",
    "TON_OWNER_MNEMONIC",
    "TON_GRAM_MNEMONIC",
    "OWNER_WALLET_MNEMONIC",
    "INTENDED_DEPLOYER_MNEMONIC",
    "R744_MNEMONIC"
];

const presentKeys = CANDIDATE_KEYS.filter((key) => Boolean(process.env[key]?.trim()));
let mnemonic = "";
let sourceKey = null;
for (const key of CANDIDATE_KEYS) {
    if (process.env[key]?.trim()) {
        mnemonic = process.env[key].trim();
        sourceKey = key;
        break;
    }
}

if (!mnemonic) {
    console.log(JSON.stringify({
        ok: false,
        reason: "Intended GRAM Wallet recovery phrase not provided",
        checkedEnvKeys: CANDIDATE_KEYS,
        presentEnvKeys: presentKeys,
        hint: "Set GRAM_WALLET_MNEMONIC in the shell or a local .env, then re-run. Do not use the current Railway deployer phrase for this check."
    }, null, 2));
    process.exit(2);
}

const words = mnemonic.split(/\s+/).filter(Boolean);
const keyPair = await mnemonicToPrivateKey(words);
const wallet = WalletContractV4.create({
    workchain: 0,
    publicKey: keyPair.publicKey
});

const derived = wallet.address.toString({
    bounceable: false,
    urlSafe: true,
    testOnly: true
});
const match = wallet.address.equals(Address.parse(OWNER_WALLET));

const report = {
    DERIVED_ADDRESS: derived,
    MATCH_WITH_OWNER_WALLET: match ? "YES" : "NO",
    sourceEnvKey: sourceKey
};

if (match) {
    const client = new TonClient({
        endpoint: "https://testnet.toncenter.com/api/v2/jsonRPC"
    });
    const state = await client.getContractState(wallet.address);
    const seqnoResult = await client.runMethodWithError(wallet.address, "seqno", []);
    let seqno = null;
    if (seqnoResult.exit_code === 0) {
        try {
            seqno = seqnoResult.stack.readNumber();
        } catch {
            seqno = null;
        }
    }
    report.walletType = "WalletContractV4 / V4R2";
    report.walletId = wallet.walletId;
    report.networkCompatibility = {
        ownerPrefix: "0Q = testnet non-bounceable",
        tonNetworkExpected: "testnet",
        compatibleWithCodePath: true
    };
    report.activationState = {
        state: state.state,
        balanceTon: Number(state.balance) / 1e9,
        code: state.code ? "present" : "absent",
        data: state.data ? "present" : "absent",
        seqnoExitCode: seqnoResult.exit_code,
        seqno
    };
}

console.log(JSON.stringify(report, null, 2));
