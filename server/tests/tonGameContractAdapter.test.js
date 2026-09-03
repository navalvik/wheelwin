/**
 * T2.3 — TonGameContractAdapter tests.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { Cell, TupleReader, loadMessage, toNano } from "@ton/core";
import { keyPairFromSeed, mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import { TonGameContractAdapter } from "../payment/TonGameContractAdapter.js";
import {
    decodeCancelStatus,
    decodeContractState,
    decodePaidMask,
    decodePlayerPayment,
    decodeRefundMask,
    decodeRefundedTotal,
    decodeRequiredTotal,
    decodeResidualSwept,
    decodeSettlementState,
    decodeTotalPaid,
    decodeWinner
} from "../payment/ton/gameContract/GameContractDeserializer.js";
import {
    InvalidAddressError,
    InvalidContractResponseError,
    SerializationError
} from "../payment/ton/gameContract/GameContractErrors.js";
import {
    serializeArchiveBody,
    serializeEmergencyCancelBody,
    serializeLegacySettleBody,
    serializeSettleBody,
    serializeSweepResidualBody
} from "../payment/ton/gameContract/GameContractSerializer.js";
import {
    buildGameEscrowWallet,
    loadGameEscrowCodeCell
} from "../payment/ton/buildGameEscrowStateInit.js";
import { MockTonTransport } from "../payment/ton/MockTonTransport.js";
import { ContractNotFoundError } from "../payment/TonGameContractAdapter.js";

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

function createMockTonService({
    accountState = "active",
    getMethodHandlers = {}
} = {}) {

    const transport = new MockTonTransport();

    const client = {
        async runMethod(address, method) {

            const friendly = typeof address === "string"
                ? address
                : address.toString({
                    bounceable: true,
                    urlSafe: true
                });

            const handler = getMethodHandlers[method];

            if (!handler) {

                throw new Error(`Unhandled get-method: ${method}`);

            }

            return handler(friendly);

        }
    };

    const defaultAddress = friendlyAddress("contract-a");

    transport.seedAddressInfo(defaultAddress, {
        state: accountState,
        balance: "1000000000"
    });

    return {
        getActiveNetwork() {

            return "testnet";

        },
        isConnected() {

            return true;

        },
        getTransport() {

            return transport;

        },
        getClient() {

            return client;

        },
        async broadcastTransaction(bocBase64) {

            return transport.sendBoc(bocBase64);

        },
        async getAccount(address) {

            return transport.getAddressInformation(address);

        },
        async getSeqno() {

            return 1;

        },
        async getTransactions(address, query) {

            return transport.getTransactions(address, query);

        },
        async runGetMethod(address, method) {

            return client.runMethod(address, method);

        }
    };

}

function deployedGameEscrowAccount(overrides = {}) {

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

function createAdapter(tonService, overrides = {}) {

    return new TonGameContractAdapter({
        tonConfig: {
            endpoint: "https://testnet.toncenter.com/api/v2/jsonRPC",
            apiKey: null,
            deployerMnemonic: null,
            network: "testnet",
            ...overrides
        },
        tonService
    });

}

const contractAddress = friendlyAddress("contract-a");

const defaultGetMethodHandlers = {
    get_contract_state: () => ({
        stack: [
            { value: 6 },
            { value: 1 },
            { value: 7 }
        ]
    }),
    get_paid_mask: () => ({
        stack: [{ value: 7 }]
    }),
    get_total_paid: () => ({
        stack: [{ value: 30n }]
    }),
    get_required_total: () => ({
        stack: [{ value: 30n }]
    }),
    get_player_payment: () => ({
        stack: [
            { value: friendlyAddress("player-1") },
            { value: 10n },
            { value: 1 }
        ]
    }),
    get_refund_mask: () => ({
        stack: [{ value: 0 }]
    }),
    get_refunded_total: () => ({
        stack: [{ value: 0n }]
    }),
    get_cancel_status: () => ({
        stack: [
            { value: 0 },
            { value: 0 },
            { value: 0 }
        ]
    }),
    get_participants: () => ({
        stack: [[
            [
                { value: friendlyAddress("player-1") },
                { value: 10 },
                { value: 1 },
                { value: "ref-1" }
            ]
        ]]
    }),
    get_winner: () => ({
        stack: [
            { value: friendlyAddress("player-1") },
            { value: "hash-winner" }
        ]
    }),
    get_settlement_state: () => ({
        stack: [
            { value: 8 },
            { value: friendlyAddress("player-1") },
            { value: 28 },
            { value: 2 },
            { value: "tx-settle" }
        ]
    }),
    get_balances: () => ({
        stack: [
            { value: 1000000000n },
            { value: 500000000n },
            { value: "GRM" }
        ]
    }),
    get_archive_state: () => ({
        stack: [
            { value: 1 },
            { value: 1234567890 },
            { value: "game_complete" }
        ]
    }),
    get_network: () => ({
        stack: [{ value: "testnet" }]
    }),
    get_residual_swept: () => ({
        stack: [{ value: -1 }]
    })
};

async function main() {

    // --- escrow derivation ---

    {
        const escrow = buildGameEscrowWallet({
            contractId: "contract_1",
            snapshot: {
                gameId: "g1",
                roomId: "r1",
                totalPot: 30,
                players: [
                    { playerId: "p1", wallet: "EQ1", requiredGram: 10 }
                ]
            }
        });

        assert.ok(escrow.addressFriendly.startsWith("EQ"));

        console.log("  escrow derivation: OK");
    }

    // --- deploy serialization path ---

    {
        const transport = new MockTonTransport();

        const adapter = createAdapter({
            getActiveNetwork: () => "testnet",
            isConnected: () => true,
            async broadcastTransaction(boc) {

                return transport.sendBoc(boc);

            },
            async getAccount() {

                return { state: "uninitialized", balance: "0" };

            },
            async getSeqno() {

                return 0;

            },
            async runGetMethod() {

                return { stack: [] };

            }
        });

        const result = await adapter.deploy({
            contractId: "contract_live_1",
            snapshot: {
                gameId: "game_1",
                roomId: "room_1",
                totalPot: 30,
                players: []
            }
        });

        assert.equal(result.ok, true);

        assert.ok(result.contractAddress.startsWith("EQ"));

        assert.ok(result.deploymentTxId);

        assert.equal(transport.sentBocs.length, 1);

        console.log("  deploy serialization: OK");
    }

    // --- open + load state ---

    {
        const tonService = createMockTonService({
            getMethodHandlers: defaultGetMethodHandlers
        });

        tonService.getTransport().seedAddressInfo(contractAddress, {
            state: "active",
            balance: "1000000000"
        });

        const adapter = createAdapter(tonService);

        const opened = await adapter.openContract(contractAddress);

        assert.equal(opened.exists, true);

        const loaded = await adapter.loadContract(contractAddress);

        assert.equal(loaded.state.status, "LOCKED");

        assert.equal(loaded.state.paidMask, 7);

        console.log("  open + load state: OK");
    }

    // --- decode paid mask ---

    {
        const mask = decodePaidMask({
            stack: [{ value: 5 }]
        });

        assert.equal(mask, 5);

        console.log("  decode paid mask: OK");
    }

    // --- R7.70C13 — TonClient.runMethod TupleReader stack ---

    {
        assert.equal(
            decodePaidMask({
                gas_used: 123,
                stack: new TupleReader([{ type: "int", value: 0n }])
            }),
            0
        );

        assert.equal(
            decodePaidMask({
                gas_used: 123,
                stack: new TupleReader([{ type: "int", value: 1n }])
            }),
            1
        );

        assert.equal(
            decodePaidMask({
                gas_used: 123,
                stack: new TupleReader([{ type: "int", value: 7n }])
            }),
            7
        );

        // Raw TupleReader (no wrapper object) still supported.
        assert.equal(
            decodePaidMask(new TupleReader([{ type: "int", value: 7n }])),
            7
        );

        // Existing array shapes must remain valid.
        assert.equal(decodePaidMask({ stack: [{ value: 7 }] }), 7);

        assert.equal(decodePaidMask([{ value: 1 }]), 1);

        const tonService = createMockTonService({
            getMethodHandlers: {
                ...defaultGetMethodHandlers,
                get_paid_mask: () => ({
                    gas_used: 50,
                    stack: new TupleReader([{ type: "int", value: 7n }])
                })
            }
        });

        tonService.getTransport().seedAddressInfo(contractAddress, {
            state: "active",
            balance: "1000000000"
        });

        const adapter = createAdapter(tonService);

        assert.equal(await adapter.getPaidMask(contractAddress), 7);

        console.log("  R7.70C13 TupleReader paidMask decode + getPaidMask: OK");
    }

    // --- R7.69B decode payment getters ---

    {
        assert.equal(decodeTotalPaid({ stack: [{ value: 42n }] }), 42n);

        assert.equal(decodeRequiredTotal({ stack: [{ value: 99n }] }), 99n);

        const player = decodePlayerPayment({
            stack: [
                { value: friendlyAddress("player-2") },
                { value: 15n },
                { value: 1 }
            ]
        }, 1);

        assert.equal(player.index, 1);

        assert.equal(player.paid, true);

        assert.equal(player.requiredStake, 15n);

        console.log("  decode total/required/player payment: OK");
    }

    // --- R7.69C decode cancel / refund getters ---

    {
        assert.equal(decodeRefundMask({ stack: [{ value: 5 }] }), 5);

        assert.equal(decodeRefundedTotal({ stack: [{ value: 42n }] }), 42n);

        const cancel = decodeCancelStatus({
            stack: [
                { value: 1 },
                { value: 99 },
                { value: 7 }
            ]
        });

        assert.equal(cancel.cancelled, true);
        assert.equal(cancel.cancelReason, 99);
        assert.equal(cancel.refundMask, 7);

        console.log("  decode refund/cancel status: OK");
    }

    // --- R7.69B adapter payment getters ---

    {
        const tonService = createMockTonService({
            getMethodHandlers: defaultGetMethodHandlers
        });

        tonService.getTransport().seedAddressInfo(contractAddress, {
            state: "active",
            balance: "1000000000"
        });

        const adapter = createAdapter(tonService);

        assert.equal(await adapter.getPaidMask(contractAddress), 7);

        assert.equal(await adapter.getTotalPaid(contractAddress), 30n);

        assert.equal(await adapter.getRequiredTotal(contractAddress), 30n);

        const seat = await adapter.getPlayerPayment(contractAddress, 0);

        assert.equal(seat.paid, true);

        assert.equal(seat.requiredStake, 10n);

        console.log("  adapter GameEscrow payment getters: OK");
    }

    // --- R7.69C adapter cancel / refund getters ---

    {
        const tonService = createMockTonService({
            getMethodHandlers: {
                ...defaultGetMethodHandlers,
                get_refund_mask: () => ({ stack: [{ value: 3 }] }),
                get_refunded_total: () => ({ stack: [{ value: 25n }] }),
                get_cancel_status: () => ({
                    stack: [
                        { value: 1 },
                        { value: 7 },
                        { value: 3 }
                    ]
                })
            }
        });

        tonService.getTransport().seedAddressInfo(contractAddress, {
            state: "active",
            balance: "1000000000"
        });

        const adapter = createAdapter(tonService);

        assert.equal(await adapter.getRefundMask(contractAddress), 3);
        assert.equal(await adapter.getRefundedTotal(contractAddress), 25n);

        const cancel = await adapter.getCancelStatus(contractAddress);

        assert.equal(cancel.cancelled, true);
        assert.equal(cancel.cancelReason, 7);
        assert.equal(cancel.refundMask, 3);

        console.log("  adapter GameEscrow cancel/refund getters: OK");
    }

    // --- decode balances ---

    {
        const tonService = createMockTonService({
            getMethodHandlers: defaultGetMethodHandlers
        });

        tonService.getTransport().seedAddressInfo(contractAddress, {
            state: "active",
            balance: "1000000000"
        });

        const adapter = createAdapter(tonService);

        const balances = await adapter.getBalances(contractAddress);

        assert.equal(balances.tonBalance, 1000000000n);

        assert.equal(balances.jettonBalance, 500000000n);

        assert.equal(balances.currency, "GRM");

        console.log("  decode balances: OK");
    }

    // --- decode settlement + winner ---

    {
        const tonService = createMockTonService({
            getMethodHandlers: defaultGetMethodHandlers
        });

        tonService.getTransport().seedAddressInfo(contractAddress, {
            state: "active",
            balance: "0"
        });

        const adapter = createAdapter(tonService);

        const settlement = await adapter.getSettlementState(contractAddress);

        assert.equal(settlement.status, "SETTLED");

        assert.equal(settlement.winnerAmount, 28);

        const winner = await adapter.getWinner(contractAddress);

        assert.equal(winner.winnerWallet, friendlyAddress("player-1"));

        console.log("  decode settlement + winner: OK");
    }

    // --- participants ---

    {
        const tonService = createMockTonService({
            getMethodHandlers: defaultGetMethodHandlers
        });

        tonService.getTransport().seedAddressInfo(contractAddress, {
            state: "active",
            balance: "0"
        });

        const adapter = createAdapter(tonService);

        const participants = await adapter.getParticipants(contractAddress);

        assert.equal(participants.length, 1);

        assert.equal(participants[0].paid, true);

        console.log("  decode participants: OK");
    }

    // --- archive request serialization ---

    {
        const cell = serializeArchiveBody();

        assert.ok(cell.bits.length > 0);

        console.log("  archive serialization: OK");
    }

    // --- settle request serialization ---

    {
        const legacy = serializeLegacySettleBody({
            winnerAmount: 28.5,
            organizerAmount: 1.5
        });

        const full = serializeSettleBody({
            winnerWallet: friendlyAddress("player-1"),
            winnerAmount: 28.5,
            organizerAmount: 1.5
        });

        assert.ok(legacy.bits.length > 0);

        assert.ok(full.bits.length > 0);

        console.log("  settle serialization: OK");
    }

    // --- emergency cancel serialization ---

    {
        const cell = serializeEmergencyCancelBody({ reasonCode: 42 });

        assert.ok(cell.bits.length > 0);

        console.log("  cancel serialization: OK");
    }

    // --- invalid address ---

    {
        const tonService = createMockTonService();

        const adapter = createAdapter(tonService);

        await assert.rejects(
            () => adapter.openContract("not-an-address"),
            InvalidAddressError
        );

        console.log("  invalid address: OK");
    }

    // --- contract not found ---

    {
        const tonService = createMockTonService({
            accountState: "uninitialized"
        });

        const adapter = createAdapter(tonService);

        const missing = friendlyAddress("missing-contract");

        tonService.getTransport().seedAddressInfo(missing, {
            state: "uninitialized",
            balance: "0"
        });

        assert.equal(await adapter.contractExists(missing), false);

        await assert.rejects(
            () => adapter.getContractState(missing),
            ContractNotFoundError
        );

        console.log("  contract not found: OK");
    }

    // --- invalid response ---

    {
        assert.throws(
            () => decodeContractState(contractAddress, "testnet", null),
            InvalidContractResponseError
        );

        console.log("  invalid response: OK");
    }

    // --- serialization error ---

    {
        assert.throws(
            () => serializeSettleBody({
                winnerWallet: "bad-address",
                winnerAmount: 1,
                organizerAmount: 1
            }),
            SerializationError
        );

        console.log("  serialization error: OK");
    }

    // --- settle stub path ---

    {
        const transport = new MockTonTransport();

        const adapter = createAdapter({
            getActiveNetwork: () => "testnet",
            async broadcastTransaction(boc) {

                return transport.sendBoc(boc);

            },
            async getAccount() {

                return { state: "active", balance: "0" };

            },
            async getSeqno() {

                return 1;

            },
            async runGetMethod() {

                return { stack: [] };

            }
        });

        const result = await adapter.settleContract({
            contractId: "c1",
            contractAddress,
            winnerWallet: friendlyAddress("player-1"),
            ownerWallet: friendlyAddress("owner-1"),
            winnerId: "p1",
            winnerAmount: 28.5,
            organizerAmount: 1.5
        });

        assert.equal(result.ok, true);

        assert.ok(result.settlementTxId);

        assert.equal(transport.sentBocs.length, 1);

        console.log("  settle stub path: OK");
    }

    // --- R7.61A live settle returns real deployer account tx hash ---

    {
        const TEST_MNEMONIC = [
            "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
            "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
            "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
            "abandon", "abandon", "abandon", "abandon", "abandon", "art"
        ].join(" ");

        const keyPair = await mnemonicToPrivateKey(
            TEST_MNEMONIC.split(/\s+/).filter(Boolean)
        );

        const deployerAddress = WalletContractV4.create({
            workchain: 0,
            publicKey: keyPair.publicKey
        }).address.toString({ bounceable: true, urlSafe: true });

        const escrowAddress = friendlyAddress("escrow-settle-r761");
        const REAL_TX_HASH = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/=";

        const transport = new MockTonTransport();

        transport.seedTransactions(deployerAddress, [
            {
                utime: Math.floor(Date.now() / 1000) + 5,
                transaction_id: { hash: REAL_TX_HASH, lt: "1001" },
                out_msgs: [
                    { destination: escrowAddress }
                ]
            }
        ]);

        let currentSeqno = 4;

        const adapter = createAdapter({
            getActiveNetwork: () => "testnet",
            isConnected: () => true,
            async broadcastTransaction(boc) {

                currentSeqno += 1;

                return transport.sendBoc(boc);

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
            deployerMnemonic: TEST_MNEMONIC,
            settlementTxLookupTimeoutMs: 2000,
            settlementTxLookupPollMs: 50
        });

        const result = await adapter.settleContract({
            contractId: "c_r761",
            contractAddress: escrowAddress,
            winnerWallet: friendlyAddress("player-1"),
            ownerWallet: friendlyAddress("owner-1"),
            winnerId: "p1",
            winnerAmount: 2.85,
            organizerAmount: 0.15
        });

        assert.equal(result.ok, true);
        assert.equal(result.settlementTxId, REAL_TX_HASH);
        assert.equal(
            String(result.settlementTxId).startsWith("ton_oracle_seq_"),
            false,
            "must not return synthetic ton_oracle_seq_* id"
        );
        assert.equal(transport.sentBocs.length, 1);

        console.log("  R7.61A live settle real tx hash: OK");
    }

    // --- R7.61A settle lookup timeout ---

    {
        const TEST_MNEMONIC = [
            "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
            "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
            "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
            "abandon", "abandon", "abandon", "abandon", "abandon", "art"
        ].join(" ");

        const transport = new MockTonTransport();

        const adapter = createAdapter({
            getActiveNetwork: () => "testnet",
            isConnected: () => true,
            async broadcastTransaction(boc) {

                return transport.sendBoc(boc);

            },
            async getAccount() {

                return { state: "active", balance: "0" };

            },
            async getSeqno() {

                return 0;

            },
            async getTransactions() {

                return [];

            },
            async runGetMethod() {

                return { stack: [] };

            }
        }, {
            deployerMnemonic: TEST_MNEMONIC,
            settlementTxLookupTimeoutMs: 150,
            settlementTxLookupPollMs: 40
        });

        const result = await adapter.settleContract({
            contractId: "c_r761_timeout",
            contractAddress: friendlyAddress("escrow-timeout"),
            winnerWallet: friendlyAddress("player-1"),
            ownerWallet: friendlyAddress("owner-1"),
            winnerId: "p1",
            winnerAmount: 1,
            organizerAmount: 0.05
        });

        assert.equal(result.ok, false);
        assert.equal(result.reason, "settle_failed");

        console.log("  R7.61A settle lookup timeout: OK");
    }

    // --- decode contract state DTO ---

    {
        const state = decodeContractState(contractAddress, "testnet", {
            stack: [
                { value: 3 },
                { value: 1 },
                { value: 2 }
            ]
        });

        assert.equal(state.status, "PAYMENTS_OPEN");

        assert.equal(state.paidMask, 2);

        assert.equal(state.network, "testnet");

        console.log("  contract state DTO: OK");
    }

    // --- decode winner DTO ---

    {
        const winner = decodeWinner(contractAddress, {
            stack: [
                { value: friendlyAddress("player-1") },
                { value: "pid-hash" }
            ]
        });

        assert.equal(winner.winnerPlayerIdHash, "pid-hash");

        console.log("  winner DTO: OK");
    }

    // --- R6.34 live escrow activation success ---

    {
        const TEST_MNEMONIC = [
            "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
            "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
            "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
            "abandon", "abandon", "abandon", "abandon", "abandon", "art"
        ].join(" ");

        let accountCalls = 0;
        let currentSeqno = 0;

        const keyPair = await mnemonicToPrivateKey(
            TEST_MNEMONIC.split(/\s+/).filter(Boolean)
        );
        const deployerAddress = WalletContractV4.create({
            workchain: 0,
            publicKey: keyPair.publicKey
        }).address.toString({ bounceable: true, urlSafe: true });

        const transport = new MockTonTransport();

        const tonService = {
            getActiveNetwork: () => "testnet",
            isConnected: () => true,
            async broadcastTransaction(boc) {

                return transport.sendBoc(boc);

            },
            async getAccount() {

                accountCalls += 1;

                return accountCalls >= 2
                    ? deployedGameEscrowAccount()
                    : {
                        state: "uninitialized",
                        balance: "0",
                        code: "",
                        last_transaction_id: {
                            lt: "0",
                            hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
                        }
                    };

            },
            async getBalance() {

                return toNano("0.5");

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
        };

        const adapter = createAdapter(tonService, {
            deployerMnemonic: TEST_MNEMONIC,
            gameEscrowMode: "game",
            pollIntervalMs: 200,
            escrowActivationTimeoutMs: 3000,
            settlementTxLookupTimeoutMs: 2000,
            settlementTxLookupPollMs: 40
        });

        // R7.70C2.6 — advance seqno + seed destination-bound deployer tx on send.
        const originalSend = adapter._sendOracleMessage.bind(adapter);

        adapter._sendOracleMessage = async (opts) => {

            const destination = typeof opts.to === "string"
                ? opts.to
                : opts.to.toString({ bounceable: true, urlSafe: true });

            const previousBroadcast = tonService.broadcastTransaction;

            tonService.broadcastTransaction = async (boc) => {

                const seqnoUsed = currentSeqno;
                currentSeqno += 1;
                transport.seedTransactions(deployerAddress, [
                    {
                        utime: Math.floor(Date.now() / 1000) + 5,
                        transaction_id: {
                            hash: `activation-tx-${seqnoUsed}`,
                            lt: String(1000 + seqnoUsed)
                        },
                        out_msgs: [{ destination }]
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

        const result = await adapter.deploy({
            contractId: "contract_activation_ok",
            snapshot: {
                gameId: "game_act",
                roomId: "room_act",
                totalPot: 30,
                players: []
            }
        });

        assert.equal(result.ok, true);

        assert.ok(result.contractAddress.startsWith("EQ"));

        assert.ok(accountCalls >= 2);

        assert.ok(transport.sentBocs.length >= 1);

        // R7.54 — sent BOC must be an external-in Message envelope, not a raw
        // createTransfer() body Cell.
        const sentBoc = transport.sentBocs[0];
        const messageCell = Cell.fromBoc(Buffer.from(sentBoc, "base64"))[0];
        const message = loadMessage(messageCell.beginParse());

        assert.equal(message.info.type, "external-in");
        assert.ok(message.body);

        console.log("  live escrow activation success: OK");
        console.log("  R7.54 external-in Message envelope: OK");
    }

    // --- R6.34 activation timeout ---

    {
        const TEST_MNEMONIC = [
            "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
            "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
            "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
            "abandon", "abandon", "abandon", "abandon", "abandon", "art"
        ].join(" ");

        let accountCalls = 0;
        let currentSeqno = 0;

        const keyPair = await mnemonicToPrivateKey(
            TEST_MNEMONIC.split(/\s+/).filter(Boolean)
        );
        const deployerAddress = WalletContractV4.create({
            workchain: 0,
            publicKey: keyPair.publicKey
        }).address.toString({ bounceable: true, urlSafe: true });

        const transport = new MockTonTransport();

        const tonService = {
            getActiveNetwork: () => "testnet",
            isConnected: () => true,
            async broadcastTransaction(boc) {

                return transport.sendBoc(boc);

            },
            async getAccount() {

                accountCalls += 1;

                return { state: "uninitialized", balance: "0" };

            },
            async getBalance() {

                return toNano("0.5");

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
        };

        const adapter = createAdapter(tonService, {
            deployerMnemonic: TEST_MNEMONIC,
            gameEscrowMode: "game",
            pollIntervalMs: 200,
            escrowActivationTimeoutMs: 400,
            settlementTxLookupTimeoutMs: 2000,
            settlementTxLookupPollMs: 40
        });

        const originalSend = adapter._sendOracleMessage.bind(adapter);

        adapter._sendOracleMessage = async (opts) => {

            const destination = typeof opts.to === "string"
                ? opts.to
                : opts.to.toString({ bounceable: true, urlSafe: true });

            const previousBroadcast = tonService.broadcastTransaction;

            tonService.broadcastTransaction = async (boc) => {

                const seqnoUsed = currentSeqno;
                currentSeqno += 1;
                transport.seedTransactions(deployerAddress, [
                    {
                        utime: Math.floor(Date.now() / 1000) + 5,
                        transaction_id: {
                            hash: `timeout-tx-${seqnoUsed}`,
                            lt: String(2000 + seqnoUsed)
                        },
                        out_msgs: [{ destination }]
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

        const result = await adapter.deploy({
            contractId: "contract_activation_timeout",
            snapshot: {
                gameId: "game_timeout",
                roomId: "room_timeout",
                totalPot: 30,
                players: []
            }
        });

        assert.equal(result.ok, false);

        assert.equal(result.reason, "escrow_activation_timeout");

        assert.ok(accountCalls >= 1);

        console.log("  live escrow activation timeout: OK");
    }

    // --- R6.34 RPC temporary failure then active ---

    {
        const TEST_MNEMONIC = [
            "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
            "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
            "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
            "abandon", "abandon", "abandon", "abandon", "abandon", "art"
        ].join(" ");

        let accountCalls = 0;
        let currentSeqno = 0;

        const keyPair = await mnemonicToPrivateKey(
            TEST_MNEMONIC.split(/\s+/).filter(Boolean)
        );
        const deployerAddress = WalletContractV4.create({
            workchain: 0,
            publicKey: keyPair.publicKey
        }).address.toString({ bounceable: true, urlSafe: true });

        const transport = new MockTonTransport();

        const tonService = {
            getActiveNetwork: () => "testnet",
            isConnected: () => true,
            async broadcastTransaction(boc) {

                return transport.sendBoc(boc);

            },
            async getAccount() {

                accountCalls += 1;

                if (accountCalls < 3) {

                    throw new Error("temporary RPC failure");

                }

                return deployedGameEscrowAccount();

            },
            async getBalance() {

                return toNano("0.5");

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
        };

        const adapter = createAdapter(tonService, {
            deployerMnemonic: TEST_MNEMONIC,
            gameEscrowMode: "game",
            pollIntervalMs: 200,
            escrowActivationTimeoutMs: 3000,
            settlementTxLookupTimeoutMs: 2000,
            settlementTxLookupPollMs: 40
        });

        const originalSend = adapter._sendOracleMessage.bind(adapter);

        adapter._sendOracleMessage = async (opts) => {

            const destination = typeof opts.to === "string"
                ? opts.to
                : opts.to.toString({ bounceable: true, urlSafe: true });

            const previousBroadcast = tonService.broadcastTransaction;

            tonService.broadcastTransaction = async (boc) => {

                const seqnoUsed = currentSeqno;
                currentSeqno += 1;
                transport.seedTransactions(deployerAddress, [
                    {
                        utime: Math.floor(Date.now() / 1000) + 5,
                        transaction_id: {
                            hash: `rpc-retry-tx-${seqnoUsed}`,
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

                tonService.broadcastTransaction = previousBroadcast;

            }

        };

        const result = await adapter.deploy({
            contractId: "contract_activation_retry",
            snapshot: {
                gameId: "game_retry",
                roomId: "room_retry",
                totalPot: 30,
                players: []
            }
        });

        assert.equal(result.ok, true);

        assert.ok(accountCalls >= 3);

        console.log("  live escrow activation RPC retry: OK");
    }

    // --- R6.34 no-mnemonic path skips activation polling ---

    {
        let accountCalls = 0;

        const transport = new MockTonTransport();

        const adapter = createAdapter({
            getActiveNetwork: () => "testnet",
            isConnected: () => true,
            async broadcastTransaction(boc) {

                return transport.sendBoc(boc);

            },
            async getAccount() {

                accountCalls += 1;

                return { state: "uninitialized", balance: "0" };

            },
            async getSeqno() {

                return 0;

            },
            async runGetMethod() {

                return { stack: [] };

            }
        }, {
            deployerMnemonic: null,
            pollIntervalMs: 200,
            escrowActivationTimeoutMs: 400
        });

        const result = await adapter.deploy({
            contractId: "contract_no_mnemonic",
            snapshot: {
                gameId: "game_nm",
                roomId: "room_nm",
                totalPot: 30,
                players: []
            }
        });

        assert.equal(result.ok, true);

        assert.equal(accountCalls, 0);

        console.log("  no-mnemonic deploy skips activation poll: OK");
    }

    {
        const cell = serializeSweepResidualBody();
        assert.ok(cell.bits.length > 0);
        assert.equal(decodeResidualSwept({ stack: [{ value: -1 }] }), true);
        assert.equal(decodeResidualSwept({ stack: [{ value: 0 }] }), false);

        const mainnetAdapter = createAdapter(createMockTonService(), {
            network: "mainnet",
            deployerMnemonic: [
                "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
                "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
                "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
                "abandon", "abandon", "abandon", "abandon", "abandon", "art"
            ].join(" ")
        });

        const mainnetSweep = await mainnetAdapter.sweepSettledResidual({
            contractAddress
        });
        assert.equal(mainnetSweep.ok, false);
        assert.equal(mainnetSweep.reason, "sweep_testnet_only");

        console.log("  residual sweep serialization + mainnet skip: OK");
    }

    console.log("tonGameContractAdapter tests passed");
}

main().catch((error) => {

    console.error(error);

    process.exit(1);

});
