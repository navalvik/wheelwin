import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { durableWriteJson } from '../DurableJson.js';
import { deriveIncomingTransactionId } from './IncomingTransferIdentity.js';
import { deriveTonAddressIdentity } from './TonAddressIdentity.js';

/** Durable receipts are independent of eligibility to play. No signing keys. */
export class IncomingReceiptStore {
    constructor({ dataDir }) { this.dir = join(dataDir, 'incoming-receipts'); this.records = new Map(); }
    initialize() {
        mkdirSync(this.dir, { recursive: true });
        this.records.clear();
        for (const name of readdirSync(this.dir).filter(n => n.endsWith('.json'))) {
            const record = JSON.parse(readFileSync(join(this.dir, name), 'utf8'));
            this.validate(record);
            if (name !== this.filename(record.transactionId)) throw new Error('RECEIPT_FILENAME_INVALID');
            this.records.set(record.transactionId, Object.freeze(record));
        }
    }
    filename(id) { return createHash('sha256').update(id).digest('hex') + '.json'; }
    validate(r) {
        if (r.schemaVersion !== 1 || r.network !== 'testnet' || r.asset !== 'TON'
            || r.transactionId !== deriveIncomingTransactionId({ network: r.network, providerId: 'toncenter',
                accountId: r.providerAccountId, transactionId: r.providerTransactionId })
            || !Number.isSafeInteger(r.amountAtomic) || r.amountAtomic <= 0
            || !Number.isSafeInteger(r.transactionTime)
            || (r.ownershipStatus === 'UNRESOLVED'
                ? (r.roomId !== null || !Array.isArray(r.candidateRoomIds))
                : !r.roomId)
            || !r.senderAddress || !r.destinationWalletAddress) throw new Error('RECEIPT_INVALID');
        deriveTonAddressIdentity(r.senderAddress);
        deriveTonAddressIdentity(r.destinationWalletAddress);
    }
    record(record) {
        this.validate(record);
        const path = join(this.dir, this.filename(record.transactionId));
        let existing = this.records.get(record.transactionId);
        if (!existing) {
            try { durableWriteJson(path, record, { exclusive: true }); }
            catch (error) {
                if (error.code !== 'EEXIST') throw error;
                existing = JSON.parse(readFileSync(path, 'utf8'));
            }
        }
        if (existing) {
            const normalizedExisting = existing.ownershipStatus == null
                ? { ...existing, ownershipStatus: 'RESOLVED' } : existing;
            if (JSON.stringify(normalizedExisting) === JSON.stringify(record)) {
                this.records.set(record.transactionId, Object.freeze(existing));
                return;
            }
            if (existing.ownershipStatus === 'UNRESOLVED' && record.ownershipStatus !== 'UNRESOLVED') {
                durableWriteJson(path, record);
                this.records.set(record.transactionId, Object.freeze(record));
                return;
            }
            if (record.ownershipStatus === 'UNRESOLVED' && existing.ownershipStatus === 'UNRESOLVED') {
                const merged = { ...existing,
                    candidateRoomIds: [...new Set([...(existing.candidateRoomIds ?? []), ...(record.candidateRoomIds ?? [])])],
                    unresolvedReasons: [...new Set([...(existing.unresolvedReasons ?? [existing.unresolvedReason].filter(Boolean)),
                        ...(record.unresolvedReasons ?? [record.unresolvedReason].filter(Boolean))])]
                };
                durableWriteJson(path, merged);
                this.records.set(record.transactionId, Object.freeze(merged));
                return;
            }
            if (record.ownershipStatus === 'UNRESOLVED' && existing.ownershipStatus !== 'UNRESOLVED') return;
            throw new Error('RECEIPT_IDENTITY_CONFLICT');
        }
        this.records.set(record.transactionId, Object.freeze(existing ?? record));
    }
    recordUnresolved(record) { this.record({ ...record, roomId: null, ownershipStatus: 'UNRESOLVED' }); }
    get(transactionId) { return this.records.get(transactionId) ?? null; }
    listForRoom(roomId) { return [...this.records.values()].filter(r => r.roomId === roomId); }
    listUnresolved() { return [...this.records.values()].filter(r => r.ownershipStatus === 'UNRESOLVED'); }
}
