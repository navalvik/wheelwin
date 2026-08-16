/**
 * R17.8V.2P.I — Deployment Cost Snapshot Stage B tests.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    TonFinancialPersistence,
    TON_FINANCIAL_RECORD_TYPES
} from "../persistence/TonFinancialPersistence.js";
import { DeploymentCostService } from "../payment/reimbursement/DeploymentCostService.js";
import { DeploymentCostSnapshotRepository } from "../payment/reimbursement/DeploymentCostSnapshotRepository.js";
import { DEPLOYMENT_COST_SNAPSHOT_STATUS } from "../payment/reimbursement/deploymentCostSnapshotStates.js";
import { DEPLOYMENT_COST_SERVICE_RESULT } from "../payment/reimbursement/deploymentCostServiceResults.js";

function sampleCapture(overrides = {}) {

    return {
        gameId: "game_stage_b_1",
        roomId: "room_stage_b_1",
        contractId: "contract_stage_b_1",
        contractAddress: "EQCvx9tido_G8ZtyMgxMR_bKxjRG1qSGGHQFFNU2-at8WC7s",
        deploymentTxHash: "oszAXcW26TcLUBz8QVnns4AjsKX/bRPXWYRD3J57GiY=",
        deployWallet: "EQB83sDeployWalletExampleAddress0000000000003PDQ",
        deployedAt: 1_700_000_000_000,
        timestamp: 1_700_000_000_100,
        ...overrides
    };

}

function createStack({ enabled = true, dataDir } = {}) {

    const dir = dataDir ?? mkdtempSync(join(tmpdir(), "wheelwin-dcs-stage-b-"));

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
        env: {
            DEPLOYMENT_COST_SNAPSHOT_ENABLED: enabled ? "true" : "false"
        }
    });

    service.initialize();

    return { dir, persistence, repository, service };

}

async function main() {

    const dirs = [];

    try {

        // --- feature disabled creates nothing ---

        {
            const stack = createStack({ enabled: false });

            dirs.push(stack.dir);

            const result = stack.service.captureDeploymentCost(sampleCapture());

            assert.equal(result.ok, false);
            assert.equal(
                result.code,
                DEPLOYMENT_COST_SERVICE_RESULT.FEATURE_DISABLED
            );
            assert.equal(result.snapshot, null);
            assert.equal(
                stack.service.getSnapshotByDeploymentTxHash(
                    sampleCapture().deploymentTxHash
                ),
                null
            );

            stack.service.shutdown();
            stack.persistence.shutdown();
        }

        // --- valid capture creates PENDING_LOOKUP ---

        {
            const stack = createStack({ enabled: true });

            dirs.push(stack.dir);

            const result = stack.service.captureDeploymentCost(sampleCapture());

            assert.equal(result.ok, true);
            assert.equal(result.code, DEPLOYMENT_COST_SERVICE_RESULT.OK);
            assert.ok(result.snapshot);
            assert.equal(
                result.snapshot.recordType,
                TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_COST_SNAPSHOT
            );
            assert.equal(
                result.snapshot.payload.status,
                DEPLOYMENT_COST_SNAPSHOT_STATUS.PENDING_LOOKUP
            );
            assert.equal(result.snapshot.payload.attachedTon, null);
            assert.equal(result.snapshot.payload.networkFeeTon, null);
            assert.equal(result.snapshot.payload.deploymentCostTon, null);

            const byHash = stack.service.getSnapshotByDeploymentTxHash(
                sampleCapture().deploymentTxHash
            );

            assert.ok(byHash);
            assert.equal(byHash.payload.gameId, sampleCapture().gameId);

            const byGame = stack.service.getSnapshotByGameId(
                sampleCapture().gameId
            );

            assert.ok(byGame);

            stack.service.shutdown();
            stack.persistence.shutdown();
        }

        // --- duplicate deploymentTxHash returns existing ---

        {
            const stack = createStack({ enabled: true });

            dirs.push(stack.dir);

            const first = stack.service.captureDeploymentCost(sampleCapture());

            assert.equal(first.code, DEPLOYMENT_COST_SERVICE_RESULT.OK);

            const second = stack.service.captureDeploymentCost(sampleCapture({
                gameId: "game_stage_b_other"
            }));

            assert.equal(second.ok, true);
            assert.equal(
                second.code,
                DEPLOYMENT_COST_SERVICE_RESULT.SNAPSHOT_DUPLICATE
            );
            assert.equal(
                second.snapshot.recordId,
                first.snapshot.recordId
            );

            stack.service.shutdown();
            stack.persistence.shutdown();
        }

        // --- invalid payload rejected ---

        {
            const stack = createStack({ enabled: true });

            dirs.push(stack.dir);

            const result = stack.service.captureDeploymentCost({
                gameId: "only-game"
            });

            assert.equal(result.ok, false);
            assert.equal(
                result.code,
                DEPLOYMENT_COST_SERVICE_RESULT.INVALID_CAPTURE_PAYLOAD
            );
            assert.ok(Array.isArray(result.errors));
            assert.ok(result.errors.length > 0);

            stack.service.shutdown();
            stack.persistence.shutdown();
        }

        // --- not initialized ---

        {
            const dir = mkdtempSync(join(tmpdir(), "wheelwin-dcs-stage-b-"));

            dirs.push(dir);

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
                env: { DEPLOYMENT_COST_SNAPSHOT_ENABLED: "true" }
            });

            const result = service.captureDeploymentCost(sampleCapture());

            assert.equal(result.ok, false);
            assert.equal(
                result.code,
                DEPLOYMENT_COST_SERVICE_RESULT.NOT_INITIALIZED
            );

            persistence.shutdown();
        }

        // --- persistence reload ---

        {
            const stack = createStack({ enabled: true });

            dirs.push(stack.dir);

            const created = stack.service.captureDeploymentCost(sampleCapture({
                gameId: "game_reload",
                roomId: "room_reload",
                contractId: "contract_reload",
                deploymentTxHash: "reload-hash-aaaaaaaaaaaaaaaaaaaa="
            }));

            assert.equal(created.ok, true);

            stack.service.shutdown();
            stack.persistence.shutdown();

            const persistence2 = new TonFinancialPersistence({
                dataDir: stack.dir,
                autoCheckpoint: false
            });

            persistence2.initialize();

            const repository2 = new DeploymentCostSnapshotRepository({
                persistence: persistence2,
                tonNetwork: "testnet"
            });

            const service2 = new DeploymentCostService({
                repository: repository2,
                env: { DEPLOYMENT_COST_SNAPSHOT_ENABLED: "true" }
            });

            service2.initialize();

            const reloaded = service2.getSnapshotByDeploymentTxHash(
                "reload-hash-aaaaaaaaaaaaaaaaaaaa="
            );

            assert.ok(reloaded);
            assert.equal(
                reloaded.payload.status,
                DEPLOYMENT_COST_SNAPSHOT_STATUS.PENDING_LOOKUP
            );
            assert.equal(reloaded.payload.deploymentCostTon, null);

            service2.shutdown();
            persistence2.shutdown();
        }

        console.log("deploymentCostSnapshot.stageB.test.js: PASS");

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
