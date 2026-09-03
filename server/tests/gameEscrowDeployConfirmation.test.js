/**
 * GameEscrow DEPLOY confirmation: sendBoc + seqno are not sufficient.
 * On-chain escrow account (active + expected code + deploy tx) is required.
 */
import assert from "node:assert/strict";

import { toNano } from "@ton/core";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import { resetTonDeployDebugForTests } from "../diagnostics/DeployPipelineForensics.js";
import {
    TonGameContractAdapter,
    resetDeployerSendLocksForTests
} from "../payment/TonGameContractAdapter.js";
import { loadGameEscrowCodeCell } from "../payment/ton/buildGameEscrowStateInit.js";
import { MockTonTransport } from "../payment/ton/MockTonTransport.js";

const TEST_MNEMONIC = [
    "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
    "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
    "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
    "abandon", "abandon", "abandon", "abandon", "abandon", "art"
].join(" ");

const ZERO_TX_HASH = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const SNAPSHOT = Object.freeze({
    gameId: "game_deploy_confirm",
    roomId: "room_deploy_confirm",
    totalPot: 30,
    players: []
});

function deployedAccount(overrides = {}) {

    return {
        state: "active",
        balance: "500000000",
        code: loadGameEscrowCodeCell().toBoc().toString("base64"),
        last_transaction_id: {
            lt: "1",
            hash: "escrow-deploy-tx"
        },
        ...overrides
    };

}

function uninitializedAccount() {

    return {
        state: "uninitialized",
        balance: "0",
        code: "",
        last_transaction_id: {
            lt: "0",
            hash: ZERO_TX_HASH
        }
    };

}

async function deployerAddress() {

    const keyPair = await mnemonicToPrivateKey(
        TEST_MNEMONIC.split(/\s+/).filter(Boolean)
    );

    return WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey
    }).address.toString({ bounceable: true, urlSafe: true });

}

function createAdapter(tonService, overrides = {}) {

    return new TonGameContractAdapter({
        tonConfig: {
            endpoint: "https://testnet.toncenter.com/api/v2/jsonRPC",
            apiKey: null,
            deployerMnemonic: TEST_MNEMONIC,
            network: "testnet",
            gameEscrowMode: "game",
            pollIntervalMs: 200,
            escrowActivationTimeoutMs: 3000,
            settlementTxLookupTimeoutMs: 2000,
            settlementTxLookupPollMs: 40,
            ...overrides
        },
        tonService
    });

}

function createTonService({
    transport,
    getAccount,
    getSeqno,
    onBroadcast = null
}) {

    return {
        getActiveNetwork: () => "testnet",
        isConnected: () => true,
        async broadcastTransaction(boc) {

            if (onBroadcast) {

                await onBroadcast(boc);

            }

            return transport.sendBoc(boc);

        },
        getAccount,
        async getBalance() {

            return toNano("0.5");

        },
        getSeqno,
        async getTransactions(address) {

            return transport.getTransactions(address);

        },
        async runGetMethod() {

            return { stack: [] };

        }
    };

}

function wrapSendToAdvanceSeqno(adapter, tonService, transport, seqnoBox, wallet) {

    const originalSend = adapter._sendOracleMessage.bind(adapter);

    adapter._sendOracleMessage = async (opts) => {

        const destination = typeof opts.to === "string"
            ? opts.to
            : opts.to.toString({ bounceable: true, urlSafe: true });

        const previousBroadcast = tonService.broadcastTransaction;

        tonService.broadcastTransaction = async (boc) => {

            const seqnoUsed = seqnoBox.value;
            seqnoBox.value += 1;
            transport.seedTransactions(wallet, [
                {
                    utime: Math.floor(Date.now() / 1000) + 5,
                    transaction_id: {
                        hash: `deployer-tx-${seqnoUsed}`,
                        lt: String(1000 + seqnoUsed)
                    },
                    out_msgs: [{ destination }],
                    success: true
                }
            ]);

            return previousBroadcast(boc);

        };

        try {

            return await originalSend(opts);

        } finally {

            tonService.broadcastTransaction = previousBroadcast;

        }

    };

}

async function main() {

    resetTonDeployDebugForTests();
    resetDeployerSendLocksForTests();

    const wallet = await deployerAddress();

    // 1. sendBoc + successful on-chain GameEscrow deployment → confirmed
    {
        const transport = new MockTonTransport();
        const seqnoBox = { value: 0 };
        let accountCalls = 0;

        const tonService = createTonService({
            transport,
            async getAccount() {

                accountCalls += 1;

                return accountCalls >= 2
                    ? deployedAccount()
                    : uninitializedAccount();

            },
            async getSeqno() {

                return seqnoBox.value;

            }
        });

        const adapter = createAdapter(tonService);
        wrapSendToAdvanceSeqno(adapter, tonService, transport, seqnoBox, wallet);

        const result = await adapter.deployContract({
            contractId: "contract_confirm_ok",
            snapshot: SNAPSHOT
        });

        assert.equal(result.ok, true, "deployed escrow must confirm");
        assert.ok(result.contractAddress);
        assert.ok(result.deploymentTxId);
        assert.ok(transport.sentBocs.length === 1);

        console.log("  1 sendBoc + on-chain deploy → confirmed: OK");
    }

    resetTonDeployDebugForTests();
    resetDeployerSendLocksForTests();

    // 2. sendBoc + unchanged seqno but GameEscrow deployed → confirmed
    {
        const transport = new MockTonTransport();
        const currentSeqno = 7;
        let sendCount = 0;

        const tonService = createTonService({
            transport,
            async getAccount() {

                return deployedAccount({
                    last_transaction_id: {
                        lt: "42",
                        hash: "stale-seqno-escrow-tx"
                    }
                });

            },
            async getSeqno() {

                return currentSeqno;

            },
            onBroadcast() {

                sendCount += 1;

            }
        });

        const adapter = createAdapter(tonService, {
            settlementTxLookupTimeoutMs: 200,
            settlementTxLookupPollMs: 40,
            escrowActivationTimeoutMs: 3000
        });

        const result = await adapter.deployContract({
            contractId: "contract_stale_seqno_deployed",
            snapshot: SNAPSHOT
        });

        assert.equal(
            result.ok,
            true,
            "deployed escrow must confirm even if seqno monitoring is stale"
        );
        assert.equal(result.deploymentTxId, "stale-seqno-escrow-tx");
        assert.equal(sendCount, 1);
        assert.equal(transport.sentBocs.length, 1);

        console.log("  2 sendBoc + stale seqno + deployed escrow → confirmed: OK");
    }

    resetTonDeployDebugForTests();
    resetDeployerSendLocksForTests();

    // 3. sendBoc + GameEscrow remains uninitialized → not confirmed
    {
        const transport = new MockTonTransport();
        const seqnoBox = { value: 0 };

        const tonService = createTonService({
            transport,
            async getAccount() {

                return uninitializedAccount();

            },
            async getSeqno() {

                return seqnoBox.value;

            }
        });

        const adapter = createAdapter(tonService, {
            escrowActivationTimeoutMs: 400
        });
        wrapSendToAdvanceSeqno(adapter, tonService, transport, seqnoBox, wallet);

        const result = await adapter.deployContract({
            contractId: "contract_uninit",
            snapshot: SNAPSHOT
        });

        assert.equal(result.ok, false);
        assert.equal(result.reason, "escrow_activation_timeout");
        assert.equal(transport.sentBocs.length, 1);

        console.log("  3 sendBoc + uninitialized escrow → not confirmed: OK");
    }

    resetTonDeployDebugForTests();
    resetDeployerSendLocksForTests();

    // 4. No deployment transaction → not confirmed
    {
        const transport = new MockTonTransport();
        const seqnoBox = { value: 0 };

        const tonService = createTonService({
            transport,
            async getAccount() {

                return deployedAccount({
                    last_transaction_id: {
                        lt: "0",
                        hash: ZERO_TX_HASH
                    }
                });

            },
            async getSeqno() {

                return seqnoBox.value;

            }
        });

        const adapter = createAdapter(tonService, {
            escrowActivationTimeoutMs: 400
        });
        wrapSendToAdvanceSeqno(adapter, tonService, transport, seqnoBox, wallet);

        const result = await adapter.deployContract({
            contractId: "contract_no_tx",
            snapshot: SNAPSHOT
        });

        assert.equal(result.ok, false);
        assert.equal(result.reason, "escrow_activation_timeout");
        assert.equal(transport.sentBocs.length, 1);

        console.log("  4 active code without deploy tx → not confirmed: OK");
    }

    resetTonDeployDebugForTests();
    resetDeployerSendLocksForTests();

    // 5 + 6. Seqno confirmation failure does not resend; uninitialized stays failed
    {
        const transport = new MockTonTransport();
        const currentSeqno = 11;
        let sendCount = 0;

        const tonService = createTonService({
            transport,
            async getAccount() {

                return uninitializedAccount();

            },
            async getSeqno() {

                return currentSeqno;

            },
            onBroadcast() {

                sendCount += 1;

            }
        });

        const adapter = createAdapter(tonService, {
            settlementTxLookupTimeoutMs: 200,
            settlementTxLookupPollMs: 40,
            escrowActivationTimeoutMs: 400
        });

        const result = await adapter.deployContract({
            contractId: "contract_no_duplicate",
            snapshot: SNAPSHOT
        });

        assert.equal(result.ok, false);
        assert.equal(result.reason, "escrow_activation_timeout");
        assert.equal(sendCount, 1, "must not resend deploy because seqno did not change");
        assert.equal(transport.sentBocs.length, 1);

        console.log("  5/6 seqno miss does not duplicate deploy in one attempt: OK");
    }

    console.log("gameEscrowDeployConfirmation.test.js: all assertions passed");

}

main().catch((error) => {

    console.error(error);
    process.exit(1);

});
