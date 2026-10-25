import test from "node:test";
import assert from "node:assert/strict";
import { deriveTestnetRoomPaymentRequirements } from "../../payment/runtime/deriveTestnetRoomPaymentRequirements.js";

const A = "0:"+"a".repeat(64);
const B = "0:"+"b".repeat(64);
const C = "0:"+"c".repeat(64);
const seats=["Olga","Lena","Bob"];
function profiles(stake=1) {
    return [
        {playerId:"Olga",baseStake:stake,sectorCount:1,wallet:A},
        {playerId:"Lena",baseStake:stake,sectorCount:2,wallet:B},
        {playerId:"Bob",baseStake:stake,sectorCount:1,wallet:C}
    ];
}
function build(p=profiles(),roster=seats,room="game-new-2") {
    return deriveTestnetRoomPaymentRequirements(room,roster,id=>p.find(x=>x.playerId===id));
}
test("3 player profiles generate immutable native Testnet transfers 1/2.5/1 GRAM",()=>{
    const pay=build();
    assert.equal(pay.length,3);
    assert.deepEqual(pay.map(x=>x.amountAtomic),[1_000_000_000,2_500_000_000,1_000_000_000]);
    assert.deepEqual(pay.map(x=>x.expectedSender),[A,B,C]);
    assert.equal(new Set(pay.map(x=>x.paymentReference)).size,3);
    assert.ok(pay.every(x=>Object.isFrozen(x)&&/^WW_[a-f0-9]{32}$/.test(x.paymentReference)));
    assert.ok(Object.isFrozen(pay));
});
test("10 GRAM base with two sectors requires exact 25 GRAM, not 10",()=>{
    assert.deepEqual(build(profiles(10)).map(x=>x.amountAtomic),[
        10_000_000_000,25_000_000_000,10_000_000_000
    ]);
});
test("reconnect produces same references; distinct room changes all refs",()=>{
    assert.deepEqual(build(),build());
    assert.notDeepEqual(build(),build(profiles(),seats,"another-room"));
});
test("invalid, absent, wrong-workchain wallet and mismatched stakes fail closed",()=>{
    const changed=[
        [{...profiles()[0],wallet:"not-ton"},profiles()[1],profiles()[2]],
        [{...profiles()[0],wallet:"-1:"+"a".repeat(64)},profiles()[1],profiles()[2]],
        [{...profiles()[0],baseStake:10},profiles()[1],profiles()[2]],
        [{...profiles()[0],sectorCount:3},profiles()[1],profiles()[2]],
        [{...profiles()[0],wallet:null},profiles()[1],profiles()[2]]
    ];
    for(const p of changed) assert.equal(build(p),null);
    assert.equal(build(profiles(),["Olga","Lena","Olga"]),null);
    assert.equal(build(profiles(),["Olga","Lena"]),null);
    assert.equal(build(profiles().slice(0,2)),null);
});
