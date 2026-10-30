import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WalletPoolRegistry } from "../../payment/WalletPoolRegistry.js";

function createPool(t) {
    const dir = mkdtempSync(join(tmpdir(), "ww-manual-quarantine-"));
    t.after(() => rmSync(dir, {recursive:true,force:true}));
    const catalogPath = join(dir,"catalog.json");
    const wallets = Array.from({length:64},(_,i) => ({
        walletId:`wallet-${i+1}`,
        roomNumber:i+1,
        address:"0:"+(i+1).toString(16).padStart(64,"0"),
        network:"testnet",workchain:0
    }));
    writeFileSync(catalogPath,JSON.stringify(wallets),"utf8");
    const make=()=>new WalletPoolRegistry({catalogPath,network:"testnet"});
    return {dir,make};
}

test("quarantine of a live room wallet preserves its reservation and financial flow",t=>{
    const {dir,make}=createPool(t);
    const pool=make();
    pool.initialize({snapshotDir:dir});
    const assigned=pool.reserve({roomId:"live-room",walletId:"wallet-2"});
    assert.equal(assigned.wallet.roomNumber,2);
    const hold=pool.manuallyQuarantine(2,{
        note:"Investigate mismatched inbound payment",
        actor:"admin",now:1700000000000
    });
    assert.deepEqual(hold,{
        roomNumber:2,quarantined:true,alreadyQuarantined:false,reservedByRoomId:"live-room"
    });
    assert.equal(pool.getReservationForRoom("live-room").roomNumber,2,
        "quarantine must not steal the wallet from an active game");
    assert.equal(pool.getAvailableCount(),62,
        "historical wallet 1 and active wallet 2 are unavailable");
    assert.deepEqual(pool.listQuarantinedWallets().find(x=>x.roomNumber===2),{
        roomNumber:2,walletId:"wallet-2",address:"0:"+("2").padStart(64,"0"),
        network:"testnet",reservedByRoomId:"live-room",
        reason:"ADMIN_MANUAL_HOLD",
        quarantineNote:"Investigate mismatched inbound payment",
        quarantinedAt:"2023-11-14T22:13:20.000Z",
        quarantinedBy:"admin"
    });
    assert.equal(pool.manuallyQuarantine(2).alreadyQuarantined,true,
        "repeat admin request is idempotent");
    assert.equal(pool.release({roomId:"live-room",unresolvedObligations:0}).released,true);
    pool.persistSnapshot(dir);
    assert.equal(pool.getReservationForRoom("live-room"),null);
    assert.equal(pool.getAvailableCount(),62,
        "wallet stays held after room completion");
    assert.throws(()=>pool.reserve({roomId:"new-room",walletId:"wallet-2"}),
        /wallet quarantined/);
    const snapshot=JSON.parse(readFileSync(join(dir,"wallet-pool.json"),"utf8"));
    assert.ok(snapshot.manualQuarantines.includes(2));
    assert.equal(snapshot.manualQuarantineDetails.find(x=>x.roomNumber===2)?.placedBy,"admin");
    assert.equal(JSON.stringify(snapshot).includes("secretKey"),false);

    const restarted=make();
    restarted.initialize({snapshotDir:dir});
    assert.equal(restarted.isQuarantined(2),true);
    assert.equal(restarted.listQuarantinedWallets().find(x=>x.roomNumber===2)?.quarantineNote,
        "Investigate mismatched inbound payment");
    assert.throws(()=>restarted.reserve({roomId:"new-room",walletId:"wallet-2"}),
        /wallet quarantined/);

    const released=restarted.manuallyReleaseQuarantine({roomNumber:2,verifiedSafe:true});
    assert.equal(released.released,true);
    assert.equal(restarted.isQuarantined(2),false);
    assert.equal(restarted.getAvailableCount(),63);
    assert.equal(restarted.reserve({roomId:"next-room",walletId:"wallet-2"}).wallet.roomNumber,2);
});

test("active wallet quarantine survives a restart without releasing the active room",t=>{
    const {dir,make}=createPool(t);
    const original=make();
    original.initialize({snapshotDir:dir});
    original.reserve({roomId:"in-progress",walletId:"wallet-3"});
    original.manuallyQuarantine(3,{note:"Investigate current session"});
    const resumed=make();
    resumed.initialize({snapshotDir:dir});
    assert.equal(resumed.getReservationForRoom("in-progress")?.roomNumber,3);
    assert.equal(resumed.isQuarantined(3),true);
    assert.throws(()=>resumed.reserve({roomId:"other",walletId:"wallet-3"}),
        /wallet quarantined|already assigned/);
    assert.equal(resumed.release({roomId:"in-progress",unresolvedObligations:0}).released,true);
    assert.equal(resumed.isQuarantined(3),true);
});
