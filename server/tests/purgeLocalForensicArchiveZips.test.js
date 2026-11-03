import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { purgeLocalForensicArchiveZips } from "../forensic/purgeLocalForensicArchiveZips.js";

test("Mainnet ZIP purge deletes only files with a confirmed non-empty R2 object", async () => {
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
        const out=await purgeLocalForensicArchiveZips({volumeRoot:volume,stagingDir:staging,
            temporaryRoot:join(volume,"tmp"), applicationDataDir:join(volume,"other-data"),
            verifyObject:async name=>name!=="2026-10-28_ROOM_other_COMPLETED.zip",
            logger:{info:m=>info.push(m)}});
        assert.equal(out.deleted,2);
        assert.equal(out.failed,0);
        assert.equal(out.unconfirmed,1);
        assert.equal(out.bytes,6);
        assert.deepEqual(readdirSync(original),[]);
        assert.deepEqual(readdirSync(supplement),[]);
        assert.equal(readFileSync(zip3,"utf8"),"three","unconfirmed R2 object keeps its local ZIP");
        assert.deepEqual(JSON.parse(readFileSync(ledger,"utf8")).refunds,[{state:"PENDING"}]);
        assert.equal(JSON.parse(readFileSync(status,"utf8")).roomId,"raje");
        assert.equal(readFileSync(unrelated,"utf8"),"not a game archive");
        assert.match(info.join(" " ),/RAILWAY_FORENSIC_ZIP_PURGE/);
        const again=await purgeLocalForensicArchiveZips({volumeRoot:volume,stagingDir:staging,
            temporaryRoot:join(volume,"tmp"),applicationDataDir:join(volume,"other-data"),
            verifyObject:async()=>true});
        assert.equal(again.deleted,1,"a later positive R2 check may safely remove a previously retained ZIP");
        assert.equal(existsSync(zip3),false);
    } finally {rmSync(volume,{recursive:true,force:true});}
});

test("unknown R2 state never deletes a local game ZIP", async t => {
    const volume=mkdtempSync(join(tmpdir(),"wheelwin-zip-unconfirmed-"));
    t.after(()=>rmSync(volume,{recursive:true,force:true}));
    const staging=join(volume,"r2-archive-staging");
    mkdirSync(staging,{recursive:true});
    const zip=join(staging,"2026-10-29_ROOM_CPGJ_COMPLETED.zip");
    writeFileSync(zip,"keep until R2 confirms");
    const result=await purgeLocalForensicArchiveZips({stagingDir:staging,
        volumeRoot:join(volume,"volume"),temporaryRoot:join(volume,"tmp"),
        applicationDataDir:join(volume,"app")});
    assert.equal(result.deleted,0);
    assert.equal(result.unconfirmed,1);
    assert.equal(readFileSync(zip,"utf8"),"keep until R2 confirms");
});
