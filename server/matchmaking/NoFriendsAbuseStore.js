import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STORE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "no-friends-abuse.json");
const LOCK_DURATION_MS = 8 * 60 * 60 * 1000;

/** Durable, privacy-preserving failure counter for cloud No Friends matching. */
export class NoFriendsAbuseStore {

    constructor({ filePath = STORE_PATH, now = () => Date.now() } = {}) {
        this._filePath = filePath;
        this._now = now;
        this._entries = new Map();
        if (existsSync(filePath)) {
            const parsed = JSON.parse(readFileSync(filePath, "utf8"));
            for (const [key, value] of Object.entries(parsed?.entries ?? {})) {
                if (Number.isInteger(value?.failures) && Number.isFinite(value?.blockedUntil)) {
                    this._entries.set(key, value);
                }
            }
        }
    }

    get(key) {
        const entry = this._entries.get(key) ?? { failures: 0, blockedUntil: 0 };
        if (entry.blockedUntil > 0 && entry.blockedUntil <= this._now()) {
            this._entries.delete(key);
            this._persist();
            return { failures: 0, blockedUntil: 0 };
        }
        return { ...entry };
    }

    recordFailure(key) {
        const previous = this.get(key);
        const failures = previous.failures + 1;
        const blockedUntil = failures >= 3 ? this._now() + LOCK_DURATION_MS : 0;
        const next = { failures, blockedUntil };
        this._entries.set(key, next);
        this._persist();
        return { ...next };
    }

    recordSuccess(key) {
        this._entries.delete(key);
        this._persist();
    }

    _persist() {
        mkdirSync(dirname(this._filePath), { recursive: true });
        const tempPath = `${this._filePath}.tmp`;
        const entries = Object.fromEntries(this._entries);
        writeFileSync(tempPath, JSON.stringify({ schemaVersion: 1, entries }, null, 2), "utf8");
        renameSync(tempPath, this._filePath);
    }

}
