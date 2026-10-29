import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForensicArchiveService } from "../forensic/ForensicArchiveService.js";
import { MockForensicArchiveUploader } from "../forensic/R2ForensicArchiveUploader.js";
import { evaluateFinalForensicArchive, FINAL_ARCHIVE_CHAIN_SETTLEMENT_GRACE_MS } from "../forensic/FinalForensicArchiveGate.js";

const clock = 2_000_000;
const closedAt = clock-2*FINAL_ARCHIVE_CHAIN_SETTLEMENT_GRACE_MS;
const completeRefund = id => ({obligationId:id,state:"COMPLETE",finalizedEvidence:{finalized:true,transactionId:"tx-"+id}});
const original = () => ({
    schemaVersion:1,network:"testnet",globalId:-3,roomId:"room-final",
    closedRoom:{roomId:"room-final",closureReason:"setup_expired",closedAtMs:closedAt},
    outcome:{kind:"REFUND"},intents:[
        {playerId:"olga",state:"PENDING"},{playerId:"bob",state:"PENDING"},{playerId:"lena",state:"PENDING"}
    ],ledger:[],refunds:[],receipts:[],unresolvedReceipts:[],
    paymentObservations:[],paymentDecisions:[],outstandingObligations:0
});
const checked = () => ({source:"FINAL_FORENSIC_HISTORY_COVERAGE",
    completedAt:clock-1,resultWindowComplete:true,providerError:null,
    candidateCount:0,checkedCount:0,pendingCount:0});

test("final ZIP waits until all three refunds are finalized AND post-close history is complete", () => {
    const snapshot=original();
    assert.equal(evaluateFinalForensicArchive({snapshot,nowMs:clock}).ready,false);
    snapshot.paymentObservations.push(checked());
    snapshot.refunds.push(completeRefund("olga"),completeRefund("bob"),{state:"SUBMISSION_UNKNOWN"});
    assert.equal(evaluateFinalForensicArchive({snapshot,nowMs:clock}).ready,false);
    snapshot.refunds[2]=completeRefund("lena");
    assert.equal(evaluateFinalForensicArchive({snapshot,nowMs:clock}).ready,true);
    assert.equal(evaluateFinalForensicArchive({snapshot,nowMs:closedAt+1}).ready,false);
    snapshot.unresolvedReceipts.push({transactionId:"ambiguous"});
    assert.equal(evaluateFinalForensicArchive({snapshot,nowMs:clock}).ready,false);
});

test("nonfinalized or incomplete historical incoming observations block the one final ZIP", () => {
    const snapshot=original();
    for(const evidence of [
        {resultWindowComplete:false,providerError:"HTTP_429",candidateCount:0,checkedCount:0,pendingCount:0},
        {resultWindowComplete:true,providerError:null,candidateCount:5,checkedCount:3,pendingCount:0},
        {resultWindowComplete:true,providerError:null,candidateCount:1,checkedCount:1,pendingCount:1},
    ]) {
        snapshot.paymentObservations=[{source:"FINAL_FORENSIC_HISTORY_COVERAGE",completedAt:clock-1,...evidence}];
        assert.equal(evaluateFinalForensicArchive({snapshot,nowMs:clock}).ready,false);
    }
    snapshot.paymentObservations=[checked()];
    snapshot.outstandingObligations=1;
    assert.equal(evaluateFinalForensicArchive({snapshot,nowMs:clock}).ready,false);
});

test("payout game requires 3 settled stakes and both winner/owner settlements", () => {
    const snapshot={...original(),closedRoom:null,outcome:{kind:"PAYOUT"},
        intents:[{state:"SETTLED"},{state:"SETTLED"},{state:"SETTLED"}],
        ledger:[{kind:"PAYOUT_PLAN"},{kind:"PAYOUT_SETTLEMENT"}]};
    assert.equal(evaluateFinalForensicArchive({snapshot}).ready,false);
    snapshot.ledger.push({kind:"PAYOUT_SETTLEMENT"});
    assert.equal(evaluateFinalForensicArchive({snapshot}).ready,true);
    snapshot.outstandingObligations=1;
    assert.equal(evaluateFinalForensicArchive({snapshot}).ready,false);
});

test("one game creates no preliminary ZIP and sends exactly one final ZIP", async () => {
    const root=mkdtempSync(join(tmpdir(),"wheelwin-one-final-"));
    try {
        const stagingDir=join(root,"staging"),sessionHistoryDir=join(root,"history"),
            diagnosticLogsDir=join(root,"logs");
        mkdirSync(sessionHistoryDir);mkdirSync(diagnosticLogsDir);
        writeFileSync(join(sessionHistoryDir,
            "2026-10-30_01-00-00_ROOM_room-final_GAME_game-final_ROOM_DESTROYED.json"),
            JSON.stringify({roomId:"room-final",gameId:"game-final",lifecycleResult:"ROOM_DESTROYED"}));
        let snapshot=original();
        const uploader=new MockForensicArchiveUploader();
        const service=new ForensicArchiveService({
            config:{enabled:true,required:true,bucket:"mock",prefix:"forensic-archives",
                stagingDir,sessionHistoryDir,diagnosticLogsDir,maxUploadAttempts:2},
            uploader,financialSnapshotProvider:()=>snapshot,
            finalityChecker:finance=>evaluateFinalForensicArchive({snapshot:finance,nowMs:clock})
        });
        const request={roomId:"room-final",gameId:"game-final",reason:"setup_expired"};
        const pending=await service.ensureArchivedAndUploaded(request);
        assert.equal(pending.skipped,true);
        assert.equal(uploader.uploads.length,0,"R2 has no incomplete archive");
        assert.deepEqual(readdirSync(stagingDir),["room-final"]);
        snapshot={...snapshot,refunds:[completeRefund("olga"),completeRefund("bob"),completeRefund("lena")],
            paymentObservations:[checked()]};
        const result=await service.ensureArchivedAndUploaded(request);
        assert.equal(result.uploaded,true);
        assert.equal(uploader.uploads.length,1);
        assert.equal(uploader.objects.size,1);
        assert.ok(uploader.uploads[0].bytes.subarray(0,2).equals(Buffer.from("PK")));
        // No later changes or retries are allowed to replace the committed archive.
        snapshot={...snapshot,refunds:[...snapshot.refunds,{state:"SUBMISSION_UNKNOWN"}]};
        const replay=await service.ensureArchivedAndUploaded(request);
        assert.equal(replay.uploaded,true);
        assert.equal(uploader.uploads.length,1,"the one final ZIP must NEVER be uploaded twice");
        const restarted=new ForensicArchiveService({
            config:{enabled:true,required:true,bucket:"mock",prefix:"forensic-archives",
                stagingDir,sessionHistoryDir,diagnosticLogsDir,maxUploadAttempts:2},
            uploader,financialSnapshotProvider:()=>snapshot,
            finalityChecker:finance=>evaluateFinalForensicArchive({snapshot:finance,nowMs:clock})
        });
        await restarted.ensureArchivedAndUploaded(request);
        assert.equal(uploader.uploads.length,1,"Railway restart cannot cause another R2 upload");
    } finally {rmSync(root,{recursive:true,force:true});}
});

test("final-only R2 uploads fail closed on a previously committed different revision", async () => {
    const root=mkdtempSync(join(tmpdir(),"wheelwin-final-conflict-"));
    try{
        const file=join(root,"game.zip");writeFileSync(file,"testing");
        const uploader=new MockForensicArchiveUploader();
        await uploader.uploadFile(file,"one-room.zip",{revision:"aaaaaaaaaaaaaaaaaaaaaaaa",final:true});
        await assert.rejects(
            uploader.uploadFile(file,"one-room.zip",{revision:"bbbbbbbbbbbbbbbbbbbbbbbb",final:true}),
            /R2_FINAL_ARCHIVE_CONFLICT/);
        assert.equal(uploader.uploads.length,1);
        assert.equal(uploader.objects.size,1);
    } finally {rmSync(root,{recursive:true,force:true});}
});
