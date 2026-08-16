/**
 * R17.8V.2P.M — Deployment Reimbursement Worker foundation tests.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    DuplicateRecordError,
    TonFinancialPersistence,
    TON_FINANCIAL_RECORD_TYPES
} from "../persistence/TonFinancialPersistence.js";
import { isDeploymentReimbursementEnabled } from "../payment/reimbursement/deploymentReimbursementConfig.js";
import { DeploymentReimbursementRepository } from "../payment/reimbursement/DeploymentReimbursementRepository.js";
import { DeploymentReimbursementService } from "../payment/reimbursement/DeploymentReimbursementService.js";
import { DeploymentReimbursementWorker } from "../payment/reimbursement/DeploymentReimbursementWorker.js";
import { ReimbursementTransferService } from "../payment/reimbursement/ReimbursementTransferService.js";
import { DEPLOYMENT_REIMBURSEMENT_STATUS } from "../payment/reimbursement/deploymentReimbursementStates.js";
import { DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT } from "../payment/reimbursement/deploymentReimbursementServiceResults.js";
import {
    validateDeploymentReimbursementCreateInput,
    applyDeploymentReimbursementStatusPatch,
    deploymentReimbursementRecordId
} from "../payment/reimbursement/deploymentReimbursementSchema.js";
import { DEPLOYMENT_COST_SNAPSHOT_STATUS } from "../payment/reimbursement/deploymentCostSnapshotStates.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REIMB_DIR = join(__dirname, "../payment/reimbursement");

const DEPLOY_HASH = "oszAXcW26TcLUBz8QVnns4AjsKX/bRPXWYRD3J57GiY=";
const REIMB_WALLET = "EQBReimbursementWalletAddressPinOnly0000000001PDQ";
const DEPLOY_WALLET = "EQB83sDeployWalletExampleAddress0000000000003PDQ";

function sampleCreateInput(overrides = {}) {

    return {
        gameId: "game_stage_m_1",
        roomId: "room_stage_m_1",
        contractId: "contract_stage_m_1",
        deploymentTxHash: DEPLOY_HASH,
        deployWallet: DEPLOY_WALLET,
        reimbursementWallet: REIMB_WALLET,
        deploymentCostSnapshotId: "snap_stage_m_1",
        amountTon: "0.023859709",
        status: DEPLOYMENT_REIMBURSEMENT_STATUS.PENDING,
        ...overrides
    };

}

function frozenSnapshotRecord(overrides = {}) {

    const payload = {
        id: "snap_stage_m_1",
        gameId: "game_stage_m_1",
        roomId: "room_stage_m_1",
        contractId: "contract_stage_m_1",
        deploymentTxHash: DEPLOY_HASH,
        deployWallet: DEPLOY_WALLET,
        deploymentCostTon: "0.023859709",
        status: DEPLOYMENT_COST_SNAPSHOT_STATUS.FROZEN,
        ...overrides
    };

    return {
        recordId: payload.id,
        recordType: TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_COST_SNAPSHOT,
        payload
    };

}

function createStack({ enabled = true, reimbursementWallet = REIMB_WALLET } = {}) {

    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-reimb-stage-m-"));

    const persistence = new TonFinancialPersistence({
        dataDir,
        autoCheckpoint: false
    });

    persistence.initialize();

    const repository = new DeploymentReimbursementRepository({
        persistence,
        tonNetwork: "testnet"
    });

    const env = {
        DEPLOYMENT_REIMBURSEMENT_ENABLED: enabled ? "true" : "false",
        TON_REIMBURSEMENT_EXPECTED_ADDRESS: reimbursementWallet
    };

    const service = new DeploymentReimbursementService({
        repository,
        reimbursementWallet,
        env
    });

    service.initialize();

    const transferService = new ReimbursementTransferService();

    const worker = new DeploymentReimbursementWorker({
        repository,
        transferService,
        env,
        pollIntervalMs: 60_000
    });

    worker.initialize();

    return {
        dataDir,
        persistence,
        repository,
        service,
        worker,
        transferService,
        cleanup() {
            worker.shutdown();
            service.shutdown();
            rmSync(dataDir, { recursive: true, force: true });
        }
    };

}

function assertNoForbiddenSourcePatterns() {

    // Stage O owns transfer/adapter; Stage M scans queue foundation only.
    const files = [
        "DeploymentReimbursementService.js",
        "DeploymentReimbursementWorker.js",
        "DeploymentReimbursementRepository.js",
        "deploymentReimbursementSchema.js",
        "deploymentReimbursementConfig.js",
        "deploymentReimbursementStates.js"
    ];

    const forbidden = [
        /mnemonic/i,
        /privateKey/i,
        /sendTransfer/,
        /WalletContract/,
        /fromSecretKey/,
        /openWallet/,
        /GameEscrow/
    ];

    for (const file of files) {

        const source = readFileSync(join(REIMB_DIR, file), "utf8");

        for (const pattern of forbidden) {

            assert.equal(
                pattern.test(source),
                false,
                `${file} must not match ${pattern}`
            );

        }

    }

}

async function main() {

    // --- record type ---

    assert.equal(
        TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_REIMBURSEMENT,
        "deployment_reimbursement"
    );

    // --- feature flag default false ---

    assert.equal(isDeploymentReimbursementEnabled({}), false);
    assert.equal(
        isDeploymentReimbursementEnabled({
            DEPLOYMENT_REIMBURSEMENT_ENABLED: "false"
        }),
        false
    );
    assert.equal(
        isDeploymentReimbursementEnabled({
            DEPLOYMENT_REIMBURSEMENT_ENABLED: "true"
        }),
        true
    );

    // --- schema validation ---

    {
        const ok = validateDeploymentReimbursementCreateInput(sampleCreateInput());

        assert.equal(ok.ok, true);
        assert.equal(ok.payload.amountTon, "0.023859709");
        assert.equal(
            ok.payload.status,
            DEPLOYMENT_REIMBURSEMENT_STATUS.PENDING
        );
        assert.equal(
            ok.payload.id,
            deploymentReimbursementRecordId(DEPLOY_HASH)
        );

        const missing = validateDeploymentReimbursementCreateInput({
            gameId: "g1"
        });

        assert.equal(missing.ok, false);

        const confirmedCreate = validateDeploymentReimbursementCreateInput(
            sampleCreateInput({
                status: DEPLOYMENT_REIMBURSEMENT_STATUS.CONFIRMED
            })
        );

        assert.equal(confirmedCreate.ok, false);

        const confirmedPatch = applyDeploymentReimbursementStatusPatch(
            ok.payload,
            { status: DEPLOYMENT_REIMBURSEMENT_STATUS.CONFIRMED }
        );

        assert.equal(confirmedPatch.ok, false);
        assert.ok(
            confirmedPatch.errors.includes("confirmed_not_allowed_stage_m")
        );
    }

    // --- unit: frozen accepted / pending rejected / duplicate ---

    {
        const stack = createStack({ enabled: true });

        try {

            const frozen = stack.service.createFromSnapshot(frozenSnapshotRecord());

            assert.equal(frozen.ok, true);
            assert.equal(
                frozen.code,
                DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.OK
            );
            assert.equal(
                frozen.reimbursement.payload.status,
                DEPLOYMENT_REIMBURSEMENT_STATUS.PENDING
            );
            assert.equal(
                frozen.reimbursement.payload.amountTon,
                "0.023859709"
            );
            assert.equal(
                frozen.reimbursement.recordType,
                TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_REIMBURSEMENT
            );

            const pendingSnap = stack.service.createFromSnapshot(
                frozenSnapshotRecord({
                    status: DEPLOYMENT_COST_SNAPSHOT_STATUS.PENDING_LOOKUP,
                    deploymentCostTon: null
                })
            );

            assert.equal(pendingSnap.ok, false);
            assert.equal(
                pendingSnap.code,
                DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.SNAPSHOT_NOT_FROZEN
            );

            const dup = stack.service.createFromSnapshot(frozenSnapshotRecord());

            assert.equal(dup.ok, true);
            assert.equal(
                dup.code,
                DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.DUPLICATE
            );
            assert.equal(
                dup.reimbursement.recordId,
                frozen.reimbursement.recordId
            );

            assert.equal(
                stack.repository.findByGameId("game_stage_m_1")?.recordId,
                frozen.reimbursement.recordId
            );
            assert.equal(
                stack.repository.findByDeploymentTxHash(DEPLOY_HASH)?.recordId,
                frozen.reimbursement.recordId
            );

            assert.throws(
                () => stack.repository.create(sampleCreateInput()),
                (error) => error instanceof DuplicateRecordError
            );

        } finally {

            stack.cleanup();

        }

    }

    // --- disabled flag: no queue creation ---

    {
        const stack = createStack({ enabled: false });

        try {

            const result = stack.service.createFromSnapshot(frozenSnapshotRecord());

            assert.equal(result.ok, false);
            assert.equal(
                result.code,
                DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.FEATURE_DISABLED
            );
            assert.equal(stack.repository.listPending().length, 0);

            const queue = await stack.worker.processQueue();

            assert.equal(queue.skipped, "feature_disabled");
            assert.equal(queue.scanned, 0);

        } finally {

            stack.cleanup();

        }

    }

    // --- worker: pending queue read; no TON transfer ---

    {
        const stack = createStack({ enabled: true });

        try {

            const created = stack.service.createFromSnapshot(frozenSnapshotRecord());

            assert.equal(created.ok, true);
            assert.equal(stack.repository.listPending().length, 1);

            const transfer = await stack.transferService.sendReimbursement(
                created.reimbursement
            );

            assert.equal(transfer.ok, false);
            assert.ok(
                transfer.code === "NOT_INITIALIZED"
                || transfer.code === "FEATURE_DISABLED"
                || transfer.code === "FAILED",
                `expected blocked transfer code, got ${transfer.code}`
            );
            assert.equal(transfer.txHash ?? null, null);

            const queue = await stack.worker.processQueue();

            assert.equal(queue.scanned, 1);
            assert.equal(queue.claimed, 1);
            assert.notEqual(
                queue.results[0]?.code,
                DEPLOYMENT_REIMBURSEMENT_STATUS.CONFIRMED
            );
            assert.equal(queue.results[0]?.ok, false);

            const after = stack.repository.findById(created.reimbursement.recordId);

            assert.equal(
                after.payload.status,
                DEPLOYMENT_REIMBURSEMENT_STATUS.FAILED_RETRY
            );
            assert.notEqual(
                after.payload.status,
                DEPLOYMENT_REIMBURSEMENT_STATUS.CONFIRMED
            );
            assert.equal(after.payload.txHash, null);

        } finally {

            stack.cleanup();

        }

    }

    // --- security: no wallet / mnemonic / tx send in Stage M sources ---

    assertNoForbiddenSourcePatterns();

    console.log("deploymentReimbursement.stageM.test.js: OK");

}

main().catch((error) => {

    console.error(error);
    process.exitCode = 1;

});
