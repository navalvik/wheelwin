/**
 * Mainnet 6B-A: verify the INTERNAL integrity of a FULL masterchain block
 * against a separately supplied root-hash checkpoint. This is a prerequisite,
 * not an independently authenticated TON consensus checkpoint.
 *
 * In particular, a root hash from Toncenter/TonAPI/liteserver itself is not
 * trusted. This module does NOT validate a validator-signature chain, anchor
 * provenance, shard hash dictionary, shard inclusion, or transaction inclusion.
 * Every result is non-authoritative for settlement, Page5 and payouts.
 *
 * No network access, secrets, signing, filesystem, global state or polling.
 * The checkpoint comes from the caller; do not mistake an arbitrary caller
 * value for a verified masterchain trust root.
 *
 * BlockInfo follows TON crypto/block/block.tlb (block#11ef55aa and
 * block_info#9bc7a987). Only complete, ordinary, single-root block BoCs
 * are supported; pruned Merkle proofs are deliberately not accepted.
 */
import { Cell, loadShardIdent } from "@ton/core";

const MASTERCHAIN_SHARD = 0x8000000000000000n;
const MAX_BOC_BYTES = 524288;
const GLOBAL_ID = -239;

function reject(reason) {
    return Object.freeze({
        network: "mainnet", status: "BLOCKED", reason,
        checkpointRootHashMatched: false,
        masterchainHeaderMatched: false,
        independentlyAuthenticatedCheckpoint: false,
        validatorSignaturesVerified: false,
        shardInclusionProofVerified: false,
        transactionInclusionProofVerified: false,
        cryptographicProofVerified: false,
        settlementAuthorized: false,
        gameStartAuthorized: false
    });
}
function normalHash(value) {
    return typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value)
        ? value.toLowerCase() : null;
}
function validClaim(checkpoint) {
    return checkpoint !== null && typeof checkpoint === "object"
        && !Array.isArray(checkpoint)
        && checkpoint.network === "mainnet"
        && checkpoint.globalId === GLOBAL_ID
        && checkpoint.workchain === -1
        && checkpoint.shard === "-9223372036854775808"
        && Number.isSafeInteger(checkpoint.seqno)
        && checkpoint.seqno > 1 && checkpoint.seqno <= 0xffffffff
        && normalHash(checkpoint.rootHash) !== null;
}
function decodeOneRoot(boc) {
    if (typeof boc !== "string" || !boc.length
        || boc.length > Math.ceil(MAX_BOC_BYTES * 4 / 3) + 4
        || !/^[a-zA-Z0-9+/_-]+={0,2}$/.test(boc)) return null;
    try {
        const bytes = Buffer.from(boc.replace(/-/g, "+").replace(/_/g, "/"), "base64");
        if (!bytes.length || bytes.length > MAX_BOC_BYTES) return null;
        const roots = Cell.fromBoc(bytes);
        return roots.length === 1 && !roots[0].isExotic ? roots[0] : null;
    } catch { return null; }
}
function loadPreviousBlockRef(cell) {
    if (!cell || cell.isExotic) return null;
    try {
        const s = cell.beginParse();
        const endLt = s.loadUintBig(64);
        const seqno = s.loadUint(32);
        const rootHash = s.loadBuffer(32);
        const fileHash = s.loadBuffer(32);
        if (s.remainingBits !== 0 || s.remainingRefs !== 0
            || endLt <= 0n || seqno < 1
            || rootHash.equals(Buffer.alloc(32)) || fileHash.equals(Buffer.alloc(32)))
            return null;
        return {endLt, seqno};
    } catch { return null; }
}
function readMasterchainHeader(root, claim) {
    try {
        const block = root.beginParse();
        if (block.loadUint(32) !== 0x11ef55aa
            || block.loadInt(32) !== GLOBAL_ID
            || block.remainingBits !== 0 || block.remainingRefs !== 4) return false;
        const infoCell = block.loadRef();
        if (!infoCell || infoCell.isExotic) return false;
        const info = infoCell.beginParse();
        if (info.loadUint(32) !== 0x9bc7a987) return false;
        const version = info.loadUint(32);
        const notMaster = info.loadBit();
        const afterMerge = info.loadBit();
        const beforeSplit = info.loadBit();
        const afterSplit = info.loadBit();
        const wantSplit = info.loadBit();
        const wantMerge = info.loadBit();
        const keyBlock = info.loadBit();
        const vertSeqnoIncr = info.loadBit();
        const flags = info.loadUint(8);
        const seqno = info.loadUint(32);
        const vertSeqno = info.loadUint(32);
        const shard = loadShardIdent(info);
        const genUtime = info.loadUint(32);
        const startLt = info.loadUintBig(64);
        const endLt = info.loadUintBig(64);
        info.loadUint(32); // gen_validator_list_hash_short (NOT signature proof)
        info.loadUint(32); // gen_catchain_seqno
        const minRefMcSeqno = info.loadUint(32);
        const prevKeyBlockSeqno = info.loadUint(32);
        if (version !== 0 || notMaster || afterMerge || beforeSplit
            || afterSplit || wantSplit || wantMerge
            || flags > 1 || seqno !== claim.seqno
            || vertSeqno < Number(vertSeqnoIncr)
            || shard.shardPrefixBits !== 0 || shard.workchainId !== -1
            || shard.shardPrefix !== MASTERCHAIN_SHARD
            || genUtime <= 0 || startLt <= 0n || endLt <= startLt
            || minRefMcSeqno > seqno || prevKeyBlockSeqno >= seqno) return false;
        // global_version#c4 version:uint32 capabilities:uint64, if present.
        if (flags === 1) {
            if (info.loadUint(8) !== 0xc4) return false;
            info.loadUint(32);
            info.loadUintBig(64);
        }
        if (vertSeqnoIncr) return false; // Require simple vertical chain header.
        if (info.remainingBits !== 0 || info.remainingRefs !== 1) return false;
        const prev = loadPreviousBlockRef(info.loadRef());
        if (!prev || prev.seqno !== seqno - 1 || prev.endLt > startLt) return false;
        // A real full Block has 3 remaining ref roots (ValueFlow,
        // MerkleUpdate, BlockExtra). Do not parse/reinterpret them as proofs.
        if (block.remainingRefs !== 3 || block.remainingBits !== 0) return false;
        if (block.loadRef().isExotic) return false; // ValueFlow
        if (block.loadRef().type !== 4) return false; // MerkleUpdate only
        if (block.loadRef().isExotic) return false; // BlockExtra
        return block.remainingRefs === 0 && block.remainingBits === 0
            && typeof keyBlock === "boolean";
    } catch { return false; }
}

/**
 * The input rootHash must originate from an independently verified
 * checkpoint in a future phase. This method CANNOT vouch for that origin.
 */
export function inspectMainnetMasterchainHeaderCheckpoint({
    checkpoint, masterchainBlockBocBase64
} = {}) {
    if (!validClaim(checkpoint)) return reject("MASTERCHAIN_CHECKPOINT_INVALID");
    const root = decodeOneRoot(masterchainBlockBocBase64);
    if (!root) return reject("MASTERCHAIN_BLOCK_BOC_INVALID");
    if (root.hash(0).toString("hex") !== normalHash(checkpoint.rootHash))
        return reject("MASTERCHAIN_BLOCK_ROOT_HASH_MISMATCH");
    if (!readMasterchainHeader(root, checkpoint))
        return reject("MASTERCHAIN_BLOCK_HEADER_MISMATCH");

    return Object.freeze({
        network: "mainnet",
        status: "MASTERCHAIN_HEADER_MATCHES_SUPPLIED_CHECKPOINT",
        reason: "CHECKPOINT_AUTHENTICATION_AND_INCLUSION_PROOFS_REQUIRED",
        checkpointRootHashMatched: true,
        masterchainHeaderMatched: true,
        independentlyAuthenticatedCheckpoint: false,
        validatorSignaturesVerified: false,
        shardInclusionProofVerified: false,
        transactionInclusionProofVerified: false,
        cryptographicProofVerified: false,
        settlementAuthorized: false,
        gameStartAuthorized: false
    });
}
