import assert from "node:assert/strict";
import { SocketGateway } from "../socket/SocketGateway.js";
import { ClientPage5DeviceReportStore, PAGE5_DEVICE_REPORT_SCHEMA }
    from "../forensic/ClientPage5DeviceReportStore.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root=mkdtempSync(join(tmpdir(),"wheelwin-page5-socket-"));
try {
    const store=new ClientPage5DeviceReportStore({stagingDir:root});
    const gateway=Object.create(SocketGateway.prototype);
    let finalized=false;
    let archiveCalls=0;
    gateway._gameplayContextResolver={
        resolve:id=>id === "auth_socket"
            ? {ok:true,roomId:"Abc",gameId:"game_1",playerId:"player_Olga"}
            : {ok:false,reason:"NO_BINDING"}
    };
    gateway._resultSessionLifecycle={isActive:room=>room==="Abc"};
    gateway._clientPage5ReportStore=store;
    gateway._forensicArchiveService={
        getUploadStatus:()=>({uploaded:finalized,
            archiveFilename:finalized?"Abc_COMPLETED.zip":null,
            received:store.snapshot("Abc","game_1").received,
            expected:3}),
        ensureArchivedAndUploaded:async()=>{archiveCalls++;}
    };
    const input={event:"PAGE5_DEVICE_REPORT",roomId:"Abc",
        gameId:"game_1",playerId:"player_Olga",
        report:{schema:PAGE5_DEVICE_REPORT_SCHEMA,
            roomId:"Abc",gameId:"game_1",playerId:"player_Olga",
            device:{platform:"Android",mnemonic:"DO_NOT_KEEP"},
            metrics:{physicsReceived:100},events:[],buckets:[]}};
    const recv=(socketId,payload)=>{
        let ack=null;
        gateway._handlePage6ClientDiag({id:socketId},payload,result=>{ack=result;});
        return ack;
    };
    assert.equal(recv("unauth",input).reason,"BINDING_MISMATCH");
    assert.equal(recv("auth_socket",{...input,roomId:"other"}).reason,"BINDING_MISMATCH");
    assert.equal(recv("auth_socket",{...input,playerId:"player_Bob"}).reason,"BINDING_MISMATCH");
    assert.equal(store.snapshot("Abc","game_1").received,0);
    assert.equal(recv("auth_socket",input).ok,true);
    assert.equal(recv("auth_socket",input).duplicate,true);
    assert.equal(store.snapshot("Abc","game_1").received,1);
    assert.equal(store.readPlayer("Abc","game_1","player_Olga").device.mnemonic,undefined);
    assert.equal(recv("auth_socket",{...input,event:"PAGE5_DEVICE_REPORT_STATUS"}).received,1);
    assert.equal(recv("unauth",{...input,event:"PAGE5_DEVICE_REPORT_STATUS"}).reason,
        "BINDING_MISMATCH");
    assert.equal(archiveCalls,0,"archive waits for three independent reports");
    gateway._resultSessionLifecycle={isActive:()=>false};
    assert.equal(recv("auth_socket",{
        ...input,playerId:"player_Olga"
    }).reason,"RESULT_SESSION_NOT_ACTIVE");
    gateway._resultSessionLifecycle={isActive:()=>true};
    finalized=true;
    assert.equal(recv("auth_socket",input).reason,"ARCHIVE_ALREADY_FINAL");
    assert.equal(recv("auth_socket",{...input,event:"PAGE5_DEVICE_REPORT_STATUS"}).uploaded,true);
    assert.equal(archiveCalls,0);
} finally {
    rmSync(root,{recursive:true,force:true});
}
console.log("page5DeviceReportSocket: all assertions passed");
