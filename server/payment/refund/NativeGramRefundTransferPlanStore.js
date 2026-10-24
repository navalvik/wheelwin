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
import { walletV4SignedBodyHash } from "./WalletV4SignedPayloadSignature.js";
import { decodeWalletV4NativeRefundBody } from "./WalletV4NativeRefundDecoder.js";

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
        if (process.platform !== "win32") {
            const directory = openSync(this.directory, "r");
            try { fsyncSync(directory); } finally { closeSync(directory); }
        }
        // Windows directory durability must be validated before any live use.
        // This reservation never turns an advisory quote into fee assurance.
        return Object.freeze({ replay: false, plan });
    }

    getSignedMessage(obligationId) {
        const path = this.pathFor(obligationId) + ".signed";
        if (!existsSync(path)) return null;
        const record = JSON.parse(readFileSync(path, "utf8"));
        const plan = this.get(obligationId);
        const keys = ["obligationId", "idempotencyKey", "sourceWalletAddress", "signedBodyHash", "seqno", "walletId", "validUntil"];
        if (!plan || Object.keys(record).length !== keys.length || keys.some(key => !(key in record)) ||
            record.obligationId !== obligationId || record.idempotencyKey !== plan.idempotencyKey ||
            record.sourceWalletAddress !== plan.sourceWalletAddress ||
            !/^[a-f0-9]{64}$/.test(record.signedBodyHash) ||
            ![record.seqno, record.walletId, record.validUntil].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff))
            throw Error("REFUND_SIGNED_MESSAGE_INVALID");
        return Object.freeze(record);
    }

    /** Called only after independent decoding AND signature verification.
     * Publish once before broadcast. A replay is a hold, never permission to
     * broadcast again. Store public identity only, not a spendable signed BOC.
     */
    reserveSignedMessage(obligationId, boc) {
        const plan = this.get(obligationId);
        if (!plan) throw Error("REFUND_PLAN_MISSING");
        const bytes = Buffer.from(boc, "base64");
        const parsed = decodeWalletV4NativeRefundBody(bytes);
        if (parsed.amountAtomic !== plan.refundAmountAtomic || !tonAddressIdentitiesEqual(parsed.to, plan.refundDestination))
            throw Error("REFUND_SIGNED_MESSAGE_PLAN_MISMATCH");
        const record = Object.freeze({
            obligationId, idempotencyKey: plan.idempotencyKey,
            sourceWalletAddress: plan.sourceWalletAddress,
            signedBodyHash: walletV4SignedBodyHash(bytes), seqno: parsed.seqno,
            walletId: parsed.walletId, validUntil: parsed.validUntil
        });
        const path = this.pathFor(obligationId) + ".signed";
        const temp = path + "." + createHash("sha256").update(process.pid + ":" + Math.random()).digest("hex") + ".tmp";
        const fd = openSync(temp, "wx", 0o600);
        try { writeSync(fd, JSON.stringify(record) + "\n"); fsyncSync(fd); }
        finally { closeSync(fd); }
        try { linkSync(temp, path); }
        catch (error) {
            if (error?.code !== "EEXIST") throw error;
            throw Error("REFUND_SIGNED_MESSAGE_ALREADY_RESERVED");
        } finally { unlinkSync(temp); }
        if (process.platform !== "win32") {
            const directory = openSync(this.directory, "r");
            try { fsyncSync(directory); } finally { closeSync(directory); }
        }
        return record;
    }
}
