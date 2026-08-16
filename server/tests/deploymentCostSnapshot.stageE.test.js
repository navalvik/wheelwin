/**
 * R17.8V.2P.L — Deployment Cost Snapshot Stage E tests (recovery).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    TonFinancialPersistence,
    TON_FINANCIAL_RECORD_TYPES
} from "../persistence/TonFinancialPersistence.js";
import { GAME_CONTRACT_STATUS } from "../models/GameContract.js";
import { DeploymentCostService } from "../payment/reimbursement/DeploymentCostService.js";
import { DeploymentCostSnapshotRepository } from "../payment/reimbursement/DeploymentCostSnapshotRepository.js";
import {
    DEPLOYMENT_COST_LOOKUP_MAX_ATTEMPTS,
    deploymentCostLookupBackoffMs,
    deploymentCostNextLookupAt,
    isDeploymentCostLookupDue
} from "../payment/reimbursement/deploymentCostLookupBackoff.js";
import { DEPLOYMENT_COST_SNAPSHOT_STATUS } from "../payment/reimbursement/deploymentCostSnapshotStates.js";
import { DEPLOYMENT_COST_SERVICE_RESULT } from "../payment/reimbursement/deploymentCostServiceResults.js";
import { tonStringToNanoton } from "../payment/reimbursement/nanoton.js";

const HASH = "stage-e-deploy-hash-aaaaaaaaaaaaaa=";
const CONTRACT = "EQCvx9tido_G8ZtyMgxMR_bKxjRG1qSGGHQFFNU2-at8WC7s";
const DEPLOY_WALLET = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";

function buildTx({ hash = HASH, attachedTon = "0.020396066", feeTon = "0.003463643" } = {}) {

    return {
        transaction_id: { hash },
        fee: tonStringToNanoton(feeTon).toString(),
        out_msgs: [
            {
                destination: CONTRACT,
                value: tonStringToNanoton(attachedTon).toString()
            }
        ]
    };

}

function createStack({ transport = null, enabled = true } = {}) {

    const dir = mkdtempSync(join(tmpdir(), "wheelwin-dcs-stage-e-"));

    const persistence = new TonFinancialPersistence({
        dataDir: dir,
        autoCheckpoint: false
    });

    persistence.initialize();

    const repository = new DeploymentCostSnapshotRepository({
        persistence,
        tonNetwork: "testnet"
    });

    const service = new DeploymentCostService({
        repository,
        transport,
        env: {
            DEPLOYMENT_COST_SNAPSHOT_ENABLED: enabled ? "true" : "false"
        }
    });

    // Manual initialize without auto background recovery for deterministic tests.
    service._initialized = true;

    return { dir, persistence, repository, service };

}

function seedGameContract(persistence, overrides = {}) {

    return persistence.createGameContract(
        {
            contractId: "contract_stage_e_1",
            gameId: "game_stage_e_1",
            roomId: "room_stage_e_1",
            status: GAME_CONTRACT_STATUS.DEPLOYED,
            contractAddress: CONTRACT,
            deploymentTxId: HASH,
            deployedAt: Date.now(),
            snapshot: {
                oracleWallet: DEPLOY_WALLET
            },
            ...overrides
        },
        {
            status: GAME_CONTRACT_STATUS.DEPLOYED,
            roomId: "room_stage_e_1",
            gameId: "game_stage_e_1",
            contractId: "contract_stage_e_1",
            tonNetwork: "testnet",
            correlationId: "corr-stage-e"
        }
    );

}

async function main() {

    const dirs = [];

    try {

        // --- backoff calculation ---

        {
            assert.equal(deploymentCostLookupBackoffMs(1), 5_000);
            assert.equal(deploymentCostLookupBackoffMs(2), 30_000);
            assert.equal(deploymentCostLookupBackoffMs(3), 5 * 60_000);
            assert.ok(deploymentCostLookupBackoffMs(99) >= 5_000);

            const now = 1_000_000;
            assert.equal(
                deploymentCostNextLookupAt(1, now),
                now + 5_000
            );

            assert.equal(
                isDeploymentCostLookupDue({
                    status: "PENDING_LOOKUP",
                    nextLookupAt: now - 1
                }, now),
                true
            );

            assert.equal(
                isDeploymentCostLookupDue({
                    status: "PENDING_LOOKUP",
                    nextLookupAt: now + 60_000
                }, now),
                false
            );
        }

        // --- missing snapshot recovered from game_contract ---

        {
            const stack = createStack({
                transport: {
                    async getTransactions() {

                        return [buildTx()];

                    }
                }
            });

            dirs.push(stack.dir);

            seedGameContract(stack.persistence);

            assert.equal(
                stack.service.getSnapshotByDeploymentTxHash(HASH),
                null
            );

            const missing = await stack.service.recoverMissingSnapshots();

            assert.equal(missing.scanned, 1);
            assert.equal(missing.created, 1);

            const snap = stack.service.getSnapshotByDeploymentTxHash(HASH);

            assert.ok(snap);
            assert.equal(
                snap.payload.status,
                DEPLOYMENT_COST_SNAPSHOT_STATUS.FROZEN
            );
            assert.equal(snap.payload.deploymentCostTon, "0.023859709");
            assert.notEqual(snap.payload.deploymentCostTon, "0.022");

            // duplicate recovery safe

            const again = await stack.service.recoverMissingSnapshots();

            assert.equal(again.created, 0);
            assert.ok(again.skipped >= 1);

            stack.service.shutdown();
            stack.persistence.shutdown();
        }

        // --- pending retry ---

        {
            const stack = createStack({
                transport: {
                    calls: 0,
                    async getTransactions() {

                        this.calls += 1;

                        if (this.calls === 1) {

                            return [];

                        }

                        return [buildTx({ hash: "pending-retry-hash=======" })];

                    }
                }
            });

            dirs.push(stack.dir);

            const created = stack.service.captureDeploymentCost({
                gameId: "game_pending_retry",
                roomId: "room_pending_retry",
                contractId: "contract_pending_retry",
                contractAddress: CONTRACT,
                deploymentTxHash: "pending-retry-hash=======",
                deployWallet: DEPLOY_WALLET
            });

            assert.equal(created.ok, true);

            const first = await stack.service.lookupAndFreezeSnapshot(
                created.snapshot
            );

            assert.equal(first.ok, false);
            assert.equal(
                first.code,
                DEPLOYMENT_COST_SERVICE_RESULT.LOOKUP_PENDING
            );

            // Force due
            stack.repository.updatePendingLookup(created.snapshot.recordId, {
                nextLookupAt: Date.now() - 1,
                lookupAttempts: 1
            });

            const retry = await stack.service.retryPendingSnapshots();

            assert.equal(retry.attempted, 1);
            assert.equal(retry.frozen, 1);

            const frozen = stack.service.getSnapshotByDeploymentTxHash(
                "pending-retry-hash======="
            );

            assert.equal(
                frozen.payload.status,
                DEPLOYMENT_COST_SNAPSHOT_STATUS.FROZEN
            );

            stack.service.shutdown();
            stack.persistence.shutdown();
        }

        // --- failed lookup recovery ---

        {
            const stack = createStack({
                transport: {
                    async getTransactions() {

                        return [buildTx({ hash: "failed-retry-hash========" })];

                    }
                }
            });

            dirs.push(stack.dir);

            const created = stack.service.captureDeploymentCost({
                gameId: "game_failed_retry",
                roomId: "room_failed_retry",
                contractId: "contract_failed_retry",
                contractAddress: CONTRACT,
                deploymentTxHash: "failed-retry-hash========",
                deployWallet: DEPLOY_WALLET
            });

            stack.repository.updatePendingLookup(created.snapshot.recordId, {
                status: DEPLOYMENT_COST_SNAPSHOT_STATUS.FAILED_LOOKUP,
                errorReason: "max_attempts",
                lookupAttempts: DEPLOYMENT_COST_LOOKUP_MAX_ATTEMPTS,
                nextLookupAt: Date.now() - 1
            });

            const recovered = await stack.service.recoverFailedSnapshots();

            assert.equal(recovered.requeued, 1);
            assert.equal(recovered.frozen, 1);

            stack.service.shutdown();
            stack.persistence.shutdown();
        }

        // --- RPC unavailable keeps pending ---

        {
            const stack = createStack({
                transport: {
                    async getTransactions() {

                        throw new Error("rpc_unavailable");

                    }
                }
            });

            dirs.push(stack.dir);

            const created = stack.service.captureDeploymentCost({
                gameId: "game_rpc_e",
                roomId: "room_rpc_e",
                contractId: "contract_rpc_e",
                contractAddress: CONTRACT,
                deploymentTxHash: "rpc-e-hash-aaaaaaaaaaaaaaaaaa=",
                deployWallet: DEPLOY_WALLET
            });

            const result = await stack.service.lookupAndFreezeSnapshot(
                created.snapshot
            );

            assert.equal(result.ok, false);
            assert.equal(
                result.snapshot.payload.status,
                DEPLOYMENT_COST_SNAPSHOT_STATUS.PENDING_LOOKUP
            );
            assert.equal(result.snapshot.payload.deploymentCostTon, null);

            stack.service.shutdown();
            stack.persistence.shutdown();
        }

        // --- permanent failure after max attempts ---

        {
            const stack = createStack({
                transport: {
                    async getTransactions() {

                        return [];

                    }
                }
            });

            dirs.push(stack.dir);

            const created = stack.service.captureDeploymentCost({
                gameId: "game_terminal",
                roomId: "room_terminal",
                contractId: "contract_terminal",
                contractAddress: CONTRACT,
                deploymentTxHash: "terminal-hash-aaaaaaaaaaaaaaaa=",
                deployWallet: DEPLOY_WALLET
            });

            stack.repository.updatePendingLookup(created.snapshot.recordId, {
                lookupAttempts: DEPLOYMENT_COST_LOOKUP_MAX_ATTEMPTS - 1,
                nextLookupAt: Date.now() - 1
            });

            const refreshed = stack.repository.findById(created.snapshot.recordId);
            const result = await stack.service.lookupAndFreezeSnapshot(refreshed);

            assert.equal(result.ok, false);

            const after = stack.repository.findById(created.snapshot.recordId);

            assert.equal(
                after.payload.status,
                DEPLOYMENT_COST_SNAPSHOT_STATUS.FAILED_LOOKUP
            );
            assert.equal(
                after.payload.lookupAttempts,
                DEPLOYMENT_COST_LOOKUP_MAX_ATTEMPTS
            );

            stack.service.shutdown();
            stack.persistence.shutdown();
        }

        // --- restart recovery via runBackgroundRecovery ---

        {
            const stack = createStack({
                transport: {
                    async getTransactions() {

                        return [buildTx({ hash: "restart-hash-aaaaaaaaaaaaaaaa=" })];

                    }
                }
            });

            dirs.push(stack.dir);

            stack.persistence.createGameContract(
                {
                    contractId: "contract_restart",
                    gameId: "game_restart",
                    roomId: "room_restart",
                    status: GAME_CONTRACT_STATUS.DEPLOYED,
                    contractAddress: CONTRACT,
                    deploymentTxId: "restart-hash-aaaaaaaaaaaaaaaa=",
                    deployedAt: Date.now(),
                    snapshot: { oracleWallet: DEPLOY_WALLET }
                },
                {
                    status: GAME_CONTRACT_STATUS.DEPLOYED,
                    roomId: "room_restart",
                    gameId: "game_restart",
                    contractId: "contract_restart",
                    tonNetwork: "testnet",
                    correlationId: "corr-restart"
                }
            );

            const report = await stack.service.runBackgroundRecovery();

            assert.equal(report.ok, true);
            assert.equal(report.missing.created, 1);

            const snap = stack.service.getSnapshotByGameId("game_restart");

            assert.ok(snap);
            assert.equal(
                snap.payload.status,
                DEPLOYMENT_COST_SNAPSHOT_STATUS.FROZEN
            );

            assert.equal(
                snap.recordType,
                TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_COST_SNAPSHOT
            );

            stack.service.shutdown();
            stack.persistence.shutdown();
        }

        console.log("deploymentCostSnapshot.stageE.test.js: PASS");

    } finally {

        for (const dir of dirs) {

            rmSync(dir, { recursive: true, force: true });

        }

    }

}

main().catch((error) => {

    console.error(error);
    process.exitCode = 1;

});
