/**
 * R7.69A / R7.69C — GameEscrow STAKE + payment lifecycle sandbox tests.
 */
import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { toNano } from "@ton/core";
import "@ton/test-utils";
import {
    GameEscrow,
    STATUS_CANCELLED,
    STATUS_DEPLOYED,
    STATUS_PAYMENTS_OPEN,
    STATUS_READY,
    STATUS_SETTLED,
    STATUS_UNINITIALIZED
} from "../wrappers/GameEscrow";

describe("GameEscrow stakes", () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let oracle: SandboxContract<TreasuryContract>;
    let owner: SandboxContract<TreasuryContract>;
    let playerA: SandboxContract<TreasuryContract>;
    let playerB: SandboxContract<TreasuryContract>;
    let playerC: SandboxContract<TreasuryContract>;
    let winner: SandboxContract<TreasuryContract>;
    let gameEscrow: SandboxContract<GameEscrow>;

    const contractIdHash = 0x1111111111111111111111111111111111111111111111111111111111111111n;
    const snapshotHash = 0x2222222222222222222222222222222222222222222222222222222222222222n;
    const stakeA = toNano("1");
    const stakeB = toNano("1");
    const stakeC = toNano("1");
    const winnerAmount = toNano("2.85");
    const ownerAmount = toNano("0.15");

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury("deployer");
        oracle = await blockchain.treasury("oracle");
        owner = await blockchain.treasury("owner");
        playerA = await blockchain.treasury("playerA");
        playerB = await blockchain.treasury("playerB");
        playerC = await blockchain.treasury("playerC");
        winner = playerA;

        gameEscrow = blockchain.openContract(await GameEscrow.fromInit());

        const deployResult = await gameEscrow.send(
            deployer.getSender(),
            { value: toNano("0.05") },
            null
        );

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: gameEscrow.address,
            deploy: true,
            success: true
        });

        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_UNINITIALIZED);
    });

    async function initGame() {
        return gameEscrow.send(
            deployer.getSender(),
            { value: toNano("0.05") },
            {
                $$type: "InitGame",
                oracle: oracle.address,
                owner: owner.address,
                contractIdHash,
                snapshotHash
            }
        );
    }

    async function openPayments() {
        return gameEscrow.send(
            oracle.getSender(),
            { value: toNano("0.05") },
            {
                $$type: "OpenPayments",
                player0: playerA.address,
                stake0: stakeA,
                player1: playerB.address,
                stake1: stakeB,
                player2: playerC.address,
                stake2: stakeC
            }
        );
    }

    async function stake(
        player: SandboxContract<TreasuryContract>,
        index: number,
        value: bigint
    ) {
        return gameEscrow.send(
            player.getSender(),
            { value },
            {
                $$type: "Stake",
                playerIndex: BigInt(index)
            }
        );
    }

    async function settleFrom(sender: SandboxContract<TreasuryContract>) {
        return gameEscrow.send(
            sender.getSender(),
            { value: toNano("0.05") },
            {
                $$type: "Settle",
                snapshotHash,
                winner: winner.address,
                winnerAmount,
                ownerAmount
            }
        );
    }

    async function emergencyCancel(
        sender: SandboxContract<TreasuryContract>,
        reasonCode = 1n
    ) {
        return gameEscrow.send(
            sender.getSender(),
            { value: toNano("0.1") },
            {
                $$type: "EmergencyCancel",
                reasonCode
            }
        );
    }

    it("player A/B/C pay → READY → SETTLE pays winner and owner", async () => {
        await initGame();
        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_DEPLOYED);

        await openPayments();
        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_PAYMENTS_OPEN);
        expect(await gameEscrow.getGetRequiredTotal()).toEqual(stakeA + stakeB + stakeC);
        expect(await gameEscrow.getGetPaidMask()).toEqual(0n);

        const a = await stake(playerA, 0, stakeA);
        expect(a.transactions).toHaveTransaction({
            from: playerA.address,
            to: gameEscrow.address,
            success: true
        });
        expect(await gameEscrow.getGetPaidMask()).toEqual(1n);

        const b = await stake(playerB, 1, stakeB);
        expect(b.transactions).toHaveTransaction({
            from: playerB.address,
            to: gameEscrow.address,
            success: true
        });
        expect(await gameEscrow.getGetPaidMask()).toEqual(3n);

        const c = await stake(playerC, 2, stakeC);
        expect(c.transactions).toHaveTransaction({
            from: playerC.address,
            to: gameEscrow.address,
            success: true
        });
        expect(await gameEscrow.getGetPaidMask()).toEqual(7n);
        expect(await gameEscrow.getGetTotalPaid()).toEqual(stakeA + stakeB + stakeC);
        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_READY);

        const payment0 = await gameEscrow.getGetPlayerPayment(0n);
        expect(payment0.paid).toBe(true);
        expect(payment0.requiredStake).toEqual(stakeA);

        const winnerBefore = (await blockchain.getContract(winner.address)).balance;
        const ownerBefore = (await blockchain.getContract(owner.address)).balance;

        const settle = await settleFrom(oracle);
        expect(settle.transactions).toHaveTransaction({
            from: oracle.address,
            to: gameEscrow.address,
            success: true
        });
        expect(settle.transactions).toHaveTransaction({
            from: gameEscrow.address,
            to: winner.address,
            value: winnerAmount,
            success: true
        });
        expect(settle.transactions).toHaveTransaction({
            from: gameEscrow.address,
            to: owner.address,
            value: ownerAmount,
            success: true
        });

        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_SETTLED);

        const winnerGain =
            (await blockchain.getContract(winner.address)).balance - winnerBefore;
        const ownerGain =
            (await blockchain.getContract(owner.address)).balance - ownerBefore;
        expect(winnerGain).toBeGreaterThan(winnerAmount - toNano("0.01"));
        expect(ownerGain).toBeGreaterThan(ownerAmount - toNano("0.01"));
    });

    it("duplicate payment rejected", async () => {
        await initGame();
        await openPayments();
        await stake(playerA, 0, stakeA);

        const dup = await stake(playerA, 0, stakeA);
        expect(dup.transactions).toHaveTransaction({
            from: playerA.address,
            to: gameEscrow.address,
            success: false
        });
        expect(await gameEscrow.getGetPaidMask()).toEqual(1n);
    });

    it("wrong amount rejected", async () => {
        await initGame();
        await openPayments();

        const bad = await stake(playerA, 0, toNano("0.5"));
        expect(bad.transactions).toHaveTransaction({
            from: playerA.address,
            to: gameEscrow.address,
            success: false
        });
        expect(await gameEscrow.getGetPaidMask()).toEqual(0n);
    });

    it("invalid player rejected", async () => {
        await initGame();
        await openPayments();

        const badIndex = await stake(playerA, 3, stakeA);
        expect(badIndex.transactions).toHaveTransaction({
            from: playerA.address,
            to: gameEscrow.address,
            success: false
        });

        const wrongWallet = await stake(playerB, 0, stakeA);
        expect(wrongWallet.transactions).toHaveTransaction({
            from: playerB.address,
            to: gameEscrow.address,
            success: false
        });
    });

    it("payment after READY rejected", async () => {
        await initGame();
        await openPayments();
        await stake(playerA, 0, stakeA);
        await stake(playerB, 1, stakeB);
        await stake(playerC, 2, stakeC);
        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_READY);

        // Extra stake attempt with a fresh treasury pretending to be unpaid — status blocks.
        const extra = await gameEscrow.send(
            playerA.getSender(),
            { value: stakeA },
            { $$type: "Stake", playerIndex: 0n }
        );
        expect(extra.transactions).toHaveTransaction({
            from: playerA.address,
            to: gameEscrow.address,
            success: false
        });
    });

    it("payment after SETTLED rejected", async () => {
        await initGame();
        await openPayments();
        await stake(playerA, 0, stakeA);
        await stake(playerB, 1, stakeB);
        await stake(playerC, 2, stakeC);
        await settleFrom(oracle);
        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_SETTLED);

        const afterSettle = await stake(playerA, 0, stakeA);
        expect(afterSettle.transactions).toHaveTransaction({
            from: playerA.address,
            to: gameEscrow.address,
            success: false
        });
    });

    it("SETTLE before READY rejected", async () => {
        await initGame();
        await openPayments();
        await stake(playerA, 0, stakeA);

        const early = await settleFrom(oracle);
        expect(early.transactions).toHaveTransaction({
            from: oracle.address,
            to: gameEscrow.address,
            success: false
        });
        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_PAYMENTS_OPEN);
    });
});

describe("GameEscrow cancel and refunds (R7.69C)", () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let oracle: SandboxContract<TreasuryContract>;
    let owner: SandboxContract<TreasuryContract>;
    let playerA: SandboxContract<TreasuryContract>;
    let playerB: SandboxContract<TreasuryContract>;
    let playerC: SandboxContract<TreasuryContract>;
    let gameEscrow: SandboxContract<GameEscrow>;

    const contractIdHash = 0x3333333333333333333333333333333333333333333333333333333333333333n;
    const snapshotHash = 0x4444444444444444444444444444444444444444444444444444444444444444n;
    const stakeA = toNano("1");
    const stakeB = toNano("1.5");
    const stakeC = toNano("2");
    const winnerAmount = toNano("4");
    const ownerAmount = toNano("0.5");

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury("deployer");
        oracle = await blockchain.treasury("oracle");
        owner = await blockchain.treasury("owner");
        playerA = await blockchain.treasury("playerA");
        playerB = await blockchain.treasury("playerB");
        playerC = await blockchain.treasury("playerC");

        gameEscrow = blockchain.openContract(await GameEscrow.fromInit());

        await gameEscrow.send(
            deployer.getSender(),
            { value: toNano("0.05") },
            null
        );
    });

    async function initAndOpen() {
        await gameEscrow.send(
            deployer.getSender(),
            { value: toNano("0.05") },
            {
                $$type: "InitGame",
                oracle: oracle.address,
                owner: owner.address,
                contractIdHash,
                snapshotHash
            }
        );
        await gameEscrow.send(
            oracle.getSender(),
            { value: toNano("0.05") },
            {
                $$type: "OpenPayments",
                player0: playerA.address,
                stake0: stakeA,
                player1: playerB.address,
                stake1: stakeB,
                player2: playerC.address,
                stake2: stakeC
            }
        );
    }

    async function stake(
        player: SandboxContract<TreasuryContract>,
        index: number,
        value: bigint
    ) {
        return gameEscrow.send(
            player.getSender(),
            { value },
            { $$type: "Stake", playerIndex: BigInt(index) }
        );
    }

    async function cancel(reasonCode = 42n) {
        return gameEscrow.send(
            oracle.getSender(),
            { value: toNano("0.1") },
            { $$type: "EmergencyCancel", reasonCode }
        );
    }

    it("cancel before READY with no payments → CANCELLED, empty refunds", async () => {
        await initAndOpen();
        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_PAYMENTS_OPEN);

        const result = await cancel(7n);
        expect(result.transactions).toHaveTransaction({
            from: oracle.address,
            to: gameEscrow.address,
            success: true
        });

        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_CANCELLED);
        expect(await gameEscrow.getGetRefundMask()).toEqual(0n);
        expect(await gameEscrow.getGetRefundedTotal()).toEqual(0n);

        const cancelStatus = await gameEscrow.getGetCancelStatus();
        expect(cancelStatus.cancelled).toBe(true);
        expect(cancelStatus.cancelReason).toEqual(7n);
        expect(cancelStatus.refundMask).toEqual(0n);
    });

    it("cancel after partial payments refunds only paid seats", async () => {
        await initAndOpen();
        await stake(playerA, 0, stakeA);
        await stake(playerB, 1, stakeB);
        expect(await gameEscrow.getGetPaidMask()).toEqual(3n);

        const aBefore = (await blockchain.getContract(playerA.address)).balance;
        const bBefore = (await blockchain.getContract(playerB.address)).balance;
        const cBefore = (await blockchain.getContract(playerC.address)).balance;

        const result = await cancel();
        expect(result.transactions).toHaveTransaction({
            from: gameEscrow.address,
            to: playerA.address,
            value: stakeA,
            success: true
        });
        expect(result.transactions).toHaveTransaction({
            from: gameEscrow.address,
            to: playerB.address,
            value: stakeB,
            success: true
        });
        expect(result.transactions).not.toHaveTransaction({
            from: gameEscrow.address,
            to: playerC.address
        });

        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_CANCELLED);
        expect(await gameEscrow.getGetRefundMask()).toEqual(3n);
        expect(await gameEscrow.getGetRefundedTotal()).toEqual(stakeA + stakeB);

        const aGain =
            (await blockchain.getContract(playerA.address)).balance - aBefore;
        const bGain =
            (await blockchain.getContract(playerB.address)).balance - bBefore;
        const cGain =
            (await blockchain.getContract(playerC.address)).balance - cBefore;
        expect(aGain).toBeGreaterThan(stakeA - toNano("0.01"));
        expect(bGain).toBeGreaterThan(stakeB - toNano("0.01"));
        expect(cGain).toEqual(0n);
    });

    it("refund 1 player", async () => {
        await initAndOpen();
        await stake(playerA, 0, stakeA);

        const result = await cancel();
        expect(result.transactions).toHaveTransaction({
            from: gameEscrow.address,
            to: playerA.address,
            value: stakeA,
            success: true
        });
        expect(await gameEscrow.getGetRefundMask()).toEqual(1n);
        expect(await gameEscrow.getGetRefundedTotal()).toEqual(stakeA);
        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_CANCELLED);
    });

    it("refund 2 players", async () => {
        await initAndOpen();
        await stake(playerA, 0, stakeA);
        await stake(playerC, 2, stakeC);

        const result = await cancel();
        expect(result.transactions).toHaveTransaction({
            from: gameEscrow.address,
            to: playerA.address,
            value: stakeA,
            success: true
        });
        expect(result.transactions).toHaveTransaction({
            from: gameEscrow.address,
            to: playerC.address,
            value: stakeC,
            success: true
        });
        expect(await gameEscrow.getGetRefundMask()).toEqual(5n);
        expect(await gameEscrow.getGetRefundedTotal()).toEqual(stakeA + stakeC);
    });

    it("refund 3 players after READY", async () => {
        await initAndOpen();
        await stake(playerA, 0, stakeA);
        await stake(playerB, 1, stakeB);
        await stake(playerC, 2, stakeC);
        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_READY);

        const result = await cancel(99n);
        expect(result.transactions).toHaveTransaction({
            from: gameEscrow.address,
            to: playerA.address,
            value: stakeA,
            success: true
        });
        expect(result.transactions).toHaveTransaction({
            from: gameEscrow.address,
            to: playerB.address,
            value: stakeB,
            success: true
        });
        expect(result.transactions).toHaveTransaction({
            from: gameEscrow.address,
            to: playerC.address,
            value: stakeC,
            success: true
        });

        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_CANCELLED);
        expect(await gameEscrow.getGetRefundMask()).toEqual(7n);
        expect(await gameEscrow.getGetRefundedTotal()).toEqual(
            stakeA + stakeB + stakeC
        );

        const cancelStatus = await gameEscrow.getGetCancelStatus();
        expect(cancelStatus.cancelled).toBe(true);
        expect(cancelStatus.cancelReason).toEqual(99n);
        expect(cancelStatus.refundMask).toEqual(7n);
    });

    it("double cancel / refund rejected", async () => {
        await initAndOpen();
        await stake(playerA, 0, stakeA);
        await cancel();
        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_CANCELLED);

        const again = await cancel(2n);
        expect(again.transactions).toHaveTransaction({
            from: oracle.address,
            to: gameEscrow.address,
            success: false
        });
        expect(await gameEscrow.getGetRefundMask()).toEqual(1n);
        expect(await gameEscrow.getGetRefundedTotal()).toEqual(stakeA);
    });

    it("cancel after SETTLE rejected", async () => {
        await initAndOpen();
        await stake(playerA, 0, stakeA);
        await stake(playerB, 1, stakeB);
        await stake(playerC, 2, stakeC);

        await gameEscrow.send(
            oracle.getSender(),
            { value: toNano("0.05") },
            {
                $$type: "Settle",
                snapshotHash,
                winner: playerA.address,
                winnerAmount,
                ownerAmount
            }
        );
        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_SETTLED);

        const cancelAttempt = await cancel();
        expect(cancelAttempt.transactions).toHaveTransaction({
            from: oracle.address,
            to: gameEscrow.address,
            success: false
        });
        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_SETTLED);
        expect(await gameEscrow.getGetRefundMask()).toEqual(0n);
    });

    it("non-oracle cancel rejected", async () => {
        await initAndOpen();
        await stake(playerA, 0, stakeA);

        const bad = await gameEscrow.send(
            playerA.getSender(),
            { value: toNano("0.1") },
            { $$type: "EmergencyCancel", reasonCode: 1n }
        );
        expect(bad.transactions).toHaveTransaction({
            from: playerA.address,
            to: gameEscrow.address,
            success: false
        });
        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_PAYMENTS_OPEN);
    });
});
