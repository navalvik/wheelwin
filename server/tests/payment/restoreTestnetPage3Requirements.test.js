import test from "node:test";
import assert from "node:assert/strict";
import { deriveTestnetRoomPaymentRequirements } from "../../payment/runtime/deriveTestnetRoomPaymentRequirements.js";
import { RoomLobbyBridge } from "../../socket/RoomLobbyBridge.js";

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

test("wallet 1 with historical oj7v funds is excluded without shrinking 64 wallet catalog",async t=>{
    const [{mkdtempSync,writeFileSync,rmSync},{tmpdir},{join},{WalletPoolRegistry}]=await Promise.all([
        import("node:fs"), import("node:os"),import("node:path"),
        import("../../payment/WalletPoolRegistry.js")
    ]);
    const dir=mkdtempSync(join(tmpdir(),"wheelwin-wallet-1-quarantine-"));
    const previous=process.env.ROOM_WALLET_QUARANTINED_NUMBERS;
    t.after(()=>{
        if(previous===undefined)delete process.env.ROOM_WALLET_QUARANTINED_NUMBERS;
        else process.env.ROOM_WALLET_QUARANTINED_NUMBERS=previous;
        rmSync(dir,{force:true,recursive:true});
    });
    const catalog=join(dir,"catalog.json");
    writeFileSync(catalog,JSON.stringify(Array.from({length:64},(_,i)=>({
        roomNumber:i+1, walletId:"wallet-"+(i+1),
        address:"0:"+(i+1).toString(16).padStart(64,"0"),
        workchain:0,network:"testnet"
    }))));
    const pool=new WalletPoolRegistry({catalogPath:catalog,network:"testnet"});
    pool.initialize();
    delete process.env.ROOM_WALLET_QUARANTINED_NUMBERS;
    // Wallet #1 remains quarantined even if Railway loses its variable.
    assert.equal(pool.getAvailableCount(),63);
    assert.throws(()=>pool.reserve({roomId:"missing-env",walletId:"wallet-1"}),{
        name:"WalletAssignmentConflictError"
    });
    process.env.ROOM_WALLET_QUARANTINED_NUMBERS="1";
    assert.equal(pool.size,64);
    assert.equal(pool.getAvailableCount(),63);
    assert.equal(pool.listAvailableWallets().length,63);
    const reservation=pool.reserve({roomId:"new-room",network:"testnet"});
    assert.equal(reservation.wallet.roomNumber,2);
    assert.throws(()=>pool.reserve({roomId:"cannot-use-old-wallet",walletId:"wallet-1"}),{
        name:"WalletAssignmentConflictError"
    });
});

test("actual Page3 socket profile handler records only the payer address before VERIFY_NEXT",()=>{
    const changed=[], errors=[];
    const fake={
        _assertAuthoritativeMutation:()=>({roomId:"room-1",playerId:"Olga"}),
        _roomManager:{getRoom:()=>({players:["Olga","Lena","Bob"]})},
        _playerManager:{updateIdentity:(id,patch)=>changed.push({id,patch})},
        _continueToVerifyByRoom:new Set(),
        _emitRoomError:(id,code)=>errors.push({id,code})
    };
    RoomLobbyBridge.prototype._handleUpdatePlayerProfile.call(fake,"socket-olga",{wallet:A});
    assert.deepEqual(changed,[{id:"Olga",patch:{wallet:A}}]);
    assert.equal(errors.length,0);
    RoomLobbyBridge.prototype._handleUpdatePlayerProfile.call(fake,"socket-olga",{wallet:"-1:"+"a".repeat(64)});
    assert.equal(changed.length,1);
    assert.equal(errors.length,1);
    fake._continueToVerifyByRoom.add("room-1");
    RoomLobbyBridge.prototype._handleUpdatePlayerProfile.call(fake,"socket-olga",{wallet:B});
    assert.equal(changed.length,1);
    assert.equal(errors.length,2);
});


test("Page4 reconnect never labels an already MATCHED transfer as payable", () => {
    const delivered = [];
    let intentState = "PENDING";
    const fake = {
        _roomManager: { getRoom: () => ({ players: seats }) },
        _playerToSocket: new Map([["Olga", "socket-olga"]]),
        _paymentApplicationBinding: {
            runtime: {
                paymentService: {
                    listPaymentIntentsForRoom: () => [{
                        roomId: "room-1",
                        playerId: "Olga",
                        state: intentState,
                        paymentReference: "WW_123",
                        amountAtomic: 1_000_000_000,
                        expectedSender: A,
                        destinationWalletAddress: B,
                        expiresAt: Date.now() + 30_000,
                        network: "testnet",
                        asset: "TON"
                    }]
                },
                ledger: { store: { findByIdempotencyKey: () => null } }
            }
        },
        _deliverToSocket: (socketId, event, payload) =>
            delivered.push({ socketId, event, payload })
    };

    RoomLobbyBridge.prototype._deliverPaymentStatusToSocket.call(
        fake, "room-1", "Olga", "socket-olga"
    );
    assert.equal(delivered.at(-1).payload.status, "AWAITING_PAYMENT");

    intentState = "MATCHED";
    RoomLobbyBridge.prototype._deliverPaymentStatusToSocket.call(
        fake, "room-1", "Olga", "socket-olga"
    );
    assert.equal(delivered.at(-1).payload.status, "CONFIRMING_PAYMENT");
    assert.equal(delivered.at(-1).payload.playerId, "Olga");
    assert.equal(delivered.at(-1).payload.paymentReference, "WW_123");

    // A second seat must not see Olga's payment status.
    const count = delivered.length;
    RoomLobbyBridge.prototype._deliverPaymentStatusToSocket.call(
        fake, "room-1", "Lena", "socket-olga"
    );
    assert.equal(delivered.length, count);

    intentState = "FAILED";
    RoomLobbyBridge.prototype._deliverPaymentStatusToSocket.call(
        fake, "room-1", "Olga", "socket-olga"
    );
    assert.equal(delivered.at(-1).payload.status, "PAYMENT_UNAVAILABLE");
});
