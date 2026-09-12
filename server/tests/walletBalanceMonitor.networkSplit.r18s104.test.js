/**
 * r18-s104 — WalletBalanceMonitor network split tests (no live RPC).
 *
 * Verifies the read-only Testnet/Mainnet monitoring split:
 * - Mainnet profile resolves ONLY mainnet-only pins (TON_MAINNET_*);
 * - Application (Testnet) profile behavior is unchanged;
 * - Each profile queries ONLY its own TonService;
 * - There is no cross-network fallback in any failure mode;
 * - Snapshots never carry credential material.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    WALLET_BALANCE_STATUS,
    WALLET_BALANCE_TYPES,
    WalletBalanceMonitor,
    selectWalletNetworkSnapshot
} from "../console/wallet/WalletBalanceMonitor.js";

// r18-s104 — Operator-confirmed Mainnet identities (public addresses only).
const MAINNET_OWNER = "EQC_xk04sMe07ttDQHq0ZIFxDAiYJChQ8IzgLgxEXlYmsDuc";
const MAINNET_DEPLOYMENT = "EQBry-bfWJTLfPBHmft1_Rtt-WUvQhI4tpf2aX96G-FYKe5a";
const MAINNET_RESIDUES = "EQD-ylhSs7YLUJpZymRiiX2HnovASnwS9LbhK9OidoveBZJE";

// Testnet-era application-network fixtures (public addresses).
const TESTNET_OWNER = "EQBaklBYMdMsuq7a2eTYhMkz1OF7ZSHaO1mnFd1MZd3YjMgi";
const TESTNET_DEPLOYMENT = "EQBry-bfWJTLfPBHmft1_Rtt-WUvQhI4tpf2aX96G-FYKe5a";

function createRecordingService(calls, balances) {

    return {
        async getBalance(address) {

            calls.push(String(address));

            const nano = balances[String(address)];

            if (nano === undefined) {

                throw new Error(`unexpected address: ${address}`);

            }

            return nano;

        }
    };

}

const APPLICATION_BALANCES = {
    [TESTNET_OWNER]: 1_500_000_000n,
    [TESTNET_DEPLOYMENT]: 2_000_000_000n
};

const MAINNET_BALANCES = {
    [MAINNET_OWNER]: 1_000_000_000n,
    [MAINNET_DEPLOYMENT]: 2_500_000_000n,
    [MAINNET_RESIDUES]: 500_000_000n
};

function createMonitor({ tonService = null, mainnetTonService = null, env = {} } = {}) {

    const monitor = new WalletBalanceMonitor({
        tonService,
        mainnetTonService,
        runtimeConfig: {
            ton: {
                network: "testnet",
                deployerExpectedAddress: TESTNET_DEPLOYMENT
            }
        },
        env: {
            OWNER_WALLET: TESTNET_OWNER,
            TON_MAINNET_OWNER_WALLET: env.TON_MAINNET_OWNER_WALLET ?? MAINNET_OWNER,
            TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS:
                env.TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS ?? MAINNET_DEPLOYMENT,
            TON_MAINNET_RESIDUES_EXPECTED_ADDRESS:
                env.TON_MAINNET_RESIDUES_EXPECTED_ADDRESS ?? MAINNET_RESIDUES,
            ...env
        },
        setIntervalFn: () => 1,
        clearIntervalFn: () => {},
        nowFn: (() => {

            let ticks = 0;

            return () => 1_700_000_000_000 + (++ticks);

        })()
    });

    return monitor;

}

function findWallet(wallets, walletType) {

    return wallets.find((wallet) => wallet.walletType === walletType);

}

test("r18-s104 Mainnet profile resolves the operator-confirmed Mainnet Owner address", async () => {

    const mainnetCalls = [];

    const monitor = createMonitor({
        tonService: createRecordingService([], APPLICATION_BALANCES),
        mainnetTonService: createRecordingService(mainnetCalls, MAINNET_BALANCES)
    });

    await monitor.initialize();
    const snapshot = await monitor.refresh();

    const mainnetProfile = snapshot.networkProfiles.mainnet;

    assert.equal(mainnetProfile.network, "mainnet");
    assert.equal(mainnetProfile.enabled, true);

    const owner = findWallet(mainnetProfile.wallets, WALLET_BALANCE_TYPES.OWNER_WALLET);

    assert.equal(owner.address, MAINNET_OWNER);
    assert.equal(owner.network, "mainnet");
    assert.equal(owner.balance, "1");
    assert.equal(owner.status, WALLET_BALANCE_STATUS.OK);
    assert.match(owner.accountId, /^0:[0-9a-f]{64}$/);

    assert.deepEqual(
        mainnetCalls.sort(),
        [MAINNET_DEPLOYMENT, MAINNET_OWNER, MAINNET_RESIDUES].sort()
    );

    monitor.shutdown();

});

test("r18-s104 Mainnet Deployment/Oracle and Residues resolve from mainnet-only pins", async () => {

    const mainnetCalls = [];

    const monitor = createMonitor({
        tonService: createRecordingService([], APPLICATION_BALANCES),
        mainnetTonService: createRecordingService(mainnetCalls, MAINNET_BALANCES)
    });

    await monitor.initialize();
    const snapshot = await monitor.refresh();

    const deployment = findWallet(
        snapshot.networkProfiles.mainnet.wallets,
        WALLET_BALANCE_TYPES.DEPLOYMENT_WALLET
    );
    const residues = findWallet(
        snapshot.networkProfiles.mainnet.wallets,
        WALLET_BALANCE_TYPES.RESIDUES_WALLET
    );

    assert.equal(deployment.address, MAINNET_DEPLOYMENT);
    assert.equal(deployment.network, "mainnet");
    assert.equal(deployment.balance, "2.5");

    assert.equal(residues.address, MAINNET_RESIDUES);
    assert.equal(residues.network, "mainnet");
    assert.equal(residues.balance, "0.5");

    assert.deepEqual(
        mainnetCalls.sort(),
        [MAINNET_DEPLOYMENT, MAINNET_OWNER, MAINNET_RESIDUES].sort()
    );

    monitor.shutdown();

});

test("r18-s104 Testnet application profile is unchanged and never inherits Mainnet pins", async () => {

    const applicationCalls = [];
    const mainnetCalls = [];

    const monitor = createMonitor({
        tonService: createRecordingService(applicationCalls, APPLICATION_BALANCES),
        mainnetTonService: createRecordingService(mainnetCalls, MAINNET_BALANCES)
    });

    await monitor.initialize();
    const snapshot = await monitor.refresh();

    assert.equal(snapshot.network, "testnet");
    assert.equal(snapshot.applicationNetwork, "testnet");
    assert.equal(snapshot.networkProfiles.testnet.network, "testnet");

    const owner = findWallet(snapshot.wallets, WALLET_BALANCE_TYPES.OWNER_WALLET);
    const deployment = findWallet(snapshot.wallets, WALLET_BALANCE_TYPES.DEPLOYMENT_WALLET);
    const residues = findWallet(snapshot.wallets, WALLET_BALANCE_TYPES.RESIDUES_WALLET);

    assert.equal(owner.address, TESTNET_OWNER);
    assert.equal(owner.network, "testnet");

    assert.equal(deployment.address, TESTNET_DEPLOYMENT);
    assert.equal(deployment.network, "testnet");

    // The application-network Residues pin is unset — the Mainnet Residues
    // pin must NOT be inherited (no cross-network fallback).
    assert.equal(residues.status, WALLET_BALANCE_STATUS.NOT_CONFIGURED);
    assert.equal(residues.address, null);

    // Each service is queried only with its own profile's addresses.
    assert.deepEqual(
        applicationCalls.sort(),
        [TESTNET_DEPLOYMENT, TESTNET_OWNER].sort()
    );
    assert.deepEqual(
        mainnetCalls.sort(),
        [MAINNET_DEPLOYMENT, MAINNET_OWNER, MAINNET_RESIDUES].sort()
    );

    monitor.shutdown();

});

test("r18-s104 no cross-network fallback when a profile service is unavailable", async () => {

    // Mainnet TonService missing → Mainnet UNAVAILABLE, Testnet stays OK.
    const withoutMainnet = createMonitor({
        tonService: createRecordingService([], APPLICATION_BALANCES)
    });

    await withoutMainnet.initialize();
    const snapshotA = await withoutMainnet.refresh();

    const mainnetOwnerA = findWallet(
        snapshotA.networkProfiles.mainnet.wallets,
        WALLET_BALANCE_TYPES.OWNER_WALLET
    );
    const appOwnerA = findWallet(snapshotA.wallets, WALLET_BALANCE_TYPES.OWNER_WALLET);

    assert.equal(mainnetOwnerA.status, WALLET_BALANCE_STATUS.UNAVAILABLE);
    assert.equal(mainnetOwnerA.error, "Mainnet TonService is unavailable");
    assert.equal(mainnetOwnerA.address, MAINNET_OWNER);
    assert.equal(appOwnerA.status, WALLET_BALANCE_STATUS.OK);

    withoutMainnet.shutdown();

    // Application TonService missing → Testnet UNAVAILABLE, Mainnet stays OK.
    const mainnetCalls = [];

    const withoutApplication = createMonitor({
        mainnetTonService: createRecordingService(mainnetCalls, MAINNET_BALANCES)
    });

    await withoutApplication.initialize();
    const snapshotB = await withoutApplication.refresh();

    const appOwnerB = findWallet(snapshotB.wallets, WALLET_BALANCE_TYPES.OWNER_WALLET);
    const mainnetOwnerB = findWallet(
        snapshotB.networkProfiles.mainnet.wallets,
        WALLET_BALANCE_TYPES.OWNER_WALLET
    );

    assert.equal(appOwnerB.status, WALLET_BALANCE_STATUS.UNAVAILABLE);
    assert.equal(appOwnerB.error, "TonService is unavailable");
    assert.equal(mainnetOwnerB.status, WALLET_BALANCE_STATUS.OK);
    assert.equal(mainnetOwnerB.balance, "1");

    withoutApplication.shutdown();

});

test("r18-s104 Mainnet profile is disabled without mainnet-only pins (fail closed)", async () => {

    const monitor = createMonitor({
        tonService: createRecordingService([], APPLICATION_BALANCES),
        env: {
            TON_MAINNET_OWNER_WALLET: "",
            TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS: "",
            TON_MAINNET_RESIDUES_EXPECTED_ADDRESS: ""
        }
    });

    await monitor.initialize();
    const snapshot = await monitor.refresh();

    const mainnetProfile = snapshot.networkProfiles.mainnet;

    assert.equal(mainnetProfile.enabled, false);
    assert.equal(
        findWallet(mainnetProfile.wallets, WALLET_BALANCE_TYPES.OWNER_WALLET).status,
        WALLET_BALANCE_STATUS.NOT_CONFIGURED
    );
    assert.equal(
        findWallet(mainnetProfile.wallets, WALLET_BALANCE_TYPES.OWNER_WALLET).address,
        null
    );

    monitor.shutdown();

});

test("r18-s104 selectWalletNetworkSnapshot is explicit and fallback-free", async () => {

    const monitor = createMonitor({
        tonService: createRecordingService([], APPLICATION_BALANCES),
        mainnetTonService: createRecordingService([], MAINNET_BALANCES)
    });

    await monitor.initialize();
    await monitor.refresh();
    const snapshot = monitor.getSnapshot();

    const testnet = selectWalletNetworkSnapshot(snapshot, "testnet");
    const mainnet = selectWalletNetworkSnapshot(snapshot, " MAINNET ");

    assert.equal(testnet.profile.network, "testnet");
    assert.equal(mainnet.profile.network, "mainnet");

    assert.equal(selectWalletNetworkSnapshot(snapshot, "devnet"), null);
    assert.equal(selectWalletNetworkSnapshot(snapshot, null), null);
    assert.equal(selectWalletNetworkSnapshot(null, "testnet"), null);

    monitor.shutdown();

});

test("r18-s104 split snapshot payload never carries credential material", async () => {

    const monitor = createMonitor({
        tonService: createRecordingService([], APPLICATION_BALANCES),
        mainnetTonService: createRecordingService([], MAINNET_BALANCES)
    });

    await monitor.initialize();
    const snapshot = await monitor.refresh();

    const payload = JSON.stringify(snapshot);

    assert.equal(payload.includes("mnemonic"), false);
    assert.equal(payload.includes("private"), false);
    assert.equal(payload.includes("secret"), false);
    assert.equal(payload.includes("seed"), false);
    assert.equal(payload.includes("REIMBURSEMENT_WALLET"), false);

    monitor.shutdown();

});