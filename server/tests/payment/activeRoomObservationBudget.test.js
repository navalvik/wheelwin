import test from "node:test";
import assert from "node:assert/strict";
import {
    ActiveRoomObservationBudget,
    ACTIVE_ROOM_OBSERVATION_INTERVAL_MS,
    ACTIVE_ROOM_MAX_OBSERVATIONS_PER_SECOND
} from "../../payment/runtime/ActiveRoomObservationBudget.js";

test("three player requests in one room result in exactly one check per interval",()=>{
    const b=new ActiveRoomObservationBudget();
    assert.equal(b.claim("gameA",100_000),true);
    assert.equal(b.claim("gameA",100_000),false);
    assert.equal(b.claim("gameA",104_000),false);
    assert.equal(b.claim("gameA",111_999),false);
    assert.equal(b.claim("gameA",112_000),true);
    assert.equal(ACTIVE_ROOM_OBSERVATION_INTERVAL_MS,12_000);
});
test("50 simultaneous rooms never exceed six provider observations in one second",()=>{
    const budget=new ActiveRoomObservationBudget();
    const covered=new Set();
    const rateBySecond=new Map();
    for(let second=0;second<40 && covered.size<50;second++){
        let accepted=0;
        for(let room=0;room<50;room++){
            for(let player=0;player<3;player++){
                if(budget.claim("room"+room,100_000+second*1000)){
                    covered.add(room);
                    accepted++;
                }
            }
        }
        rateBySecond.set(second,accepted);
    }
    assert.equal(covered.size,50);
    assert.equal(ACTIVE_ROOM_MAX_OBSERVATIONS_PER_SECOND,6);
    assert.ok([...rateBySecond.values()].every(v=>v<=6));
    assert.equal(rateBySecond.get(0),6);
});
test("denied burst does not consume a room cadence",()=>{
    const budget=new ActiveRoomObservationBudget({maxPerSecond:1});
    assert.equal(budget.claim("first",100_000),true);
    assert.equal(budget.claim("second",100_000),false);
    assert.equal(budget.claim("second",101_000),true);
    assert.equal(budget.claim("second",101_001),false);
    assert.equal(budget.claim("second",113_000),true);
});
test("rolling rate cannot burst across a wall-clock second boundary",()=>{
    const budget=new ActiveRoomObservationBudget({maxPerSecond:2});
    assert.equal(budget.claim("a",100_999),true);
    assert.equal(budget.claim("b",100_999),true);
    assert.equal(budget.claim("c",101_000),false);
    assert.equal(budget.claim("c",101_999),true);
    assert.equal(budget.claim("d",101_999),true);
    assert.equal(budget.claim("e",102_000),false);
});

test("closing a room releases only its cadence, never the per-second provider budget",()=>{
    const b=new ActiveRoomObservationBudget({maxPerSecond:2});
    b.claim("old",100_000);
    b.forget("old");
    assert.equal(b.claim("old",100_000),true);
    assert.equal(b.claim("new",100_000),false);
    assert.equal(b.claim("new",101_000),true);
    assert.equal(b.claim("",101_000),false);
});
