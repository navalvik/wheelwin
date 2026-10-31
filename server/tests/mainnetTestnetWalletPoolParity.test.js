import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
    WalletPoolRegistry
} from "../payment/WalletPoolRegistry.js";

function catalog(network, {secret=false}={}) {
    return Array.from({length:64},(_,i)=>({
        roomNumber:i+1,
        address:"0:"+BigInt(i+1).toString(16).padStart(64,"0"),
        network,
        ...(secret?{secretKey:"DO_NOT_PERSIST_SECRET_VALUE",mnemonic:"DO_NOT_PERSIST_SEED"}:{})
    }));
}
function withFolder(action) {
    const dir=mkdtempSync(join(tmpdir(),"wheelwin-wallet-pool-parity-"));
    try{return action(dir);}finally{rmSync(dir,{recursive:true,force:true});}
}

test("Mainnet uses exactly the same 64-wallet registry and reservation rules as Testnet",()=>{
    withFolder(root=>{
        const env={ROOM_WALLETS_MAINNET_JSON:JSON.stringify(catalog("mainnet",{secret:true}))};
        const pool=new WalletPoolRegistry({network:"mainnet",env});
        const snapshotDir=join(root,"mainnet");
        pool.initialize({snapshotDir});
        assert.equal(pool.size,64);
        assert.equal(pool.network,"mainnet");
        assert.equal(pool.listWallets().length,64);
        assert.ok(pool.listWallets().every(w=>w.network==="mainnet"));
        assert.ok(pool.listWallets().every(w=>!Object.hasOwn(w,"secretKey") && !Object.hasOwn(w,"mnemonic")));
        // The historical Testnet hold on wallet #1 must NOT be assigned
        // automatically to Mainnet wallet #1.
        const owner=pool.reserve({roomId:"first-room",network:"mainnet",now:1800000000000});
        assert.equal(owner.wallet.roomNumber,1);
        assert.equal(owner.wallet.reservedByRoomId,"first-room");
        assert.throws(()=>pool.reserve({roomId:"first-room",network:"mainnet"}),
            /room already has a wallet assigned/);
        assert.throws(()=>pool.reserve({roomId:"other-room",walletId:owner.wallet.walletId,network:"mainnet"}),
            /already reserved/);
        assert.throws(()=>pool.release({roomId:"first-room",unresolvedObligations:1}),
            /wallet recycling blocked|outstanding|unresolved|recycl/i);
        assert.equal(pool.getReservationForRoom("first-room").walletId,owner.wallet.walletId);
        pool.persistSnapshot(snapshotDir);
        const data=readFileSync(join(snapshotDir,"wallet-pool.json"),"utf8");
        assert.ok(!data.includes("DO_NOT_PERSIST"));
        assert.ok(!data.includes("mnemonic"));
        const restart=new WalletPoolRegistry({network:"mainnet",env});
        restart.initialize({snapshotDir});
        assert.equal(restart.getReservationForRoom("first-room")?.walletId,owner.wallet.walletId);
        assert.equal(restart.listAvailableWallets().length,63);
        assert.equal(restart.release({roomId:"first-room",unresolvedObligations:0}).released,true);
        assert.equal(restart.listAvailableWallets().length,64);
    });
});

test("Mainnet catalog refuses missing var despite Testnet env and testnet file fallback",()=>{
    assert.throws(()=>new WalletPoolRegistry({
        network:"mainnet",
        env:{ROOM_WALLETS_TESTNET_JSON:JSON.stringify(catalog("testnet")),
            ROOM_WALLETS_JSON:JSON.stringify(catalog("testnet"))}
    }).initialize(),/room wallet catalog not found/);
});

test("Mainnet catalog never imports Testnet wallet identity or mixed catalogs",()=>{
    const incorrect=catalog("mainnet");
    incorrect[20]={...incorrect[20],network:"testnet"};
    assert.throws(()=>new WalletPoolRegistry({
        network:"mainnet",env:{ROOM_WALLETS_MAINNET_JSON:JSON.stringify(incorrect)}
    }).initialize(),/non-mainnet wallet/);
    assert.throws(()=>new WalletPoolRegistry({
        network:"mainnet",env:{ROOM_WALLETS_MAINNET_JSON:JSON.stringify(catalog("testnet"))}
    }).initialize(),/non-mainnet wallet/);
});

test("Testnet legacy catalog source and #1 historical hold keep existing behavior",()=>{
    const pool=new WalletPoolRegistry({
        network:"testnet",env:{ROOM_WALLETS_JSON:JSON.stringify(catalog("testnet"))}
    });
    pool.initialize();
    assert.equal(pool.listWallets().length,64);
    assert.equal(pool.getWalletByRoomNumber(1).network,"testnet");
    assert.ok(pool.listQuarantinedWallets().some(w=>w.roomNumber===1));
    const reserved=pool.reserve({roomId:"legacy-room",network:"testnet",now:1800000000000});
    assert.equal(reserved.wallet.roomNumber,2);
    assert.equal(pool.release({roomId:"legacy-room"}).released,true);
});

test("unknown pool network rejects at construction without touching catalog",()=>{
    assert.throws(()=>new WalletPoolRegistry({network:"TESTNET"}),
        /room wallet network must be testnet or mainnet/);
    assert.throws(()=>new WalletPoolRegistry({network:"invalid"}),
        /room wallet network must be testnet or mainnet/);
});
