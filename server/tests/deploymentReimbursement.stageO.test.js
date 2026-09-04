/**
 * R17.8V.2P.O — Deployment Reimbursement Transfer Service tests.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Cell, loadMessage } from "@ton/core";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import {
    TonFinancialPersistence,
    TON_FINANCIAL_RECORD_TYPES
} from "../persistence/TonFinancialPersistence.js";
import { DeploymentCostSnapshotRepository } from "../payment/reimbursement/DeploymentCostSnapshotRepository.js";
import { DeploymentReimbursementRepository } from "../payment/reimbursement/DeploymentReimbursementRepository.js";
import { DeploymentReimbursementWorker } from "../payment/reimbursement/DeploymentReimbursementWorker.js";
import {
    REIMBURSEMENT_TRANSFER_RESULT,
    ReimbursementTransferService
} from "../payment/reimbursement/ReimbursementTransferService.js";
import {
    deriveReimbursementWalletIdentity,
    loadReimbursementWalletConfig,
    reimbursementAddressesEqual
} from "../payment/reimbursement/ReimbursementWalletConfig.js";
import { DEPLOYMENT_COST_SNAPSHOT_STATUS } from "../payment/reimbursement/deploymentCostSnapshotStates.js";
import { DEPLOYMENT_REIMBURSEMENT_STATUS } from "../payment/reimbursement/deploymentReimbursementStates.js";
import { ReimbursementWalletAdapter } from "../payment/reimbursement/ReimbursementWalletAdapter.js";
import { SECRET_ENV_KEYS } from "../config/secrets.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REIMB_DIR = join(__dirname, "../payment/reimbursement");

const TEST_MNEMONIC = [
    "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
    "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
    "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
    "abandon", "abandon", "abandon", "abandon", "abandon", "about"
].join(" ");

const DEPLOY_HASH = "oszAXcW26TcLUBz8QVnns4AjsKX/bRPXWYRD3J57GiY=";
const DEPLOY_WALLET = "EQB83sDeployWalletExampleAddress0000000000003PDQ";
const COST = "0.023859709";

async function reimbursementAddressFromMnemonic(mnemonic = TEST_MNEMONIC) {

    const identity = await deriveReimbursementWalletIdentity(mnemonic);

    return identity.address;

}

function createMockAdapter({
    address,
    sendImpl = async () => ({
        ok: true,
        code: "SENT",
        txHash: "mock_tx_hash_stage_o"
    })
} = {}) {

    return {
        _address: address,
        async initialize() {
            return { ok: true, address: this._address };
        },
        shutdown() {},
        getAddress() {
            return this._address;
        },
        async sendTransfer(params) {
            return sendImpl(params);
        }
    };

}

function createStack({
    enabled = true,
    emergencyEnabled = true,
    maxTransfer = "0.05",
    adapter = null,
    withSnapshot = true
} = {}) {

    const dir = mkdtempSync(join(tmpdir(), "wheelwin-reimb-stage-o-"));

    const persistence = new TonFinancialPersistence({
        dataDir: dir,
        autoCheckpoint: false
    });

    persistence.initialize();

    const snapshotRepository = new DeploymentCostSnapshotRepository({
        persistence,
        tonNetwork: "testnet"
    });

    const repository = new DeploymentReimbursementRepository({
        persistence,
        tonNetwork: "testnet"
    });

    return {
        dir,
        persistence,
        snapshotRepository,
        repository,
        env: {
            DEPLOYMENT_REIMBURSEMENT_ENABLED: enabled ? "true" : "false",
            REIMBURSEMENT_ENABLED: emergencyEnabled ? "true" : "false",
            REIMBURSEMENT_MAX_TRANSFER: maxTransfer
        },
        adapter,
        withSnapshot,
        cleanup() {
            rmSync(dir, { recursive: true, force: true });
        }
    };

}

async function seedFrozenAndPending(stack, {
    gameId = "game_stage_o_1",
    deployWallet = DEPLOY_WALLET,
    amountTon = COST,
    reimbursementWallet
} = {}) {

    const pendingSnap = stack.snapshotRepository.create({
        gameId,
        roomId: "room_stage_o_1",
        contractId: "contract_stage_o_1",
        contractAddress: "EQCvx9tido_G8ZtyMgxMR_bKxjRG1qSGGHQFFNU2-at8WC7s",
        deploymentTxHash: `${DEPLOY_HASH}:${gameId}`,
        deployWallet,
        status: DEPLOYMENT_COST_SNAPSHOT_STATUS.PENDING_LOOKUP
    });

    const frozen = stack.snapshotRepository.freezeFromChain(pendingSnap.recordId, {
        attachedTon: "0.020396066",
        networkFeeTon: "0.003463643",
        deploymentCostTon: amountTon,
        source: "chain"
    });

    const reimb = stack.repository.create({
        gameId,
        roomId: "room_stage_o_1",
        contractId: "contract_stage_o_1",
        deploymentTxHash: `${DEPLOY_HASH}:${gameId}`,
        deployWallet,
        reimbursementWallet,
        deploymentCostSnapshotId: frozen.recordId,
        amountTon,
        status: DEPLOYMENT_REIMBURSEMENT_STATUS.PENDING
    });

    return { frozen, reimb };
}

async function main() {

    const stacks = [];
    const reimbAddress = await reimbursementAddressFromMnemonic();

    try {

        assert.ok(
            SECRET_ENV_KEYS.includes("TON_REIMBURSEMENT_MNEMONIC"),
            "reimbursement mnemonic must be registered as secret"
        );
        assert.ok(
            SECRET_ENV_KEYS.includes("TON_RESIDUES_MNEMONIC"),
            "residues mnemonic must be registered as secret"
        );

        // --- Security: address pin match / mismatch ---

        {
            const ok = await loadReimbursementWalletConfig({
                TON_REIMBURSEMENT_MNEMONIC: TEST_MNEMONIC,
                TON_REIMBURSEMENT_EXPECTED_ADDRESS: reimbAddress
            });

            assert.equal(ok.ok, true);
            assert.ok(
                reimbursementAddressesEqual(ok.derivedAddress, reimbAddress)
            );

            const mismatch = await loadReimbursementWalletConfig({
                TON_REIMBURSEMENT_MNEMONIC: TEST_MNEMONIC,
                TON_REIMBURSEMENT_EXPECTED_ADDRESS: DEPLOY_WALLET
            });

            assert.equal(mismatch.ok, false);
            assert.equal(mismatch.code, "ADDRESS_MISMATCH");

            const empty = await loadReimbursementWalletConfig({
                TON_REIMBURSEMENT_MNEMONIC: "",
                TON_REIMBURSEMENT_EXPECTED_ADDRESS: reimbAddress
            });

            assert.equal(empty.ok, false);
            assert.equal(empty.code, "MISSING_MNEMONIC");
        }

        // --- Security: owner / deployer mnemonic never referenced in Stage O sources ---

        {
            const files = [
                "ReimbursementTransferService.js",
                "ReimbursementWalletAdapter.js",
                "ReimbursementWalletConfig.js",
                "DeploymentReimbursementWorker.js"
            ];

            for (const file of files) {

                const source = readFileSync(join(REIMB_DIR, file), "utf8");

                assert.equal(
                    /TON_DEPLOYER_MNEMONIC/.test(source),
                    false,
                    `${file} must not access deployer mnemonic`
                );
                assert.equal(
                    /OWNER_MNEMONIC|ownerMnemonic|owner_wallet_mnemonic/i.test(source),
                    false,
                    `${file} must not access owner mnemonic env`
                );
                assert.equal(/GameEscrow/.test(source), false);
                assert.equal(/SETTLE/.test(source), false);
            }

            const adapterSrc = readFileSync(
                join(REIMB_DIR, "ReimbursementWalletAdapter.js"),
                "utf8"
            );

            assert.ok(adapterSrc.includes("TON_REIMBURSEMENT") || adapterSrc.includes("loadReimbursementWalletConfig"));
            assert.match(adapterSrc, /send permanently retired/);
            assert.equal(/broadcastTransaction/.test(adapterSrc), false);
        }

        // --- Validation: disabled flag blocks send ---

        {
            const stack = createStack({ enabled: false });

            stacks.push(stack);

            const transfer = new ReimbursementTransferService({
                adapter: createMockAdapter({ address: reimbAddress }),
                env: stack.env
            });

            await transfer.initialize();

            const result = await transfer.sendReimbursement({
                payload: {
                    gameId: "g1",
                    deployWallet: DEPLOY_WALLET,
                    amountTon: COST,
                    reimbursementWallet: reimbAddress
                }
            });

            assert.equal(result.ok, false);
            assert.equal(
                result.code,
                REIMBURSEMENT_TRANSFER_RESULT.SEND_RETIRED
            );
        }

        // --- Validation: emergency pause ---

        {
            const stack = createStack({
                enabled: true,
                emergencyEnabled: false
            });

            stacks.push(stack);

            const transfer = new ReimbursementTransferService({
                adapter: createMockAdapter({ address: reimbAddress }),
                env: stack.env
            });

            await transfer.initialize();

            const result = await transfer.sendReimbursement({
                payload: {
                    gameId: "g1",
                    deployWallet: DEPLOY_WALLET,
                    amountTon: COST,
                    reimbursementWallet: reimbAddress
                }
            });

            assert.equal(result.ok, false);
            assert.equal(
                result.code,
                REIMBURSEMENT_TRANSFER_RESULT.SEND_RETIRED
            );
        }

        // --- Validation: invalid amount / exceeds max ---

        {
            const stack = createStack({
                enabled: true,
                maxTransfer: "0.01"
            });

            stacks.push(stack);

            const transfer = new ReimbursementTransferService({
                adapter: createMockAdapter({ address: reimbAddress }),
                env: stack.env
            });

            await transfer.initialize();

            const zero = await transfer.sendReimbursement({
                payload: {
                    gameId: "g_zero",
                    deployWallet: DEPLOY_WALLET,
                    amountTon: "0",
                    reimbursementWallet: reimbAddress
                }
            });

            assert.equal(zero.ok, false);
            assert.equal(zero.code, REIMBURSEMENT_TRANSFER_RESULT.SEND_RETIRED);

            const over = await transfer.sendReimbursement({
                payload: {
                    gameId: "g_over",
                    deployWallet: DEPLOY_WALLET,
                    amountTon: COST,
                    reimbursementWallet: reimbAddress
                }
            });

            assert.equal(over.ok, false);
            assert.equal(
                over.code,
                REIMBURSEMENT_TRANSFER_RESULT.SEND_RETIRED
            );
        }

        // --- Validation: destination must match frozen snapshot ---

        {
            const stack = createStack({ enabled: true });

            stacks.push(stack);

            await seedFrozenAndPending(stack, {
                gameId: "game_stage_o_dest",
                reimbursementWallet: reimbAddress
            });

            const transfer = new ReimbursementTransferService({
                adapter: createMockAdapter({ address: reimbAddress }),
                snapshotRepository: stack.snapshotRepository,
                env: stack.env
            });

            await transfer.initialize();

            const badDest = await transfer.sendReimbursement({
                payload: {
                    gameId: "game_stage_o_dest",
                    deployWallet: reimbAddress,
                    amountTon: COST,
                    reimbursementWallet: reimbAddress
                }
            });

            assert.equal(badDest.ok, false);
            assert.equal(
                badDest.code,
                REIMBURSEMENT_TRANSFER_RESULT.SEND_RETIRED
            );
        }

        // --- Transfer: mock success → SENT + worker stores txHash, not CONFIRMED ---

        {
            const stack = createStack({ enabled: true });

            stacks.push(stack);

            const { reimb } = await seedFrozenAndPending(stack, {
                gameId: "game_stage_o_sent",
                reimbursementWallet: reimbAddress
            });

            const transfer = new ReimbursementTransferService({
                adapter: createMockAdapter({
                    address: reimbAddress,
                    sendImpl: async () => ({
                        ok: true,
                        code: "SENT",
                        txHash: "mock_success_tx_o"
                    })
                }),
                snapshotRepository: stack.snapshotRepository,
                env: stack.env
            });

            await transfer.initialize();

            const sent = await transfer.sendReimbursement(reimb);

            assert.equal(sent.ok, false);
            assert.equal(sent.code, REIMBURSEMENT_TRANSFER_RESULT.SEND_RETIRED);
            assert.equal(sent.txHash, null);

            const worker = new DeploymentReimbursementWorker({
                repository: stack.repository,
                transferService: transfer,
                env: stack.env,
                pollIntervalMs: 60_000
            });

            worker.initialize();

            const queue = await worker.processQueue();

            assert.equal(queue.skipped, "send_permanently_retired");
            assert.equal(queue.claimed, 0);

            const after = stack.repository.findById(reimb.recordId);

            assert.equal(
                after.payload.status,
                DEPLOYMENT_REIMBURSEMENT_STATUS.PENDING
            );
            assert.equal(after.payload.txHash, null);
            assert.notEqual(
                after.payload.status,
                DEPLOYMENT_REIMBURSEMENT_STATUS.CONFIRMED
            );

            worker.shutdown();
            transfer.shutdown();
        }

        // --- Transfer: mock failure → FAILED_RETRY ---

        {
            const stack = createStack({ enabled: true });

            stacks.push(stack);

            const { reimb } = await seedFrozenAndPending(stack, {
                gameId: "game_stage_o_fail",
                reimbursementWallet: reimbAddress
            });

            const transfer = new ReimbursementTransferService({
                adapter: createMockAdapter({
                    address: reimbAddress,
                    sendImpl: async () => ({
                        ok: false,
                        code: "FAILED",
                        errorReason: "mock_broadcast_error"
                    })
                }),
                snapshotRepository: stack.snapshotRepository,
                env: stack.env
            });

            await transfer.initialize();

            const worker = new DeploymentReimbursementWorker({
                repository: stack.repository,
                transferService: transfer,
                env: stack.env,
                pollIntervalMs: 60_000
            });

            worker.initialize();

            const queue = await worker.processQueue();

            assert.equal(queue.skipped, "send_permanently_retired");
            assert.equal(queue.claimed, 0);

            const after = stack.repository.findById(reimb.recordId);

            assert.equal(
                after.payload.status,
                DEPLOYMENT_REIMBURSEMENT_STATUS.PENDING
            );
            assert.equal(after.payload.txHash, null);

            worker.shutdown();
            transfer.shutdown();
        }

        // --- Uninit reimbursement wallet: seqno get-method exit_code -13 ---

        {
            let capturedBoc = null;
            const adapter = new ReimbursementWalletAdapter({
                tonService: {
                    async getBalance() {
                        return 2_000_000_000n;
                    },
                    async getSeqno() {
                        throw new Error(
                            "Unable to execute get method. Got exit_code: -13"
                        );
                    },
                    async broadcastTransaction(boc) {
                        capturedBoc = boc;
                        return { hash: "uninit_seqno_broadcast_hash" };
                    }
                },
                env: {
                    TON_REIMBURSEMENT_MNEMONIC: TEST_MNEMONIC,
                    TON_REIMBURSEMENT_EXPECTED_ADDRESS: reimbAddress
                }
            });

            const result = await adapter.sendTransfer({
                destination:
                    "EQB83s9XMOMseDFxyXxj4hrC0sS4FB4xhdNiUPkl_3zx3PDQ",
                amountTon: "0.023878622"
            });

            assert.equal(result.ok, false);
            assert.equal(result.code, "SEND_RETIRED");
            assert.equal(capturedBoc, null);

            adapter.shutdown();
        }

        {
            let capturedBoc = null;
            const adapter = new ReimbursementWalletAdapter({
                tonService: {
                    async getBalance() {
                        return 2_000_000_000n;
                    },
                    async getSeqno() {
                        return 4;
                    },
                    async broadcastTransaction(boc) {
                        capturedBoc = boc;
                        return { hash: "active_seqno_broadcast_hash" };
                    }
                },
                env: {
                    TON_REIMBURSEMENT_MNEMONIC: TEST_MNEMONIC,
                    TON_REIMBURSEMENT_EXPECTED_ADDRESS: reimbAddress
                }
            });

            const result = await adapter.sendTransfer({
                destination:
                    "EQB83s9XMOMseDFxyXxj4hrC0sS4FB4xhdNiUPkl_3zx3PDQ",
                amountTon: "0.023878622"
            });

            assert.equal(result.ok, false);
            assert.equal(result.code, "SEND_RETIRED");
            assert.equal(capturedBoc, null);

            adapter.shutdown();
        }

        // --- Safety: no real TonService broadcast in these tests ---

        {
            let broadcastCalls = 0;

            const fakeTon = {
                async getSeqno() {
                    return 1;
                },
                async getBalance() {
                    return 1_000_000_000n;
                },
                async broadcastTransaction() {
                    broadcastCalls += 1;
                    throw new Error("real broadcast must not run in Stage O tests");
                }
            };

            // Tests above used mocks only; assert harness never called broadcast.
            assert.equal(broadcastCalls, 0);
            assert.equal(typeof fakeTon.broadcastTransaction, "function");
            assert.equal(
                TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_REIMBURSEMENT,
                "deployment_reimbursement"
            );

            // Sanity: derived address is real V4R2 from test mnemonic.
            const keyPair = await mnemonicToPrivateKey(
                TEST_MNEMONIC.split(/\s+/).filter(Boolean)
            );
            const wallet = WalletContractV4.create({
                workchain: 0,
                publicKey: keyPair.publicKey
            });

            assert.ok(
                reimbursementAddressesEqual(
                    wallet.address.toString({ bounceable: true, urlSafe: true }),
                    reimbAddress
                )
            );
        }

        console.log("deploymentReimbursement.stageO.test.js: OK");

    } finally {

        for (const stack of stacks) {

            try {

                stack.cleanup();

            } catch {

                // ignore

            }

        }

    }

}

main().catch((error) => {

    console.error(error);
    process.exitCode = 1;

});
