import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { durableWriteJson } from './DurableJson.js';

function contextIdentity(context) {
    if (context == null) return null;
    return {
        roomId:context.roomId, gameId:context.gameId, payoutId:context.payoutId,
        winnerId:context.winnerId, winnerWallet:context.winnerWallet,
        ownerWallet:context.ownerWallet, principal:context.principal,
        roomWallet:{roomNumber:context.roomWallet?.roomNumber,
            walletId:context.roomWallet?.walletId, address:context.roomWallet?.address}
    };
}

/** One irreversible financial direction per room: prize OR refunds. */
export class FinancialOutcomeStore {
    constructor(dataDir) { this.directory = join(dataDir, 'financial-outcomes'); }
    path(roomId) { return join(this.directory, createHash('sha256').update(roomId).digest('hex') + '.json'); }
    get(roomId) {
        const path = this.path(roomId);
        if (!existsSync(path)) return null;
        const value = JSON.parse(readFileSync(path, 'utf8'));
        if (value.roomId !== roomId || !['PAYOUT','REFUND'].includes(value.kind)) throw new Error('FINANCIAL_OUTCOME_CORRUPT');
        return value;
    }
    list() {
        if (!existsSync(this.directory)) return [];
        return readdirSync(this.directory).filter(x => x.endsWith('.json')).map(name => {
            const record = JSON.parse(readFileSync(join(this.directory, name), 'utf8'));
            if (this.path(record.roomId) !== join(this.directory, name)) throw new Error('FINANCIAL_OUTCOME_CORRUPT');
            return this.get(record.roomId);
        });
    }
    claim(roomId, kind, context = null) {
        if (typeof roomId !== 'string' || !roomId || !['PAYOUT','REFUND'].includes(kind)) throw new Error('FINANCIAL_OUTCOME_INVALID');
        try { durableWriteJson(this.path(roomId), {roomId, kind, context, network:'testnet'}, {exclusive:true}); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        const value = this.get(roomId);
        if (value.kind !== kind || JSON.stringify(contextIdentity(value.context)) !== JSON.stringify(contextIdentity(context))) throw new Error('FINANCIAL_OUTCOME_CONFLICT');
        return value;
    }
}
