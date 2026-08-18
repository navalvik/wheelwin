/// R17.9L.11 — Deposit Contract (financial guarantee layer only).
/// Immutable three-seat deposit escrow with player-funded deploy and oracle release/refund.

const DEPOSIT_CONTRACT_VERSION: Int = 1;
const SEAT_COUNT: Int = 3;
const ALL_SEATS_MASK: Int = 7; // 0b111

const STATUS_UNINITIALIZED: Int = 0;
const STATUS_AWAITING_FUNDS: Int = 1;
const STATUS_PARTIALLY_FUNDED: Int = 2;
const STATUS_FULL: Int = 3;
const STATUS_RELEASED: Int = 4;
const STATUS_REFUNDING: Int = 5;
const STATUS_REFUNDED: Int = 6;
const STATUS_EXPIRED: Int = 7;

/// Gas cushion for release forward fee.
const RELEASE_GAS_RESERVE: Int = ton("0.05");

/// Gas cushion for up to three refund sends plus surplus distribution.
const REFUND_GAS_RESERVE: Int = ton("0.08");

/// FUND — FundSeat { seatIndex }
message(0x46554E44) FundSeat {
    seatIndex: Int as uint8;
}

/// RELE — Release { gameContract, gameIdHash }
message(0x52454C45) Release {
    gameContract: Address;
    gameIdHash: Int as uint256;
}

/// EXPR — Expire {}
message(0x45585052) Expire {}

/// RFND — Refund {}
message(0x52464644) Refund {}

contract DepositContract(
    contractVersion: Int as uint16,
    depositIdHash: Int as uint256,
    roomIdHash: Int as uint256,
    gameIdHash: Int as uint256,
    player0: Address,
    player1: Address,
    player2: Address,
    expectedStake0: Int as coins,
    expectedStake1: Int as coins,
    expectedStake2: Int as coins,
    creationFeePerSeat: Int as coins,
    expiresAt: Int as uint64,
    releaseAuthority: Address,
    networkTag: Int as uint8,
    status: Int as uint8,
    paidMask: Int as uint8,
    creditedAmount0: Int as coins,
    creditedAmount1: Int as coins,
    creditedAmount2: Int as coins,
    surplusNano: Int as coins,
    refundMask: Int as uint8,
    releasedTo: Address,
    totalCredited: Int as coins
) {
    /// Immutable binding fields are never assigned after deploy.
    /// Mutable fields are initialized in StateInit at deploy time.

    /// Empty receive: allowed once at deploy (UNINITIALIZED → AWAITING_FUNDS).
    /// All post-deploy empty transfers bounce (no donation path).
    receive() {
        if (self.status == STATUS_UNINITIALIZED) {
            self.status = STATUS_AWAITING_FUNDS;
            return;
        }

        throw(104);
    }

    receive(msg: FundSeat) {
        self.requireFundable();

        require(msg.seatIndex < SEAT_COUNT, "DepositContract: invalid seat");

        let seatBit: Int = 1 << msg.seatIndex;

        require((self.paidMask & seatBit) == 0, "DepositContract: seat already funded");

        let expectedPlayer: Address = self.playerForSeat(msg.seatIndex);

        require(sender() == expectedPlayer, "DepositContract: wrong player wallet");

        let expectedAmount: Int = self.expectedAmountForSeat(msg.seatIndex);
        let creditedBefore: Int = self.creditedAmountForSeat(msg.seatIndex);
        let remaining: Int = expectedAmount - creditedBefore;

        require(remaining > 0, "DepositContract: seat already credited");

        let inbound: Int = context().value;
        let credit: Int = inbound;

        if (credit > remaining) {
            credit = remaining;
        }

        self.setCreditedAmountForSeat(msg.seatIndex, creditedBefore + credit);
        self.surplusNano = self.surplusNano + (inbound - credit);
        self.totalCredited = self.totalCredited + credit;

        if (self.creditedAmountForSeat(msg.seatIndex) >= expectedAmount) {
            self.paidMask = self.paidMask | seatBit;
        }

        self.refreshFundingStatus();
    }

    receive(msg: Expire) {
        require(now() > self.expiresAt, "DepositContract: not expired");
        require(
            self.status != STATUS_RELEASED && self.status != STATUS_REFUNDED,
            "DepositContract: terminal state"
        );

        self.status = STATUS_EXPIRED;
    }

    receive(msg: Release) {
        require(sender() == self.releaseAuthority, "DepositContract: unauthorized release");
        require(self.status == STATUS_FULL, "DepositContract: not full");
        require(self.releasedTo == newAddress(0, 0), "DepositContract: already released");
        require(msg.gameContract != newAddress(0, 0), "DepositContract: invalid game contract");
        require(msg.gameIdHash == self.gameIdHash, "DepositContract: game binding mismatch");

        let payout: Int = myBalance() - RELEASE_GAS_RESERVE;

        require(payout > 0, "DepositContract: insufficient balance for release");

        send(SendParameters{
            to: msg.gameContract,
            value: payout,
            mode: SendPayGasSeparately,
            bounce: false
        });

        self.releasedTo = msg.gameContract;
        self.status = STATUS_RELEASED;
    }

    receive(msg: Refund) {
        require(
            self.status != STATUS_RELEASED && self.status != STATUS_REFUNDED,
            "DepositContract: terminal state"
        );

        if (now() <= self.expiresAt && self.status != STATUS_EXPIRED) {
            require(sender() == self.releaseAuthority, "DepositContract: unauthorized refund");
        }

        self.executeRefund();
    }

    fun requireFundable() {
        require(
            self.status != STATUS_RELEASED
                && self.status != STATUS_REFUNDED
                && self.status != STATUS_REFUNDING,
            "DepositContract: terminal state"
        );
        require(self.status != STATUS_EXPIRED, "DepositContract: expired");
        require(now() <= self.expiresAt, "DepositContract: expired");
    }

    fun playerForSeat(seatIndex: Int): Address {
        if (seatIndex == 0) {
            return self.player0;
        }
        if (seatIndex == 1) {
            return self.player1;
        }
        return self.player2;
    }

    fun expectedAmountForSeat(seatIndex: Int): Int {
        if (seatIndex == 0) {
            return self.expectedStake0 + self.creationFeePerSeat;
        }
        if (seatIndex == 1) {
            return self.expectedStake1 + self.creationFeePerSeat;
        }
        return self.expectedStake2 + self.creationFeePerSeat;
    }

    fun creditedAmountForSeat(seatIndex: Int): Int {
        if (seatIndex == 0) {
            return self.creditedAmount0;
        }
        if (seatIndex == 1) {
            return self.creditedAmount1;
        }
        return self.creditedAmount2;
    }

    fun setCreditedAmountForSeat(seatIndex: Int, amount: Int) {
        if (seatIndex == 0) {
            self.creditedAmount0 = amount;
            return;
        }
        if (seatIndex == 1) {
            self.creditedAmount1 = amount;
            return;
        }
        self.creditedAmount2 = amount;
    }

    fun refreshFundingStatus() {
        if (self.paidMask == ALL_SEATS_MASK) {
            self.status = STATUS_FULL;
            return;
        }

        if (
            self.paidMask != 0
                || self.creditedAmount0 > 0
                || self.creditedAmount1 > 0
                || self.creditedAmount2 > 0
        ) {
            self.status = STATUS_PARTIALLY_FUNDED;
            return;
        }

        self.status = STATUS_AWAITING_FUNDS;
    }

    fun executeRefund() {
        self.status = STATUS_REFUNDING;

        self.refundSeatIfNeeded(0, 1, self.player0);
        self.refundSeatIfNeeded(1, 2, self.player1);
        self.refundSeatIfNeeded(2, 4, self.player2);

        if (self.surplusNano > 0 && self.totalCredited > 0) {
            self.distributeSurplusProRata();
        }

        self.status = STATUS_REFUNDED;
    }

    fun refundSeatIfNeeded(
        seatIndex: Int,
        seatBit: Int,
        destination: Address
    ) {
        if ((self.refundMask & seatBit) != 0) {
            return;
        }

        let credited: Int = self.creditedAmountForSeat(seatIndex);

        if (credited <= 0) {
            return;
        }

        require(
            myBalance() >= credited + REFUND_GAS_RESERVE,
            "DepositContract: insufficient balance for refund"
        );

        send(SendParameters{
            to: destination,
            value: credited,
            mode: SendPayGasSeparately,
            bounce: false
        });

        self.refundMask = self.refundMask | seatBit;
    }

    fun distributeSurplusProRata() {
        let pool: Int = self.surplusNano;

        if (pool <= 0 || self.totalCredited <= 0) {
            return;
        }

        let sentTotal: Int = 0;

        sentTotal = sentTotal + self.sendSurplusShare(self.player0, self.creditedAmount0, pool);
        sentTotal = sentTotal + self.sendSurplusShare(self.player1, self.creditedAmount1, pool);
        sentTotal = sentTotal + self.sendSurplusShare(self.player2, self.creditedAmount2, pool);

        self.surplusNano = pool - sentTotal;
    }

    fun sendSurplusShare(
        destination: Address,
        credited: Int,
        pool: Int
    ): Int {
        if (pool <= 0 || credited <= 0) {
            return 0;
        }

        let share: Int = (pool * credited) / self.totalCredited;

        if (share <= 0) {
            return 0;
        }

        require(
            myBalance() >= share + ton("0.02"),
            "DepositContract: insufficient balance for surplus refund"
        );

        send(SendParameters{
            to: destination,
            value: share,
            mode: SendPayGasSeparately,
            bounce: false
        });

        return share;
    }

    get fun get_version(): Int {
        return self.contractVersion;
    }

    get fun get_deposit_id(): Int {
        return self.depositIdHash;
    }

    get fun get_room_id_hash(): Int {
        return self.roomIdHash;
    }

    get fun get_game_id_hash(): Int {
        return self.gameIdHash;
    }

    get fun get_player0(): Address {
        return self.player0;
    }

    get fun get_player1(): Address {
        return self.player1;
    }

    get fun get_player2(): Address {
        return self.player2;
    }

    get fun get_expected_stake0(): Int {
        return self.expectedStake0;
    }

    get fun get_expected_stake1(): Int {
        return self.expectedStake1;
    }

    get fun get_expected_stake2(): Int {
        return self.expectedStake2;
    }

    get fun get_creation_fee_per_seat(): Int {
        return self.creationFeePerSeat;
    }

    get fun get_expected_amount0(): Int {
        return self.expectedStake0 + self.creationFeePerSeat;
    }

    get fun get_expected_amount1(): Int {
        return self.expectedStake1 + self.creationFeePerSeat;
    }

    get fun get_expected_amount2(): Int {
        return self.expectedStake2 + self.creationFeePerSeat;
    }

    get fun get_paid_mask(): Int {
        return self.paidMask;
    }

    get fun get_status(): Int {
        return self.status;
    }

    get fun get_credited_amount0(): Int {
        return self.creditedAmount0;
    }

    get fun get_credited_amount1(): Int {
        return self.creditedAmount1;
    }

    get fun get_credited_amount2(): Int {
        return self.creditedAmount2;
    }

    get fun get_surplus_nano(): Int {
        return self.surplusNano;
    }

    get fun get_expires_at(): Int {
        return self.expiresAt;
    }

    get fun get_release_authority(): Address {
        return self.releaseAuthority;
    }

    get fun get_network_tag(): Int {
        return self.networkTag;
    }

    get fun get_released_to(): Address {
        if (self.status == STATUS_RELEASED) {
            return self.releasedTo;
        }
        return newAddress(0, 0);
    }

    get fun get_refund_mask(): Int {
        return self.refundMask;
    }

    get fun get_total_credited(): Int {
        return self.totalCredited;
    }
}
