/**
 * R7.70C2.6 — Sequential deployer wallet seqno confirmation.
 *
 * Proves the production exitcode=33 failure mode cannot recur:
 * DEPLOY / INIT_GAME / OPEN_PAYMENTS must use strictly increasing seqnos,
 * wait for on-chain seqno advancement (not mere broadcast acceptance),
 * refuse to confirm against a prior same-destination transaction,
 * and serialize concurrent sends against the same deployer wallet.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { beginCell, internal, toNano } from "@ton/core";
import { keyPairFromSeed, mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import {
    getTonDeployDebug,
    resetTonDeployDebugForTests
} from "../diagnostics/DeployPipelineForensics.js";
import {
    parseWalletV4SeqnoFromTransaction,
    resetDeployerSendLocksForTests,
    TonGameContractAdapter
} from "../payment/TonGameContractAdapter.js";
import { isInfrastructureFailure } from "../services/ton/TonServiceRetry.js";
import { serializeGameEscrowInitGameBody } from "../payment/ton/gameContract/GameContractSerializer.js";
import { MockTonTransport } from "../payment/ton/MockTonTransport.js";

const TEST_MNEMONIC = [
    "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
    "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
    "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
    "abandon", "abandon", "abandon", "abandon", "abandon", "art"
].join(" ");

const OWNER = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
const ORACLE = "EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j";
const HASH_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function friendlyAddress(seedLabel) {

    const seed = createHash("sha256").update(seedLabel).digest();
    const keyPair = keyPairFromSeed(seed);

    return WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey
    }).address.toString({
        bounceable: true,
        urlSafe: true
    });

}

async function resolveDeployerAddress() {

    const keyPair = await mnemonicToPrivateKey(
        TEST_MNEMONIC.split(/\s+/).filter(Boolean)
    );

    return WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey
    }).address.toString({ bounceable: true, urlSafe: true });

}

/**
 * Build a TonCenter-like in_msg.msg_data.body carrying Wallet V4 seqno.
 */
async function buildWalletV4InMsgBody(seqno, destination) {

    const keyPair = await mnemonicToPrivateKey(
        TEST_MNEMONIC.split(/\s+/).filter(Boolean)
    );

    const wallet = WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey
    });

    const transfer = wallet.createTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [
            internal({
                to: destination,
                value: toNano("0.05"),
                bounce: false,
                body: beginCell().endCell()
            })
        ]
    });

    return transfer.toBoc().toString("base64");

}

async function createTxFixture({
    seqno,
    destination,
    hash,
    lt,
    utime = Math.floor(Date.now() / 1000)
}) {

    const body = await buildWalletV4InMsgBody(seqno, destination);

    return {
        utime,
        transaction_id: { hash, lt: String(lt) },
        in_msg: {
            source: "",
            destination: await resolveDeployerAddress(),
            msg_data: {
                "@type": "msg.dataRaw",
                body
            }
        },
        out_msgs: [
            { destination }
        ]
    };

}

function createAdvancingService({
    transport,
    initialSeqno = 10,
    advanceOnBroadcast = true,
    seqnoSchedule = null
}) {

    let currentSeqno = initialSeqno;
    let seqnoReads = 0;
    const usedSeqnos = [];
    const broadcastAt = [];

    return {
        usedSeqnos,
        broadcastAt,
        getCurrentSeqno: () => currentSeqno,
        bumpSeqno: () => {

            currentSeqno += 1;

            return currentSeqno;

        },
        service: {
            getActiveNetwork: () => "testnet",
            isConnected: () => true,
            getTransport: () => transport,
            async broadcastTransaction(boc) {

                broadcastAt.push(Date.now());
                usedSeqnos.push(currentSeqno);

                if (advanceOnBroadcast) {

                    // Simulate chain acceptance: seqno advances after broadcast.
                    currentSeqno += 1;

                }

                return transport.sendBoc(boc);

            },
            async getAccount() {

                return { state: "active", balance: "0" };

            },
            async getSeqno() {

                seqnoReads += 1;

                if (Array.isArray(seqnoSchedule) && seqnoSchedule.length > 0) {

                    const next = seqnoSchedule.shift();

                    if (next !== undefined) {

                        currentSeqno = next;

                    }

                }

                return currentSeqno;

            },
            async getTransactions(address) {

                return transport.getTransactions(address);

            },
            async runGetMethod() {

                return { stack: [] };

            }
        }
    };

}

function createAdapter(tonService, overrides = {}) {

    return new TonGameContractAdapter({
        tonConfig: {
            endpoint: "https://testnet.toncenter.com/api/v2/jsonRPC",
            apiKey: null,
            deployerMnemonic: TEST_MNEMONIC,
            network: "testnet",
            gameEscrowMode: "game",
            oracleAddress: ORACLE,
            ownerWallet: OWNER,
            settlementTxLookupTimeoutMs: 1500,
            settlementTxLookupPollMs: 40,
            ...overrides
        },
        tonService
    });

}

async function main() {

    resetTonDeployDebugForTests();
    resetDeployerSendLocksForTests();

    // --- parseWalletV4SeqnoFromTransaction ---

    {
        const destination = friendlyAddress("escrow-parse");
        const tx = await createTxFixture({
            seqno: 42,
            destination,
            hash: "parse-hash",
            lt: 1
        });

        assert.equal(parseWalletV4SeqnoFromTransaction(tx), 42);
        assert.equal(
            parseWalletV4SeqnoFromTransaction({
                out_msgs: [{ destination }]
            }),
            null
        );
        console.log("  parseWalletV4SeqnoFromTransaction: OK");
    }

    {
        const axios429 = new Error("Request failed with status code 429");
        axios429.name = "AxiosError";
        axios429.status = 429;

        assert.equal(isInfrastructureFailure(axios429), true);
        assert.equal(
            isInfrastructureFailure(new Error("TonCenter HTTP 429")),
            true
        );
        assert.equal(
            isInfrastructureFailure(new Error("BOC was not accepted")),
            false
        );

        console.log("  isInfrastructureFailure axios 429: OK");
    }

    // --- Test 1: Sequential DEPLOY / INIT_GAME / OPEN_PAYMENTS seqnos ---

    {
        resetDeployerSendLocksForTests();
        resetTonDeployDebugForTests();

        const escrow = friendlyAddress("escrow-seq");
        const deployerAddress = await resolveDeployerAddress();
        const transport = new MockTonTransport();
        const harness = createAdvancingService({
            transport,
            initialSeqno: 14
        });

        // Pre-seed nothing; each send appends its own confirmed tx.
        const txs = [];

        transport.getTransactions = async () => txs;

        const originalBroadcast = harness.service.broadcastTransaction.bind(
            harness.service
        );

        harness.service.broadcastTransaction = async (boc) => {

            const seqnoUsed = harness.getCurrentSeqno();
            const result = await originalBroadcast(boc);
            const hash = `hash-seq-${seqnoUsed}`;

            txs.unshift(await createTxFixture({
                seqno: seqnoUsed,
                destination: escrow,
                hash,
                lt: 1000 + seqnoUsed
            }));

            return result;

        };

        const adapter = createAdapter(harness.service);

        const deployTx = await adapter._sendOracleMessage({
            operation: "DEPLOY",
            to: escrow,
            body: beginCell().endCell(),
            bounce: false,
            resolveAccountTxHash: true
        });

        const initTx = await adapter._sendOracleMessage({
            operation: "INIT_GAME",
            to: escrow,
            body: serializeGameEscrowInitGameBody({
                oracle: ORACLE,
                owner: OWNER,
                contractIdHash: HASH_A,
                snapshotHash: HASH_B
            }),
            bounce: false,
            resolveAccountTxHash: true
        });

        const openTx = await adapter._sendOracleMessage({
            operation: "OPEN_PAYMENTS",
            to: escrow,
            body: beginCell().endCell(),
            bounce: false,
            resolveAccountTxHash: true
        });

        assert.deepEqual(harness.usedSeqnos, [14, 15, 16]);
        assert.equal(deployTx, "hash-seq-14");
        assert.equal(initTx, "hash-seq-15");
        assert.equal(openTx, "hash-seq-16");
        assert.equal(
            String(deployTx).startsWith("ton_oracle_seq_"),
            false
        );

        console.log("  Test 1 sequential seqnos N/N+1/N+2: OK");
    }

    // --- Test 2: Previous same-destination tx cannot satisfy confirmation ---

    {
        resetDeployerSendLocksForTests();

        const escrow = friendlyAddress("escrow-false-match");
        const deployerAddress = await resolveDeployerAddress();
        const transport = new MockTonTransport();

        const deployTx = await createTxFixture({
            seqno: 20,
            destination: escrow,
            hash: "DEPLOY_TX_HASH",
            lt: 2000,
            utime: Math.floor(Date.now() / 1000) + 10
        });

        // Only DEPLOY tx is visible — INIT_GAME must NOT match it.
        transport.seedTransactions(deployerAddress, [deployTx]);

        let currentSeqno = 21;

        const adapter = createAdapter({
            getActiveNetwork: () => "testnet",
            isConnected: () => true,
            async broadcastTransaction() {

                currentSeqno = 22;

                return { "@type": "ok" };

            },
            async getAccount() {

                return { state: "active", balance: "0" };

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
        }, {
            settlementTxLookupTimeoutMs: 250,
            settlementTxLookupPollMs: 40
        });

        // Direct matcher: looking for seqno 21 must not return DEPLOY (seqno 20).
        const match = adapter._findSettlementDeployerTx(
            [deployTx],
            escrow,
            Math.floor(Date.now() / 1000) - 5,
            21
        );

        assert.equal(match, null, "DEPLOY tx must not satisfy INIT_GAME seqno");

        await assert.rejects(
            () => adapter._sendOracleMessage({
                operation: "INIT_GAME",
                to: escrow,
                body: beginCell().endCell(),
                bounce: false,
                resolveAccountTxHash: true
            }),
            (error) => String(error?.message ?? error).includes(
                "settlement_tx_lookup_timeout"
            )
        );

        console.log("  Test 2 previous tx cannot satisfy confirmation: OK");
    }

    // --- Test 3: Delayed seqno confirmation ---

    {
        resetDeployerSendLocksForTests();
        resetTonDeployDebugForTests();

        const escrow = friendlyAddress("escrow-delayed");
        const deployerAddress = await resolveDeployerAddress();
        const transport = new MockTonTransport();

        // Read seqno: 30 (pre-broadcast), then several 30s while waiting, then 31.
        const seqnoSchedule = [30, 30, 30, 30, 31];
        let broadcastCount = 0;

        const initBody = await buildWalletV4InMsgBody(30, escrow);

        transport.seedTransactions(deployerAddress, []);

        const adapter = createAdapter({
            getActiveNetwork: () => "testnet",
            isConnected: () => true,
            async broadcastTransaction() {

                broadcastCount += 1;

                return { "@type": "ok" };

            },
            async getAccount() {

                return { state: "active", balance: "0" };

            },
            async getSeqno() {

                if (seqnoSchedule.length === 0) {

                    return 31;

                }

                return seqnoSchedule.shift();

            },
            async getTransactions() {

                // Tx appears only after seqno has advanced (last schedule values).
                if (seqnoSchedule.length === 0) {

                    return [
                        {
                            utime: Math.floor(Date.now() / 1000) + 5,
                            transaction_id: { hash: "DELAYED_TX_HASH", lt: "3001" },
                            in_msg: {
                                source: "",
                                destination: deployerAddress,
                                msg_data: {
                                    "@type": "msg.dataRaw",
                                    body: initBody
                                }
                            },
                            out_msgs: [{ destination: escrow }]
                        }
                    ];

                }

                return [];

            },
            async runGetMethod() {

                return { stack: [] };

            }
        }, {
            settlementTxLookupTimeoutMs: 2000,
            settlementTxLookupPollMs: 30
        });

        const started = Date.now();

        const txId = await adapter._sendOracleMessage({
            operation: "DEPLOY",
            to: escrow,
            body: beginCell().endCell(),
            bounce: false,
            resolveAccountTxHash: true
        });

        const elapsed = Date.now() - started;

        assert.equal(txId, "DELAYED_TX_HASH");
        assert.equal(broadcastCount, 1);
        assert.ok(elapsed >= 60, "must poll through delayed seqno reads");

        const debug = getTonDeployDebug();

        assert.equal(debug.confirmationStatus, "TX_HASH_MATCHED");
        assert.equal(debug.confirmedSeqno, 31);
        assert.equal(debug.matchedTxHash, "DELAYED_TX_HASH");

        console.log("  Test 3 delayed seqno confirmation: OK");
    }

    // --- Test 4: Stale seqno — no advance ⇒ no next operation success ---

    {
        resetDeployerSendLocksForTests();

        const escrow = friendlyAddress("escrow-stale");
        let currentSeqno = 40;

        const adapter = createAdapter({
            getActiveNetwork: () => "testnet",
            isConnected: () => true,
            async broadcastTransaction() {

                // Broadcast accepted, but chain never advances seqno.
                return { "@type": "ok" };

            },
            async getAccount() {

                return { state: "active", balance: "0" };

            },
            async getSeqno() {

                return currentSeqno;

            },
            async getTransactions() {

                return [];

            },
            async runGetMethod() {

                return { stack: [] };

            }
        }, {
            settlementTxLookupTimeoutMs: 200,
            settlementTxLookupPollMs: 40
        });

        await assert.rejects(
            () => adapter._sendOracleMessage({
                operation: "DEPLOY",
                to: escrow,
                body: beginCell().endCell(),
                bounce: false,
                resolveAccountTxHash: true
            }),
            (error) => String(error?.message ?? error).includes(
                "deployer_seqno_confirmation_timeout"
            )
        );

        // Next operation still sees the same seqno — must also fail, not reuse.
        await assert.rejects(
            () => adapter._sendOracleMessage({
                operation: "INIT_GAME",
                to: escrow,
                body: beginCell().endCell(),
                bounce: false,
                resolveAccountTxHash: true
            }),
            (error) => String(error?.message ?? error).includes(
                "deployer_seqno_confirmation_timeout"
            )
        );

        console.log("  Test 4 stale seqno protection: OK");
    }

    // --- Test 5: Concurrent calls serialized on same deployer ---

    {
        resetDeployerSendLocksForTests();

        const escrow = friendlyAddress("escrow-concurrent");
        const deployerAddress = await resolveDeployerAddress();
        const transport = new MockTonTransport();
        const txs = [];
        let currentSeqno = 50;
        const usedSeqnos = [];
        let inFlight = 0;
        let maxInFlight = 0;

        const adapter = createAdapter({
            getActiveNetwork: () => "testnet",
            isConnected: () => true,
            async broadcastTransaction() {

                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                usedSeqnos.push(currentSeqno);

                const seqnoUsed = currentSeqno;

                // Hold the critical section briefly to amplify races without the lock.
                await new Promise((resolve) => setTimeout(resolve, 80));

                currentSeqno += 1;
                txs.unshift(await createTxFixture({
                    seqno: seqnoUsed,
                    destination: escrow,
                    hash: `concurrent-${seqnoUsed}`,
                    lt: 5000 + seqnoUsed
                }));

                inFlight -= 1;

                return { "@type": "ok" };

            },
            async getAccount() {

                return { state: "active", balance: "0" };

            },
            async getSeqno() {

                return currentSeqno;

            },
            async getTransactions() {

                return txs;

            },
            async runGetMethod() {

                return { stack: [] };

            }
        }, {
            settlementTxLookupTimeoutMs: 2000,
            settlementTxLookupPollMs: 30
        });

        const [a, b] = await Promise.all([
            adapter._sendOracleMessage({
                operation: "INIT_GAME",
                to: escrow,
                body: beginCell().endCell(),
                bounce: false,
                resolveAccountTxHash: true
            }),
            adapter._sendOracleMessage({
                operation: "OPEN_PAYMENTS",
                to: escrow,
                body: beginCell().endCell(),
                bounce: false,
                resolveAccountTxHash: true
            })
        ]);

        assert.deepEqual(usedSeqnos, [50, 51]);
        assert.equal(maxInFlight, 1, "deployer critical sections must not overlap");
        assert.equal(
            new Set([a, b]).size,
            2,
            "each operation must resolve a distinct tx hash"
        );

        console.log("  Test 5 concurrent serialization: OK");
    }

    // --- Matcher still accepts destination-only fixtures (no body) after seqno wait ---

    {
        const escrow = friendlyAddress("escrow-fallback");
        const adapter = createAdapter({
            getActiveNetwork: () => "testnet",
            isConnected: () => true,
            async broadcastTransaction() {

                return { "@type": "ok" };

            },
            async getSeqno() {

                return 1;

            },
            async getTransactions() {

                return [];

            }
        });

        const match = adapter._findSettlementDeployerTx(
            [
                {
                    utime: Math.floor(Date.now() / 1000),
                    transaction_id: { hash: "no-body-hash", lt: "1" },
                    out_msgs: [{ destination: escrow }]
                }
            ],
            escrow,
            Math.floor(Date.now() / 1000) - 5,
            7
        );

        assert.equal(match?.hash, "no-body-hash");
        console.log("  destination-only fixture fallback: OK");
    }

    // --- crLz: INIT_GAME broadcast SUCCESS + seqno confirmed + HTTP 429 lookup ---

    {
        resetDeployerSendLocksForTests();
        resetTonDeployDebugForTests();

        const escrow = friendlyAddress("escrow-429");
        const deployerAddress = await resolveDeployerAddress();
        let currentSeqno = 317;
        let broadcastCount = 0;
        let lookupCalls = 0;

        const initBody = await buildWalletV4InMsgBody(317, escrow);

        function axios429() {

            const error = new Error("Request failed with status code 429");
            error.name = "AxiosError";
            error.status = 429;
            error.response = { status: 429 };
            return error;

        }

        const adapter = createAdapter({
            getActiveNetwork: () => "testnet",
            isConnected: () => true,
            async broadcastTransaction() {

                broadcastCount += 1;
                currentSeqno = 318;
                return { "@type": "ok" };

            },
            async getAccount() {

                return { state: "active", balance: "0" };

            },
            async getSeqno() {

                return currentSeqno;

            },
            async getTransactions() {

                lookupCalls += 1;

                if (lookupCalls <= 2) {

                    throw axios429();

                }

                return [
                    {
                        utime: Math.floor(Date.now() / 1000) + 5,
                        transaction_id: {
                            hash: "2+hWJWNViLl1eEhN5OviIgZ5JK6I4da8G2GrekNdz3Y=",
                            lt: "4291"
                        },
                        in_msg: {
                            source: "",
                            destination: deployerAddress,
                            msg_data: {
                                "@type": "msg.dataRaw",
                                body: initBody
                            }
                        },
                        out_msgs: [{ destination: escrow }]
                    }
                ];

            },
            async runGetMethod() {

                return { stack: [] };

            }
        }, {
            settlementTxLookupTimeoutMs: 2000,
            settlementTxLookupPollMs: 30
        });

        const init = await adapter.initGame({
            contractAddress: escrow,
            oracle: ORACLE,
            owner: OWNER,
            contractIdHash: HASH_A,
            snapshotHash: HASH_B
        });

        assert.equal(init.ok, true, "INIT_GAME must succeed after 429 retry");
        assert.equal(
            init.txId,
            "2+hWJWNViLl1eEhN5OviIgZ5JK6I4da8G2GrekNdz3Y="
        );
        assert.equal(broadcastCount, 1, "must not rebroadcast after 429");
        assert.ok(lookupCalls >= 3, "confirmation lookup must retry");

        const debug = getTonDeployDebug();

        assert.notEqual(debug.currentStage, "FAILED");
        assert.equal(debug.broadcastResult, "SUCCESS");
        assert.equal(debug.confirmationStatus, "TX_HASH_MATCHED");
        assert.equal(debug.confirmedSeqno, 318);
        assert.equal(
            debug.matchedTxHash,
            "2+hWJWNViLl1eEhN5OviIgZ5JK6I4da8G2GrekNdz3Y="
        );
        assert.ok(debug.stage.includes("TX_LOOKUP_TRANSIENT"));
        assert.equal(debug.stage.includes("FAILED"), false);

        console.log("  crLz INIT_GAME 429 confirmation retry: OK");
    }

    // --- Broadcast failure remains FAILED, no confirmation success ---

    {
        resetDeployerSendLocksForTests();
        resetTonDeployDebugForTests();

        const escrow = friendlyAddress("escrow-broadcast-fail");
        let broadcastCount = 0;

        const adapter = createAdapter({
            getActiveNetwork: () => "testnet",
            isConnected: () => true,
            async broadcastTransaction() {

                broadcastCount += 1;
                throw new Error("BOC was not accepted");

            },
            async getSeqno() {

                return 10;

            },
            async getTransactions() {

                return [];

            },
            async runGetMethod() {

                return { stack: [] };

            }
        });

        const init = await adapter.initGame({
            contractAddress: escrow,
            oracle: ORACLE,
            owner: OWNER,
            contractIdHash: HASH_A,
            snapshotHash: HASH_B
        });

        assert.equal(init.ok, false);
        assert.equal(init.reason, "init_game_failed");
        assert.equal(broadcastCount, 1);

        const debug = getTonDeployDebug();

        assert.equal(debug.currentStage, "FAILED");
        assert.notEqual(debug.broadcastResult, "SUCCESS");

        console.log("  INIT_GAME genuine broadcast failure: OK");
    }

    console.log("R7.70C2.6 deployer seqno confirmation: all assertions passed");

}

await main();
