/**
 * R17.8V.2P.N — Deployment Reimbursement Settlement Integration tests.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { EventBus } from "../events/EventBus.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    TonFinancialPersistence,
    TON_FINANCIAL_RECORD_TYPES
} from "../persistence/TonFinancialPersistence.js";
import { DeploymentCostSnapshotRepository } from "../payment/reimbursement/DeploymentCostSnapshotRepository.js";
import { DeploymentReimbursementRepository } from "../payment/reimbursement/DeploymentReimbursementRepository.js";
import { DeploymentReimbursementService } from "../payment/reimbursement/DeploymentReimbursementService.js";
import { DEPLOYMENT_COST_SNAPSHOT_STATUS } from "../payment/reimbursement/deploymentCostSnapshotStates.js";
import { DEPLOYMENT_REIMBURSEMENT_STATUS } from "../payment/reimbursement/deploymentReimbursementStates.js";
import { DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT } from "../payment/reimbursement/deploymentReimbursementServiceResults.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICE_SRC = join(
    __dirname,
    "../payment/reimbursement/DeploymentReimbursementService.js"
);

const DEPLOY_HASH = "oszAXcW26TcLUBz8QVnns4AjsKX/bRPXWYRD3J57GiY=";
const REIMB_WALLET = "EQBReimbursementWalletAddressPinOnly0000000001PDQ";
const DEPLOY_WALLET = "EQB83sDeployWalletExampleAddress0000000000003PDQ";
const COST = "0.023859709";

function createBus() {

    const bus = new EventBus({
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        eventBusConfig: {}
    });

    bus.initialize();

    return bus;

}

function settlementPayload(overrides = {}) {

    return {
        gameId: "game_stage_n_1",
        roomId: "room_stage_n_1",
        contractId: "contract_stage_n_1",
        status: "SETTLEMENT_COMPLETED",
        winnerId: "winner_1",
        winnerAmount: "1.0",
        organizerAmount: "0.1",
        settlementTxHash: "settlement_tx_hash_stage_n",
        timestamp: Date.now(),
        ...overrides
    };

}

function createStack({ enabled = true } = {}) {

    const dir = mkdtempSync(join(tmpdir(), "wheelwin-reimb-stage-n-"));

    const persistence = new TonFinancialPersistence({
        dataDir: dir,
        autoCheckpoint: false
    });

    persistence.initialize();

    const eventBus = createBus();

    const snapshotRepository = new DeploymentCostSnapshotRepository({
        persistence,
        tonNetwork: "testnet"
    });

    const repository = new DeploymentReimbursementRepository({
        persistence,
        tonNetwork: "testnet"
    });

    const service = new DeploymentReimbursementService({
        repository,
        snapshotRepository,
        eventBus,
        reimbursementWallet: REIMB_WALLET,
        env: {
            DEPLOYMENT_REIMBURSEMENT_ENABLED: enabled ? "true" : "false",
            TON_REIMBURSEMENT_EXPECTED_ADDRESS: REIMB_WALLET
        }
    });

    service.initialize();

    return {
        dir,
        persistence,
        eventBus,
        snapshotRepository,
        repository,
        service,
        cleanup() {
            service.shutdown();
            eventBus.shutdown();
            rmSync(dir, { recursive: true, force: true });
        }
    };

}

function seedPendingSnapshot(snapshotRepository, overrides = {}) {

    return snapshotRepository.create({
        gameId: "game_stage_n_1",
        roomId: "room_stage_n_1",
        contractId: "contract_stage_n_1",
        contractAddress: "EQCvx9tido_G8ZtyMgxMR_bKxjRG1qSGGHQFFNU2-at8WC7s",
        deploymentTxHash: DEPLOY_HASH,
        deployWallet: DEPLOY_WALLET,
        status: DEPLOYMENT_COST_SNAPSHOT_STATUS.PENDING_LOOKUP,
        ...overrides
    });

}

function seedFrozenSnapshot(snapshotRepository, overrides = {}) {

    const pending = seedPendingSnapshot(snapshotRepository, overrides);

    return snapshotRepository.freezeFromChain(pending.recordId, {
        attachedTon: "0.020396066",
        networkFeeTon: "0.003463643",
        deploymentCostTon: COST,
        source: "chain"
    });

}

function emitSettlement(eventBus, payload) {

    eventBus.emit({
        source: EVENT_SOURCES.CONTRACT_SETTLEMENT_MANAGER,
        type: EVENT_TYPES.SETTLEMENT_COMPLETED,
        payload
    });

}

async function waitFor(predicate, { timeoutMs = 2_000, intervalMs = 25 } = {}) {

    const started = Date.now();

    while (Date.now() - started < timeoutMs) {

        if (predicate()) {

            return true;

        }

        await delay(intervalMs);

    }

    return false;

}

async function main() {

    const stacks = [];

    try {

        assert.equal(
            EVENT_TYPES.SETTLEMENT_COMPLETED,
            "SETTLEMENT_COMPLETED"
        );
        assert.equal(
            EVENT_TYPES.DEPLOYMENT_REIMBURSEMENT_CREATED,
            "DEPLOYMENT_REIMBURSEMENT_CREATED"
        );
        assert.equal(
            EVENT_TYPES.DEPLOYMENT_REIMBURSEMENT_SKIPPED,
            "DEPLOYMENT_REIMBURSEMENT_SKIPPED"
        );
        assert.equal(
            EVENT_TYPES.DEPLOYMENT_REIMBURSEMENT_NO_SNAPSHOT,
            "DEPLOYMENT_REIMBURSEMENT_NO_SNAPSHOT"
        );

        // --- Integration: settlement event creates reimbursement ---

        {
            const stack = createStack({ enabled: true });

            stacks.push(stack);

            seedFrozenSnapshot(stack.snapshotRepository);

            const audits = [];

            stack.eventBus.subscribe(
                EVENT_TYPES.DEPLOYMENT_REIMBURSEMENT_CREATED,
                (envelope) => audits.push(envelope)
            );

            emitSettlement(stack.eventBus, settlementPayload());

            assert.ok(
                await waitFor(
                    () => stack.repository.findByGameId("game_stage_n_1")
                ),
                "async reimbursement create after SETTLEMENT_COMPLETED"
            );

            const reimb = stack.repository.findByGameId("game_stage_n_1");

            assert.equal(
                reimb.recordType,
                TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_REIMBURSEMENT
            );
            assert.equal(
                reimb.payload.status,
                DEPLOYMENT_REIMBURSEMENT_STATUS.PENDING
            );
            assert.equal(reimb.payload.amountTon, COST);
            assert.equal(reimb.payload.deploymentTxHash, DEPLOY_HASH);
            assert.equal(reimb.payload.deployWallet, DEPLOY_WALLET);
            assert.ok(reimb.payload.deploymentCostSnapshotId);
            assert.equal(audits.length, 1);
            assert.equal(audits[0].payload.gameId, "game_stage_n_1");
            assert.equal(audits[0].payload.deploymentTxHash, DEPLOY_HASH);
        }

        // --- Direct: frozen accepted / pending rejected ---

        {
            const stack = createStack({ enabled: true });

            stacks.push(stack);

            const frozen = seedFrozenSnapshot(stack.snapshotRepository, {
                gameId: "game_stage_n_frozen",
                deploymentTxHash: `${DEPLOY_HASH}:frozen`
            });

            const ok = stack.service.handleSettlementCompleted(
                settlementPayload({ gameId: "game_stage_n_frozen" })
            );

            assert.equal(ok.ok, true);
            assert.equal(ok.code, DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.OK);
            assert.equal(ok.reimbursement.payload.amountTon, COST);
            assert.equal(
                ok.reimbursement.payload.deploymentCostSnapshotId,
                frozen.recordId
            );

            const pendingOnly = createStack({ enabled: true });

            stacks.push(pendingOnly);

            seedPendingSnapshot(pendingOnly.snapshotRepository, {
                gameId: "game_stage_n_pending",
                deploymentTxHash: `${DEPLOY_HASH}:pending`
            });

            const rejected = pendingOnly.service.handleSettlementCompleted(
                settlementPayload({ gameId: "game_stage_n_pending" })
            );

            assert.equal(rejected.ok, false);
            assert.equal(
                rejected.code,
                DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.SNAPSHOT_NOT_FROZEN
            );
            assert.equal(
                pendingOnly.repository.findByGameId("game_stage_n_pending"),
                null
            );
        }

        // --- Idempotency: duplicate settlement event ---

        {
            const stack = createStack({ enabled: true });

            stacks.push(stack);

            seedFrozenSnapshot(stack.snapshotRepository, {
                gameId: "game_stage_n_dup",
                deploymentTxHash: `${DEPLOY_HASH}:dup`
            });

            const first = stack.service.handleSettlementCompleted(
                settlementPayload({ gameId: "game_stage_n_dup" })
            );
            const second = stack.service.handleSettlementCompleted(
                settlementPayload({ gameId: "game_stage_n_dup" })
            );

            assert.equal(first.ok, true);
            assert.equal(first.code, DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.OK);
            assert.equal(second.ok, true);
            assert.equal(
                second.code,
                DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.DUPLICATE
            );
            assert.equal(
                second.reimbursement.recordId,
                first.reimbursement.recordId
            );

            const all = stack.persistence.findByGame("game_stage_n_dup").filter(
                (record) => (
                    record.recordType
                        === TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_REIMBURSEMENT
                )
            );

            assert.equal(all.length, 1);
        }

        // --- Feature flag disabled: no queue, no errors ---

        {
            const stack = createStack({ enabled: false });

            stacks.push(stack);

            seedFrozenSnapshot(stack.snapshotRepository);

            const skipped = [];

            stack.eventBus.subscribe(
                EVENT_TYPES.DEPLOYMENT_REIMBURSEMENT_SKIPPED,
                (envelope) => skipped.push(envelope)
            );

            emitSettlement(stack.eventBus, settlementPayload());

            assert.ok(
                await waitFor(() => skipped.length >= 1),
                "disabled path emits SKIPPED asynchronously"
            );

            assert.equal(
                skipped[0].payload.reason,
                "feature_disabled"
            );
            assert.equal(
                stack.repository.findByGameId("game_stage_n_1"),
                null
            );

            const direct = stack.service.handleSettlementCompleted(
                settlementPayload()
            );

            assert.equal(direct.ok, true);
            assert.equal(
                direct.code,
                DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.FEATURE_DISABLED
            );
        }

        // --- Missing snapshot ---

        {
            const stack = createStack({ enabled: true });

            stacks.push(stack);

            const result = stack.service.handleSettlementCompleted(
                settlementPayload({ gameId: "game_missing_snapshot" })
            );

            assert.equal(result.ok, false);
            assert.equal(
                result.code,
                DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.NO_SNAPSHOT
            );
        }

        // --- Safety: non-blocking (settlement emit returns before create) ---

        {
            const stack = createStack({ enabled: true });

            stacks.push(stack);

            seedFrozenSnapshot(stack.snapshotRepository, {
                gameId: "game_stage_n_async",
                deploymentTxHash: `${DEPLOY_HASH}:async`
            });

            emitSettlement(
                stack.eventBus,
                settlementPayload({ gameId: "game_stage_n_async" })
            );

            assert.equal(
                stack.repository.findByGameId("game_stage_n_async"),
                null,
                "create must be deferred (setImmediate), not sync on emit"
            );

            assert.ok(
                await waitFor(
                    () => stack.repository.findByGameId("game_stage_n_async")
                )
            );
        }

        // --- Safety: no transfer / wallet / settlement mutation in service ---

        {
            const source = readFileSync(SERVICE_SRC, "utf8");

            assert.equal(/mnemonic/i.test(source), false);
            assert.equal(/privateKey/i.test(source), false);
            assert.equal(/sendTransfer/.test(source), false);
            assert.equal(/WalletContract/.test(source), false);
            assert.equal(/GameEscrow/.test(source), false);
            assert.equal(/processQueue/.test(source), false);
            assert.ok(source.includes("setImmediate"));
            assert.ok(source.includes("handleSettlementCompleted"));
            assert.ok(
                !source.includes("ContractSettlementManager"),
                "must not import/mutate ContractSettlementManager"
            );
        }

        console.log("deploymentReimbursement.stageN.test.js: OK");

    } finally {

        for (const stack of stacks) {

            try {

                stack.cleanup();

            } catch {

                // ignore cleanup races

            }

        }

    }

}

main().catch((error) => {

    console.error(error);
    process.exitCode = 1;

});
