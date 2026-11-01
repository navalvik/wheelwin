import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import {
    ClientPage5DeviceReportStore, PAGE5_DEVICE_REPORT_SCHEMA,
    PAGE5_DEVICE_REPORT_WAIT_MS, sanitizePage5DeviceReport
} from "../forensic/ClientPage5DeviceReportStore.js";
import { ForensicArchiveService } from "../forensic/ForensicArchiveService.js";
import { MockForensicArchiveUploader } from "../forensic/R2ForensicArchiveUploader.js";
import { evaluateFinalForensicArchive } from "../forensic/FinalForensicArchiveGate.js";

const roomId="RoomX",gameId="game_X";
const players=["player_Olga","player_Bob","player_Lena"];
function report(playerId) {
    return {
        schema:PAGE5_DEVICE_REPORT_SCHEMA,roomId,gameId,playerId,
        nickname:playerId.replace("player_",""),
        exportedAt:"2026-11-01T19:40:22Z",
        device:{platform:"Android",androidMajor:10,telegramVersion:"12",dpr:3,
            buildSha:"build123",telegramInitData:"PRIVATE"},
        metrics:{physicsReceived:1500,wheelPaints:300,privateKey:"private"},
        droppedEvents:0,
        buckets:[{second:1793562001000,physicsPackets:100,
            wheelPaints:30,firstSimulationTime:100,lastSimulationTime:1100,
            mnemonic:"SECRET"}],
        events:[{kind:"page6_rendered",wallMs:1793562019200,
            monoMs:14000,serverTimestamp:1793562019100,
            walletAddress:"SECRET",buttonEnabled:true}]
    };
}
function financialSnapshot() {
    return {
        roomId,gameId,network:"testnet",outstandingObligations:0,
        outcome:{kind:"PAYOUT"},
        intents:players.map(playerId=>({playerId,state:"SETTLED",amountAtomic:1000000000})),
        refunds:[],unresolvedReceipts:[],receipts:[],paymentObservations:[],
        paymentDecisions:[],ledger:[
            {kind:"PAYOUT_PLAN",metadata:{payoutId:"plan"}},
            {kind:"PAYOUT_SETTLEMENT",metadata:{payoutId:"plan",recipientId:"winner"}},
            {kind:"PAYOUT_SETTLEMENT",metadata:{payoutId:"plan",recipientId:"owner"}}
        ]
    };
}
function extractZipEntry(buffer,name) {
    let end = -1;
    for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65557);i--){
        if(buffer.readUInt32LE(i)===0x06054b50){end=i;break;}
    }
    assert.notEqual(end,-1,"ZIP final central directory");
    const count=buffer.readUInt16LE(end+10);
    let offset=buffer.readUInt32LE(end+16);
    for(let i=0;i<count;i++){
        const method=buffer.readUInt16LE(offset+10);
        const length=buffer.readUInt32LE(offset+20);
        const nameLength=buffer.readUInt16LE(offset+28);
        const extra=buffer.readUInt16LE(offset+30);
        const comment=buffer.readUInt16LE(offset+32);
        const local=buffer.readUInt32LE(offset+42);
        const entry=buffer.subarray(offset+46,offset+46+nameLength).toString();
        if(entry===name){
            const begin=local+30+buffer.readUInt16LE(local+26)+buffer.readUInt16LE(local+28);
            const bytes=buffer.subarray(begin,begin+length);
            return (method===8?inflateRawSync(bytes):bytes).toString();
        }
        offset+=46+nameLength+extra+comment;
    }
    throw Error("MISSING_ZIP_ENTRY:"+name);
}
function fixture({finishedAt=Date.now()}={}) {
    const root=mkdtempSync(join(tmpdir(),"wheelwin-page5-single-zip-"));
    const stagingDir=join(root,"staging"),sessionHistoryDir=join(root,"session-history");
    const diagnosticLogsDir=join(root,"logs");
    mkdirSync(sessionHistoryDir,{recursive:true});
    mkdirSync(diagnosticLogsDir,{recursive:true});
    const sessionRecord={roomId,gameId,finishedAt,lifecycleResult:"GAME_COMPLETED"};
    writeFileSync(join(sessionHistoryDir,
        "2026-11-01_ROOM_RoomX_GAME_game_X_COMPLETED.json"),
        JSON.stringify(sessionRecord));
    const config={enabled:true,required:true,bucket:"mock",prefix:"forensic-archives",
        stagingDir,sessionHistoryDir,diagnosticLogsDir,maxUploadAttempts:2};
    const store=new ClientPage5DeviceReportStore({stagingDir});
    const uploader=new MockForensicArchiveUploader();
    const service=new ForensicArchiveService({
        config,deviceReportStore:store,uploader,
        financialSnapshotProvider:financialSnapshot,
        sessionHistoryArchive:{listRecords:()=>({records:[sessionRecord]})},
        finalityChecker:(snapshot,{sessionRecord})=>
            evaluateFinalForensicArchive({snapshot,sessionRecord})
    });
    return {root,store,uploader,service,config,
        cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test("client device report strict authenticated identity, bounds and privacy",()=>{
    const clean=sanitizePage5DeviceReport({
        roomId,gameId,playerId:players[0],rawReport:report(players[0])
    });
    assert.equal(clean.ok,true);
    assert.equal(clean.report.device.telegramInitData,undefined);
    assert.equal(clean.report.metrics.privateKey,undefined);
    assert.equal(clean.report.buckets[0].mnemonic,undefined);
    assert.equal(clean.report.events[0].walletAddress,undefined);
    assert.equal(clean.report.events[0].buttonEnabled,true);
    assert.equal(clean.report.buckets[0].lastSimulationTime,1100);
    assert.equal(sanitizePage5DeviceReport({
        roomId,gameId,playerId:players[1],rawReport:report(players[0])
    }).reason,"IDENTITY_MISMATCH");
    assert.equal(sanitizePage5DeviceReport({
        roomId:"../bad",gameId,playerId:players[0],rawReport:report(players[0])
    }).reason,"INVALID_BINDING");
    assert.equal(sanitizePage5DeviceReport({
        roomId,gameId,playerId:players[0],
        rawReport:{...report(players[0]),events:Array.from({length:300},()=>({kind:"a"}))}
    }).reason,"INVALID_REPORT_SHAPE");
    assert.equal(sanitizePage5DeviceReport({
        roomId,gameId,playerId:players[0],
        rawReport:{...report(players[0]),oversize:"Z".repeat(200000)}
    }).reason,"REPORT_TOO_LARGE");
});
test("3 reports are durable, collected before a single immutable R2 ZIP",async()=>{
    const f=fixture();
    try {
        const request={roomId,gameId,reason:"game_completed"};
        const first=await f.service.ensureArchivedAndUploaded(request);
        assert.equal(first.skipped,true);
        assert.equal(first.reason,"PAGE5_DEVICE_REPORTS_PENDING");
        assert.equal(f.uploader.uploads.length,0);
        assert.equal(f.store.record({roomId,gameId,playerId:players[0],rawReport:report(players[0])}).received,1);
        assert.equal(f.store.record({roomId,gameId,playerId:players[0],rawReport:report(players[0])}).duplicate,true);
        assert.equal((await f.service.ensureArchivedAndUploaded(request)).skipped,true);
        assert.equal(f.store.record({roomId,gameId,playerId:players[1],rawReport:report(players[1])}).received,2);
        assert.equal((await f.service.ensureArchivedAndUploaded(request)).skipped,true);
        // Simulate restart of store: data is still staged as JSON, never ZIP.
        const reopened=new ClientPage5DeviceReportStore({stagingDir:f.config.stagingDir});
        assert.equal(reopened.snapshot(roomId,gameId).received,2);
        assert.equal(f.store.record({roomId,gameId,playerId:players[2],rawReport:report(players[2])}).received,3);
        assert.equal((await f.service.ensureArchivedAndUploaded(request)).uploaded,true);
        assert.equal(f.uploader.uploads.length,1);
        assert.equal(f.uploader.objects.size,1);
        const zip=f.uploader.uploads[0].bytes;
        const manifest=JSON.parse(extractZipEntry(zip,"forensics/page5-device-report-manifest.json"));
        assert.equal(manifest.complete,true);
        assert.equal(manifest.received,3);
        assert.equal(manifest.missing,0);
        for(const playerId of players){
            const d=JSON.parse(extractZipEntry(zip,
                "forensics/page5-device-reports/"+playerId+".json"));
            assert.equal(d.playerId,playerId);
            assert.equal(d.metrics.physicsReceived,1500);
            assert.equal(d.device.telegramInitData,undefined);
        }
        assert.equal(f.service.getUploadStatus(roomId,gameId).uploaded,true);
        assert.equal(f.service.getUploadStatus(roomId,gameId).received,3);
        assert.equal((await f.service.ensureArchivedAndUploaded(request)).uploaded,true);
        assert.equal(f.uploader.uploads.length,1,"no second R2 upload");
        const stagedZip=f.uploader.uploads[0].localPath;
        assert.equal(existsSync(stagedZip),false,"no R2 ZIP remains on Railway");
    } finally {f.cleanup();}
});
test("missing handset does not block FINAL financial ZIP beyond 90s",async()=>{
    const f=fixture({finishedAt:Date.now()-PAGE5_DEVICE_REPORT_WAIT_MS-1000});
    try {
        assert.equal(f.store.record({
            roomId,gameId,playerId:players[0],rawReport:report(players[0])
        }).ok,true);
        const result=await f.service.ensureArchivedAndUploaded({
            roomId,gameId,reason:"game_completed"
        });
        assert.equal(result.uploaded,true);
        const zip=f.uploader.uploads[0].bytes;
        const manifest=JSON.parse(extractZipEntry(zip,
            "forensics/page5-device-report-manifest.json"));
        assert.equal(manifest.received,1);
        assert.equal(manifest.missing,2);
        assert.equal(manifest.complete,false);
        assert.equal(f.uploader.uploads.length,1);
    } finally {f.cleanup();}
});
