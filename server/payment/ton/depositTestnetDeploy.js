/**
 * R17.9L.14 — Testnet-only Deposit Contract deploy guards and plan builder.
 * Never uses TON_DEPLOYER_MNEMONIC / WheelWin Deploy Wallet.
 * Does not call GameContractManager or TonGameContractAdapter.deploy().
 */
import { contractAddress } from "@ton/core";

import { canonicalizeTonWalletAddress } from "../../models/TonWalletAddress.js";
import {
    DEPOSIT_ACCOUNT_STATE
} from "../../deposit/RealTonDepositBlockchainSource.js";
import {
    buildDepositStateInit,
    loadDepositCodeCell
} from "./buildDepositStateInit.js";
import {
    assertVerifiedDepositArtifact,
    hashDepositArtifactBoc
} from "./verifyDepositArtifact.js";
import {
    DEPOSIT_TESTNET_FIXTURE,
    FROZEN_DEPOSIT_ARTIFACT_SHA256,
    PRODUCTION_DEPLOY_WALLET,
    TESTNET_DEPOSIT_DEPLOYER_EXPECTED_ADDRESS_ENV,
    TESTNET_DEPOSIT_DEPLOYER_MNEMONIC_ENV,
    assertFixturePlayersDistinct,
    buildDepositTestnetStateInitParams
} from "./depositTestnetFixture.js";

export const TESTNET_DEPLOYMENT_CREDENTIAL_REQUIRED =
    "TESTNET DEPLOYMENT CREDENTIAL REQUIRED";

export class DepositTestnetDeployError extends Error {

    constructor(message, details = {}) {

        super(message);

        this.name = "DepositTestnetDeployError";

        this.details = Object.freeze({ ...details });

        this.code = details.code ?? "DEPOSIT_TESTNET_DEPLOY_ERROR";

    }

}

function trimOrNull(value) {

    if (typeof value !== "string") {

        return null;

    }

    const trimmed = value.trim();

    return trimmed ? trimmed : null;

}

export function normalizeNetworkName(network) {

    return String(network ?? "").trim().toLowerCase();

}

export function isTestnetEndpoint(endpoint) {

    const value = String(endpoint ?? "").trim().toLowerCase();

    if (!value) {

        return false;

    }

    if (value.includes("testnet")) {

        return true;

    }

    return false;

}

export function isMainnetEndpoint(endpoint) {

    const value = String(endpoint ?? "").trim().toLowerCase();

    if (!value) {

        return false;

    }

    if (value.includes("testnet")) {

        return false;

    }

    return value.includes("toncenter.com")
        || value.includes("mainnet")
        || value.includes("tonapi.io");

}

export function assertTestnetNetworkConfig(env = process.env) {

    const network = normalizeNetworkName(env.TON_NETWORK);

    if (network !== "testnet") {

        throw new DepositTestnetDeployError(
            "R17.9L.14 requires TON_NETWORK=testnet",
            { code: "NETWORK_NOT_TESTNET", network }
        );

    }

    const endpoint = trimOrNull(env.TON_TESTNET_ENDPOINT)
        || trimOrNull(env.TON_ENDPOINT)
        || "https://testnet.toncenter.com/api/v2/jsonRPC";

    if (isMainnetEndpoint(endpoint) || !isTestnetEndpoint(endpoint)) {

        throw new DepositTestnetDeployError(
            "R17.9L.14 refuses a non-testnet RPC endpoint",
            { code: "ENDPOINT_NOT_TESTNET" }
        );

    }

    return Object.freeze({
        network,
        endpoint
    });

}

function normalizeMnemonic(value) {

    if (typeof value !== "string") {

        return null;

    }

    const words = value.trim().split(/\s+/).filter(Boolean);

    return words.length ? words.join(" ") : null;

}

/**
 * Dedicated TESTNET Deposit deployer only.
 * Rejects missing credential, production mnemonic reuse, and Deploy Wallet identity.
 */
export function assertDedicatedTestnetDepositDeployer(env = process.env) {

    const dedicated = normalizeMnemonic(env[TESTNET_DEPOSIT_DEPLOYER_MNEMONIC_ENV]);

    if (!dedicated) {

        throw new DepositTestnetDeployError(
            TESTNET_DEPLOYMENT_CREDENTIAL_REQUIRED,
            { code: "TESTNET_DEPLOYMENT_CREDENTIAL_REQUIRED" }
        );

    }

    const production = normalizeMnemonic(env.TON_DEPLOYER_MNEMONIC);

    if (production && dedicated === production) {

        throw new DepositTestnetDeployError(
            "R17.9L.14 refuses WheelWin Deploy Wallet / TON_DEPLOYER_MNEMONIC",
            { code: "PRODUCTION_DEPLOY_WALLET_REJECTED" }
        );

    }

    return Object.freeze({
        configured: true,
        expectedAddress: trimOrNull(env[TESTNET_DEPOSIT_DEPLOYER_EXPECTED_ADDRESS_ENV])
    });

}

export function assertSenderIsNotProductionDeployWallet(senderAddress) {

    const canonical = canonicalizeTonWalletAddress(senderAddress)
        || String(senderAddress ?? "").trim();

    const forbidden = canonicalizeTonWalletAddress(PRODUCTION_DEPLOY_WALLET)
        || PRODUCTION_DEPLOY_WALLET;

    if (canonical && canonical === forbidden) {

        throw new DepositTestnetDeployError(
            "R17.9L.14 refuses production Deploy Wallet as sender",
            { code: "PRODUCTION_DEPLOY_WALLET_REJECTED" }
        );

    }

    const productionPin = canonicalizeTonWalletAddress(
        process.env.TON_DEPLOYER_EXPECTED_ADDRESS
    );

    if (productionPin && canonical === productionPin) {

        throw new DepositTestnetDeployError(
            "R17.9L.14 refuses production Deploy Wallet expected address",
            { code: "PRODUCTION_DEPLOY_WALLET_REJECTED" }
        );

    }

    return true;

}

export function evaluateExistingDepositAccount({
    state,
    codeHash = null,
    expectedCodeHash = null
} = {}) {

    if (state === DEPOSIT_ACCOUNT_STATE.NONEXISTENT) {

        return Object.freeze({
            action: "deploy",
            reason: null
        });

    }

    if (state === DEPOSIT_ACCOUNT_STATE.UNINIT) {

        return Object.freeze({
            action: "block",
            reason: "uninitialized_account"
        });

    }

    if (state === DEPOSIT_ACCOUNT_STATE.FROZEN) {

        return Object.freeze({
            action: "block",
            reason: "frozen_account"
        });

    }

    if (state === DEPOSIT_ACCOUNT_STATE.ACTIVE) {

        if (expectedCodeHash && codeHash && codeHash === expectedCodeHash) {

            return Object.freeze({
                action: "verify_existing",
                reason: null
            });

        }

        return Object.freeze({
            action: "block",
            reason: "unexpected_active_contract"
        });

    }

    return Object.freeze({
        action: "block",
        reason: "unknown_account_state"
    });

}

export function verifyLocalDepositArtifactIdentity() {

    const verified = assertVerifiedDepositArtifact({
        expectedSha256: FROZEN_DEPOSIT_ARTIFACT_SHA256,
        requirePresent: true,
        requireLoadable: true
    });

    if (verified.actualSha256 !== FROZEN_DEPOSIT_ARTIFACT_SHA256) {

        throw new DepositTestnetDeployError(
            "Deposit artifact SHA256 mismatch",
            {
                code: "ARTIFACT_MISMATCH",
                actualSha256: verified.actualSha256,
                expectedSha256: FROZEN_DEPOSIT_ARTIFACT_SHA256
            }
        );

    }

    const hashed = hashDepositArtifactBoc();
    const code = loadDepositCodeCell({
        expectedSha256: FROZEN_DEPOSIT_ARTIFACT_SHA256
    });

    return Object.freeze({
        sha256: hashed.sha256,
        codeHash: code.hash().toString("hex"),
        path: hashed.path
    });

}

/**
 * Build a public, reproducible testnet deploy plan. Does not send TON.
 */
export function prepareDepositTestnetDeployPlan({
    env = process.env,
    fixture = DEPOSIT_TESTNET_FIXTURE
} = {}) {

    const network = assertTestnetNetworkConfig(env);

    assertFixturePlayersDistinct(fixture);

    if (fixture.network !== "testnet" || fixture.networkTag !== 0) {

        throw new DepositTestnetDeployError(
            "Fixture networkTag must be TESTNET",
            { code: "FIXTURE_NETWORK_MISMATCH" }
        );

    }

    const artifact = verifyLocalDepositArtifactIdentity();
    const built = buildDepositStateInit({
        ...buildDepositTestnetStateInitParams(fixture),
        expectedArtifactSha256: FROZEN_DEPOSIT_ARTIFACT_SHA256,
        env: {
            ...env,
            TON_TESTNET_ORACLE_ADDRESS: fixture.releaseAuthority
        }
    });

    const independent = contractAddress(built.workchain, {
        code: built.code,
        data: built.data
    });

    if (!built.address.equals(independent)) {

        throw new DepositTestnetDeployError(
            "StateInit address mismatch — deployment blocked",
            { code: "ADDRESS_MISMATCH" }
        );

    }

    const expectedAddress = built.address.toString({
        bounceable: true,
        urlSafe: true
    });

    const expectedAddressTestOnly = built.addressFriendly;

    return Object.freeze({
        network: network.network,
        endpoint: network.endpoint,
        contractVersion: built.contractVersion,
        depositId: built.depositId,
        roomId: built.roomId,
        gameId: built.gameId,
        depositIdHash: built.depositIdHash,
        roomIdHash: built.roomIdHash,
        gameIdHash: built.gameIdHash,
        player0: built.bindings[0].wallet,
        player1: built.bindings[1].wallet,
        player2: built.bindings[2].wallet,
        expectedStake0: built.bindings[0].expectedAmount.toString(),
        expectedStake1: built.bindings[1].expectedAmount.toString(),
        expectedStake2: built.bindings[2].expectedAmount.toString(),
        creationFeePerSeat: built.creationFeePerSeat.toString(),
        expiresAt: built.expiresAt.toString(),
        releaseAuthority: built.releaseAuthority.toString({
            bounceable: true,
            urlSafe: true
        }),
        networkTag: built.networkTag,
        expectedAddress,
        expectedAddressTestOnly,
        workchain: built.workchain,
        artifactSha256: artifact.sha256,
        expectedCodeHash: artifact.codeHash,
        code: built.code,
        data: built.data,
        stateInit: built.stateInit,
        address: built.address
    });

}

export function toPublicDeployPlan(plan) {

    return Object.freeze({
        network: plan.network,
        contractVersion: plan.contractVersion,
        depositId: plan.depositId,
        roomId: plan.roomId,
        gameId: plan.gameId,
        depositIdHash: plan.depositIdHash,
        roomIdHash: plan.roomIdHash,
        gameIdHash: plan.gameIdHash,
        player0: plan.player0,
        player1: plan.player1,
        player2: plan.player2,
        expectedStake0: plan.expectedStake0,
        expectedStake1: plan.expectedStake1,
        expectedStake2: plan.expectedStake2,
        creationFeePerSeat: plan.creationFeePerSeat,
        expiresAt: plan.expiresAt,
        releaseAuthority: plan.releaseAuthority,
        networkTag: plan.networkTag,
        expectedAddress: plan.expectedAddress,
        expectedAddressTestOnly: plan.expectedAddressTestOnly,
        artifactSha256: plan.artifactSha256,
        expectedCodeHash: plan.expectedCodeHash
    });

}
