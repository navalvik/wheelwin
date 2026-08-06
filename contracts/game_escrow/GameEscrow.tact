/// R7.66B — GameEscrow v1 (Tact).
/// INIT_GAME + SETTLE only. No STAKE / player payments / payout transfers yet.

const STATUS_UNINITIALIZED: Int = 0;
const STATUS_DEPLOYED: Int = 1;
const STATUS_READY: Int = 5;
const STATUS_SETTLING: Int = 7;
const STATUS_SETTLED: Int = 8;
const STATUS_FAILED: Int = 10;

const CONTRACT_VERSION: Int = 1;

/// INIT_GAME — 0x494e4954 ("INIT")
message(0x494e4954) InitGame {
    oracle: Address;
    owner: Address;
    contractIdHash: Int as uint256;
    snapshotHash: Int as uint256;
}

/// SETTLE — 0x53544c ("STL", 32-bit opcode value)
message(0x53544c) Settle {
    snapshotHash: Int as uint256;
    winner: Address;
    winnerAmount: Int as coins;
    ownerAmount: Int as coins;
}

struct SettlementInfo {
    winner: Address;
    winnerAmount: Int as coins;
    ownerAmount: Int as coins;
    settled: Bool;
}

contract GameEscrow {
    version: Int as uint16;
    status: Int as uint8;
    oracle: Address;
    owner: Address;
    contractIdHash: Int as uint256;
    snapshotHash: Int as uint256;
    winner: Address;
    winnerAmount: Int as coins;
    ownerAmount: Int as coins;
    settled: Bool;

    init() {
        let zero: Address = newAddress(0, 0);
        self.version = CONTRACT_VERSION;
        self.status = STATUS_UNINITIALIZED;
        self.oracle = zero;
        self.owner = zero;
        self.contractIdHash = 0;
        self.snapshotHash = 0;
        self.winner = zero;
        self.winnerAmount = 0;
        self.ownerAmount = 0;
        self.settled = false;
    }

    /// Empty body — deploy path before INIT_GAME.
    receive() {
        // intentionally empty
    }

    receive(msg: InitGame) {
        require(self.status == STATUS_UNINITIALIZED, "GameEscrow: not uninitialized");
        self.oracle = msg.oracle;
        self.owner = msg.owner;
        self.contractIdHash = msg.contractIdHash;
        self.snapshotHash = msg.snapshotHash;
        self.status = STATUS_DEPLOYED;
    }

    receive(msg: Settle) {
        require(sender() == self.oracle, "GameEscrow: sender is not oracle");
        require(self.settled == false, "GameEscrow: already settled");
        require(msg.snapshotHash == self.snapshotHash, "GameEscrow: snapshot mismatch");

        self.winner = msg.winner;
        self.winnerAmount = msg.winnerAmount;
        self.ownerAmount = msg.ownerAmount;
        self.status = STATUS_SETTLED;
        self.settled = true;
    }

    get fun get_status(): Int {
        return self.status;
    }

    get fun get_contract_id_hash(): Int {
        return self.contractIdHash;
    }

    get fun get_snapshot_hash(): Int {
        return self.snapshotHash;
    }

    get fun get_settlement_info(): SettlementInfo {
        return SettlementInfo{
            winner: self.winner,
            winnerAmount: self.winnerAmount,
            ownerAmount: self.ownerAmount,
            settled: self.settled
        };
    }
}
