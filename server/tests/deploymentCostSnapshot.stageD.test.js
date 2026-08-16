/**
 * R17.8V.2P.K — Deployment Cost Snapshot Stage D tests (lookup + freeze).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    TonFinancialPersistence
} from "../persistence/TonFinancialPersistence.js";
import { DeploymentCostService } from "../payment/reimbursement/DeploymentCostService.js";
import { DeploymentCostSnapshotRepository } from "../payment/reimbursement/DeploymentCostSnapshotRepository.js";
import { DEPLOYMENT_COST_SNAPSHOT_STATUS } from "../payment/reimbursement/deploymentCostSnapshotStates.js";
import { DEPLOYMENT_COST_SERVICE_RESULT } from "../payment/reimbursement/deploymentCostServiceResults.js";
import {
    extractDeployCostFromTransaction,
    extractNetworkFeeNanoton
} from "../payment/reimbursement/extractDeployCostFromTransaction.js";
import {
    nanotonToTonString,
    tonStringToNanoton
} from "../payment/reimbursement/nanoton.js";

/** DnRQ production evidence (R17.8V.2N). */
const DNRQ = Object.freeze({
    contractAddress: "EQCvx9tido_G8ZtyMgxMR_bKxjRG1qSGGHQFFNU2-at8WC7s",
    deploymentTxHash: "oszAXcW26TcLUBz8QVnns4AjsKX/bRPXWYRD3J57GiY=",
    deployWallet: "EQB83sDeployWalletExampleAddress0000000000003PDQ",
    attachedTon: "0.020396066",
    feeTon: "0.003463643",
    costTon: "0.023859709",
    valueTonForbidden: "0.022"
});

function dnrqNanotons() {

    return {
        attached: tonStringToNanoton(DNRQ.attachedTon),
        fee: tonStringToNanoton(DNRQ.feeTon),
        cost: tonStringToNanoton(DNRQ.costTon)
    };

}

function buildDnRqTransaction() {

    const { attached, fee } = dnrqNanotons();

    return {
        transaction_id: { hash: DNRQ.deploymentTxHash },
        fee: fee.toString(),
        out_msgs: [
            {
                destination: DNRQ.contractAddress,
                value: attached.toString()
            }
        ]
    };

}

function sampleCapture(overrides = {}) {

    return {
        gameId: "game_stage_d_1",
        roomId: "room_stage_d_1",
        contractId: "contract_stage_d_1",
        contractAddress: DNRQ.contractAddress,
        deploymentTxHash: DNRQ.deploymentTxHash,
        deployWallet: DNRQ.deployWallet,
        deployedAt: Date.now(),
        ...overrides
    };

}

function createMockTransport(transactions) {

    return {
        async getTransactions() {

            return transactions;

        }
    };

}

function createStack({ transport = null } = {}) {

    const dir = mkdtempSync(join(tmpdir(), "wheelwin-dcs-stage-d-"));

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
        env: { DEPLOYMENT_COST_SNAPSHOT_ENABLED: "true" }
    });

    service.initialize();

    return { dir, persistence, repository, service };

}

async function main() {

    const dirs = [];

    try {

        // --- BigInt sum + conversion ---

        {
            const { attached, fee, cost } = dnrqNanotons();

            assert.equal(attached + fee, cost);
            assert.equal(nanotonToTonString(attached), DNRQ.attachedTon);
            assert.equal(nanotonToTonString(fee), DNRQ.feeTon);
            assert.equal(nanotonToTonString(cost), DNRQ.costTon);
            assert.notEqual(nanotonToTonString(cost), DNRQ.valueTonForbidden);
        }

        // --- extraction helper DnRQ ---

        {
            const extracted = extractDeployCostFromTransaction(
                buildDnRqTransaction(),
                {
                    contractAddress: DNRQ.contractAddress,
                    deploymentTxHash: DNRQ.deploymentTxHash
                }
            );

            assert.equal(extracted.ok, true);
            assert.equal(
                nanotonToTonString(extracted.attachedNanoton),
                DNRQ.attachedTon
            );
            assert.equal(
                nanotonToTonString(extracted.networkFeeNanoton),
                DNRQ.feeTon
            );
            assert.equal(
                nanotonToTonString(extracted.deploymentCostNanoton),
                DNRQ.costTon
            );
            assert.notEqual(
                nanotonToTonString(extracted.deploymentCostNanoton),
                DNRQ.valueTonForbidden
            );
        }

        // --- invalid transaction rejection ---

        {
            const missingOut = extractDeployCostFromTransaction(
                {
                    transaction_id: { hash: DNRQ.deploymentTxHash },
                    fee: "1000",
                    out_msgs: []
                },
                { contractAddress: DNRQ.contractAddress }
            );

            assert.equal(missingOut.ok, false);

            const wrongDest = extractDeployCostFromTransaction(
                {
                    transaction_id: { hash: DNRQ.deploymentTxHash },
                    fee: "1000",
                    out_msgs: [{
                        destination: "EQWrongDestination000000000000000000000001",
                        value: "1000"
                    }]
                },
                { contractAddress: DNRQ.contractAddress }
            );

            assert.equal(wrongDest.ok, false);

            const badFee = extractNetworkFeeNanoton({});

            assert.equal(badFee, null);
        }

        // --- PENDING_LOOKUP + mocked TonCenter → FROZEN ---

        {
            const stack = createStack({
                transport: createMockTransport([buildDnRqTransaction()])
            });

            dirs.push(stack.dir);

            const created = stack.service.captureDeploymentCost(sampleCapture());

            assert.equal(created.ok, true);
            assert.equal(
                created.snapshot.payload.status,
                DEPLOYMENT_COST_SNAPSHOT_STATUS.PENDING_LOOKUP
            );

            const frozen = await stack.service.lookupAndFreezeSnapshot(
                created.snapshot
            );

            assert.equal(frozen.ok, true);
            assert.equal(
                frozen.snapshot.payload.status,
                DEPLOYMENT_COST_SNAPSHOT_STATUS.FROZEN
            );
            assert.equal(frozen.snapshot.payload.source, "chain");
            assert.equal(
                frozen.snapshot.payload.attachedTon,
                DNRQ.attachedTon
            );
            assert.equal(
                frozen.snapshot.payload.networkFeeTon,
                DNRQ.feeTon
            );
            assert.equal(
                frozen.snapshot.payload.deploymentCostTon,
                DNRQ.costTon
            );
            assert.notEqual(
                frozen.snapshot.payload.deploymentCostTon,
                DNRQ.valueTonForbidden
            );
            assert.equal(frozen.snapshot.immutable, true);

            // freeze protection

            await assert.rejects(
                async () => stack.repository.freezeFromChain(
                    frozen.snapshot.recordId,
                    {
                        attachedTon: "1",
                        networkFeeTon: "1",
                        deploymentCostTon: "2"
                    }
                )
            );

            // restart reload

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

            const reloaded = repository2.findByDeploymentTxHash(
                DNRQ.deploymentTxHash
            );

            assert.ok(reloaded);
            assert.equal(
                reloaded.payload.status,
                DEPLOYMENT_COST_SNAPSHOT_STATUS.FROZEN
            );
            assert.equal(reloaded.payload.deploymentCostTon, DNRQ.costTon);
            assert.notEqual(
                reloaded.payload.deploymentCostTon,
                DNRQ.valueTonForbidden
            );

            persistence2.shutdown();
        }

        // --- tx not found stays PENDING_LOOKUP ---

        {
            const stack = createStack({
                transport: createMockTransport([])
            });

            dirs.push(stack.dir);

            const created = stack.service.captureDeploymentCost(sampleCapture({
                gameId: "game_pending",
                deploymentTxHash: "missing-hash-aaaaaaaaaaaaaaaaaaaa="
            }));

            const result = await stack.service.lookupAndFreezeSnapshot(
                created.snapshot
            );

            assert.equal(result.ok, false);
            assert.equal(
                result.code,
                DEPLOYMENT_COST_SERVICE_RESULT.LOOKUP_PENDING
            );
            assert.equal(
                result.snapshot.payload.status,
                DEPLOYMENT_COST_SNAPSHOT_STATUS.PENDING_LOOKUP
            );
            assert.equal(result.snapshot.payload.deploymentCostTon, null);

            stack.service.shutdown();
            stack.persistence.shutdown();
        }

        // --- RPC failure stays PENDING_LOOKUP ---

        {
            const stack = createStack({
                transport: {
                    async getTransactions() {

                        throw new Error("rpc_down");

                    }
                }
            });

            dirs.push(stack.dir);

            const created = stack.service.captureDeploymentCost(sampleCapture({
                gameId: "game_rpc",
                deploymentTxHash: "rpc-fail-hash-aaaaaaaaaaaaaaaaaaa="
            }));

            const result = await stack.service.lookupAndFreezeSnapshot(
                created.snapshot
            );

            assert.equal(result.ok, false);
            assert.equal(
                result.code,
                DEPLOYMENT_COST_SERVICE_RESULT.LOOKUP_PENDING
            );
            assert.equal(
                result.snapshot.payload.status,
                DEPLOYMENT_COST_SNAPSHOT_STATUS.PENDING_LOOKUP
            );

            stack.service.shutdown();
            stack.persistence.shutdown();
        }

        console.log("deploymentCostSnapshot.stageD.test.js: PASS");

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
