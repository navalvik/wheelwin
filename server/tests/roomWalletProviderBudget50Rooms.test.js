import test from "node:test";
import assert from "node:assert/strict";

import {
    RoomWalletProviderBudget,
    RoomWalletProviderBudgetError
} from "../payment/roomWallet/RoomWalletProviderBudget.js";
import {
    fetchDualSourceRoomWalletTransactions
} from "../payment/roomWallet/RoomWalletDualSourceEvidence.js";

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

test("simulated 50 simultaneous rooms use at most two concurrent requests PER provider", async () => {
    const budget = new RoomWalletProviderBudget({
        concurrencyPerProvider: 2,
        spacingMs: 2,
        maxQueuedPerProvider: 64
    });
    const active = { tonapi: 0, "toncenter-v3": 0 };
    const peaks = { tonapi: 0, "toncenter-v3": 0 };
    const calls = { tonapi: 0, "toncenter-v3": 0 };

    const fetchImpl = async (url, options) => {
        assert.equal(options.method, "GET");
        const provider = url.includes("tonapi.io") ? "tonapi" : "toncenter-v3";
        active[provider]++;
        peaks[provider] = Math.max(peaks[provider], active[provider]);
        calls[provider]++;
        try {
            await wait(6);
            return { ok: true, status: 200, async json() { return { transactions: [] }; } };
        } finally {
            active[provider]--;
        }
    };

    const rooms = Array.from({ length: 50 }, (_, i) => ({
        address: "0:" + (i + 1).toString(16).padStart(64, "0")
    }));
    const results = await Promise.all(rooms.map(({ address }) =>
        fetchDualSourceRoomWalletTransactions({
            address,
            expectedRoomWalletRaw: address,
            fetchImpl,
            requestBudget: budget,
            timeoutMs: 1000
        })
    ));

    assert.equal(results.length, 50);
    assert.ok(results.every(x => x.transactions.length === 0
        && x.source === "tonapi+toncenter-v3"));
    assert.deepEqual(calls, { tonapi: 50, "toncenter-v3": 50 });
    assert.ok(peaks.tonapi <= 2 && peaks["toncenter-v3"] <= 2);
    const snapshot = budget.snapshot();
    for (const name of ["tonapi", "toncenter-v3"]) {
        assert.equal(snapshot[name].started, 50);
        assert.equal(snapshot[name].rejected, 0);
        assert.equal(snapshot[name].active, 0);
        assert.equal(snapshot[name].queued, 0);
        assert.ok(snapshot[name].peakActive <= 2);
        assert.ok(snapshot[name].peakQueued <= 50);
    }
});

test("a burst beyond bounded queue is rejected as retryable, NEVER treated as no payment", async () => {
    const budget = new RoomWalletProviderBudget({
        concurrencyPerProvider: 1,
        spacingMs: 0,
        maxQueuedPerProvider: 2
    });
    let release;
    const lock = new Promise(resolve => { release = resolve; });
    const first = budget.schedule("tonapi", () => lock);
    const second = budget.schedule("tonapi", async () => "second");
    const third = budget.schedule("tonapi", async () => "third");

    await assert.rejects(budget.schedule("tonapi", async () => "unsafe"), error =>
        error instanceof RoomWalletProviderBudgetError
        && error.code === "PROVIDER_QUEUE_FULL"
        && error.retryable === true);
    release("first");
    assert.deepEqual(await Promise.all([first, second, third]), ["first", "second", "third"]);
    assert.equal(budget.snapshot().tonapi.rejected, 1);
});

test("failed provider request releases a scheduler slot for the next wallet", async () => {
    const budget = new RoomWalletProviderBudget({
        concurrencyPerProvider: 1, spacingMs: 0
    });
    const result = await Promise.allSettled([
        budget.schedule("toncenter-v3", async () => { throw new Error("HTTP 542"); }),
        budget.schedule("toncenter-v3", async () => "after-542")
    ]);
    assert.equal(result[0].status, "rejected");
    assert.equal(result[1].status, "fulfilled");
    assert.equal(result[1].value, "after-542");
    assert.equal(budget.snapshot()["toncenter-v3"].active, 0);
});

test("rate spacing prevents instant hundred-request Testnet fallback bursts", async () => {
    const budget = new RoomWalletProviderBudget({
        concurrencyPerProvider: 2, spacingMs: 14
    });
    const started = [];
    const all = await Promise.all(Array.from({ length: 6 }, () =>
        budget.schedule("tonapi", async () => {
            started.push(Date.now());
            return "OK";
        })
    ));
    assert.equal(all.length, 6);
    assert.ok(all.every(x => x === "OK"));
    for (let i = 1; i < started.length; i++) {
        assert.ok(started[i] - started[i - 1] >= 8,
            "unexpected burst: " + (started[i] - started[i - 1]) + " ms");
    }
});

test("invalid source, invalid budget and no live network requests fail closed", async () => {
    const budget = new RoomWalletProviderBudget({ spacingMs: 0 });
    await assert.rejects(
        budget.schedule("mainnet", async () => ({})),
        error => error.code === "UNKNOWN_PROVIDER"
    );
    await assert.rejects(
        budget.schedule("tonapi", "send money"),
        error => error.code === "REQUEST_NOT_FUNCTION"
    );
    await assert.rejects(
        fetchDualSourceRoomWalletTransactions({
            address: "0:" + "a".repeat(64),
            expectedRoomWalletRaw: "0:" + "a".repeat(64),
            fetchImpl: async () => { throw new Error("SHOULD_NOT_BE_CALLED"); },
            requestBudget: {}
        }),
        error => error.code === "EVIDENCE_BUDGET_INVALID"
    );
    assert.deepEqual(budget.snapshot(), {});
});
