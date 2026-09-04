/**
 * R17.8V.2P.Q — Deployment Reimbursement Production Safety Hardening tests.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { toNano } from "@ton/core";

import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import { DeploymentReimbursementRepository } from "../payment/reimbursement/DeploymentReimbursementRepository.js";
import { DeploymentReimbursementWorker } from "../payment/reimbursement/DeploymentReimbursementWorker.js";
import {
    REIMBURSEMENT_TRANSFER_RESULT,
    ReimbursementTransferService
} from "../payment/reimbursement/ReimbursementTransferService.js";
import {
    ReimbursementPolicy,
    REIMBURSEMENT_POLICY_RESULT
} from "../payment/reimbursement/ReimbursementPolicy.js";
import {
    ReimbursementWalletMonitor,
    REIMBURSEMENT_WALLET_MONITOR_RESULT
} from "../payment/reimbursement/ReimbursementWalletMonitor.js";
import { ReimbursementTransactionScanner } from "../payment/reimbursement/ReimbursementTransactionScanner.js";
import {
    REIMBURSEMENT_CONFIRMATION_RESULT,
    ReimbursementConfirmationService
} from "../payment/reimbursement/ReimbursementConfirmationService.js";
import { DEPLOYMENT_REIMBURSEMENT_STATUS } from "../payment/reimbursement/deploymentReimbursementStates.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { nanotonToTonString } from "../payment/reimbursement/nanoton.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REIMB_DIR = join(__dirname, "../payment/reimbursement");

const REIMB_WALLET = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
const DEPLOY_WALLET = "EQBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQX8";
const AMOUNT_NANO = toNano("0.02");
const AMOUNT_TON = nanotonToTonString(AMOUNT_NANO);
const TX_HASH = "real_chain_tx_hash_stage_q";

function mockTx({
    hash = TX_HASH,
    destination = DEPLOY_WALLET,
    value = AMOUNT_NANO.toString(),
    lt = "100",
    utime = Math.floor(Date.now() / 1000)
} = {}) {

    return {
        utime,
        transaction_id: { hash, lt },
        out_msgs: [{ destination, value }]
    };

}

function createRepo() {

    const dir = mkdtempSync(join(tmpdir(), "wheelwin-reimb-stage-q-"));

    const persistence = new TonFinancialPersistence({
        dataDir: dir,
        autoCheckpoint: false
    });

    persistence.initialize();

    const repository = new DeploymentReimbursementRepository({
        persistence,
        tonNetwork: "testnet"
    });

    return {
        dir,
        repository,
        cleanup() {
            rmSync(dir, { recursive: true, force: true });
        }
    };

}

function seedPending(repository, {
    gameId,
    amountTon = AMOUNT_TON,
    deployWallet = DEPLOY_WALLET
} = {}) {

    return repository.create({
        gameId,
        roomId: "room_q",
        contractId: "contract_q",
        deploymentTxHash: `deploy:${gameId}`,
        deployWallet,
        reimbursementWallet: REIMB_WALLET,
        deploymentCostSnapshotId: `snap:${gameId}`,
        amountTon,
        status: DEPLOYMENT_REIMBURSEMENT_STATUS.PENDING
    });

}

async function main() {

    const cleanups = [];

    try {

        assert.equal(
            EVENT_TYPES.REIMBURSEMENT_DAILY_LIMIT_REACHED,
            "REIMBURSEMENT_DAILY_LIMIT_REACHED"
        );
        assert.equal(
            DEPLOYMENT_REIMBURSEMENT_STATUS.AWAITING_TRANSACTION_HASH,
            "AWAITING_TRANSACTION_HASH"
        );

        // --- Limits: max transfer + daily limit across multiple records ---

        {
            const stack = createRepo();

            cleanups.push(stack);

            const policy = new ReimbursementPolicy({
                repository: stack.repository,
                env: {
                    REIMBURSEMENT_MAX_TRANSFER: "0.03",
                    REIMBURSEMENT_DAILY_LIMIT: "0.05"
                }
            });

            assert.equal(
                policy.validateSingleTransfer("0.04").code,
                REIMBURSEMENT_POLICY_RESULT.AMOUNT_EXCEEDS_MAX
            );
            assert.equal(
                policy.validateSingleTransfer("0.02").ok,
                true
            );

            const first = seedPending(stack.repository, {
                gameId: "game_q_daily_1",
                amountTon: "0.03"
            });

            stack.repository.markSent(first.recordId, { txHash: "tx_daily_1" });

            const blocked = policy.validateDailyLimit({
                amountTon: "0.03",
                excludeRecordId: null
            });

            assert.equal(blocked.ok, false);
            assert.equal(
                blocked.code,
                REIMBURSEMENT_POLICY_RESULT.DAILY_LIMIT_REACHED
            );

            const okSmall = policy.validateDailyLimit({
                amountTon: "0.01"
            });

            assert.equal(okSmall.ok, true);
        }

        // --- Wallet: insufficient balance + reserve ---

        {
            const monitor = new ReimbursementWalletMonitor({
                address: REIMB_WALLET,
                env: { REIMBURSEMENT_WALLET_RESERVE: "0.05" },
                tonService: {
                    async getBalance() {
                        return toNano("0.06");
                    }
                }
            });

            const fail = await monitor.validateAvailableBalance("0.02");

            assert.equal(fail.ok, false);
            assert.equal(
                fail.code,
                REIMBURSEMENT_WALLET_MONITOR_RESULT.INSUFFICIENT_BALANCE
            );

            const ok = await monitor.validateAvailableBalance("0.005");

            assert.equal(ok.ok, true);
        }

        // --- Emergency: global disabled / operational pause ---

        {
            const stack = createRepo();

            cleanups.push(stack);

            seedPending(stack.repository, { gameId: "game_q_pause" });

            let sendCalls = 0;

            const transferService = {
                async sendReimbursement() {
                    sendCalls += 1;
                    return {
                        ok: false,
                        code: REIMBURSEMENT_TRANSFER_RESULT.FEATURE_DISABLED
                    };
                }
            };

            const worker = new DeploymentReimbursementWorker({
                repository: stack.repository,
                transferService,
                env: {
                    DEPLOYMENT_REIMBURSEMENT_ENABLED: "true",
                    REIMBURSEMENT_ENABLED: "false"
                },
                pollIntervalMs: 60_000
            });

            worker.initialize();

            const paused = await worker.processQueue();

            assert.equal(paused.skipped, "send_permanently_retired");
            assert.equal(sendCalls, 0);
            assert.equal(stack.repository.listPending().length, 1);
            assert.equal(
                stack.repository.findByGameId("game_q_pause").payload.status,
                DEPLOYMENT_REIMBURSEMENT_STATUS.PENDING
            );

            worker.shutdown();

            const transfer = new ReimbursementTransferService({
                env: {
                    DEPLOYMENT_REIMBURSEMENT_ENABLED: "false",
                    REIMBURSEMENT_ENABLED: "true"
                }
            });

            await transfer.initialize();

            const disabled = await transfer.sendReimbursement({
                payload: {
                    deployWallet: DEPLOY_WALLET,
                    amountTon: AMOUNT_TON,
                    reimbursementWallet: REIMB_WALLET
                }
            });

            assert.equal(
                disabled.code,
                REIMBURSEMENT_TRANSFER_RESULT.SEND_RETIRED
            );
        }

        // --- No synthetic hash: adapter-equivalent path via transfer service ---

        {
            const stack = createRepo();

            cleanups.push(stack);

            const created = seedPending(stack.repository, {
                gameId: "game_q_await_hash"
            });

            const transferService = new ReimbursementTransferService({
                adapter: {
                    getAddress: () => REIMB_WALLET,
                    async sendTransfer() {
                        return {
                            ok: true,
                            code: "AWAITING_TRANSACTION_HASH",
                            txHash: null,
                            seqno: 7
                        };
                    }
                },
                env: {
                    DEPLOYMENT_REIMBURSEMENT_ENABLED: "true",
                    REIMBURSEMENT_ENABLED: "true",
                    REIMBURSEMENT_MAX_TRANSFER: "1",
                    REIMBURSEMENT_DAILY_LIMIT: "10"
                }
            });

            await transferService.initialize();

            const worker = new DeploymentReimbursementWorker({
                repository: stack.repository,
                transferService,
                env: {
                    DEPLOYMENT_REIMBURSEMENT_ENABLED: "true",
                    REIMBURSEMENT_ENABLED: "true"
                },
                pollIntervalMs: 60_000
            });

            worker.initialize();

            const queue = await worker.processQueue();

            assert.equal(queue.skipped, "send_permanently_retired");
            assert.equal(queue.claimed, 0);

            const after = stack.repository.findById(created.recordId);

            assert.equal(
                after.payload.status,
                DEPLOYMENT_REIMBURSEMENT_STATUS.PENDING
            );
            assert.equal(after.payload.txHash, null);

            assert.throws(
                () => stack.repository.markSent(created.recordId, {
                    txHash: "reimb_seqno_1_123"
                })
            );

            worker.shutdown();
            transferService.shutdown();
        }

        // --- Recover missing hash via deep scan; no resend ---

        {
            const stack = createRepo();

            cleanups.push(stack);

            const created = seedPending(stack.repository, {
                gameId: "game_q_recover"
            });

            stack.repository.markAwaitingTransactionHash(created.recordId, {
                processedAt: Date.now()
            });

            let sendCalls = 0;
            const pages = [
                [mockTx({
                    hash: "other",
                    destination: REIMB_WALLET,
                    lt: "200"
                })],
                [mockTx({ hash: TX_HASH, lt: "100" })]
            ];

            const transport = {
                async getTransactions(_wallet, query = {}) {
                    if (query.lt) {
                        return pages[1];
                    }
                    return pages[0];
                }
            };

            const scanner = new ReimbursementTransactionScanner({
                transport,
                pageSize: 1,
                maxPages: 5
            });

            const confirmation = new ReimbursementConfirmationService({
                repository: stack.repository,
                transport,
                scanner,
                env: { DEPLOYMENT_REIMBURSEMENT_ENABLED: "true" }
            });

            confirmation.initialize();

            const recovered = await confirmation.recoverMissingTransactionHashes();

            assert.equal(recovered.scanned, 1);
            assert.equal(
                recovered.results[0]?.code,
                REIMBURSEMENT_CONFIRMATION_RESULT.TX_RECOVERED
            );

            const after = stack.repository.findById(created.recordId);

            assert.equal(after.payload.txHash, TX_HASH);
            assert.equal(
                after.payload.status,
                DEPLOYMENT_REIMBURSEMENT_STATUS.CONFIRMED
            );

            const worker = new DeploymentReimbursementWorker({
                repository: stack.repository,
                transferService: {
                    async sendReimbursement() {
                        sendCalls += 1;
                        return { ok: true, code: "SENT", txHash: "nope" };
                    }
                },
                confirmationService: confirmation,
                env: {
                    DEPLOYMENT_REIMBURSEMENT_ENABLED: "true",
                    REIMBURSEMENT_ENABLED: "true"
                },
                pollIntervalMs: 60_000
            });

            worker.initialize();
            await worker.processQueue();
            assert.equal(sendCalls, 0);

            worker.shutdown();
            confirmation.shutdown();
        }

        // --- Deep scan pagination ---

        {
            const calls = [];
            const transport = {
                async getTransactions(_wallet, query = {}) {
                    calls.push(query);
                    if (!query.lt) {
                        return [mockTx({ hash: "page1", lt: "300" })];
                    }
                    if (query.lt === "300") {
                        return [mockTx({ hash: "page2", lt: "200" })];
                    }
                    return [];
                }
            };

            const scanner = new ReimbursementTransactionScanner({
                transport,
                pageSize: 1,
                maxPages: 10
            });

            const txs = await scanner.scanTransactions(REIMB_WALLET);

            assert.ok(txs.length >= 2);
            assert.ok(calls.length >= 2);
            assert.ok(calls.some((q) => q.lt && q.hash));
        }

        // --- Transfer service uses wallet monitor ---

        {
            const transfer = new ReimbursementTransferService({
                adapter: {
                    getAddress: () => REIMB_WALLET,
                    async sendTransfer() {
                        return { ok: true, code: "SENT", txHash: "should_not" };
                    }
                },
                walletMonitor: new ReimbursementWalletMonitor({
                    address: REIMB_WALLET,
                    env: { REIMBURSEMENT_WALLET_RESERVE: "0.05" },
                    tonService: {
                        async getBalance() {
                            return toNano("0.01");
                        }
                    }
                }),
                env: {
                    DEPLOYMENT_REIMBURSEMENT_ENABLED: "true",
                    REIMBURSEMENT_ENABLED: "true",
                    REIMBURSEMENT_MAX_TRANSFER: "1"
                }
            });

            await transfer.initialize();

            const result = await transfer.sendReimbursement({
                payload: {
                    deployWallet: DEPLOY_WALLET,
                    amountTon: "0.02",
                    reimbursementWallet: REIMB_WALLET
                }
            });

            assert.equal(
                result.code,
                REIMBURSEMENT_TRANSFER_RESULT.SEND_RETIRED
            );
            assert.equal(result.txHash, null);

            transfer.shutdown();
        }

        // --- Security: no Owner / GameEscrow / Settlement in Stage Q modules ---

        {
            const files = [
                "ReimbursementPolicy.js",
                "ReimbursementWalletMonitor.js",
                "ReimbursementTransactionScanner.js"
            ];

            for (const file of files) {

                const source = readFileSync(join(REIMB_DIR, file), "utf8");

                assert.equal(/TON_DEPLOYER_MNEMONIC|OWNER_MNEMONIC/.test(source), false);
                assert.equal(/GameEscrow|SETTLE/.test(source), false);
                assert.equal(/broadcastTransaction|createTransfer|mnemonicToPrivateKey/.test(source), false);
            }

            const adapter = readFileSync(
                join(REIMB_DIR, "ReimbursementWalletAdapter.js"),
                "utf8"
            );

            assert.equal(/reimb_seqno_/.test(adapter), false);
        }

        console.log("deploymentReimbursement.stageQ.test.js: OK");

    } finally {

        for (const stack of cleanups) {

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
