/**
 * R17.9L.14A — Dedicated TESTNET Deposit deployer configuration API.
 *
 * Requests TESTNET_DEPOSIT_DEPLOYER, never DEPLOYER.
 * Never falls back to TON_DEPLOYER_MNEMONIC.
 * Never returns or logs mnemonic / private key / seed.
 */
import { canonicalizeTonWalletAddress } from "../../models/TonWalletAddress.js";
import {
    DEPLOYER_WALLET_CONTRACT_TYPE,
    deriveDeployerWalletIdentity
} from "./deriveDeployerWalletIdentity.js";
import {
    PRODUCTION_DEPLOY_WALLET,
    TESTNET_DEPOSIT_DEPLOYER_EXPECTED_ADDRESS_ENV,
    TESTNET_DEPOSIT_DEPLOYER_MNEMONIC_ENV
} from "./depositTestnetFixture.js";

export const TESTNET_DEPOSIT_DEPLOYER_ROLE = "TESTNET_DEPOSIT_DEPLOYER";

export const TESTNET_DEPOSIT_DEPLOYER_CREDENTIAL_REQUIRED =
    "TESTNET_DEPOSIT_DEPLOYER_CREDENTIAL_REQUIRED";

export const TESTNET_DEPOSIT_DEPLOYER_MUST_NOT_EQUAL_PRODUCTION_DEPLOYER =
    "TESTNET_DEPOSIT_DEPLOYER_MUST_NOT_EQUAL_PRODUCTION_DEPLOYER";

export const TESTNET_DEPOSIT_DEPLOYER_REQUIRES_TESTNET =
    "TESTNET_DEPOSIT_DEPLOYER_REQUIRES_TESTNET";

export class TestnetDepositDeployerError extends Error {

    constructor(code, message = code) {

        super(message);

        this.name = "TestnetDepositDeployerError";

        this.code = code;

    }

}

function trimOrNull(value) {

    if (typeof value !== "string") {

        return null;

    }

    const trimmed = value.trim();

    return trimmed ? trimmed : null;

}

function normalizeMnemonic(value) {

    if (typeof value !== "string") {

        return null;

    }

    const words = value.trim().split(/\s+/).filter(Boolean);

    return words.length ? words.join(" ") : null;

}

function normalizeNetworkName(network) {

    return String(network ?? "").trim().toLowerCase();

}

function assertErrorHasNoSecretMaterial(error, env) {

    const haystack = `${error?.message ?? ""}\n${error?.stack ?? ""}\n${JSON.stringify(error)}`;
    const dedicated = normalizeMnemonic(env?.[TESTNET_DEPOSIT_DEPLOYER_MNEMONIC_ENV]);
    const production = normalizeMnemonic(env?.TON_DEPLOYER_MNEMONIC);

    if (dedicated && haystack.includes(dedicated)) {

        throw new TestnetDepositDeployerError(
            TESTNET_DEPOSIT_DEPLOYER_CREDENTIAL_REQUIRED,
            TESTNET_DEPOSIT_DEPLOYER_CREDENTIAL_REQUIRED
        );

    }

    if (production && haystack.includes(production)) {

        throw new TestnetDepositDeployerError(
            TESTNET_DEPOSIT_DEPLOYER_CREDENTIAL_REQUIRED,
            TESTNET_DEPOSIT_DEPLOYER_CREDENTIAL_REQUIRED
        );

    }

}

/**
 * Fail-closed credential + network check. Does not load a wallet.
 * Never returns mnemonic values.
 */
export function assertTestnetDepositDeployerConfig(env = process.env) {

    const network = normalizeNetworkName(env.TON_NETWORK);

    if (network !== "testnet") {

        throw new TestnetDepositDeployerError(
            TESTNET_DEPOSIT_DEPLOYER_REQUIRES_TESTNET,
            TESTNET_DEPOSIT_DEPLOYER_REQUIRES_TESTNET
        );

    }

    const dedicated = normalizeMnemonic(env[TESTNET_DEPOSIT_DEPLOYER_MNEMONIC_ENV]);

    if (!dedicated) {

        throw new TestnetDepositDeployerError(
            TESTNET_DEPOSIT_DEPLOYER_CREDENTIAL_REQUIRED,
            TESTNET_DEPOSIT_DEPLOYER_CREDENTIAL_REQUIRED
        );

    }

    const production = normalizeMnemonic(env.TON_DEPLOYER_MNEMONIC);

    if (production && dedicated === production) {

        throw new TestnetDepositDeployerError(
            TESTNET_DEPOSIT_DEPLOYER_MUST_NOT_EQUAL_PRODUCTION_DEPLOYER,
            TESTNET_DEPOSIT_DEPLOYER_MUST_NOT_EQUAL_PRODUCTION_DEPLOYER
        );

    }

    return Object.freeze({
        role: TESTNET_DEPOSIT_DEPLOYER_ROLE,
        network,
        configured: true,
        expectedAddress: trimOrNull(env[TESTNET_DEPOSIT_DEPLOYER_EXPECTED_ADDRESS_ENV])
    });

}

/**
 * Derive the public TESTNET Deposit deployer identity.
 * Uses TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC only.
 */
export async function getTestnetDepositDeployer(env = process.env) {

    const config = assertTestnetDepositDeployerConfig(env);
    const dedicated = normalizeMnemonic(env[TESTNET_DEPOSIT_DEPLOYER_MNEMONIC_ENV]);

    let identity;

    try {

        identity = await deriveDeployerWalletIdentity({
            mnemonic: dedicated,
            network: config.network
        });

    } catch (error) {

        assertErrorHasNoSecretMaterial(error, env);

        throw new TestnetDepositDeployerError(
            "TESTNET_DEPOSIT_DEPLOYER_IDENTITY_DERIVATION_FAILED",
            "Dedicated testnet Deposit deployer identity derivation failed"
        );

    }

    const walletAddress = identity.address;

    if (config.expectedAddress) {

        const expected = canonicalizeTonWalletAddress(config.expectedAddress)
            || config.expectedAddress;
        const actual = canonicalizeTonWalletAddress(walletAddress)
            || walletAddress;

        if (expected !== actual) {

            throw new TestnetDepositDeployerError(
                "TESTNET_DEPOSIT_DEPLOYER_ADDRESS_MISMATCH",
                "Dedicated testnet Deposit deployer address does not match expected pin"
            );

        }

    }

    const forbidden = canonicalizeTonWalletAddress(PRODUCTION_DEPLOY_WALLET)
        || PRODUCTION_DEPLOY_WALLET;
    const canonical = canonicalizeTonWalletAddress(walletAddress)
        || walletAddress;

    if (canonical === forbidden) {

        throw new TestnetDepositDeployerError(
            TESTNET_DEPOSIT_DEPLOYER_MUST_NOT_EQUAL_PRODUCTION_DEPLOYER,
            TESTNET_DEPOSIT_DEPLOYER_MUST_NOT_EQUAL_PRODUCTION_DEPLOYER
        );

    }

    return Object.freeze({
        role: TESTNET_DEPOSIT_DEPLOYER_ROLE,
        network: config.network,
        walletAddress,
        walletVersion: identity.walletContractType || DEPLOYER_WALLET_CONTRACT_TYPE,
        workchain: identity.workchain,
        walletId: identity.walletId
    });

}

function publicProductionDeployerAddress(address) {

    return canonicalizeTonWalletAddress(address) || address || null;

}

/**
 * Safe readiness snapshot. Never includes mnemonic/private key/seed.
 */
export async function inspectTestnetDepositDeployerReadiness(env = process.env) {

    const network = normalizeNetworkName(env.TON_NETWORK) || null;
    const dedicatedConfigured = Boolean(
        normalizeMnemonic(env[TESTNET_DEPOSIT_DEPLOYER_MNEMONIC_ENV])
    );
    const productionConfigured = Boolean(normalizeMnemonic(env.TON_DEPLOYER_MNEMONIC));

    let dedicatedAddress = null;
    let dedicatedStatus = "NOT CONFIGURED";
    let productionAddress = null;
    let blocker = null;

    if (!dedicatedConfigured) {

        dedicatedStatus = "NOT CONFIGURED";
        blocker = TESTNET_DEPOSIT_DEPLOYER_CREDENTIAL_REQUIRED;

    } else {

        try {

            const deployer = await getTestnetDepositDeployer(env);

            dedicatedAddress = deployer.walletAddress;
            dedicatedStatus = "CONFIGURED";

        } catch (error) {

            assertErrorHasNoSecretMaterial(error, env);

            dedicatedStatus = "BLOCKED";
            blocker = error?.code || "TESTNET_DEPOSIT_DEPLOYER_BLOCKED";

        }

    }

    if (productionConfigured) {

        try {

            const identity = await deriveDeployerWalletIdentity({
                mnemonic: normalizeMnemonic(env.TON_DEPLOYER_MNEMONIC),
                network: network || null
            });

            productionAddress = publicProductionDeployerAddress(identity.address);

        } catch (error) {

            assertErrorHasNoSecretMaterial(error, env);

            productionAddress = null;

        }

    }

    const addressesIdentical = dedicatedAddress && productionAddress
        ? (canonicalizeTonWalletAddress(dedicatedAddress)
            === canonicalizeTonWalletAddress(productionAddress))
        : false;

    return Object.freeze({
        network,
        dedicatedConfigured,
        productionConfigured,
        dedicatedStatus,
        dedicatedAddress,
        productionAddress,
        addressesIdentical,
        blocker,
        liveDeploymentBlocked: dedicatedStatus !== "CONFIGURED"
    });

}
