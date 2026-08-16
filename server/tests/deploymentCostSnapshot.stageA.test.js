/**
 * R17.8V.2P.H — Deployment Cost Snapshot Stage A tests.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    DuplicateRecordError,
    TonFinancialPersistence,
    TON_FINANCIAL_RECORD_TYPES
} from "../persistence/TonFinancialPersistence.js";
import { isDeploymentCostSnapshotEnabled } from "../payment/reimbursement/deploymentCostSnapshotConfig.js";
import { DeploymentCostSnapshotRepository } from "../payment/reimbursement/DeploymentCostSnapshotRepository.js";
import { DEPLOYMENT_COST_SNAPSHOT_STATUS } from "../payment/reimbursement/deploymentCostSnapshotStates.js";
import {
    validateDeploymentCostSnapshotCreateInput,
    deploymentCostSnapshotRecordId
} from "../payment/reimbursement/deploymentCostSnapshotSchema.js";

function sampleInput(overrides = {}) {

    return {
        gameId: "game_stage_a_1",
        roomId: "room_stage_a_1",
        contractId: "contract_stage_a_1",
        contractAddress: "EQCvx9tido_G8ZtyMgxMR_bKxjRG1qSGGHQFFNU2-at8WC7s",
        deploymentTxHash: "oszAXcW26TcLUBz8QVnns4AjsKX/bRPXWYRD3J57GiY=",
        deployWallet: "EQB83sDeployWalletExampleAddress0000000000003PDQ",
        status: DEPLOYMENT_COST_SNAPSHOT_STATUS.PENDING_LOOKUP,
        ...overrides
    };

}

function createRepo(dataDir) {

    const persistence = new TonFinancialPersistence({
        dataDir,
        autoCheckpoint: false
    });

    persistence.initialize();

    return {
        persistence,
        repo: new DeploymentCostSnapshotRepository({
            persistence,
            tonNetwork: "testnet"
        })
    };

}

async function main() {

    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-dcs-stage-a-"));

    try {

        // --- record type registered ---

        assert.equal(
            TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_COST_SNAPSHOT,
            "deployment_cost_snapshot"
        );

        // --- feature flag default false ---

        assert.equal(isDeploymentCostSnapshotEnabled({}), false);
        assert.equal(
            isDeploymentCostSnapshotEnabled({
                DEPLOYMENT_COST_SNAPSHOT_ENABLED: "false"
            }),
            false
        );
        assert.equal(
            isDeploymentCostSnapshotEnabled({
                DEPLOYMENT_COST_SNAPSHOT_ENABLED: "true"
            }),
            true
        );

        // --- schema validation ---

        {
            const ok = validateDeploymentCostSnapshotCreateInput(sampleInput());

            assert.equal(ok.ok, true);
            assert.equal(ok.payload.attachedTon, null);
            assert.equal(ok.payload.networkFeeTon, null);
            assert.equal(ok.payload.deploymentCostTon, null);
            assert.equal(
                ok.payload.status,
                DEPLOYMENT_COST_SNAPSHOT_STATUS.PENDING_LOOKUP
            );
            assert.equal(
                ok.payload.id,
                deploymentCostSnapshotRecordId(ok.payload.deploymentTxHash)
            );

            const frozenCreate = validateDeploymentCostSnapshotCreateInput(
                sampleInput({
                    status: DEPLOYMENT_COST_SNAPSHOT_STATUS.FROZEN
                })
            );

            assert.equal(frozenCreate.ok, false);
            assert.ok(
                frozenCreate.errors.includes("status_frozen_not_allowed_on_create")
            );

            const missing = validateDeploymentCostSnapshotCreateInput({
                gameId: "g1"
            });

            assert.equal(missing.ok, false);
        }

        // --- repository create + find ---

        {
            const { persistence, repo } = createRepo(dataDir);

            const created = repo.create(sampleInput());

            assert.equal(
                created.recordType,
                TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_COST_SNAPSHOT
            );
            assert.equal(
                created.payload.status,
                DEPLOYMENT_COST_SNAPSHOT_STATUS.PENDING_LOOKUP
            );
            assert.equal(created.payload.deploymentCostTon, null);
            assert.equal(created.immutable, false);

            const byHash = repo.findByDeploymentTxHash(
                sampleInput().deploymentTxHash
            );

            assert.ok(byHash);
            assert.equal(
                byHash.recordId,
                deploymentCostSnapshotRecordId(sampleInput().deploymentTxHash)
            );

            const byGame = repo.findByGameId(sampleInput().gameId);

            assert.ok(byGame);
            assert.equal(byGame.payload.gameId, sampleInput().gameId);

            const byId = repo.findById(
                deploymentCostSnapshotRecordId(sampleInput().deploymentTxHash)
            );

            assert.ok(byId);

            // duplicate hash

            assert.throws(
                () => repo.create(sampleInput({
                    gameId: "game_other"
                })),
                (error) => error instanceof DuplicateRecordError
            );

            // duplicate gameId

            assert.throws(
                () => repo.create(sampleInput({
                    deploymentTxHash: "other-hash-aaaaaaaaaaaaaaaaaaaa=",
                    gameId: sampleInput().gameId
                })),
                (error) => error instanceof DuplicateRecordError
            );

            // pending update bookkeeping

            const updated = repo.updatePendingLookup(
                deploymentCostSnapshotRecordId(sampleInput().deploymentTxHash),
                {
                    status: DEPLOYMENT_COST_SNAPSHOT_STATUS.FAILED_LOOKUP,
                    errorReason: "rpc_timeout",
                    lookupAttempts: 1,
                    nextLookupAt: Date.now() + 1000
                }
            );

            assert.equal(
                updated.payload.status,
                DEPLOYMENT_COST_SNAPSHOT_STATUS.FAILED_LOOKUP
            );
            assert.equal(updated.payload.errorReason, "rpc_timeout");
            assert.equal(updated.payload.lookupAttempts, 1);

            // Stage A must reject amount patches

            assert.throws(
                () => repo.updatePendingLookup(
                    deploymentCostSnapshotRecordId(sampleInput().deploymentTxHash),
                    { attachedTon: "0.022" }
                )
            );

            // restart persistence compatibility

            persistence.shutdown();

            const persistence2 = new TonFinancialPersistence({
                dataDir,
                autoCheckpoint: false
            });

            persistence2.initialize();

            const repo2 = new DeploymentCostSnapshotRepository({
                persistence: persistence2,
                tonNetwork: "testnet"
            });

            const reloaded = repo2.findByDeploymentTxHash(
                sampleInput().deploymentTxHash
            );

            assert.ok(reloaded);
            assert.equal(
                reloaded.payload.status,
                DEPLOYMENT_COST_SNAPSHOT_STATUS.FAILED_LOOKUP
            );
            assert.equal(reloaded.payload.deploymentCostTon, null);

            // existing game_contract type still works (additive)

            persistence2.createGameContract(
                {
                    contractId: "contract_compat",
                    gameId: "game_compat",
                    roomId: "room_compat",
                    status: "DEPLOYED",
                    contractAddress: "EQcompat"
                },
                {
                    status: "DEPLOYED",
                    roomId: "room_compat",
                    gameId: "game_compat",
                    contractId: "contract_compat",
                    tonNetwork: "testnet",
                    correlationId: "corr-compat"
                }
            );

            assert.ok(persistence2.loadGameContract("contract_compat"));

            persistence2.shutdown();
        }

        console.log("deploymentCostSnapshot.stageA.test.js: PASS");

    } finally {

        rmSync(dataDir, { recursive: true, force: true });

    }

}

main().catch((error) => {

    console.error(error);
    process.exitCode = 1;

});
