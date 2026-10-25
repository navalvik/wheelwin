import test from "node:test";
import assert from "node:assert/strict";
import {ActiveRoomObservationBudget, ACTIVE_ROOM_OBSERVATION_INTERVAL_MS} from "../../payment/runtime/ActiveRoomObservationBudget.js";

test("three player requests in one room result in exactly one chain check per interval",()=>{
    const b=new ActiveRoomObservationBudget();
    assert.equal(b.claim("gameA",100_000),true);
    assert.equal(b.claim("gameA",100_000),false);
    assert.equal(b.claim("gameA",104_000),false);
    assert.equal(b.claim("gameA",111_999),false);
    assert.equal(b.claim("gameA",112_000),true);
    assert.equal(ACTIVE_ROOM_OBSERVATION_INTERVAL_MS,12_000);
});
test("50 simultaneous active rooms cost <= 50 provider observations in 12s",()=>{
    const b=new ActiveRoomObservationBudget();
    let count=0;
    for(let tick=0;tick<12_000;tick+=4000){
        for(let room=0;room<50;room++){
            for(let player=0;player<3;player++){
                if(b.claim("room"+room,100_000+tick))count++;
            }
        }
    }
    assert.equal(count,50);
    for(let room=0;room<50;room++)assert.equal(b.claim("room"+room,112_000),true);
});
test("closing room forgets old budget and never blocks a new room",()=>{
    const b=new ActiveRoomObservationBudget();
    b.claim("old",100_000);
    b.forget("old");
    assert.equal(b.claim("old",101_000),true);
    assert.equal(b.claim("new",101_000),true);
    assert.equal(b.claim("",101_000),false);
});
