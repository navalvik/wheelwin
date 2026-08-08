/**
 * R7.66F — GameEscrow SETTLE serializer + settlement path tests.
 */
import assert from "node:assert/strict";

import { Address, toNano } from "@ton/core";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import {
    getTonSettlementDebug,
    resetTonSettlementDebugForTests
} from "../diagnostics/SettlementPipelineForensics.js";
import { TonGameContractAdapter } from "../payment/TonGameContractAdapter.js";
import {
    GAME_ESCROW_MODE_GAME,
    GAME_ESCROW_MODE_V4
} from "../payment/ton/buildGameEscrowStateInit.js";
import { buildSettleMessagePlan } from "../payment/ton/buildSettleMessagePlan.js";
import { GAME_CONTRACT_OPCODES } from "../payment/ton/gameContract/GameContractOpcodes.js";
import {
    GAME_ESCROW_SETTLE_OPCODE_BITS,
    serializeGameEscrowSettleBody,
    serializeLegacySettleBody
} from "../payment/ton/gameContract/GameContractSerializer.js";
import { MockTonTransport } from "../payment/ton/MockTonTransport.js";

const OWNER = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
const WINNER = "EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j";
const SNAPSHOT_HASH = "2222222222222222222222222222222222222222222222222222222222222222";
const ESCROW = "EQACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAsoi";

const TEST_MNEMONIC = [
    "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
    "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
    "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
    "abandon", "abandon", "abandon", "abandon", "abandon", "art"
].join(" ");

function assertGameEscrowSettleBody(body) {

    const slice = body.beginParse();
    assert.equal(
        slice.loadUint(GAME_ESCROW_SETTLE_OPCODE_BITS),
        GAME_CONTRACT_OPCODES.SETTLE
    );
    assert.equal(
        slice.loadUintBig(256).toString(16).padStart(64, "0"),
        SNAPSHOT_HASH
    );
    assert.ok(slice.loadAddress().equals(Address.parse(WINNER)));
    assert.equal(slice.loadCoins(), toNano("2.85"));
    assert.equal(slice.loadCoins(), toNano("0.15"));
    assert.equal(slice.remainingBits, 0);

}

async function createLiveAdapter(gameEscrowMode) {

    const transport = new MockTonTransport();
    const keyPair = await mnemonicToPrivateKey(
        TEST_MNEMONIC.split(/\s+/).filter(Boolean)
    );
    const deployerAddress = WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey
    }).address.toString({ bounceable: true, urlSafe: true });

    transport.seedTransactions(deployerAddress, [
        {
            utime: Math.floor(Date.now() / 1000) + 5,
            transaction_id: { hash: "GameEscrowSettleTxHash==", lt: "2002" },
            out_msgs: [{ destination: ESCROW }]
        }
    ]);

    let currentSeqno = 1;

    const adapter = new TonGameContractAdapter({
        tonConfig: {
            endpoint: "https://testnet.toncenter.com/api/v2/jsonRPC",
            apiKey: null,
            deployerMnemonic: TEST_MNEMONIC,
            network: "testnet",
            gameEscrowMode,
            settlementTxLookupTimeoutMs: 2000,
            settlementTxLookupPollMs: 50
        },
        tonService: {
            getActiveNetwork: () => "testnet",
            isConnected: () => true,
            getTransport: () => transport,
            async broadcastTransaction(boc) {

                // R7.70C2.6 — broadcast acceptance then on-chain seqno advance.
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
        }
    });

    return { adapter, transport };

}

async function main() {

    resetTonSettlementDebugForTests();

    // --- serializer matches contract ABI ---

    {
        const body = serializeGameEscrowSettleBody({
            snapshotHash: SNAPSHOT_HASH,
            winnerWallet: WINNER,
            winnerAmount: 2.85,
            ownerAmount: 0.15
        });
        assertGameEscrowSettleBody(body);
        console.log("  serializer matches contract ABI: OK");
    }

    // --- deterministic body ---

    {
        const a = serializeGameEscrowSettleBody({
            snapshotHash: SNAPSHOT_HASH,
            winnerWallet: WINNER,
            winnerAmount: 2.85,
            ownerAmount: 0.15
        });
        const b = serializeGameEscrowSettleBody({
            snapshotHash: SNAPSHOT_HASH,
            winnerWallet: WINNER,
            winnerAmount: "2.85",
            organizerAmount: 0.15
        });
        assert.equal(a.hash().toString("hex"), b.hash().toString("hex"));

        const different = serializeGameEscrowSettleBody({
            snapshotHash: SNAPSHOT_HASH,
            winnerWallet: WINNER,
            winnerAmount: 2.85,
            ownerAmount: 0.16
        });
        assert.notEqual(a.hash().toString("hex"), different.hash().toString("hex"));
        console.log("  deterministic body: OK");
    }

    // --- v4 path unchanged ---

    {
        resetTonSettlementDebugForTests();

        const plan = buildSettleMessagePlan({
            winnerAmount: 2.85,
            organizerAmount: 0.15,
            gameEscrowMode: GAME_ESCROW_MODE_V4
        });
        assert.equal(plan.ok, true);
        assert.equal(plan.mode, GAME_ESCROW_MODE_V4);

        const legacy = serializeLegacySettleBody({
            winnerAmount: 2.85,
            organizerAmount: 0.15
        });
        assert.equal(plan.body.hash().toString("hex"), legacy.hash().toString("hex"));

        const slice = plan.body.beginParse();
        assert.equal(slice.loadUint(24), GAME_CONTRACT_OPCODES.SETTLE);
        assert.equal(slice.loadCoins(), toNano("2.85"));
        assert.equal(slice.loadCoins(), toNano("0.15"));

        const { adapter, transport } = await createLiveAdapter(GAME_ESCROW_MODE_V4);
        const result = await adapter.settleContract({
            contractId: "c_v4",
            contractAddress: ESCROW,
            winnerWallet: WINNER,
            ownerWallet: OWNER,
            winnerId: "p1",
            winnerAmount: 2.85,
            organizerAmount: 0.15,
            gameEscrowMode: GAME_ESCROW_MODE_V4
        });

        assert.equal(result.ok, true);
        assert.ok(result.settlementTxId);
        assert.equal(transport.sentBocs.length, 1);
        assert.equal(
            getTonSettlementDebug()?.gameEscrowSettlement?.mode,
            GAME_ESCROW_MODE_V4
        );

        console.log("  v4 path unchanged: OK");
    }

    // --- game path creates SETTLE message ---

    {
        resetTonSettlementDebugForTests();

        const plan = buildSettleMessagePlan({
            winnerWallet: WINNER,
            winnerAmount: 2.85,
            organizerAmount: 0.15,
            snapshotHash: SNAPSHOT_HASH,
            gameEscrowMode: GAME_ESCROW_MODE_GAME
        });

        assert.equal(plan.ok, true);
        assert.equal(plan.mode, GAME_ESCROW_MODE_GAME);
        assertGameEscrowSettleBody(plan.body);

        const { adapter, transport } = await createLiveAdapter(GAME_ESCROW_MODE_GAME);
        const result = await adapter.settleContract({
            contractId: "c_game",
            contractAddress: ESCROW,
            winnerWallet: WINNER,
            ownerWallet: OWNER,
            winnerId: "p1",
            winnerAmount: 2.85,
            organizerAmount: 0.15,
            snapshotHash: SNAPSHOT_HASH,
            gameEscrowMode: GAME_ESCROW_MODE_GAME
        });

        assert.equal(result.ok, true);
        assert.ok(result.settlementTxId);
        assert.equal(transport.sentBocs.length, 1);

        const debug = getTonSettlementDebug()?.gameEscrowSettlement;
        assert.equal(debug?.mode, GAME_ESCROW_MODE_GAME);
        assert.equal(debug?.escrowAddress, ESCROW);
        assert.equal(debug?.winner, WINNER);
        assert.equal(debug?.owner, OWNER);
        assert.equal(debug?.winnerAmount, 2.85);
        assert.equal(debug?.ownerAmount, 0.15);
        assert.equal(debug?.snapshotHash, SNAPSHOT_HASH);
        assert.equal(debug?.transactionHash, result.settlementTxId);

        console.log("  game path creates SETTLE message: OK");
    }

    resetTonSettlementDebugForTests();
    console.log("gameEscrowSettle.test.js: all assertions passed");

}

main().catch((error) => {

    console.error(error);
    process.exitCode = 1;

});
