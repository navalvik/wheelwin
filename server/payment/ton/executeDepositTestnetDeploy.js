/**
 * R17.9L.14B — Send the TESTNET Deposit Contract deploy using only
 * TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC. Never uses TON_DEPLOYER_MNEMONIC.
 * Empty receive only. No FundSeat. No Game Contract deploy.
 */
import {
    Address,
    beginCell,
    external,
    internal,
    storeMessage,
    toNano
} from "@ton/core";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import { canonicalizeTonWalletAddress } from "../../models/TonWalletAddress.js";
import {
    DEPOSIT_ACCOUNT_STATE
} from "../../deposit/RealTonDepositBlockchainSource.js";
import {
    DEPLOYER_WALLET_WORKCHAIN
} from "./deriveDeployerWalletIdentity.js";
import {
    DepositTestnetDeployError,
    assertDedicatedTestnetDepositDeployer,
    assertSenderIsNotProductionDeployWallet,
    assertTestnetNetworkConfig,
    evaluateExistingDepositAccount
} from "./depositTestnetDeploy.js";
import {
    PRODUCTION_DEPLOY_WALLET,
    TESTNET_DEPOSIT_DEPLOYER_MNEMONIC_ENV
} from "./depositTestnetFixture.js";
import { getTestnetDepositDeployer } from "./getTestnetDepositDeployer.js";

export const DEPOSIT_TESTNET_DEPLOY_VALUE_TON = "0.05";

export const DEPOSIT_TESTNET_DEPLOY_MIN_SENDER_NANO = toNano("0.08");

const ACTIVE_WAIT_TIMEOUT_MS = 120_000;
const ACTIVE_WAIT_INTERVAL_MS = 3_000;

function normalizeMnemonic(value) {

    if (typeof value !== "string") {

        return null;

    }

    const words = value.trim().split(/\s+/).filter(Boolean);

    return words.length ? words.join(" ") : null;

}

function sleep(ms) {

    return new Promise((resolve) => {

        setTimeout(resolve, ms);

    });

}

function readDedicatedMnemonic(env) {

    assertDedicatedTestnetDepositDeployer(env);

    const dedicated = normalizeMnemonic(env[TESTNET_DEPOSIT_DEPLOYER_MNEMONIC_ENV]);

    if (!dedicated) {

        throw new DepositTestnetDeployError(
            "TESTNET DEPLOYMENT CREDENTIAL REQUIRED",
            { code: "TESTNET_DEPOSIT_DEPLOYER_CREDENTIAL_REQUIRED" }
        );

    }

    const production = normalizeMnemonic(env.TON_DEPLOYER_MNEMONIC);

    if (production && dedicated === production) {

        throw new DepositTestnetDeployError(
            "BLOCKED — TESTNET DEPLOYER IS PRODUCTION DEPLOYER",
            { code: "TESTNET_DEPOSIT_DEPLOYER_MUST_NOT_EQUAL_PRODUCTION_DEPLOYER" }
        );

    }

    return dedicated;

}

async function waitUntilActive(getContractState, address) {

    const deadline = Date.now() + ACTIVE_WAIT_TIMEOUT_MS;

    let last = null;

    while (Date.now() < deadline) {

        last = await getContractState(address);

        if (last.state === DEPOSIT_ACCOUNT_STATE.ACTIVE) {

            return last;

        }

        if (last.state === DEPOSIT_ACCOUNT_STATE.FROZEN) {

            throw new DepositTestnetDeployError(
                "Deployed account became FROZEN",
                { code: "ACCOUNT_FROZEN" }
            );

        }

        await sleep(ACTIVE_WAIT_INTERVAL_MS);

    }

    throw new DepositTestnetDeployError(
        "Deposit contract did not become ACTIVE within timeout",
        {
            code: "ACTIVE_TIMEOUT",
            lastState: last?.state ?? null
        }
    );

}

/**
 * Query existing account and either deploy, verify existing, or block.
 * Signing uses TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC only.
 */
export async function executeDepositTestnetDeploy({
    env = process.env,
    plan,
    tonService,
    getContractState,
    send = true
} = {}) {

    const network = assertTestnetNetworkConfig(env);

    if (!plan?.code || !plan?.data || !plan?.address || !plan?.expectedAddress) {

        throw new DepositTestnetDeployError(
            "Deploy plan is incomplete",
            { code: "DEPLOY_PLAN_INCOMPLETE" }
        );

    }

    const deployer = await getTestnetDepositDeployer(env);

    assertSenderIsNotProductionDeployWallet(deployer.walletAddress);

    const senderCanonical = canonicalizeTonWalletAddress(deployer.walletAddress)
        || deployer.walletAddress;
    const production = canonicalizeTonWalletAddress(PRODUCTION_DEPLOY_WALLET)
        || PRODUCTION_DEPLOY_WALLET;

    if (senderCanonical === production) {

        throw new DepositTestnetDeployError(
            "BLOCKED — TESTNET DEPLOYER IS PRODUCTION DEPLOYER",
            { code: "TESTNET_DEPOSIT_DEPLOYER_MUST_NOT_EQUAL_PRODUCTION_DEPLOYER" }
        );

    }

    const existing = await getContractState(plan.expectedAddress);
    const evaluation = evaluateExistingDepositAccount({
        state: existing.state,
        codeHash: existing.codeHash,
        expectedCodeHash: plan.expectedCodeHash,
        balanceNano: existing.balanceNano,
        lastLt: existing.lastLt
    });

    if (evaluation.action === "block") {

        throw new DepositTestnetDeployError(
            `Existing account blocks deployment | ${evaluation.reason}`,
            { code: "EXISTING_ACCOUNT_BLOCK", reason: evaluation.reason }
        );

    }

    if (evaluation.action === "verify_existing") {

        return Object.freeze({
            sent: false,
            action: "verify_existing",
            network: network.network,
            senderAddress: deployer.walletAddress,
            expectedAddress: plan.expectedAddress,
            transactionHash: existing.lastHash ?? null,
            logicalTime: existing.lastLt ?? null,
            accountState: existing.state,
            deployValueTon: "0",
            networkFeeNano: null
        });

    }

    if (!send) {

        return Object.freeze({
            sent: false,
            action: "dry_run",
            network: network.network,
            senderAddress: deployer.walletAddress,
            expectedAddress: plan.expectedAddress,
            transactionHash: null,
            logicalTime: null,
            accountState: existing.state,
            deployValueTon: DEPOSIT_TESTNET_DEPLOY_VALUE_TON,
            networkFeeNano: null
        });

    }

    const senderBalance = await tonService.getBalance(deployer.walletAddress);

    if (senderBalance < DEPOSIT_TESTNET_DEPLOY_MIN_SENDER_NANO) {

        throw new DepositTestnetDeployError(
            "Dedicated testnet deployer has insufficient testnet TON",
            {
                code: "INSUFFICIENT_TESTNET_TON",
                senderAddress: deployer.walletAddress,
                balanceNano: senderBalance.toString(),
                requiredNano: DEPOSIT_TESTNET_DEPLOY_MIN_SENDER_NANO.toString()
            }
        );

    }

    const dedicatedMnemonic = readDedicatedMnemonic(env);
    let keyPair;

    try {

        keyPair = await mnemonicToPrivateKey(
            dedicatedMnemonic.split(/\s+/).filter(Boolean)
        );

    } catch {

        throw new DepositTestnetDeployError(
            "Dedicated testnet Deposit deployer identity derivation failed",
            { code: "TESTNET_DEPOSIT_DEPLOYER_IDENTITY_DERIVATION_FAILED" }
        );

    }

    const wallet = WalletContractV4.create({
        workchain: DEPLOYER_WALLET_WORKCHAIN,
        publicKey: keyPair.publicKey
    });

    const walletAddress = wallet.address.toString({
        bounceable: true,
        urlSafe: true
    });

    if ((canonicalizeTonWalletAddress(walletAddress) || walletAddress)
        !== senderCanonical) {

        throw new DepositTestnetDeployError(
            "Signed wallet does not match dedicated testnet deployer",
            { code: "SENDER_IDENTITY_MISMATCH" }
        );

    }

    assertSenderIsNotProductionDeployWallet(walletAddress);

    const seqno = await tonService.getSeqno(walletAddress);

    const transfer = wallet.createTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [
            internal({
                to: plan.address instanceof Address
                    ? plan.address
                    : Address.parse(plan.expectedAddress),
                value: toNano(DEPOSIT_TESTNET_DEPLOY_VALUE_TON),
                init: {
                    code: plan.code,
                    data: plan.data
                },
                bounce: false
            })
        ]
    });

    const externalMessage = external({
        to: wallet.address,
        body: transfer
    });

    const bocBase64 = beginCell()
        .store(storeMessage(externalMessage))
        .endCell()
        .toBoc()
        .toString("base64");

    const broadcast = await tonService.broadcastTransaction(bocBase64);
    const broadcastHash = broadcast?.hash
        ?? broadcast?.result?.hash
        ?? null;

    const seqnoDeadline = Date.now() + ACTIVE_WAIT_TIMEOUT_MS;

    while (Date.now() < seqnoDeadline) {

        const nextSeqno = await tonService.getSeqno(walletAddress);

        if (nextSeqno > seqno) {

            break;

        }

        await sleep(ACTIVE_WAIT_INTERVAL_MS);

    }

    const active = await waitUntilActive(getContractState, plan.expectedAddress);

    return Object.freeze({
        sent: true,
        action: "deployed",
        network: network.network,
        senderAddress: walletAddress,
        expectedAddress: plan.expectedAddress,
        transactionHash: active.lastHash ?? broadcastHash,
        logicalTime: active.lastLt ?? null,
        accountState: active.state,
        deployValueTon: DEPOSIT_TESTNET_DEPLOY_VALUE_TON,
        networkFeeNano: null,
        sentSeqno: seqno
    });

}
