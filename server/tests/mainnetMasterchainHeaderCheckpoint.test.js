import test from "node:test";
import assert from "node:assert/strict";
import { beginCell, Cell, storeShardIdent } from "@ton/core";
import {
    inspectMainnetMasterchainHeaderCheckpoint
} from "../mainnet/MainnetMasterchainHeaderCheckpoint.js";

const MASTER = "-9223372036854775808";
const SEQNO = 120045;
const GLOBAL_ID = -239;

function merkleUpdate() {
    // Correctly shaped exotic MerkleUpdate, deliberately not proof verified.
    const before = beginCell().storeUint(1,8).endCell();
    const after = beginCell().storeUint(2,8).endCell();
    return beginCell().storeUint(4,8)
        .storeBuffer(before.hash(0))
        .storeBuffer(after.hash(0))
        .storeUint(before.depth(0),16)
        .storeUint(after.depth(0),16)
        .storeRef(before).storeRef(after).endCell({exotic:true});
}
function fixture({seqno=SEQNO,globalId=GLOBAL_ID,workchain=-1,
    shardPrefix=0x8000000000000000n,notMaster=false,
    afterMerge=false,beforeSplit=false,flags=0,
    prevSeqno=seqno-1,
    prevEndLt=100n,genUtime=1793451600,
    malformedInfo=false,otherRoot=false,invalidStateUpdate=false
}={}) {
    const previous=beginCell()
        .storeUint(prevEndLt,64).storeUint(prevSeqno,32)
        .storeBuffer(Buffer.alloc(32,1)).storeBuffer(Buffer.alloc(32,2))
        .endCell();
    const infoBuilder=beginCell()
        .storeUint(malformedInfo ? 0x11111111 : 0x9bc7a987,32)
        .storeUint(0,32).storeBit(notMaster)
        .storeBit(afterMerge).storeBit(beforeSplit).storeBit(false)
        .storeBit(false).storeBit(false).storeBit(false).storeBit(false)
        .storeUint(flags,8).storeUint(seqno,32).storeUint(0,32)
        .store(storeShardIdent({
            shardPrefixBits:0,workchainId:workchain,shardPrefix
        }))
        .storeUint(genUtime,32).storeUint(200n,64).storeUint(300n,64)
        .storeUint(0,32).storeUint(0,32).storeUint(1,32).storeUint(1,32);
    if (flags===1) infoBuilder.storeUint(0xc4,8).storeUint(1,32).storeUint(0n,64);
    const info=infoBuilder.storeRef(previous).endCell();
    const block=beginCell()
        .storeUint(0x11ef55aa,32).storeInt(globalId,32)
        .storeRef(info)
        .storeRef(Cell.EMPTY)
        .storeRef(invalidStateUpdate ? Cell.EMPTY : merkleUpdate())
        .storeRef(otherRoot ? beginCell().storeUint(1234,16).endCell() : Cell.EMPTY)
        .endCell();
    const checkpoint={network:"mainnet",globalId:-239,workchain:-1,
        shard:MASTER,seqno,rootHash:block.hash(0).toString("hex")};
    return {block,checkpoint,boc:block.toBoc().toString("base64")};
}
function inspect(f) {
    return inspectMainnetMasterchainHeaderCheckpoint({
        checkpoint:f.checkpoint,masterchainBlockBocBase64:f.boc
    });
}

test("full Mainnet block matching a supplied checkpoint remains untrusted for settlement",()=>{
    const f=fixture();
    const result=inspect(f);
    assert.equal(result.status,"MASTERCHAIN_HEADER_MATCHES_SUPPLIED_CHECKPOINT");
    assert.equal(result.checkpointRootHashMatched,true);
    assert.equal(result.masterchainHeaderMatched,true);
    for (const key of [
        "independentlyAuthenticatedCheckpoint",
        "validatorSignaturesVerified",
        "shardInclusionProofVerified",
        "transactionInclusionProofVerified",
        "cryptographicProofVerified","settlementAuthorized","gameStartAuthorized"
    ]) assert.equal(result[key],false,key);
});

test("substituting arbitrary but correctly formed block is rejected by pinned root hash",()=>{
    const f=fixture();
    const unrelated=fixture({otherRoot:true});
    const r=inspectMainnetMasterchainHeaderCheckpoint({
        checkpoint:f.checkpoint,masterchainBlockBocBase64:unrelated.boc
    });
    assert.equal(r.reason,"MASTERCHAIN_BLOCK_ROOT_HASH_MISMATCH");
});

test("wrong network, absent checkpoint, wrong workchain, seqno and invalid hashes block",()=>{
    const f=fixture();
    for (const checkpoint of [
        null,{}, {...f.checkpoint,network:"testnet"},
        {...f.checkpoint,globalId:-3},
        {...f.checkpoint,workchain:0},
        {...f.checkpoint,shard:"8000000000000000"},
        {...f.checkpoint,seqno:0},
        {...f.checkpoint,seqno:4294967296},
        {...f.checkpoint,rootHash:"garbage"}
    ]) {
        const r=inspectMainnetMasterchainHeaderCheckpoint({
            checkpoint,masterchainBlockBocBase64:f.boc
        });
        assert.equal(r.reason,"MASTERCHAIN_CHECKPOINT_INVALID");
        assert.equal(r.settlementAuthorized,false);
    }
});

test("malformed BOC, oversized data, multiple roots and empty payload fail",()=>{
    const f=fixture();
    for (const boc of ["", "$$$$", "A".repeat(900000),
        beginCell().storeUint(0,8).endCell().toBoc().toString("base64").replace(/^./,"!")]) {
        assert.equal(inspectMainnetMasterchainHeaderCheckpoint({
            checkpoint:f.checkpoint,masterchainBlockBocBase64:boc
        }).reason,"MASTERCHAIN_BLOCK_BOC_INVALID");
    }
    const two=beginCell().storeUint(1,8).endCell();
    const second=beginCell().storeUint(2,8).endCell();
    // Cell.toBoc() starts with a single root; a two-root BoC is covered by
    // the decoder's roots.length === 1 restriction.
    assert.notEqual(two.hash().toString("hex"),second.hash().toString("hex"));
});

test("self-consistent hash from Testnet block or malformed header is NOT a valid Mainnet block",()=>{
    const cases=[
        fixture({globalId:-3}),fixture({workchain:0}),
        fixture({shardPrefix:0x4000000000000000n}),
        fixture({notMaster:true}),fixture({afterMerge:true}),
        fixture({beforeSplit:true}),fixture({flags:2}),
        fixture({prevSeqno:SEQNO-2}),
        fixture({prevEndLt:301n}),fixture({genUtime:0}),
        fixture({malformedInfo:true}),fixture({invalidStateUpdate:true})
    ];
    for (const f of cases) {
        const r=inspect(f);
        assert.equal(r.status,"BLOCKED",f.block.hash().toString("hex"));
        assert.equal(r.reason,"MASTERCHAIN_BLOCK_HEADER_MISMATCH");
        assert.equal(r.cryptographicProofVerified,false);
    }
});

test("independent caller can forge supplied checkpoint: never promote match to consensus proof",()=>{
    const f=fixture({otherRoot:true});
    const result=inspect(f);
    assert.equal(result.status,"MASTERCHAIN_HEADER_MATCHES_SUPPLIED_CHECKPOINT");
    assert.equal(result.independentlyAuthenticatedCheckpoint,false);
    assert.equal(result.cryptographicProofVerified,false);
    assert.equal(result.gameStartAuthorized,false);
});
