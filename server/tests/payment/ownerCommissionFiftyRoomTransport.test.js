import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,existsSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {TestnetNativeRoomPayoutTransport}
    from "../../payment/runtime/TestnetNativeRoomPayoutTransport.js";
import {RoomPayoutCalculator}
    from "../../payment/ledger/RoomPayoutCalculator.js";

const COUNT=50,OWNER="0:"+"f".repeat(64);
const address=n=>"0:"+n.toString(16).padStart(64,"0");
const payoutId=i=>"payout_"+(i+1).toString(16).padStart(32,"0");

for(const network of ["testnet","mainnet"]) {
    test(network+": 50 simultaneous distinct room wallets terminalize owner with dual balance, never send OWNER",async t=>{
        const dataDir=mkdtempSync(join(tmpdir(),"wheelwin-owner-transport-50-"+network+"-"));
        t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
        const chainId=network==="mainnet"?-239:-3;
        const rooms=Array.from({length:COUNT},(_,i)=>({
            roomId:"transport-50-"+i,payoutId:payoutId(i),
            wallet:"0:"+(i+1000).toString(16).padStart(64,"0"),
            roomNumber:i+2,
            winner:address(i+10),
            remaining:i%2===0?140_000_000n:148_500_000n
        }));
        const byRoom=new Map(rooms.map(r=>[r.roomId,r]));
        const byAddress=new Map(rooms.map(r=>[r.wallet,r]));
        const winnerSent=new Set(),ownerSent=[],winnerSettled=new Set(),terminal=new Map();
        let estimates=0;
        const pool={
            network,getReservationForRoom:id=>{
                const room=byRoom.get(id);
                return room?{roomNumber:room.roomNumber,address:room.wallet,
                    network,reservedByRoomId:id}:null;
            }
        };
        const adapter={
            _sequenceStateDir:join(dataDir,"outbound-sequences"),
            supportsDurableTransferRetry:()=>true,
            async sendTransfer({roomNumber,destination,idempotencyKey}){
                const room=rooms.find(r=>r.roomNumber===roomNumber);
                assert.ok(room);
                if(destination!==room.winner) {
                    ownerSent.push({roomNumber,destination});
                    throw Error("OWNER_SEND_FORBIDDEN_IN_SHORTFALL_FIXTURE");
                }
                assert.equal(idempotencyKey,room.payoutId+":WINNER");
                winnerSent.add(room.roomId);
                await Promise.resolve();
                return {ok:true,txHash:"winner-mock-"+roomNumber};
            },
            async canFundTransfer({roomNumber,amountNano}){
                const r=rooms.find(x=>x.roomNumber===roomNumber);
                assert.ok(r);
                assert.equal(amountNano,148_500_000n);
                await Promise.resolve();
                return {
                    roomNumber,address:r.wallet,amountNano,
                    balanceNano:r.remaining,ok:r.remaining>=amountNano
                };
            },
            async estimateOutboundTransferFee({roomNumber,destination,amountNano}){
                const room=rooms.find(r=>r.roomNumber===roomNumber);
                assert.ok(room);
                assert.equal(room.remaining,148_500_000n,
                    "only an exact owner balance needs an external fee estimate");
                assert.equal(destination,OWNER);
                assert.equal(amountNano,148_500_000n);
                estimates++;
                return {ok:true,totalNano:1_000_000n,
                    roomNumber,destination,amountNano};
            }
        };
        const outgoingObserver={
            async findOutgoingTransfer({sourceWalletAddress,destinationIdentity,amountAtomic}){
                const room=byAddress.get(sourceWalletAddress);
                if(!room||!winnerSent.has(room.roomId)
                    ||destinationIdentity!==room.winner
                    ||amountAtomic!==2_850_000_000)return null;
                return {transactionId:"winner-source-"+room.roomNumber};
            },
            async verifyIndexedRecipientCredit({sourceWalletAddress,destinationIdentity,
                transactionId,amountAtomic}){
                const room=byAddress.get(sourceWalletAddress);
                if(!room||transactionId!=="winner-source-"+room.roomNumber)return null;
                return {
                    status:"MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED",
                    globalId:chainId,sourceTransactionId:transactionId,
                    recipientTransactionId:"winner-recipient-"+room.roomNumber,
                    messageHash:"winner-message-"+room.roomNumber,
                    destinationAddress:destinationIdentity,amountAtomic,
                    sourceFinality:"finalized",recipientFinality:"finalized",
                    sourceMcBlockSeqno:50,recipientMcBlockSeqno:51,
                    latestIndexedMcBlockSeqno:60
                };
            }
        };
        const independentVerifier={
            async verifyTransfer(data){
                return {status:"INDEPENDENT_INDEXED_CREDIT_OBSERVED",
                    provider:network==="mainnet"?"tonapi-mainnet":"tonapi-testnet",
                    ...data,actualFeeAtomic:800_000};
            },
            async observeAccountBalance({address}){
                const room=byAddress.get(address);
                if(!room)return null;
                await Promise.resolve();
                return {
                    status:"INDEPENDENT_ACCOUNT_BALANCE_OBSERVED",
                    provider:network==="mainnet"?"tonapi-mainnet":"tonapi-testnet",
                    network,address,balanceAtomic:String(room.remaining),
                    observedAtMs:Date.now()
                };
            }
        };
        const ledger={
            listPayoutObligations:roomId=>{
                const room=byRoom.get(roomId);
                return [
                    {payoutId:room.payoutId,recipientId:"Olga",role:"WINNER",
                        settled:winnerSettled.has(roomId),netAtomic:2_850_000_000},
                    {payoutId:room.payoutId,recipientId:"WheelWin",role:"OWNER",
                        settled:false,terminal:terminal.has(roomId),netAtomic:148_500_000}
                ];
            },
            settlePayout:({payoutId:id,recipientId,executionResult})=>{
                const room=rooms.find(r=>r.payoutId===id);
                assert.ok(room);
                assert.equal(recipientId,"Olga");
                assert.equal(executionResult.transactionId,
                    "winner-source-"+room.roomNumber);
                const replay=winnerSettled.has(room.roomId);
                winnerSettled.add(room.roomId);
                return {replay};
            },
            terminateOwnerCommissionUnpaid:({payoutId:id,recipientId,evidence})=>{
                const room=rooms.find(r=>r.payoutId===id);
                assert.ok(room);
                assert.equal(recipientId,"WheelWin");
                assert.ok(winnerSettled.has(room.roomId));
                assert.equal(evidence.network,network);
                assert.equal(evidence.tonapiBalanceAtomic,String(room.remaining));
                assert.equal(evidence.toncenterBalanceAtomic,String(room.remaining));
                assert.ok(room.remaining<=148_500_000n);
                const replay=terminal.has(room.roomId);
                terminal.set(room.roomId,evidence);
                return {terminal:true,paid:false,replay};
            }
        };
        const createTransport=()=>new TestnetNativeRoomPayoutTransport({
            network,dataDir,walletPool:pool,adapter,ledger,
            outgoingObserver,independentVerifier
        });
        const transport=createTransport();
        const requests=rooms.map(r=>{
            const plan=RoomPayoutCalculator.computePlan({
                payoutId:r.payoutId,roomId:r.roomId,asset:"TON",network,
                principalAtomic:3_000_000_000,nowMs:1_800_000_000_000,
                winner:{recipientId:"Olga",address:r.winner},
                owner:{recipientId:"WheelWin",address:OWNER}
            }).toJSON();
            return {roomId:r.roomId,payoutId:r.payoutId,
                roomWalletAddress:r.wallet,winnerWallet:r.winner,
                ownerWallet:OWNER,plan};
        });
        const answers=await Promise.all(requests.map(req=>transport.submit(req)));
        assert.equal(answers.length,COUNT);
        assert.ok(answers.every(x=>x.status===
            "OWNER_COMMISSION_UNPAID_GAS_SHORTAGE_TERMINAL"));
        assert.ok(answers.every(x=>x.ownerPaid===false));
        assert.equal(winnerSent.size,COUNT);
        assert.equal(winnerSettled.size,COUNT);
        assert.equal(terminal.size,COUNT);
        assert.deepEqual(ownerSent,[]);
        assert.equal(estimates,COUNT/2,
            "only exact-balance cases need a positive gas estimate");
        for(const r of rooms){
            const marker=join(dataDir,network+"-native-payout-attempts",
                r.payoutId+".OWNER.json");
            assert.ok(existsSync(marker));
            const record=JSON.parse(readFileSync(marker,"utf8"));
            assert.equal(record.state,"OWNER_COMMISSION_UNPAID_GAS_SHORTAGE_TERMINAL");
            assert.equal(record.roomId,r.roomId);
            assert.equal(record.amountAtomic,148_500_000);
            assert.equal(record.destination,OWNER);
        }
        // Repeated concurrent messages after simulated transport restart MUST
        // not broadcast another WINNER or OWNER message for old sessions.
        const before=winnerSent.size;
        const restarted=createTransport();
        const replay=await Promise.all(requests.map(req=>
            restarted.submit({...req,resume:true})));
        assert.ok(replay.every(x=>x.status===
            "OWNER_COMMISSION_UNPAID_GAS_SHORTAGE_TERMINAL"));
        assert.equal(winnerSent.size,before);
        assert.deepEqual(ownerSent,[]);
        assert.equal(terminal.size,COUNT);
    });
}
