import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { purgeLocalForensicArchiveZips } from "../forensic/purgeLocalForensicArchiveZips.js";

test("owner-directed Railway purge removes every game ZIP but never financial data or R2", () => {
    const volume = mkdtempSync(join(tmpdir(),"wheelwin-zip-purge-test-"));
    try {
        const staging=join(volume,"r2-archive-staging");
        const original=join(staging,"room-old","first");
        const supplement=join(staging,"room-old-more","second");
        const ledgers=join(volume,"ton-financial","room-wallet-payments","testnet");
        const session=join(volume,"session-history");
        mkdirSync(original,{recursive:true}); mkdirSync(supplement,{recursive:true});
        mkdirSync(ledgers,{recursive:true}); mkdirSync(session,{recursive:true});
        const zip1=join(original,"2026-10-29_ROOM_raje_GAME_game-x_ROOM_DESTROYED.zip");
        const zip2=join(supplement,"2026-10-29_ROOM_raje_NO_GAME_ROOM_DESTROYED_FIN_abc.zip");
        const zip3=join(session,"2026-10-28_ROOM_other_COMPLETED.zip");
        writeFileSync(zip1,"one"); writeFileSync(zip2,"two"); writeFileSync(zip3,"three");
        const ledger=join(ledgers,"obligations.json");
        writeFileSync(ledger,JSON.stringify({refunds:[{state:"PENDING"}]}));
        const status=join(staging,"status.json");
        writeFileSync(status,JSON.stringify({roomId:"raje",state:"uploaded"}));
        const unrelated=join(volume,"manual-backup.zip"); writeFileSync(unrelated,"not a game archive");
        const info=[];
        const out=purgeLocalForensicArchiveZips({volumeRoot:volume,stagingDir:staging,
            applicationDataDir:join(volume,"other-data"),logger:{info:m=>info.push(m)}});
        assert.equal(out.deleted,3);
        assert.equal(out.failed,0);
        assert.equal(out.bytes,11);
        assert.deepEqual(readdirSync(original),[]);
        assert.deepEqual(readdirSync(supplement),[]);
        assert.deepEqual(JSON.parse(readFileSync(ledger,"utf8")).refunds,[{state:"PENDING"}]);
        assert.equal(JSON.parse(readFileSync(status,"utf8")).roomId,"raje");
        assert.equal(readFileSync(unrelated,"utf8"),"not a game archive");
        assert.match(info.join(" " ),/RAILWAY_FORENSIC_ZIP_PURGE/);
        const again=purgeLocalForensicArchiveZips({volumeRoot:volume,stagingDir:staging});
        assert.equal(again.deleted,0,"purge is idempotent across restarts");
    } finally {rmSync(volume,{recursive:true,force:true});}
});
