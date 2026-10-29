import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { durableWriteJson } from "./DurableJson.js";

/** Append-only, secret-free payment observation and decision evidence. */
export class PaymentForensicJournal {
    constructor({ dataDir }) {
        if (typeof dataDir !== "string" || !dataDir.trim()) throw new TypeError("dataDir required");
        this._dir = join(dataDir, "payment-forensics");
        this._initialized = false;
    }
    initialize() { mkdirSync(this._dir, { recursive: true }); this._initialized = true; return this; }
    _path(roomId, kind) {
        if (!this._initialized) throw new Error("PAYMENT_FORENSIC_JOURNAL_NOT_INITIALIZED");
        const key = createHash("sha256").update(String(roomId)).digest("hex");
        return join(this._dir, `${key}.${kind}.json`);
    }
    _append(roomId, kind, entry) {
        const path = this._path(roomId, kind);
        let rows = [];
        try { rows = JSON.parse(readFileSync(path, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
        if (!Array.isArray(rows)) throw new Error("PAYMENT_FORENSIC_JOURNAL_INVALID");
        rows.push(Object.freeze({ roomId, ...entry }));
        durableWriteJson(path, rows);
    }
    recordObservation(roomId, entry) { this._append(roomId, "observations", entry); }
    recordDecision(roomId, entry) { this._append(roomId, "decisions", entry); }
    list(roomId, kind) {
        const path = this._path(roomId, kind);
        try { const rows = JSON.parse(readFileSync(path, "utf8")); return Array.isArray(rows) ? rows : []; }
        catch (error) { if (error.code === "ENOENT") return []; throw error; }
    }
}
