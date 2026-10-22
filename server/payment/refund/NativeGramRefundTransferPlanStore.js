/**
 * Durable, immutable fee-plan reservation for a native Testnet GRAM refund.
 * No signing material, network calls, execution or payment acceptance.
 * A bound plan is NEVER replaced after a process restart or retry.
 */
import { createHash } from "node:crypto";
import {
    closeSync, existsSync, fsyncSync, linkSync, mkdirSync,
    openSync, readFileSync, unlinkSync, writeSync
} from "node:fs";
import { dirname, join } from "node:path";
import { tonAddressIdentityOrNull, tonAddressIdentitiesEqual } from "../incoming/TonAddressIdentity.js";

const ATOMIC = /^(0|[1-9][0-9]*)$/;
const EXPECTED = Object.freeze([
    "obligationId", "idempotencyKey", "networkName", "globalId",
    "sourceWalletAddress", "refundDestination", "originalPaidAmountAtomic",
    "refundAmountAtomic", "reservedFeeAtomic", "denomination",
    "sendRemainingBalance"
]);

function validate(plan) {
    if (!plan || typeof plan !== "object" || Array.isArray(plan) ||
        Object.keys(plan).length !== EXPECTED.length ||
        EXPECTED.some(key => !Object.prototype.hasOwnProperty.call(plan, key)) ||
        typeof plan.obligationId !== "string" || !plan.obligationId ||
        typeof plan.idempotencyKey !== "string" || !plan.idempotencyKey ||
        plan.networkName !== "TESTNET" || plan.globalId !== -3 ||
        plan.denomination !== "TON" || plan.sendRemainingBalance !== false ||
        tonAddressIdentityOrNull(plan.sourceWalletAddress) === null ||
        tonAddressIdentityOrNull(plan.refundDestination) === null ||
        tonAddressIdentitiesEqual(plan.sourceWalletAddress, plan.refundDestination) ||
        ![plan.originalPaidAmountAtomic, plan.refundAmountAtomic, plan.reservedFeeAtomic]
            .every(v => typeof v === "string" && ATOMIC.test(v)) ||
        BigInt(plan.refundAmountAtomic) <= 0n ||
        BigInt(plan.reservedFeeAtomic) <= 0n ||
        BigInt(plan.originalPaidAmountAtomic) !==
            BigInt(plan.refundAmountAtomic) + BigInt(plan.reservedFeeAtomic)) {
        throw new Error("INVALID_NATIVE_GRAM_REFUND_PLAN");
    }
    return Object.freeze(Object.fromEntries(EXPECTED.map(k => [k, plan[k]])));
}

function same(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

export class NativeGramRefundTransferPlanStore {
    constructor({ dataDir } = {}) {
        if (typeof dataDir !== "string" || !dataDir.trim())
            throw new Error("REFUND_PLAN_DATA_DIR_REQUIRED");
        this.directory = join(dataDir, "native-gram-refund-plans");
    }

    pathFor(obligationId) {
        if (typeof obligationId !== "string" || !obligationId)
            throw new Error("REFUND_PLAN_OBLIGATION_ID_REQUIRED");
        const digest = createHash("sha256").update(obligationId).digest("hex");
        return join(this.directory, digest + ".json");
    }

    get(obligationId) {
        const path = this.pathFor(obligationId);
        if (!existsSync(path)) return null;
        const plan = validate(JSON.parse(readFileSync(path, "utf8")));
        if (plan.obligationId !== obligationId) throw new Error("REFUND_PLAN_IDENTITY_CONFLICT");
        return plan;
    }

    reserve(input) {
        const plan = validate(input);
        const path = this.pathFor(plan.obligationId);
        mkdirSync(dirname(path), { recursive: true });
        const existing = this.get(plan.obligationId);
        if (existing) {
            if (!same(existing, plan)) throw new Error("REFUND_PLAN_ALREADY_RESERVED_WITH_DIFFERENT_TERMS");
            return Object.freeze({ replay: true, plan: existing });
        }
        // Publish complete fsynced content via an exclusive hard-link.
        // Another process cannot overwrite an existing immutable reservation.
        const temp = path + "." + createHash("sha256")
            .update(plan.idempotencyKey + ":" + process.pid + ":" + Math.random())
            .digest("hex") + ".tmp";
        const fd = openSync(temp, "wx", 0o600);
        try {
            writeSync(fd, JSON.stringify(plan) + "\n");
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
        try {
            linkSync(temp, path);
        } catch (error) {
            if (error?.code !== "EEXIST") throw error;
            const winner = this.get(plan.obligationId);
            if (!winner || !same(winner, plan))
                throw new Error("REFUND_PLAN_ALREADY_RESERVED_WITH_DIFFERENT_TERMS");
            return Object.freeze({ replay: true, plan: winner });
        } finally {
            try { unlinkSync(temp); } catch {}
        }
        // Directory fsync best effort; never authorize signing based on this
        // store alone. The executor must verify recovery and quote provenance.
        return Object.freeze({ replay: false, plan });
    }
}
