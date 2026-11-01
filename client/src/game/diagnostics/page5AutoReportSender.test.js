import assert from "node:assert/strict";
import { createPage5AutoReportSender } from "./page5AutoReportSender.js";

const calls=[];
let timer=null;
const listeners=new Map();
const identities={roomId:"RoomX",gameId:"game_X",playerId:"player_Olga"};
let serverReports=0,requests=0;
let uploaded=false;
const socket={
    connected:true,
    timeout(ms){assert.equal(ms,4000);return this;},
    emit(event,payload,callback){
        calls.push({event,payload});
        if(payload.event==="PAGE5_DEVICE_REPORT"){
            serverReports++;
            callback(null,{ok:true,received:3});
        }else if(payload.event==="PAGE5_DEVICE_REPORT_STATUS"){
            requests++;
            callback(null,{ok:true,uploaded,
                received:3,expected:3,
                archiveFilename:uploaded?"RoomX_COMPLETED.zip":null});
        }
    },
    on(event,fn){listeners.set(event,fn);},
    off(event,fn){if(listeners.get(event)===fn)listeners.delete(event);}
};
let tick=null;
const messages=[];
const sender=createPage5AutoReportSender({
    socket,...identities,
    reportProvider:()=>({...identities,schema:"wheelwin.page5-device-diagnostics.v1",
        events:[],buckets:[]}),
    onStatus:msg=>messages.push(msg),
    schedule:fn=>{tick=fn;timer=1;return timer;},
    unschedule:id=>{assert.equal(id,1);tick=null;timer=null;}
});
sender.start();
assert.equal(serverReports,1,"report auto uploads immediately upon Page6 mount");
assert.equal(requests,1,"server receipt is followed by R2 status query");
assert.equal(sender.getStatus().acknowledged,true);
assert.ok(messages.some(msg=>msg.includes("RECEIVED BY SERVER")));
assert.equal(calls[0].payload.event,"PAGE5_DEVICE_REPORT");
assert.equal(calls[0].payload.playerId,"player_Olga");
uploaded=true;
sender.tick();
assert.equal(serverReports,1,"never resubmit after server acknowledgement");
sender.dispose();
assert.equal(timer,null);
assert.equal(listeners.size,0);
assert.equal(sender.getStatus().disposed,true);
assert.ok(messages.length>0);

// A disconnected Telegram WebView retries only when connection resumes.
let attempts=0;
const disconnected={...socket,connected:false,
    emit(){attempts++;}};
const retry=createPage5AutoReportSender({
    socket:disconnected,...identities,
    reportProvider:()=>({...identities}),
    schedule:()=>11,unschedule:()=>{}
});
retry.start();
assert.equal(attempts,0);
disconnected.connected=true;
disconnected.emit=(event,payload,ack)=>{attempts++;ack(null,{ok:true,received:1});};
retry.tick();
// One report upload plus the immediate authenticated archive-status query.
assert.equal(attempts,2);
assert.equal(retry.getStatus().acknowledged,true);
retry.dispose();
console.log("page5AutoReportSender: all assertions passed");
