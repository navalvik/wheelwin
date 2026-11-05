import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { MainnetFinancialLedger } from "../payment/MainnetFinancialLedger.js";

test("independent Mainnet ledger instances retain payout and confirmed legs during another room update", t => {
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-mainnet-financial-ledger-lock-"));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const config = { network: "mainnet", globalId: -239, dataDir };
    const first = new MainnetFinancialLedger({ config, nowProvider: () => 100 }).initialize();
    const staleSecond = new MainnetFinancialLedger({ config, nowProvider: () => 101 }).initialize();
    const input = { payoutId: "payout_rzmc_deterministic", roomId: "RzMc", roomNumber: 2,
        sourceWalletAddress: `0:${"1".repeat(64)}`, principalAtomic: 3_000_000_000,
        winner: { recipientId: "lena", address: `0:${"2".repeat(64)}` },
        owner: { recipientId: "WheelWin", address: `0:${"3".repeat(64)}` } };
    const payout = first.createPayout(input);

    for (const [role, transactionId] of [["winner", "winner-existing-tx"], ["owner", "owner-existing-tx"]]) {
        const leg = payout[role];
        first.updatePayoutLeg(input.payoutId, role, { state: "SUBMISSION_UNKNOWN", attemptedAtMs: 110 });
        first.updatePayoutLeg(input.payoutId, role, { state: "SUBMITTED", transactionId, submittedAtMs: 120 });
        first.updatePayoutLeg(input.payoutId, role, { state: "CONFIRMED", finalizedEvidence: {
            network: "mainnet", globalId: -239, transactionId,
            amountAtomic: leg.amountAtomic, destination: leg.address, finalized: true,
            observedAtMs: 130, independentProvider: "tonapi-mainnet", actualFeeAtomic: 1
        } });
    }

    staleSecond.recordHistoryCoverage({ roomId: "ubjL", source: "FINAL_FORENSIC_HISTORY_COVERAGE",
        completedAt: 140, ceilingMs: 140, resultWindowComplete: true, providerError: null,
        candidateCount: 2, checkedCount: 2, pendingCount: 0,
        verifiedTransactionIds: ["refund-a", "refund-b"], candidateCursor: 0 });

    const restarted = new MainnetFinancialLedger({ config, nowProvider: () => 150 }).initialize();
    const persisted = restarted.getPayout(input.payoutId);
    assert.equal(restarted.getOutcome("RzMc")?.kind, "PAYOUT");
    assert.equal(persisted.state, "COMPLETE");
    assert.equal(persisted.winner.state, "CONFIRMED");
    assert.equal(persisted.winner.transactionId, "winner-existing-tx");
    assert.equal(persisted.owner.state, "CONFIRMED");
    assert.equal(persisted.owner.transactionId, "owner-existing-tx");
    assert.equal(restarted.getHistoryCoverage("ubjL")?.pendingCount, 0);
    assert.equal(restarted.listPayouts().length, 1);
    assert.equal(restarted.createPayout(input).replay, true);
    assert.throws(() => staleSecond.createPayout({ ...input,
        payoutId: "payout_rzmc_duplicate" }), /MAINNET_ROOM_PAYOUT_ALREADY_PLANNED/);
    assert.equal(new MainnetFinancialLedger({ config }).initialize().listPayouts().length, 1);
});

test("confirmed payout restoration writes a complete plan atomically without exposing pending legs", t => {
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-mainnet-confirmed-payout-restore-"));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const config = { network: "mainnet", globalId: -239, dataDir };
    const ledger = new MainnetFinancialLedger({ config, nowProvider: () => 200 }).initialize();
    const winnerAddress = `0:${"2".repeat(64)}`;
    const ownerAddress = `0:${"3".repeat(64)}`;
    const makeLeg = (role, address, amountAtomic, transactionId) => ({
        recipientId: role === "winner" ? "lena" : "WheelWin",
        address,
        amountAtomic,
        state: "CONFIRMED",
        transactionId,
        finalizedEvidence: {
            network: "mainnet", globalId: -239, transactionId, amountAtomic,
            destination: address, finalized: true, observedAtMs: 190,
            independentProvider: "tonapi-mainnet", actualFeeAtomic: 1,
            recipientTransactionId: `${transactionId}-recipient`, messageHash: `${transactionId}-message`
        }
    });
    const input = {
        payoutId: "payout_rzmc_confirmed_restore", roomId: "RzMc", roomNumber: 2,
        sourceWalletAddress: `0:${"1".repeat(64)}`, principalAtomic: 3_000_000_000,
        createdAtMs: 180, verificationProviders: ["toncenter-mainnet", "tonapi-mainnet"],
        winner: makeLeg("winner", winnerAddress, 2_850_000_000, "winner-existing-tx"),
        owner: makeLeg("owner", ownerAddress, 147_000_000, "owner-existing-tx")
    };

    const restored = ledger.recordConfirmedPayout(input);
    assert.equal(restored.state, "COMPLETE");
    assert.equal(restored.winner.state, "CONFIRMED");
    assert.equal(restored.winner.transactionId, "winner-existing-tx");
    assert.equal(restored.owner.state, "CONFIRMED");
    assert.equal(restored.owner.transactionId, "owner-existing-tx");
    assert.equal(ledger.countOpenObligations("RzMc"), 0);
    assert.equal(ledger.getOutcome("RzMc")?.kind, "PAYOUT");
    assert.throws(() => ledger.recordConfirmedPayout({ ...input, verificationProviders: ["toncenter-mainnet"] }),
        /MAINNET_CONFIRMED_PAYOUT_INPUT_INVALID/);

    const restarted = new MainnetFinancialLedger({ config }).initialize();
    assert.equal(restarted.getPayout(input.payoutId)?.state, "COMPLETE");
    assert.equal(restarted.getPayout(input.payoutId)?.winner.transactionId, "winner-existing-tx");
    assert.equal(restarted.getPayout(input.payoutId)?.owner.transactionId, "owner-existing-tx");
});

test("separate Node processes serialize concurrent payout and history writes", async t => {
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-mainnet-ledger-process-lock-"));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const config = { network: "mainnet", globalId: -239, dataDir };
    new MainnetFinancialLedger({ config }).initialize();
    const gate = join(dataDir, "release-workers");
    const script = `
        import { existsSync, writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        import { MainnetFinancialLedger } from './server/mainnet/payment/MainnetFinancialLedger.js';
        const [dataDir, gate, role] = process.argv.slice(1);
        const config = { network: 'mainnet', globalId: -239, dataDir };
        const ledger = new MainnetFinancialLedger({ config }).initialize();
        writeFileSync(join(dataDir, role + '.ready'), 'ready');
        while (!existsSync(gate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        if (role === 'payout') ledger.createPayout({ payoutId: 'payout_concurrent_process',
            roomId: 'RzMc', roomNumber: 2, sourceWalletAddress: '0:' + '1'.repeat(64),
            principalAtomic: 3000000000,
            winner: { recipientId: 'lena', address: '0:' + '2'.repeat(64) },
            owner: { recipientId: 'WheelWin', address: '0:' + '3'.repeat(64) } });
        else ledger.recordHistoryCoverage({ roomId: 'ubjL',
            source: 'FINAL_FORENSIC_HISTORY_COVERAGE', completedAt: 200,
            ceilingMs: 200, resultWindowComplete: true, providerError: null,
            candidateCount: 2, checkedCount: 2, pendingCount: 0,
            verifiedTransactionIds: ['refund-a', 'refund-b'], candidateCursor: 0 });
    `;
    const workers = ["payout", "coverage"].map(role => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script, dataDir, gate, role], {
            cwd: process.cwd(), windowsHide: true, stdio: "ignore"
        });
        child.once("error", reject);
        child.once("exit", code => code === 0 ? resolve() : reject(new Error(`ledger child exited ${code}`)));
    }));
    const readyNames = ["payout", "coverage"].map(role => join(dataDir, `${role}.ready`));
    const readyDeadline = Date.now() + 10_000;
    while (!readyNames.every(existsSync) && Date.now() < readyDeadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(readyNames.every(existsSync), "both writer processes loaded the same base snapshot");
    writeFileSync(gate, "go");
    await Promise.all(workers);

    const restarted = new MainnetFinancialLedger({ config }).initialize();
    assert.equal(restarted.getOutcome("RzMc")?.kind, "PAYOUT");
    assert.equal(restarted.getPayout("payout_concurrent_process")?.state, "PENDING");
    assert.equal(restarted.getHistoryCoverage("ubjL")?.pendingCount, 0);
});
