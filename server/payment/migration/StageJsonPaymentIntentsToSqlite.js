/**
 * OFFLINE, non-destructive JSON -> SQLite payment-intent staging.
 *
 * This is not a runtime cutover. The live JSON store, ledger, refund
 * obligations and room-wallet reservations are never edited. No acceptance
 * or wallet-recycling authority results from this operation.
 *
 * Run only with the payment service quiesced: otherwise source changes during
 * copying are detected but cross-process writers may still be active.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve, join } from "node:path";
import { PaymentIntentStore } from "../PaymentIntentStore.js";
import { SqlitePaymentIntentStore } from "../SqlitePaymentIntentStore.js";

function assertSeparatePaths(sourceDir, stagingDir) {
    if (typeof sourceDir !== "string" || typeof stagingDir !== "string"
        || !isAbsolute(sourceDir) || !isAbsolute(stagingDir)) {
        throw new Error("Source and staging directories must be explicit absolute paths");
    }
    const source = resolve(sourceDir);
    const target = resolve(stagingDir);
    const relSource = relative(source, target);
    const relTarget = relative(target, source);
    if (source === target || !relSource || !relTarget
        || (!relSource.startsWith("..") && !isAbsolute(relSource))
        || (!relTarget.startsWith("..") && !isAbsolute(relTarget))) {
        throw new Error("Staging and source directory trees must not overlap");
    }
    if (existsSync(target)) {
        throw new Error("Staging directory already exists; refusing overwrite or repeated migration");
    }
    return { source, target };
}

function snapshot(store) {
    return store.list().map(intent => intent.toRecord())
        .sort((a, b) => a.paymentReference.localeCompare(b.paymentReference));
}

function digest(records) {
    return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

/**
 * Result contains only counts + SHA-256 digests; no wallet identities, keys,
 * addresses, payment references or raw transaction data.
 */
export function stageJsonPaymentIntentsToSqlite({ sourceDataDir, stagingDir } = {}) {
    const { source, target } = assertSeparatePaths(sourceDataDir, stagingDir);
    if (!existsSync(join(source, "payment-intents"))) {
        throw new Error("No source JSON payment-intents directory exists");
    }

    const json = new PaymentIntentStore({ dataDir: source });
    json.initialize();
    const before = snapshot(json);
    const beforeDigest = digest(before);

    mkdirSync(target);
    const sqlitePath = join(target, "payment-intents.sqlite");
    let sqlite = null;
    try {
        sqlite = new SqlitePaymentIntentStore({ databasePath: sqlitePath });
        sqlite.initialize();
        for (const record of before) sqlite.save(record);
        if (digest(snapshot(sqlite)) !== beforeDigest) {
            throw new Error("SQLite staged intents disagree with the source snapshot");
        }
        sqlite.close();
        sqlite = new SqlitePaymentIntentStore({ databasePath: sqlitePath });
        sqlite.initialize();
        if (digest(snapshot(sqlite)) !== beforeDigest) {
            throw new Error("SQLite reopened snapshot differs from JSON source");
        }
        const reloadedJson = new PaymentIntentStore({ dataDir: source });
        reloadedJson.initialize();
        if (digest(snapshot(reloadedJson)) !== beforeDigest) {
            throw new Error("JSON source changed during staging; cutover is unsafe");
        }
        return Object.freeze({
            staged: true,
            cutoverAuthorized: false,
            paymentAcceptanceEnabled: false,
            recordCount: before.length,
            sourceDigest: beforeDigest,
            stagedDigest: digest(snapshot(sqlite))
        });
    } catch (error) {
        // Target is new and exclusive; delete the partial copy on error.
        try { sqlite?.close(); } catch {}
        rmSync(target, { recursive: true, force: true });
        throw error;
    } finally {
        try { sqlite?.close(); } catch {}
    }
}
