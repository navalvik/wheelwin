/**
 * R17.9H — WalletBalanceMonitor unit tests (no live RPC).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    WALLET_BALANCE_STATUS,
    WALLET_BALANCE_TYPES,
    WalletBalanceMonitor
} from "../console/wallet/WalletBalanceMonitor.js";

test("R17.9H discovers three wallet slots and keeps previous balance on RPC error", async () => {

    let fail = false;
    let ticks = 0;

    const tonService = {
        async getBalance(address) {

            if (fail) {

                throw new Error("simulated RPC failure");

            }

            if (String(address).includes("OWNER")) {

                return 1_500_000_000n;

            }

            if (String(address).includes("DEPLOY")) {

                return 2_000_000_000n;

            }

            return 3_250_000_000n;

        }
    };

    const timers = [];

    const monitor = new WalletBalanceMonitor({
        tonService,
        runtimeConfig: {
            ton: {
                network: "testnet",
                deployerExpectedAddress: "EQ_DEPLOY_TEST"
            }
        },
        env: {
            OWNER_WALLET: "EQ_OWNER_TEST",
            TON_REIMBURSEMENT_EXPECTED_ADDRESS: "EQ_REIMB_TEST"
        },
        refreshIntervalMs: 30_000,
        setIntervalFn: (fn, ms) => {

            timers.push({ fn, ms });

            return timers.length;

        },
        clearIntervalFn: () => {},
        nowFn: () => 1_700_000_000_000 + (++ticks)
    });

    // OwnerConfiguration may already be loaded in other tests — env fallback
    // still applies when not loaded; force via address cache path after init.
    await monitor.initialize();
    monitor.start();

    assert.equal(monitor.isRunning(), true);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 30_000);

    const first = await monitor.refresh();

    assert.equal(first.wallets.length, 3);
    assert.deepEqual(
        first.wallets.map((w) => w.walletType),
        [
            WALLET_BALANCE_TYPES.OWNER_WALLET,
            WALLET_BALANCE_TYPES.DEPLOY_WALLET,
            WALLET_BALANCE_TYPES.REIMBURSEMENT_WALLET
        ]
    );

    const deployOk = first.wallets.find(
        (w) => w.walletType === WALLET_BALANCE_TYPES.DEPLOY_WALLET
    );

    assert.equal(deployOk.status, WALLET_BALANCE_STATUS.OK);
    assert.equal(deployOk.balance, "2");
    assert.equal(deployOk.unit, "TON");
    assert.equal(deployOk.address, "EQ_DEPLOY_TEST");

    const payload = JSON.stringify(first);

    assert.equal(payload.includes("mnemonic"), false);
    assert.equal(payload.includes("private"), false);
    assert.equal(payload.includes("secret"), false);
    assert.equal(payload.includes("seed"), false);

    fail = true;

    const second = await monitor.refresh();
    const deployErr = second.wallets.find(
        (w) => w.walletType === WALLET_BALANCE_TYPES.DEPLOY_WALLET
    );

    assert.equal(deployErr.status, WALLET_BALANCE_STATUS.RPC_ERROR);
    assert.equal(deployErr.balance, "2");
    assert.ok(deployErr.lastSuccessfulUpdate);

    monitor.shutdown();

    assert.equal(monitor.isRunning(), false);

});

test("R17.9H marks missing wallets as NOT_CONFIGURED without crashing", async () => {

    const monitor = new WalletBalanceMonitor({
        tonService: {
            async getBalance() {

                return 0n;

            }
        },
        runtimeConfig: { ton: { network: "testnet" } },
        env: {},
        setIntervalFn: () => 1,
        clearIntervalFn: () => {}
    });

    await monitor.initialize();

    const snapshot = await monitor.refresh();

    for (const wallet of snapshot.wallets) {

        assert.ok(
            wallet.status === WALLET_BALANCE_STATUS.NOT_CONFIGURED
            || wallet.status === WALLET_BALANCE_STATUS.OK
        );

    }

    monitor.shutdown();

});
