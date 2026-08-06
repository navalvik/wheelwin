/// R7.66C — GameEscrow v1 with SETTLE payouts.
/// INIT_GAME + SETTLE (sends winner/owner amounts). No STAKE yet.

const STATUS_UNINITIALIZED: Int = 0;
const STATUS_DEPLOYED: Int = 1;
const STATUS_READY: Int = 5;
const STATUS_SETTLING: Int = 7;
const STATUS_SETTLED: Int = 8;
const STATUS_FAILED: Int = 10;

const CONTRACT_VERSION: Int = 1;

/// Gas cushion so two payout sends can pay forward fees (testnet/mainnet).
const SETTLE_GAS_RESERVE: Int = ton("0.05");

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

    /// Empty body — deploy path and TON funding (accepts balance).
    receive() {
        // intentionally empty — value stays on contract balance
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

        let required: Int = msg.winnerAmount + msg.ownerAmount + SETTLE_GAS_RESERVE;
        require(myBalance() >= required, "GameEscrow: insufficient balance");

        // Queue payouts first. State is committed only if the action phase succeeds;
        // insufficient funds / send failure rolls back settled/status.
        send(SendParameters{
            to: msg.winner,
            value: msg.winnerAmount,
            mode: SendPayGasSeparately,
            bounce: false
        });
        send(SendParameters{
            to: self.owner,
            value: msg.ownerAmount,
            mode: SendPayGasSeparately,
            bounce: false
        });

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
