import test from "node:test";
import assert from "node:assert/strict";
import { WalletQuarantineAdminService } from "../../console/WalletQuarantineAdminService.js";

const WALLET = "0:" + "1".repeat(64);
const RESIDUES = "0:" + "2".repeat(64);

function fixture({ balanceNano = "5000000000", openDebts = false,
    sweepEnabled = false, reservedByRoomId = null, wrongSigner = false } = {}) {
    let requests = 0;
    let released = 0;
    let held = 0;
    let sweepCalls = 0;
    const wallet = {walletId:"room-wallet-1", roomNumber:1, network:"testnet",
        address:WALLET, reservedByRoomId};
    const pool = {
        getWalletByRoomNumber:n => n === 1 ? wallet : null,
        isQuarantined:() => true,
        listQuarantinedWallets:() => [{roomNumber:1,reason:"HISTORICAL_UNRESOLVED_FUNDS"}],
        manuallyReleaseQuarantine:({roomNumber,verifiedSafe}) => {
            assert.equal(verifiedSafe,true); released++; return {roomNumber,released:true};
        },
        manuallyQuarantine:() => {held++;return {roomNumber:1,quarantined:true};}
    };
    const runtime = {
        initialized:true,network:"testnet",globalId:-3,
        networkDataDir:"/test-wallet-admin-no-files",walletPool:pool,
        intentStore:{list:() => openDebts ? [{
            roomId:"old-room",destinationWalletId:wallet.walletId,state:"SETTLED"
        }] : []},
        ledger:{store:{listForRoom:() => openDebts ? [{
            kind:"INCOMING_PRINCIPAL",metadata:{paymentReference:"ref",transactionId:"tx"}
        }] : []},listPayoutObligations:()=>[]},
        refundStore:{list:() => []},
        receiptStore:{listForRoom:()=>[]}
    };
    const service = new WalletQuarantineAdminService({
        getRuntime:()=>runtime,
        getAdapter:()=>({getWalletAddress:async()=>wrongSigner ? RESIDUES : WALLET,sendAllBalance:async args=>{
            sweepCalls++;return {ok:true,code:"SUBMITTED_UNCONFIRMED",...args};
        }}),
        env:{TON_NETWORK:"testnet",TON_RESIDUES_EXPECTED_ADDRESS:RESIDUES,
            ADMIN_WALLET_SWEEP_ENABLED:sweepEnabled ? "true" : "false"},
        fetchImpl:async () => {
            requests++;
            return {ok:true,json:async()=>({
                ok:true,result:{balance:balanceNano,state:"active"}
            })};
        }
    });
    return {service,get requests(){return requests;},
        get released(){return released;},get held(){return held;},
        get sweepCalls(){return sweepCalls;}};
}

test("quarantine status polls only selected wallet and residues, not 64 wallets",async()=>{
    const f=fixture();
    const status=await f.service.status("1");
    assert.equal(f.requests,2);
    assert.equal(status.quarantined.length,1);
    assert.equal(status.selected.roomNumber,1);
    assert.equal(status.selected.balanceNano,"5000000000");
    assert.equal(status.residues.balanceNano,"5000000000");
    await f.service.status();
    assert.equal(f.requests,3);
});

test("manual quarantine release requires exact confirmation and zero on-chain balance",async()=>{
    const f=fixture();
    await assert.rejects(f.service.release({roomNumber:1,confirmation:"RELEASE 2"}),
        /RELEASE_CONFIRMATION_REQUIRED/);
    await assert.rejects(f.service.release({roomNumber:1,confirmation:"RELEASE 1"}),
        /WALLET_BALANCE_NOT_EMPTY/);
    assert.equal(f.released,0);
    const empty=fixture({balanceNano:"0"});
    assert.deepEqual(await empty.service.release({roomNumber:1,confirmation:"RELEASE 1"}),
        {roomNumber:1,released:true});
    assert.equal(empty.released,1);
});

test("historical unpaid principal or active reservation blocks release and sweep",async()=>{
    for(const props of [{openDebts:true},{reservedByRoomId:"live-room"}]){
        const f=fixture({...props,balanceNano:"0",sweepEnabled:true});
        await assert.rejects(f.service.release({roomNumber:1,confirmation:"RELEASE 1"}),
            /WALLET_HAS_OPEN_FINANCIAL_OBLIGATIONS/);
        await assert.rejects(f.service.sweep({
            roomNumber:1,confirmation:"SWEEP 1 TO TON_RESIDUES"
        }),/WALLET_HAS_OPEN_FINANCIAL_OBLIGATIONS/);
        assert.equal(f.held,0);
        assert.equal(f.sweepCalls,0);
    }
});

test("sweep is disabled by default; enabled sweep quarantines before once-only send",async()=>{
    const disabled=fixture();
    await assert.rejects(disabled.service.sweep({
        roomNumber:1,confirmation:"SWEEP 1 TO TON_RESIDUES"
    }),/ADMIN_TESTNET_SWEEP_DISABLED/);
    assert.equal(disabled.held,0);
    const enabled=fixture({sweepEnabled:true});
    const result=await enabled.service.sweep({
        roomNumber:1,confirmation:"SWEEP 1 TO TON_RESIDUES"
    });
    assert.equal(result.code,"SUBMITTED_UNCONFIRMED");
    assert.equal(result.destination,RESIDUES);
    assert.equal(enabled.held,1);
    assert.equal(enabled.sweepCalls,1);
});

test("room numbers cannot escape fixed 64-wallet registry",async()=>{
    const f=fixture();
    await assert.rejects(f.service.status("65"),/WALLET_NUMBER_MUST_BE_1_TO_64/);
    await assert.rejects(f.service.status("-1"),/WALLET_NUMBER_MUST_BE_1_TO_64/);
});

test("mismatched signing key cannot quarantine or sweep a different game wallet",async()=>{
    const f=fixture({sweepEnabled:true,wrongSigner:true});
    await assert.rejects(f.service.sweep({
        roomNumber:1,confirmation:"SWEEP 1 TO TON_RESIDUES"
    }),/SWEEP_SIGNER_CATALOG_ADDRESS_MISMATCH/);
    assert.equal(f.held,0);
    assert.equal(f.sweepCalls,0);
});
