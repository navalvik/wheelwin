/**
 * R17.8V.2P.J — Deployment Cost Snapshot Stage C tests (EventBus integration).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventBus } from "../events/EventBus.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    TonFinancialPersistence,
    TON_FINANCIAL_RECORD_TYPES
} from "../persistence/TonFinancialPersistence.js";
import { DeploymentCostService } from "../payment/reimbursement/DeploymentCostService.js";
import { DeploymentCostSnapshotRepository } from "../payment/reimbursement/DeploymentCostSnapshotRepository.js";
import { DEPLOYMENT_COST_SNAPSHOT_STATUS } from "../payment/reimbursement/deploymentCostSnapshotStates.js";
import { DEPLOYMENT_COST_SERVICE_RESULT } from "../payment/reimbursement/deploymentCostServiceResults.js";

function samplePayload(overrides = {}) {

    return {
        gameId: "game_stage_c_1",
        roomId: "room_stage_c_1",
        contractId: "contract_stage_c_1",
        contractAddress: "EQCvx9tido_G8ZtyMgxMR_bKxjRG1qSGGHQFFNU2-at8WC7s",
        deploymentTxHash: "oszAXcW26TcLUBz8QVnns4AjsKX/bRPXWYRD3J57GiY=",
        deployWallet: "EQB83sDeployWalletExampleAddress0000000000003PDQ",
        deployedAt: 1_700_000_000_000,
        timestamp: 1_700_000_000_050,
        ...overrides
    };

}

function createBus() {

    const bus = new EventBus({
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        eventBusConfig: {}
    });

    bus.initialize();

    return bus;

}

function createStack({ enabled = true } = {}) {

    const dir = mkdtempSync(join(tmpdir(), "wheelwin-dcs-stage-c-"));

    const persistence = new TonFinancialPersistence({
        dataDir: dir,
        autoCheckpoint: false
    });

    persistence.initialize();

    const eventBus = createBus();

    const repository = new DeploymentCostSnapshotRepository({
        persistence,
        tonNetwork: "testnet"
    });

    const service = new DeploymentCostService({
        repository,
        eventBus,
        env: {
            DEPLOYMENT_COST_SNAPSHOT_ENABLED: enabled ? "true" : "false"
        }
    });

    service.initialize();

    return { dir, persistence, eventBus, repository, service };

}

function emitCapture(eventBus, payload) {

    eventBus.emit({
        source: EVENT_SOURCES.GAME_CONTRACT_MANAGER,
        type: EVENT_TYPES.DEPLOYMENT_COST_CAPTURE_REQUESTED,
        payload
    });

}

async function main() {

    const dirs = [];

    try {

        // --- EventTypes contains new event ---

        assert.equal(
            EVENT_TYPES.DEPLOYMENT_COST_CAPTURE_REQUESTED,
            "DEPLOYMENT_COST_CAPTURE_REQUESTED"
        );

        // --- feature disabled: event emitted, no snapshot ---

        {
            const stack = createStack({ enabled: false });

            dirs.push(stack.dir);

            emitCapture(stack.eventBus, samplePayload());

            assert.equal(
                stack.service.getSnapshotByDeploymentTxHash(
                    samplePayload().deploymentTxHash
                ),
                null
            );

            const direct = stack.service.handleDeploymentCostCaptureRequested(
                samplePayload()
            );

            assert.equal(
                direct.code,
                DEPLOYMENT_COST_SERVICE_RESULT.FEATURE_DISABLED
            );

            stack.service.shutdown();
            stack.persistence.shutdown();
            stack.eventBus.shutdown();
        }

        // --- enabled: emit → PENDING_LOOKUP ---

        {
            const stack = createStack({ enabled: true });

            dirs.push(stack.dir);

            emitCapture(stack.eventBus, samplePayload());

            const snapshot = stack.service.getSnapshotByDeploymentTxHash(
                samplePayload().deploymentTxHash
            );

            assert.ok(snapshot);
            assert.equal(
                snapshot.recordType,
                TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_COST_SNAPSHOT
            );
            assert.equal(
                snapshot.payload.status,
                DEPLOYMENT_COST_SNAPSHOT_STATUS.PENDING_LOOKUP
            );
            assert.equal(snapshot.payload.attachedTon, null);
            assert.equal(snapshot.payload.networkFeeTon, null);
            assert.equal(snapshot.payload.deploymentCostTon, null);
            assert.equal(
                snapshot.payload.deployWallet,
                samplePayload().deployWallet
            );

            stack.service.shutdown();
            stack.persistence.shutdown();
            stack.eventBus.shutdown();
        }

        // --- duplicate event → one snapshot ---

        {
            const stack = createStack({ enabled: true });

            dirs.push(stack.dir);

            emitCapture(stack.eventBus, samplePayload());
            emitCapture(stack.eventBus, samplePayload({
                timestamp: Date.now()
            }));

            const first = stack.service.getSnapshotByDeploymentTxHash(
                samplePayload().deploymentTxHash
            );

            assert.ok(first);

            const dup = stack.service.handleDeploymentCostCaptureRequested(
                samplePayload()
            );

            assert.equal(dup.ok, true);
            assert.equal(
                dup.code,
                DEPLOYMENT_COST_SERVICE_RESULT.SNAPSHOT_DUPLICATE
            );
            assert.equal(dup.snapshot.recordId, first.recordId);

            stack.service.shutdown();
            stack.persistence.shutdown();
            stack.eventBus.shutdown();
        }

        // --- invalid payload via handler ---

        {
            const stack = createStack({ enabled: true });

            dirs.push(stack.dir);

            const result = stack.service.handleDeploymentCostCaptureRequested({
                gameId: "x"
            });

            assert.equal(result.ok, false);
            assert.equal(
                result.code,
                DEPLOYMENT_COST_SERVICE_RESULT.INVALID_CAPTURE_PAYLOAD
            );

            stack.service.shutdown();
            stack.persistence.shutdown();
            stack.eventBus.shutdown();
        }

        // --- post-persist style: durable fields then emit ---

        {
            const stack = createStack({ enabled: true });

            dirs.push(stack.dir);

            const persistedContract = {
                gameId: "game_persist",
                roomId: "room_persist",
                contractId: "contract_persist",
                contractAddress: "EQpersistAddress00000000000000000000000001",
                deploymentTxId: "persist-deploy-tx-hash=======",
                deployedAt: 1_700_000_111_000,
                snapshot: {
                    oracleWallet: "EQoracleDeployWallet0000000000000000000001"
                }
            };

            // Simulate GameContractManager payload after _persistContract.
            emitCapture(stack.eventBus, {
                gameId: persistedContract.gameId,
                roomId: persistedContract.roomId,
                contractId: persistedContract.contractId,
                contractAddress: persistedContract.contractAddress,
                deploymentTxHash: persistedContract.deploymentTxId,
                deployWallet: persistedContract.snapshot.oracleWallet,
                deployedAt: persistedContract.deployedAt,
                timestamp: Date.now()
            });

            const snap = stack.service.getSnapshotByGameId("game_persist");

            assert.ok(snap);
            assert.equal(
                snap.payload.deploymentTxHash,
                persistedContract.deploymentTxId
            );
            assert.equal(
                snap.payload.status,
                DEPLOYMENT_COST_SNAPSHOT_STATUS.PENDING_LOOKUP
            );

            stack.service.shutdown();
            stack.persistence.shutdown();
            stack.eventBus.shutdown();
        }

        console.log("deploymentCostSnapshot.stageC.test.js: PASS");

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
