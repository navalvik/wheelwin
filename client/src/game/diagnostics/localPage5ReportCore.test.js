import assert from "node:assert/strict";
import {
    createLocalPage5Report, LOCAL_REPORT_MAX_EVENTS,
    LOCAL_REPORT_MAX_BUCKETS, LOCAL_PAGE5_REPORT_SCHEMA
} from "./localPage5ReportCore.js";

let wall = 1793550000000;
let mono = 1000;
const service = createLocalPage5Report({
    now: () => wall,
    mono: () => mono
});
assert.equal(service.snapshot(), null);
assert.equal(service.recordEvent({kind:"page5_mount"}), false);
assert.equal(service.configure({
    roomId:"8JfK", gameId:"game_a", playerId:"player_olga", nickname:"Olga"
},{
    buildSha:"test-sha", platform:"Android", androidMajor:9,
    telegramVersion:"12.0", dpr:3, screenWidth:360,
    screenHeight:640, timeOriginMs:1793549999000
}), true);

service.recordEvent({kind:"page5_mount", rawWallet:"NEVER_EXPORT", reason:"mounted"});
service.recordSocket("GAME_CLOCK_UPDATE", {phase:"READY", remainingSeconds:4}, wall, mono);
service.recordSocket("GAME_STATE", {state:"SELF_TEST", serverTimestamp:wall-20}, wall, mono);
service.recordSocket("OPEN_PAGE6", {gameId:"game_a"}, wall, mono);
let snapshot=service.snapshot();
assert.equal(snapshot.schema, LOCAL_PAGE5_REPORT_SCHEMA);
assert.equal(snapshot.roomId,"8JfK");
assert.equal(snapshot.nickname,"Olga");
assert.ok(snapshot.events.some(x=>x.reason==="GAME_STATE"),"phase receipt never masked by clock");
assert.ok(snapshot.events.some(x=>x.reason==="OPEN_PAGE6"),"Page6 receipt never masked by clock");
assert.equal(JSON.stringify(snapshot).includes("NEVER_EXPORT"),false,"no arbitrary fields");

for (let i=0;i<30;i++){
   wall += 10; mono += 10;
   service.recordSocket("PHYSICS_UPDATE", {
     simulationTime:i*10, serverTimestamp:wall-25, privateKey:"SENSITIVE"
   },wall,mono);
   service.recordDispatch("PHYSICS_UPDATE",i===5?11.2:0.1,wall);
}
for(let i=0;i<12;i++){
    wall+=32;mono+=32;
    service.recordCanvas("wheel",i===6?23:3,wall);
    service.recordCanvas("pointer",2,wall);
}
service.recordStall(475);
service.recordEvent({kind:"page6_rendered",renderMs:mono});
snapshot=service.snapshot();
assert.equal(snapshot.metrics.physicsReceived,30);
assert.equal(snapshot.metrics.lastSimulationTime,290);
assert.equal(snapshot.metrics.physicsDispatchMaxMs,11.2);
assert.equal(snapshot.metrics.wheelPaints,12);
assert.equal(snapshot.metrics.pointerPaints,12);
assert.equal(snapshot.metrics.wheelPaintMaxMs,23);
assert.equal(snapshot.metrics.mainThreadStalls,1);
assert.ok(snapshot.metrics.page6ReceiveToRenderMs>0);
assert.equal(JSON.stringify(snapshot).includes("SENSITIVE"),false);
assert.ok(snapshot.buckets.some(x=>x.physicsPackets>0));
assert.ok(snapshot.events.some(x=>x.kind==="main_thread_stall"));
assert.ok(snapshot.metrics.physicsDispatchAverageMs>0);

const saved=JSON.parse(JSON.stringify(snapshot));
const restored=createLocalPage5Report({now:()=>wall+1000,mono:()=>mono+1000});
assert.equal(restored.hydrate(saved),true);
assert.equal(restored.snapshot().metrics.physicsReceived,30);
assert.equal(restored.snapshot().metrics.wheelPaints,12);
assert.equal(restored.snapshot().nickname,"Olga");
assert.equal(restored.hydrate({}),false);

assert.equal(restored.configure({
    roomId:"different",gameId:"game_b",playerId:"player_bob",nickname:"Bob"
}),true);
assert.equal(restored.snapshot().metrics.physicsReceived,0);
assert.equal(restored.snapshot().events.length,0);
assert.equal(restored.snapshot().roomId,"different");

// Never create an unbounded recording during an extended Page5.
const stress=createLocalPage5Report({now:()=>wall++,mono:()=>mono++});
stress.configure({roomId:"room",gameId:"game",playerId:"player"});
for(let i=0;i<600;i++){
    stress.recordEvent({kind:"phase_changed",phase:"SPEED"});
    stress.recordCanvas("wheel",2);
    stress.recordSocket("PHYSICS_UPDATE",{simulationTime:i*10},wall,mono);
}
assert.ok(stress.snapshot().events.length<=LOCAL_REPORT_MAX_EVENTS);
assert.ok(stress.snapshot().buckets.length<=LOCAL_REPORT_MAX_BUCKETS);
assert.ok(stress.snapshot().droppedEvents>0);
console.log("localPage5ReportCore: all assertions passed");
