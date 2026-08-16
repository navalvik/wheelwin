/**
 * R17.8V.2P.P — Deployment Reimbursement Confirmation & Recovery tests.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { toNano } from "@ton/core";

import {
    TonFinancialPersistence,
    TON_FINANCIAL_RECORD_TYPES
} from "../persistence/TonFinancialPersistence.js";
import { DeploymentReimbursementRepository } from "../payment/reimbursement/DeploymentReimbursementRepository.js";
import { DeploymentReimbursementWorker } from "../payment/reimbursement/DeploymentReimbursementWorker.js";
import {
    REIMBURSEMENT_CONFIRMATION_RESULT,
    ReimbursementConfirmationService
} from "../payment/reimbursement/ReimbursementConfirmationService.js";
import {
    REIMBURSEMENT_CONFIRMATION_MAX_ATTEMPTS
} from "../payment/reimbursement/reimbursementConfirmationBackoff.js";
import {
    extractReimbursementTransferFromTransaction
} from "../payment/reimbursement/extractReimbursementTransferFromTransaction.js";
import { DEPLOYMENT_REIMBURSEMENT_STATUS } from "../payment/reimbursement/deploymentReimbursementStates.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { nanotonToTonString } from "../payment/reimbursement/nanoton.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REIMB_DIR = join(__dirname, "../payment/reimbursement");

const TX_HASH = "reimb_confirm_tx_hash_stage_p";
const REIMB_WALLET = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
const DEPLOY_WALLET = "EQBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQX8";
const OTHER_WALLET = "EQCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCAM9c";
const AMOUNT_NANO = toNano("0.023859709");
const AMOUNT_TON = nanotonToTonString(AMOUNT_NANO);

function mockTx({
    hash = TX_HASH,
    destination = DEPLOY_WALLET,
    value = AMOUNT_NANO.toString(),
    aborted = false
} = {}) {

    return {
        aborted,
        transaction_id: { hash },
        out_msgs: [
            {
                destination,
                value
            }
        ]
    };

}

function createStack({
    enabled = true,
    transport = null
} = {}) {

    const dir = mkdtempSync(join(tmpdir(), "wheelwin-reimb-stage-p-"));

    const persistence = new TonFinancialPersistence({
        dataDir: dir,
        autoCheckpoint: false
    });

    persistence.initialize();

    const repository = new DeploymentReimbursementRepository({
        persistence,
        tonNetwork: "testnet"
    });

    const env = {
        DEPLOYMENT_REIMBURSEMENT_ENABLED: enabled ? "true" : "false"
    };

    const confirmationService = new ReimbursementConfirmationService({
        repository,
        transport,
        env,
        logger: { info() {}, warn() {}, error() {}, debug() {} }
    });

    confirmationService.initialize();

    return {
        dir,
        persistence,
        repository,
        confirmationService,
        env,
        cleanup() {
            confirmationService.shutdown();
            rmSync(dir, { recursive: true, force: true });
        }
    };

}

function seedProcessingWithTx(repository, overrides = {}) {

    const created = repository.create({
        gameId: overrides.gameId ?? "game_stage_p_1",
        roomId: "room_stage_p_1",
        contractId: "contract_stage_p_1",
        deploymentTxHash: overrides.deploymentTxHash ?? `deploy:${overrides.gameId ?? "game_stage_p_1"}`,
        deployWallet: overrides.deployWallet ?? DEPLOY_WALLET,
        reimbursementWallet: overrides.reimbursementWallet ?? REIMB_WALLET,
        deploymentCostSnapshotId: "snap_stage_p_1",
        amountTon: overrides.amountTon ?? AMOUNT_TON,
        status: DEPLOYMENT_REIMBURSEMENT_STATUS.PENDING
    });

    return repository.markSent(created.recordId, {
        txHash: overrides.txHash ?? TX_HASH
    });

}

async function main() {

    const stacks = [];

    try {

        assert.equal(
            EVENT_TYPES.REIMBURSEMENT_CONFIRMED,
            "REIMBURSEMENT_CONFIRMED"
        );

        // --- Pure extract: success / wrong dest / wrong amount ---

        {
            const ok = extractReimbursementTransferFromTransaction(
                mockTx(),
                {
                    txHash: TX_HASH,
                    deployWallet: DEPLOY_WALLET,
                    amountTon: AMOUNT_TON,
                    reimbursementWallet: REIMB_WALLET
                }
            );

            assert.equal(ok.ok, true);
            assert.equal(ok.amountNanoton, AMOUNT_NANO);

            const badDest = extractReimbursementTransferFromTransaction(
                mockTx({ destination: OTHER_WALLET }),
                {
                    txHash: TX_HASH,
                    deployWallet: DEPLOY_WALLET,
                    amountTon: AMOUNT_TON
                }
            );

            assert.equal(badDest.ok, false);
            assert.equal(badDest.reason, "destination_mismatch");

            const badAmount = extractReimbursementTransferFromTransaction(
                mockTx({ value: toNano("0.01").toString() }),
                {
                    txHash: TX_HASH,
                    deployWallet: DEPLOY_WALLET,
                    amountTon: AMOUNT_TON
                }
            );

            assert.equal(badAmount.ok, false);
            assert.equal(badAmount.reason, "amount_mismatch");
        }

        // --- Confirmation: tx exists → CONFIRMED ---

        {
            const transport = {
                async getTransactions() {
                    return [mockTx()];
                }
            };

            const stack = createStack({ transport });

            stacks.push(stack);

            seedProcessingWithTx(stack.repository);

            const result = await stack.confirmationService.confirmTransaction(
                stack.repository.findByGameId("game_stage_p_1")
            );

            assert.equal(result.ok, true);
            assert.equal(
                result.code,
                REIMBURSEMENT_CONFIRMATION_RESULT.CONFIRMED
            );
            assert.equal(
                result.record.payload.status,
                DEPLOYMENT_REIMBURSEMENT_STATUS.CONFIRMED
            );
            assert.ok(result.record.payload.confirmedAt);
            assert.equal(result.record.immutable, true);

            assert.throws(
                () => stack.repository.updateStatus(result.record.recordId, {
                    status: DEPLOYMENT_REIMBURSEMENT_STATUS.PROCESSING
                })
            );
        }

        // --- Confirmation: wrong destination → FAILED_TERMINAL ---

        {
            const transport = {
                async getTransactions() {
                    return [mockTx({ destination: OTHER_WALLET })];
                }
            };

            const stack = createStack({ transport });

            stacks.push(stack);

            seedProcessingWithTx(stack.repository, {
                gameId: "game_stage_p_bad_dest",
                deploymentTxHash: "deploy:bad_dest"
            });

            const result = await stack.confirmationService.confirmTransaction(
                stack.repository.findByGameId("game_stage_p_bad_dest")
            );

            assert.equal(result.ok, false);
            assert.equal(
                result.code,
                REIMBURSEMENT_CONFIRMATION_RESULT.TERMINAL
            );
            assert.equal(
                result.record.payload.status,
                DEPLOYMENT_REIMBURSEMENT_STATUS.FAILED_TERMINAL
            );
            assert.equal(
                result.record.payload.confirmationError,
                "destination_mismatch"
            );
        }

        // --- Confirmation: wrong amount → FAILED_TERMINAL ---

        {
            const transport = {
                async getTransactions() {
                    return [mockTx({ value: toNano("0.001").toString() })];
                }
            };

            const stack = createStack({ transport });

            stacks.push(stack);

            seedProcessingWithTx(stack.repository, {
                gameId: "game_stage_p_bad_amt",
                deploymentTxHash: "deploy:bad_amt"
            });

            const result = await stack.confirmationService.confirmTransaction(
                stack.repository.findByGameId("game_stage_p_bad_amt")
            );

            assert.equal(result.ok, false);
            assert.equal(
                result.code,
                REIMBURSEMENT_CONFIRMATION_RESULT.TERMINAL
            );
            assert.equal(
                result.record.payload.confirmationError,
                "amount_mismatch"
            );
        }

        // --- Recovery: restart after broadcast; no duplicate send ---

        {
            let sendCalls = 0;
            let lookupCalls = 0;

            const transport = {
                async getTransactions() {
                    lookupCalls += 1;
                    return [mockTx()];
                }
            };

            const stack = createStack({ transport });

            stacks.push(stack);

            seedProcessingWithTx(stack.repository, {
                gameId: "game_stage_p_recover",
                deploymentTxHash: "deploy:recover"
            });

            const transferService = {
                async sendReimbursement() {
                    sendCalls += 1;
                    return {
                        ok: true,
                        code: "SENT",
                        txHash: "should_not_send"
                    };
                }
            };

            const worker = new DeploymentReimbursementWorker({
                repository: stack.repository,
                transferService,
                confirmationService: stack.confirmationService,
                env: stack.env,
                pollIntervalMs: 60_000
            });

            worker.initialize();

            assert.equal(stack.repository.listPending().length, 0);
            assert.equal(stack.repository.listAwaitingConfirmation().length, 1);

            const recovered = await stack.confirmationService
                .recoverPendingConfirmations();

            assert.equal(recovered.due, 1);
            assert.equal(
                recovered.results[0]?.code,
                REIMBURSEMENT_CONFIRMATION_RESULT.CONFIRMED
            );
            assert.ok(lookupCalls >= 1);

            const queue = await worker.processQueue();

            assert.equal(queue.claimed, 0);
            assert.equal(sendCalls, 0, "must not resend when txHash exists");

            worker.shutdown();
        }

        // --- Retry: RPC failure then success ---

        {
            let calls = 0;

            const transport = {
                async getTransactions() {
                    calls += 1;

                    if (calls === 1) {

                        throw new Error("rpc_temporary");

                    }

                    return [mockTx()];
                }
            };

            const stack = createStack({ transport });

            stacks.push(stack);

            seedProcessingWithTx(stack.repository, {
                gameId: "game_stage_p_retry",
                deploymentTxHash: "deploy:retry"
            });

            const first = await stack.confirmationService.confirmTransaction(
                stack.repository.findByGameId("game_stage_p_retry")
            );

            assert.equal(first.ok, false);
            assert.equal(
                first.code,
                REIMBURSEMENT_CONFIRMATION_RESULT.PENDING
            );
            assert.equal(
                first.record.payload.status,
                DEPLOYMENT_REIMBURSEMENT_STATUS.PROCESSING
            );
            assert.equal(first.record.payload.confirmationAttempts, 1);
            assert.ok(first.record.payload.nextConfirmationAt > Date.now());

            // Force due.
            stack.repository.updateStatus(first.record.recordId, {
                status: DEPLOYMENT_REIMBURSEMENT_STATUS.PROCESSING,
                nextConfirmationAt: Date.now() - 1
            });

            const second = await stack.confirmationService.confirmTransaction(
                stack.repository.findByGameId("game_stage_p_retry")
            );

            assert.equal(second.ok, true);
            assert.equal(
                second.code,
                REIMBURSEMENT_CONFIRMATION_RESULT.CONFIRMED
            );
        }

        // --- Retry: delayed tx (not found) then found ---

        {
            let visible = false;

            const transport = {
                async getTransactions() {
                    return visible ? [mockTx()] : [];
                }
            };

            const stack = createStack({ transport });

            stacks.push(stack);

            seedProcessingWithTx(stack.repository, {
                gameId: "game_stage_p_delay",
                deploymentTxHash: "deploy:delay"
            });

            const pending = await stack.confirmationService.confirmTransaction(
                stack.repository.findByGameId("game_stage_p_delay")
            );

            assert.equal(
                pending.code,
                REIMBURSEMENT_CONFIRMATION_RESULT.PENDING
            );
            assert.match(
                String(pending.record.payload.confirmationError),
                /transaction_not_found/
            );

            visible = true;

            stack.repository.updateStatus(pending.record.recordId, {
                status: DEPLOYMENT_REIMBURSEMENT_STATUS.PROCESSING,
                nextConfirmationAt: Date.now() - 1
            });

            const confirmed = await stack.confirmationService.confirmTransaction(
                stack.repository.findByGameId("game_stage_p_delay")
            );

            assert.equal(
                confirmed.code,
                REIMBURSEMENT_CONFIRMATION_RESULT.CONFIRMED
            );
        }

        // --- Retry: terminal after max attempts ---

        {
            const transport = {
                async getTransactions() {
                    return [];
                }
            };

            const stack = createStack({ transport });

            stacks.push(stack);

            const seeded = seedProcessingWithTx(stack.repository, {
                gameId: "game_stage_p_terminal",
                deploymentTxHash: "deploy:terminal"
            });

            stack.repository.updateStatus(seeded.recordId, {
                status: DEPLOYMENT_REIMBURSEMENT_STATUS.PROCESSING,
                confirmationAttempts: REIMBURSEMENT_CONFIRMATION_MAX_ATTEMPTS - 1,
                nextConfirmationAt: Date.now() - 1
            });

            const result = await stack.confirmationService.confirmTransaction(
                stack.repository.findByGameId("game_stage_p_terminal")
            );

            assert.equal(
                result.code,
                REIMBURSEMENT_CONFIRMATION_RESULT.TERMINAL
            );
            assert.equal(
                result.record.payload.status,
                DEPLOYMENT_REIMBURSEMENT_STATUS.FAILED_TERMINAL
            );
        }

        // --- Security: confirmation sources have no signing / send / settlement ---

        {
            const files = [
                "ReimbursementConfirmationService.js",
                "extractReimbursementTransferFromTransaction.js",
                "reimbursementConfirmationBackoff.js"
            ];

            for (const file of files) {

                const source = readFileSync(join(REIMB_DIR, file), "utf8");

                assert.equal(/mnemonic/i.test(source), false);
                assert.equal(/sendTransfer|broadcastTransaction|createTransfer/.test(source), false);
                assert.equal(/TON_DEPLOYER_MNEMONIC|OWNER_MNEMONIC/.test(source), false);
                assert.equal(/GameEscrow|SETTLE/.test(source), false);
                assert.equal(/ContractSettlementManager/.test(source), false);
            }

            assert.equal(
                TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_REIMBURSEMENT,
                "deployment_reimbursement"
            );
        }

        console.log("deploymentReimbursement.stageP.test.js: OK");

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
