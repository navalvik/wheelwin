/**
 * Exclusive Room Wallet signing gate backed by an ATOMIC mkdir on the SAME
 * durable shared filesystem used for financial records. Never uses a TTL.
 *
 * A blocked signer must never auto-steal a lock merely because its original
 * process disappeared. Only an intent with immutable CHAIN_CONFIRMED evidence
 * can release the physical lock. This deliberately prioritizes no duplicate
 * money transfers over room-wallet availability.
 *
 * Not suitable for isolated Railway replicas with independent volumes:
 * all potential signers MUST share a single filesystem with atomic mkdir.
 * Rolling multi-writer deployments require a distributed fencing lock.
 */
import { createHash, randomUUID } from "node:crypto";
import {
    mkdirSync, writeFileSync, readFileSync, unlinkSync, rmdirSync,
    openSync, fsyncSync, closeSync, realpathSync, statSync, readdirSync
} from "node:fs";
import { join, resolve } from "node:path";
import { Address } from "@ton/core";

export class RoomWalletSignerGateError extends Error {
    constructor(code) {
        super(code);
        this.name = "RoomWalletSignerGateError";
        this.code = code;
    }
}
function ensure(test, code) {
    if (!test) throw new RoomWalletSignerGateError(code);
}
function rawAddress(address) {
    try {
        const result = Address.parse(address);
        ensure(result.workChain === 0, "SIGNER_GATE_INVALID_WORKCHAIN");
        return result.toRawString().toLowerCase();
    } catch (error) {
        if (error instanceof RoomWalletSignerGateError) throw error;
        throw new RoomWalletSignerGateError("SIGNER_GATE_INVALID_ADDRESS");
    }
}
function lockName(address) {
    return createHash("sha256").update(rawAddress(address)).digest("hex");
}
function syncDirectory(dir) {
    const descriptor = openSync(dir, "r");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

export class RoomWalletSingleWriterGate {
    constructor({ directory, intentJournal } = {}) {
        ensure(typeof directory === "string" && directory.trim() !== "",
            "SIGNER_GATE_DIRECTORY_REQUIRED");
        ensure(typeof intentJournal?.load === "function",
            "SIGNER_GATE_JOURNAL_REQUIRED");
        this._directory = resolve(directory);
        this._journal = intentJournal;
        // Must live on a persistent Railway volume, NOT /tmp. Fail closed if
        // the named lock directory cannot be created or read.
        mkdirSync(this._directory, { recursive: true, mode: 0o700 });
        this._directory = realpathSync(this._directory);
    }

    acquire({ intentId } = {}) {
        ensure(typeof intentId === "string" && /^rwout_[0-9a-f]{64}$/.test(intentId),
            "SIGNER_GATE_INTENT_REQUIRED");
        const intent = this._journal.load(intentId);
        ensure(intent.status === "ACTIVE" && intent.payload?.state === "PLANNED"
            && intent.payload?.network === "testnet",
            "SIGNER_GATE_NOT_FRESH_PLAN");
        const address = rawAddress(intent.payload.roomWallet);
        const dir = join(this._directory, lockName(address));
        const ownerToken = randomUUID();
        const meta = {
            kind: "ROOM_WALLET_EXCLUSIVE_SIGNER",
            intentId,
            roomWallet: address,
            ownerToken,
            createdAt: Date.now()
        };
        try {
            mkdirSync(dir, { mode: 0o700 }); // exclusive, atomic across processes
        } catch (error) {
            if (error?.code === "EEXIST") {
                throw new RoomWalletSignerGateError("SIGNER_GATE_WALLET_ALREADY_LOCKED");
            }
            throw new RoomWalletSignerGateError("SIGNER_GATE_STORAGE_UNAVAILABLE");
        }
        try {
            const file = join(dir, "owner.json");
            const fd = openSync(file, "wx", 0o600);
            try {
                writeFileSync(fd, JSON.stringify(meta) + "\n", "utf8");
                fsyncSync(fd);
            } finally { closeSync(fd); }
            syncDirectory(dir);
            syncDirectory(this._directory);
        } catch {
            // DO NOT remove the directory on metadata write failure. Another
            // process may have observed the lock; a durable marker must remain.
            throw new RoomWalletSignerGateError("SIGNER_GATE_METADATA_WRITE_FAILED");
        }
        return Object.freeze({ intentId, roomWallet: address, ownerToken });
    }

    assertOwnership({ intentId, ownerToken } = {}) {
        const intent = this._journal.load(intentId);
        const address = rawAddress(intent.payload.roomWallet);
        const meta = this._readByAddress(address);
        ensure(meta !== null && meta.intentId === intentId
            && typeof ownerToken === "string" && meta.ownerToken === ownerToken,
            "SIGNER_GATE_OWNERSHIP_LOST");
        ensure(meta.roomWallet === address,
            "SIGNER_GATE_ADDRESS_CONFLICT");
        return true;
    }

    /**
     * Safe pre-broadcast unwind: only the same live owner of the exclusive
     * lock may release it, and only while the durable intent is still PLANNED
     * with absolutely no persisted signed hash/seqno.
     *
     * Never callable from restart recovery: the ownerToken must be passed
     * by the actual task which failed BEFORE holdSignedMessage(). No stale
     * expiry and no recovery-time lock stealing.
     */
    releaseUnattempted({ intentId, ownerToken } = {}) {
        ensure(typeof ownerToken === "string" && ownerToken.length > 0,
            "SIGNER_GATE_OWNERSHIP_LOST");
        const intent = this._journal.load(intentId);
        const p = intent.payload;
        ensure(intent.status === "ACTIVE"
            && p.state === "PLANNED"
            && p.signedExternalMessageHash == null
            && p.seqno == null,
            "SIGNER_GATE_UNATTEMPTED_PROOF_FAILED");
        this.assertOwnership({ intentId, ownerToken });
        const dir = join(this._directory, lockName(p.roomWallet));
        try {
            unlinkSync(join(dir, "owner.json"));
            rmdirSync(dir);
            syncDirectory(this._directory);
        } catch {
            throw new RoomWalletSignerGateError("SIGNER_GATE_CLEANUP_INCOMPLETE");
        }
        return Object.freeze({ released: true, intentId, beforeBroadcast: true });
    }

    /**
     * The ONLY release path: intent was finalized with an on-chain transaction
     * proven by two independent providers and an authoritative seqno advance.
     * Recovery after a crash may call it with no token, but ONLY for the same
     * immutable CHAIN_CONFIRMED intent.
     */
    releaseConfirmed({ intentId, ownerToken = null } = {}) {
        const intent = this._journal.load(intentId);
        ensure(intent.status === "SETTLED"
            && intent.payload.state === "CHAIN_CONFIRMED"
            && intent.payload.chainReceipt?.walletTxHash,
            "SIGNER_GATE_CHAIN_PROOF_NOT_FINAL");
        const address = rawAddress(intent.payload.roomWallet);
        const dir = join(this._directory, lockName(address));
        const existing = this._readByAddress(address);
        ensure(existing !== null && existing.intentId === intentId,
            "SIGNER_GATE_LOCK_IDENTITY_MISMATCH");
        if (ownerToken != null) {
            ensure(existing.ownerToken === ownerToken, "SIGNER_GATE_OWNERSHIP_LOST");
        }
        // A signed hold must never be manually cleared by mistake. Physical
        // lease cleanup cannot authorize another payment; the next intent
        // must also satisfy the journal's transaction finality checks.
        try {
            unlinkSync(join(dir, "owner.json"));
            rmdirSync(dir);
            syncDirectory(this._directory);
        } catch {
            throw new RoomWalletSignerGateError("SIGNER_GATE_CLEANUP_INCOMPLETE");
        }
        return Object.freeze({ released: true, intentId, roomWallet: address });
    }

    isLocked(walletAddress) {
        const dir = join(this._directory, lockName(walletAddress));
        try {
            // Fail closed when an interrupted acquire left a directory without
            // parseable owner.json. It is still an exclusive lock.
            const meta = this._readByAddress(walletAddress);
            if (meta !== null) return true;
            return statSync(dir).isDirectory();
        } catch (error) {
            if (error?.code === "ENOENT") return false;
            // A filesystem problem must never look like an available wallet.
            return true;
        }
    }

    /**
     * Recovery of the extremely narrow crash window AFTER journal finality
     * was persisted but BEFORE the filesystem signer lock was removed.
     *
     * In-flight, uncertain, missing and corrupt records remain LOCKED. This
     * is never a TTL/restart-based lock release.
     */
    recoverConfirmedLocks({ maxLocks = 256 } = {}) {
        ensure(Number.isInteger(maxLocks) && maxLocks >= 1 && maxLocks <= 256,
            "SIGNER_GATE_RECOVERY_LIMIT_INVALID");
        const entries = readdirSync(this._directory, { withFileTypes: true })
            .filter(entry => entry.isDirectory());
        ensure(entries.length <= maxLocks, "SIGNER_GATE_RECOVERY_LIMIT_EXCEEDED");
        let released = 0;
        let stillHeld = 0;
        let failed = 0;
        for (const entry of entries) {
            try {
                const dir = join(this._directory, entry.name);
                const metadata = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8"));
                ensure(metadata?.kind === "ROOM_WALLET_EXCLUSIVE_SIGNER"
                    && /^[0-9a-f]{64}$/.test(entry.name)
                    && typeof metadata?.roomWallet === "string"
                    && typeof metadata?.intentId === "string"
                    && entry.name === lockName(metadata.roomWallet),
                    "SIGNER_GATE_RECOVERY_METADATA_INVALID");
                const record = this._journal.load(metadata.intentId);
                if (record.status === "SETTLED"
                    && record.payload?.state === "CHAIN_CONFIRMED"
                    && record.payload?.roomWallet === rawAddress(metadata.roomWallet)
                    && record.payload?.chainReceipt?.walletTxHash) {
                    this.releaseConfirmed({ intentId: metadata.intentId });
                    released++;
                } else {
                    stillHeld++;
                }
            } catch {
                // Never remove or ignore an unreadable/corrupted lock.
                failed++;
            }
        }
        return Object.freeze({
            inspected: entries.length, released, stillHeld, failed
        });
    }

    _readByAddress(address) {
        const dir = join(this._directory, lockName(address));
        try {
            const data = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8"));
            ensure(data?.kind === "ROOM_WALLET_EXCLUSIVE_SIGNER"
                && data?.roomWallet === rawAddress(address)
                && /^rwout_[0-9a-f]{64}$/.test(String(data.intentId))
                && typeof data.ownerToken === "string",
                "SIGNER_GATE_LOCK_CORRUPTED");
            return data;
        } catch (error) {
            if (error?.code === "ENOENT") return null;
            if (error instanceof RoomWalletSignerGateError) throw error;
            throw new RoomWalletSignerGateError("SIGNER_GATE_LOCK_READ_FAILED");
        }
    }
}
