/**
 * R17.8M.2 — Deployer balance preflight guard tests.
 */

import assert from "node:assert/strict";

import { toNano } from "@ton/core";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import {
    getTonDeployDebug,
    resetTonDeployDebugForTests
} from "../diagnostics/DeployPipelineForensics.js";
import { TonGameContractAdapter } from "../payment/TonGameContractAdapter.js";
import { checkDeployerBalancePreflight } from "../payment/ton/checkDeployerBalancePreflight.js";
import {
    DEPLOYER_MIN_BALANCE_REQUIRED_NANO,
    DEPLOYER_MIN_BALANCE_REQUIRED_TON
} from "../payment/ton/deployerBalancePolicy.js";
import { createLegacyTonServiceShim } from "../payment/ton/gameContract/legacyTonServiceShim.js";
import { MockTonTransport } from "../payment/ton/MockTonTransport.js";
import { DEFAULT_TON_RETRY_POLICY } from "../services/ton/TonServiceRetry.js";

const TEST_MNEMONIC = [
    "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
    "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
    "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
    "abandon", "abandon", "abandon", "abandon", "abandon", "about"
].join(" ");

const SECRET_MARKERS = [
    "mnemonic",
    "privateKey",
    "secret",
    "seed",
    "TON_DEPLOYER_MNEMONIC"
];

const baseSnapshot = Object.freeze({
    gameId: "game_preflight",
    roomId: "room_preflight",
    totalPot: 30,
    players: []
});

function assertNoSecrets(payload) {

    const serialized = JSON.stringify(payload).toLowerCase();

    for (const marker of SECRET_MARKERS) {

        assert.equal(
            serialized.includes(marker.toLowerCase()),
            false,
            `Payload must not contain "${marker}"`
        );

    }

    assert.equal(
        serialized.includes(TEST_MNEMONIC.split(" ")[0]),
        false,
        "Payload must not contain mnemonic words"
    );

}

function createDeployTonService({
    balanceNano = toNano("0.5"),
    transport = new MockTonTransport()
} = {}) {

    let accountCalls = 0;
    let currentSeqno = 0;

    return {
        transport,
        service: {
            getActiveNetwork: () => "testnet",
            isConnected: () => true,
            async broadcastTransaction(boc) {

                return transport.sendBoc(boc);

            },
            async getBalance() {

                return balanceNano;

            },
            async getAccount() {

                accountCalls += 1;

                return {
                    state: accountCalls >= 2 ? "active" : "uninitialized",
                    balance: String(balanceNano)
                };

            },
            async getSeqno() {

                return currentSeqno;

            },
            async getTransactions(address) {

                return transport.getTransactions(address);

            },
            async runGetMethod() {

                return { stack: [] };

            }
        },
        get currentSeqno() {

            return currentSeqno;

        },
        advanceSeqno() {

            currentSeqno += 1;

        }
    };

}

async function runPreflightUnitTests() {

    const pass = await checkDeployerBalancePreflight({
        tonConfig: {
            deployerMnemonic: TEST_MNEMONIC,
            network: "testnet"
        },
        tonService: {
            getActiveNetwork: () => "testnet",
            async getBalance() {

                return toNano("0.5");

            }
        }
    });

    assert.equal(pass.ok, true);
    assert.equal(pass.requiredBalance, DEPLOYER_MIN_BALANCE_REQUIRED_TON);
    assertNoSecrets(pass);

    const fail = await checkDeployerBalancePreflight({
        tonConfig: {
            deployerMnemonic: TEST_MNEMONIC,
            network: "testnet"
        },
        tonService: {
            getActiveNetwork: () => "testnet",
            async getBalance() {

                return toNano("0.007");

            }
        }
    });

    assert.equal(fail.ok, false);
    assert.equal(fail.reason, "INSUFFICIENT_DEPLOYER_BALANCE");
    assert.equal(fail.availableBalance, "0.007");
    assertNoSecrets(fail);

    assert.ok(DEPLOYER_MIN_BALANCE_REQUIRED_NANO > toNano("0.007"));
    assert.ok(DEPLOYER_MIN_BALANCE_REQUIRED_NANO <= toNano("0.2"));

    {
        let accountCalls = 0;
        const fastRetry = {
            maxAttempts: DEFAULT_TON_RETRY_POLICY.maxAttempts,
            initialDelayMs: 1,
            maxDelayMs: 5,
            multiplier: 1,
            timeoutMs: 1000
        };

        const shim = createLegacyTonServiceShim({
            transport: {
                async sendBoc() {
                    return { ok: true };
                },
                async getAddressInformation() {

                    accountCalls += 1;

                    if (accountCalls === 1) {

                        const error = new Error("TonCenter HTTP 429");
                        error.status = 429;
                        error.responseBody = '{"ok":false,"result":"Ratelimit exceed","code":429}';
                        throw error;

                    }

                    return {
                        state: "active",
                        balance: String(toNano("0.5"))
                    };

                }
            },
            tonClient: {
                async runMethod() {
                    throw new Error("seqno must not run during preflight");
                }
            },
            tonConfig: { network: "testnet" },
            retryPolicy: fastRetry
        });

        assert.equal(typeof shim.getBalance, "undefined");

        const recovered = await checkDeployerBalancePreflight({
            tonConfig: {
                deployerMnemonic: TEST_MNEMONIC,
                network: "testnet"
            },
            tonService: shim
        });

        assert.equal(recovered.ok, true);
        assert.equal(accountCalls, 2);
        assertNoSecrets(recovered);
    }

    {
        let accountCalls = 0;
        const fastRetry = {
            maxAttempts: DEFAULT_TON_RETRY_POLICY.maxAttempts,
            initialDelayMs: 1,
            maxDelayMs: 5,
            multiplier: 1,
            timeoutMs: 1000
        };

        const shim = createLegacyTonServiceShim({
            transport: {
                async sendBoc() {
                    return { ok: true };
                },
                async getAddressInformation() {

                    accountCalls += 1;
                    const error = new Error("TonCenter HTTP 429");
                    error.status = 429;
                    throw error;

                }
            },
            tonClient: {
                async runMethod() {
                    throw new Error("seqno must not run during preflight");
                }
            },
            tonConfig: { network: "testnet" },
            retryPolicy: fastRetry
        });

        await assert.rejects(
            () => checkDeployerBalancePreflight({
                tonConfig: {
                    deployerMnemonic: TEST_MNEMONIC,
                    network: "testnet"
                },
                tonService: shim
            }),
            (error) => error.message === "TonCenter HTTP 429" && error.status === 429
        );

        assert.equal(accountCalls, DEFAULT_TON_RETRY_POLICY.maxAttempts);
    }

}

async function runDeployAdapterTests() {

    resetTonDeployDebugForTests();

    const keyPair = await mnemonicToPrivateKey(
        TEST_MNEMONIC.split(/\s+/).filter(Boolean)
    );
    const deployerAddress = WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey
    }).address.toString({ bounceable: true, urlSafe: true });

    // --- Test B — insufficient balance: sendBoc NOT called ---

    {
        const { service, transport } = createDeployTonService({
            balanceNano: toNano("0.007")
        });

        const adapter = new TonGameContractAdapter({
            tonConfig: {
                endpoint: "https://testnet.toncenter.com/api/v2/jsonRPC",
                apiKey: null,
                deployerMnemonic: TEST_MNEMONIC,
                network: "testnet"
            },
            tonService: service
        });

        const result = await adapter.deployContract({
            contractId: "contract_preflight_fail",
            snapshot: baseSnapshot
        });

        assert.equal(result.ok, false);
        assert.equal(result.reason, "INSUFFICIENT_DEPLOYER_BALANCE");
        assert.equal(transport.sentBocs.length, 0);
        assert.equal(result.diagnostics?.deployerAddress, deployerAddress);
        assert.equal(result.diagnostics?.requiredBalance, DEPLOYER_MIN_BALANCE_REQUIRED_TON);
        assertNoSecrets(result);

        const debug = getTonDeployDebug();
        assert.ok(debug?.stage.includes("GAME_CONTRACT_DEPLOY_PREFLIGHT_FAILED"));
        assert.equal(debug?.failureReason, "INSUFFICIENT_DEPLOYER_BALANCE");

    }

    resetTonDeployDebugForTests();

    // --- Test A — sufficient balance: deploy continues ---

    {
        const stack = createDeployTonService({
            balanceNano: toNano("0.5")
        });

        const adapter = new TonGameContractAdapter({
            tonConfig: {
                endpoint: "https://testnet.toncenter.com/api/v2/jsonRPC",
                apiKey: null,
                deployerMnemonic: TEST_MNEMONIC,
                network: "testnet",
                pollIntervalMs: 200,
                escrowActivationTimeoutMs: 3000
            },
            tonService: stack.service
        });

        const originalSend = adapter._sendOracleMessage.bind(adapter);

        adapter._sendOracleMessage = async (opts) => {

            const destination = typeof opts.to === "string"
                ? opts.to
                : opts.to.toString({ bounceable: true, urlSafe: true });

            const previousBroadcast = stack.service.broadcastTransaction;

            stack.service.broadcastTransaction = async (boc) => {

                const seqnoUsed = stack.currentSeqno;
                stack.advanceSeqno();
                stack.transport.seedTransactions(deployerAddress, [
                    {
                        utime: Math.floor(Date.now() / 1000) + 5,
                        transaction_id: {
                            hash: `preflight-pass-${seqnoUsed}`,
                            lt: String(3000 + seqnoUsed)
                        },
                        out_msgs: [{ destination }]
                    }
                ]);

                return previousBroadcast(boc);

            };

            try {

                return await originalSend(opts);

            } finally {

                stack.service.broadcastTransaction = previousBroadcast;

            }

        };

        const result = await adapter.deployContract({
            contractId: "contract_preflight_pass",
            snapshot: baseSnapshot
        });

        assert.equal(result.ok, true);
        assert.ok(stack.transport.sentBocs.length >= 1);

        const debug = getTonDeployDebug();
        assert.ok(debug?.stage.includes("GAME_CONTRACT_DEPLOY_PREFLIGHT_PASSED"));

    }

}

async function main() {

    await runPreflightUnitTests();
    await runDeployAdapterTests();

    process.stdout.write("deployerBalancePreflight.test.js passed\n");

}

main().catch((error) => {

    console.error(error);

    process.exit(1);

});
