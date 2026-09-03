/// R7.69C — GameEscrow with STAKE deposits and EMERGENCY_CANCEL refunds.
/// INIT_GAME + OpenPayments + STAKE + SETTLE + EMERGENCY_CANCEL.
/// INIT_GAME and SETTLE message ABIs unchanged from R7.66C / R7.69A.

const STATUS_UNINITIALIZED: Int = 0;
const STATUS_DEPLOYED: Int = 1;
const STATUS_WAITING_PAYMENTS: Int = 2;
const STATUS_PAYMENTS_OPEN: Int = 3;
const STATUS_READY: Int = 5;
const STATUS_SETTLING: Int = 7;
const STATUS_SETTLED: Int = 8;
const STATUS_CANCELLED: Int = 9;
const STATUS_FAILED: Int = 10;

const CONTRACT_VERSION: Int = 1;
const PLAYER_COUNT: Int = 3;

/// Gas cushion so two payout sends can pay forward fees (testnet/mainnet).
const SETTLE_GAS_RESERVE: Int = ton("0.05");

/// Gas cushion for up to three refund sends on cancel.
const CANCEL_GAS_RESERVE: Int = ton("0.08");

/// INIT_GAME — 0x494e4954 ("INIT") — ABI unchanged
message(0x494e4954) InitGame {
    oracle: Address;
    owner: Address;
    contractIdHash: Int as uint256;
    snapshotHash: Int as uint256;
}

/// OPEN_PAYMENTS — 0x4F50454E ("OPEN") — register seats after INIT (not INIT ABI)
message(0x4F50454E) OpenPayments {
    player0: Address;
    stake0: Int as coins;
    player1: Address;
    stake1: Int as coins;
    player2: Address;
    stake2: Int as coins;
}

/// STAKE — 0x5354414B ("STAK")
message(0x5354414B) Stake {
    playerIndex: Int as uint8;
}

/// SETTLE — 0x53544c ("STL") — ABI unchanged
message(0x53544c) Settle {
    snapshotHash: Int as uint256;
    winner: Address;
    winnerAmount: Int as coins;
    ownerAmount: Int as coins;
}

/// EMERGENCY_CANCEL — 0x43414e43 ("CANC") — oracle refunds paid stakes
message(0x43414e43) EmergencyCancel {
    reasonCode: Int as uint32;
}

/// SWEP — oracle residual sweep after SETTLED (not SETTLE ABI)
message(0x53574550) SweepResidual {
}

struct SettlementInfo {
    winner: Address;
    winnerAmount: Int as coins;
    ownerAmount: Int as coins;
    settled: Bool;
}

struct PlayerPaymentInfo {
    player: Address;
    requiredStake: Int as coins;
    paid: Bool;
}

struct CancelStatus {
    cancelled: Bool;
    cancelReason: Int as uint32;
    refundMask: Int as uint8;
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

    // R7.69A — on-chain payment authority
    paidMask: Int as uint8;
    totalPaid: Int as coins;
    requiredTotal: Int as coins;
    player0: Address;
    stake0: Int as coins;
    player1: Address;
    stake1: Int as coins;
    player2: Address;
    stake2: Int as coins;

    // R7.69C — cancellation / refund authority
    refundMask: Int as uint8;
    refundedAmount: Int as coins;
    cancelReason: Int as uint32;

    residualSwept: Bool;

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
        self.paidMask = 0;
        self.totalPaid = 0;
        self.requiredTotal = 0;
        self.player0 = zero;
        self.stake0 = 0;
        self.player1 = zero;
        self.stake1 = 0;
        self.player2 = zero;
        self.stake2 = 0;
        self.refundMask = 0;
        self.refundedAmount = 0;
        self.cancelReason = 0;
        self.residualSwept = false;
    }

    /// Empty body — deploy path only. Player funds must use STAKE.
    receive() {
        // intentionally empty — deploy / gas top-up before payments open
        require(
            self.status == STATUS_UNINITIALIZED
                || self.status == STATUS_DEPLOYED
                || self.status == STATUS_WAITING_PAYMENTS,
            "GameEscrow: use STAKE for player deposits"
        );
    }

    receive(msg: InitGame) {
        // R17.9T.2.1 — only the declared oracle may claim INIT_GAME.
        require(sender() == msg.oracle, "GameEscrow: sender is not oracle");
        require(self.status == STATUS_UNINITIALIZED, "GameEscrow: not uninitialized");
        self.oracle = msg.oracle;
        self.owner = msg.owner;
        self.contractIdHash = msg.contractIdHash;
        self.snapshotHash = msg.snapshotHash;
        self.status = STATUS_DEPLOYED;
    }

    receive(msg: OpenPayments) {
        require(sender() == self.oracle, "GameEscrow: sender is not oracle");
        require(self.status == STATUS_DEPLOYED, "GameEscrow: not deployed");
        require(msg.stake0 > 0, "GameEscrow: invalid stake0");
        require(msg.stake1 > 0, "GameEscrow: invalid stake1");
        require(msg.stake2 > 0, "GameEscrow: invalid stake2");

        self.status = STATUS_WAITING_PAYMENTS;

        self.player0 = msg.player0;
        self.stake0 = msg.stake0;
        self.player1 = msg.player1;
        self.stake1 = msg.stake1;
        self.player2 = msg.player2;
        self.stake2 = msg.stake2;
        self.requiredTotal = msg.stake0 + msg.stake1 + msg.stake2;
        self.paidMask = 0;
        self.totalPaid = 0;
        self.refundMask = 0;
        self.refundedAmount = 0;
        self.cancelReason = 0;

        self.status = STATUS_PAYMENTS_OPEN;
    }

    receive(msg: Stake) {
        require(self.status == STATUS_PAYMENTS_OPEN, "GameEscrow: payments not open");
        require(self.settled == false, "GameEscrow: already settled");
        require(msg.playerIndex < PLAYER_COUNT, "GameEscrow: invalid player");

        let bit: Int = 1 << msg.playerIndex;
        require((self.paidMask & bit) == 0, "GameEscrow: already paid");

        let required: Int = 0;
        let expectedPlayer: Address = newAddress(0, 0);

        if (msg.playerIndex == 0) {
            required = self.stake0;
            expectedPlayer = self.player0;
        } else if (msg.playerIndex == 1) {
            required = self.stake1;
            expectedPlayer = self.player1;
        } else {
            required = self.stake2;
            expectedPlayer = self.player2;
        }

        require(sender() == expectedPlayer, "GameEscrow: wrong player wallet");
        require(context().value == required, "GameEscrow: invalid stake amount");

        self.paidMask = self.paidMask | bit;
        self.totalPaid = self.totalPaid + required;

        // READY only when every required seat has paid (on-chain authority).
        let allBits: Int = (1 << PLAYER_COUNT) - 1;
        if (self.paidMask == allBits) {
            self.status = STATUS_READY;
        }
    }

    receive(msg: Settle) {
        require(sender() == self.oracle, "GameEscrow: sender is not oracle");
        require(self.settled == false, "GameEscrow: already settled");
        require(msg.snapshotHash == self.snapshotHash, "GameEscrow: snapshot mismatch");
        // R7.69A — settle only after on-chain READY (all STAKE confirmed).
        require(self.status == STATUS_READY, "GameEscrow: not ready");

        let required: Int = msg.winnerAmount + msg.ownerAmount + SETTLE_GAS_RESERVE;
        require(myBalance() >= required, "GameEscrow: insufficient balance");

        self.status = STATUS_SETTLING;

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

    /// R7.69C — Oracle cancel before SETTLE; refund exact paid stakes once.
    receive(msg: EmergencyCancel) {
        require(sender() == self.oracle, "GameEscrow: sender is not oracle");
        require(self.settled == false, "GameEscrow: already settled");
        require(
            self.status == STATUS_PAYMENTS_OPEN || self.status == STATUS_READY,
            "GameEscrow: cancel not allowed"
        );

        // Compute exact refund total for paid seats not yet refunded.
        let pendingRefund: Int = 0;
        if ((self.paidMask & 1) != 0 && (self.refundMask & 1) == 0) {
            pendingRefund = pendingRefund + self.stake0;
        }
        if ((self.paidMask & 2) != 0 && (self.refundMask & 2) == 0) {
            pendingRefund = pendingRefund + self.stake1;
        }
        if ((self.paidMask & 4) != 0 && (self.refundMask & 4) == 0) {
            pendingRefund = pendingRefund + self.stake2;
        }

        require(
            myBalance() >= pendingRefund + CANCEL_GAS_RESERVE,
            "GameEscrow: insufficient balance for refunds"
        );

        self.cancelReason = msg.reasonCode;

        let nextMask: Int = self.refundMask;
        let refundedNow: Int = 0;

        if ((self.paidMask & 1) != 0 && (self.refundMask & 1) == 0) {
            send(SendParameters{
                to: self.player0,
                value: self.stake0,
                mode: SendPayGasSeparately,
                bounce: false
            });
            nextMask = nextMask | 1;
            refundedNow = refundedNow + self.stake0;
        }
        if ((self.paidMask & 2) != 0 && (self.refundMask & 2) == 0) {
            send(SendParameters{
                to: self.player1,
                value: self.stake1,
                mode: SendPayGasSeparately,
                bounce: false
            });
            nextMask = nextMask | 2;
            refundedNow = refundedNow + self.stake1;
        }
        if ((self.paidMask & 4) != 0 && (self.refundMask & 4) == 0) {
            send(SendParameters{
                to: self.player2,
                value: self.stake2,
                mode: SendPayGasSeparately,
                bounce: false
            });
            nextMask = nextMask | 4;
            refundedNow = refundedNow + self.stake2;
        }

        self.refundMask = nextMask;
        self.refundedAmount = self.refundedAmount + refundedNow;
        self.status = STATUS_CANCELLED;
    }

    /// Post-SETTLE residual to oracle/deploy wallet. Leaves SETTLE_GAS_RESERVE.
    receive(msg: SweepResidual) {
        require(sender() == self.oracle, "GameEscrow: sender is not oracle");
        require(self.status == STATUS_SETTLED, "GameEscrow: not settled");
        require(self.settled == true, "GameEscrow: not settled");
        require(self.residualSwept == false, "GameEscrow: already swept");
        require(myBalance() > SETTLE_GAS_RESERVE, "GameEscrow: insufficient residual");

        let amount: Int = myBalance() - SETTLE_GAS_RESERVE;
        require(amount > 0, "GameEscrow: insufficient residual");

        self.residualSwept = true;

        send(SendParameters{
            to: self.oracle,
            value: amount,
            mode: SendPayGasSeparately,
            bounce: false
        });
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

    get fun get_paid_mask(): Int {
        return self.paidMask;
    }

    get fun get_total_paid(): Int {
        return self.totalPaid;
    }

    get fun get_required_total(): Int {
        return self.requiredTotal;
    }

    get fun get_player_payment(index: Int): PlayerPaymentInfo {
        require(index >= 0 && index < PLAYER_COUNT, "GameEscrow: invalid player");

        let bit: Int = 1 << index;
        let paid: Bool = (self.paidMask & bit) != 0;

        if (index == 0) {
            return PlayerPaymentInfo{
                player: self.player0,
                requiredStake: self.stake0,
                paid: paid
            };
        }
        if (index == 1) {
            return PlayerPaymentInfo{
                player: self.player1,
                requiredStake: self.stake1,
                paid: paid
            };
        }
        return PlayerPaymentInfo{
            player: self.player2,
            requiredStake: self.stake2,
            paid: paid
        };
    }

    get fun get_refund_mask(): Int {
        return self.refundMask;
    }

    get fun get_refunded_total(): Int {
        return self.refundedAmount;
    }

    get fun get_cancel_status(): CancelStatus {
        return CancelStatus{
            cancelled: self.status == STATUS_CANCELLED,
            cancelReason: self.cancelReason,
            refundMask: self.refundMask
        };
    }

    get fun get_residual_swept(): Bool {
        return self.residualSwept;
    }
}
