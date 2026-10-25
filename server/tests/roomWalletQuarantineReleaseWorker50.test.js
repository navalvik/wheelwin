import test from "node:test";
import assert from "node:assert/strict";
import { RoomWalletReconciliationMutex } from "../payment/roomWallet/RoomWalletReconciliationMutex.js";
import { RoomWalletQuarantineReleaseWorker } from "../payment/roomWallet/RoomWalletQuarantineReleaseWorker.js";

const record = (n) => ({
    recordId: "rwrefund_guard_" + n.toString(16).padStart(64, "0"),
    status: "ACTIVE",
    payload: { roomNumber: n, roomId: "room" + n }
});

function fixture(count = 50, overrides = {}) {
    let available = Array.from({ length: count }, (_, n) => record(n + 1));
    let now = 1792902000000;
    const calls = [];
    const mutex = new RoomWalletReconciliationMutex();
    const guard = {
        async tryRelease({ recordId }) {
            calls.push(recordId);
            if (overrides.failureCodes?.[recordId]) {
                const err = new Error(overrides.failureCodes[recordId]);
                err.code = overrides.failureCodes[recordId];
                throw err;
            }
            available = available.filter(item => item.recordId !== recordId);
            return { changed: true, unblocked: true };
        }
    };
    const worker = new RoomWalletQuarantineReleaseWorker({
        repository: { listAllocationBlocks: () => available },
        releaseGuard: guard, scanMutex: mutex,
        now: () => now,
        maxWalletsPerSweep: 2,
        intervalMs: 30_000,
        failureRetryMs: 1000,
        successRetryMs: 2000
    });
    return {
        worker, mutex, calls, available: () => available,
        advance(ms) { now += ms; }
    };
}

test("50 distinct quarantined wallets close in 25 limited sweeps", async () => {
    const f = fixture();
    for (let i = 0; i < 25; i++) {
        const report = await f.worker.runOnce();
        assert.equal(report.attempted, 2);
        assert.equal(report.closed, 2);
    }
    assert.equal(f.available().length, 0);
    assert.equal(new Set(f.calls).size, 50);
    assert.equal((await f.worker.runOnce()).attempted, 0);
    f.worker.shutdown();
});

test("unknown on-chain liability remains quarantined under exponential backoff", async () => {
    const id = record(1).recordId;
    const f = fixture(1, {
        failureCodes: { [id]: "QUARANTINE_RELEASE_REFUND_UNPAID" }
    });
    const first = await f.worker.runOnce();
    assert.equal(first.blocked, 1);
    assert.equal(f.available().length, 1);
    assert.equal((await f.worker.runOnce()).attempted, 0);
    f.advance(1100);
    assert.equal((await f.worker.runOnce()).attempted, 1);
    assert.equal(f.available().length, 1);
    assert.equal(f.calls.length, 2);
    f.worker.shutdown();
});

test("pre-Page5 scanner and release scan serialize on the same room number", async () => {
    const f = fixture(1);
    const steps = [];
    let complete;
    const wait = new Promise(resolve => { complete = resolve; });
    const expired = f.mutex.runExclusive(1, async () => {
        steps.push("expired:start");
        await wait;
        steps.push("expired:end");
    });
    const releasing = f.worker.runOnce();
    await Promise.resolve();
    assert.deepEqual(steps, ["expired:start"]);
    assert.equal(f.calls.length, 0);
    complete();
    await expired;
    await releasing;
    assert.equal(f.calls.length, 1);
    assert.deepEqual(steps, ["expired:start", "expired:end"]);
    f.worker.shutdown();
});

test("per-wallet mutex permits parallel reconciliation of different wallets", async () => {
    const mutex = new RoomWalletReconciliationMutex();
    let firstResolve;
    const firstGate = new Promise(resolve => { firstResolve = resolve; });
    let secondDone = false;
    const first = mutex.runExclusive(1, async () => { await firstGate; });
    const second = mutex.runExclusive(2, async () => { secondDone = true; });
    await second;
    assert.equal(secondDone, true);
    firstResolve();
    await first;
});

test("concurrent worker invocations cannot scan the same quarantine twice", async () => {
    const f = fixture(1);
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const original = f.worker._guard.tryRelease;
    f.worker._guard.tryRelease = async (...args) => {
        await waiting;
        return original(...args);
    };
    const first = f.worker.runOnce();
    assert.equal((await f.worker.runOnce()).skipped, "in_flight");
    release();
    await first;
    assert.equal(f.calls.length, 1);
    f.worker.shutdown();
});

test("shutdown stops future scans and never forces wallet reallocation", async () => {
    const f = fixture(2);
    f.worker.shutdown();
    assert.equal((await f.worker.runOnce()).skipped, "stopped");
    assert.equal(f.available().length, 2);
    assert.equal(f.calls.length, 0);
});

test("invalid construction cannot accidentally disable the shared scan mutex", () => {
    assert.throws(() => new RoomWalletQuarantineReleaseWorker({
        repository: { listAllocationBlocks() { return []; } },
        releaseGuard: { async tryRelease() {} }
    }), /dependencies invalid/);
    assert.throws(
        () => new RoomWalletReconciliationMutex().runExclusive(65, async () => {}),
        /Invalid Room Wallet/
    );
});
