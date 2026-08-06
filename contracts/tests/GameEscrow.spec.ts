/**
 * R7.66C — GameEscrow payout sandbox tests.
 */
import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { toNano } from "@ton/core";
import "@ton/test-utils";
import {
    GameEscrow,
    STATUS_DEPLOYED,
    STATUS_SETTLED,
    STATUS_UNINITIALIZED
} from "../wrappers/GameEscrow";

describe("GameEscrow payouts", () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let oracle: SandboxContract<TreasuryContract>;
    let owner: SandboxContract<TreasuryContract>;
    let winner: SandboxContract<TreasuryContract>;
    let funder: SandboxContract<TreasuryContract>;
    let gameEscrow: SandboxContract<GameEscrow>;

    const contractIdHash = 0x1111111111111111111111111111111111111111111111111111111111111111n;
    const snapshotHash = 0x2222222222222222222222222222222222222222222222222222222222222222n;
    const winnerAmount = toNano("2.85");
    const ownerAmount = toNano("0.15");
    const fundAmount = toNano("4");

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury("deployer");
        oracle = await blockchain.treasury("oracle");
        owner = await blockchain.treasury("owner");
        winner = await blockchain.treasury("winner");
        funder = await blockchain.treasury("funder");

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

    async function fundEscrow(value: bigint) {
        return gameEscrow.send(
            funder.getSender(),
            { value },
            null
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

    it("Case 1: funds escrow with TON", async () => {
        await initGame();

        const before = (await blockchain.getContract(gameEscrow.address)).balance;
        const result = await fundEscrow(fundAmount);

        expect(result.transactions).toHaveTransaction({
            from: funder.address,
            to: gameEscrow.address,
            success: true,
            value: fundAmount
        });

        const after = (await blockchain.getContract(gameEscrow.address)).balance;
        expect(after).toBeGreaterThan(before);
        expect(after - before).toBeGreaterThanOrEqual(fundAmount - toNano("0.02"));
        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_DEPLOYED);
    });

    it("Case 2: valid SETTLE pays winner and owner", async () => {
        await initGame();
        await fundEscrow(fundAmount);

        const winnerBefore = (await blockchain.getContract(winner.address)).balance;
        const ownerBefore = (await blockchain.getContract(owner.address)).balance;

        const result = await settleFrom(oracle);

        expect(result.transactions).toHaveTransaction({
            from: oracle.address,
            to: gameEscrow.address,
            success: true
        });
        expect(result.transactions).toHaveTransaction({
            from: gameEscrow.address,
            to: winner.address,
            value: winnerAmount,
            success: true
        });
        expect(result.transactions).toHaveTransaction({
            from: gameEscrow.address,
            to: owner.address,
            value: ownerAmount,
            success: true
        });

        const winnerAfter = (await blockchain.getContract(winner.address)).balance;
        const ownerAfter = (await blockchain.getContract(owner.address)).balance;

        // Recipient wallets spend a small amount of gas processing the inbound transfer.
        const winnerGain = winnerAfter - winnerBefore;
        const ownerGain = ownerAfter - ownerBefore;
        expect(winnerGain).toBeGreaterThan(winnerAmount - toNano("0.01"));
        expect(winnerGain).toBeLessThanOrEqual(winnerAmount);
        expect(ownerGain).toBeGreaterThan(ownerAmount - toNano("0.01"));
        expect(ownerGain).toBeLessThanOrEqual(ownerAmount);
        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_SETTLED);

        const info = await gameEscrow.getGetSettlementInfo();
        expect(info.winner.equals(winner.address)).toBe(true);
        expect(info.winnerAmount).toEqual(winnerAmount);
        expect(info.ownerAmount).toEqual(ownerAmount);
        expect(info.settled).toBe(true);
    });

    it("Case 3: insufficient balance rejected", async () => {
        await initGame();
        // Far below winnerAmount + ownerAmount + gas reserve.
        await fundEscrow(toNano("0.1"));

        const result = await settleFrom(oracle);

        expect(result.transactions).toHaveTransaction({
            from: oracle.address,
            to: gameEscrow.address,
            success: false
        });

        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_DEPLOYED);
        const info = await gameEscrow.getGetSettlementInfo();
        expect(info.settled).toBe(false);
    });

    it("Case 4: double settle rejected", async () => {
        await initGame();
        await fundEscrow(fundAmount);

        const first = await settleFrom(oracle);
        expect(first.transactions).toHaveTransaction({
            from: oracle.address,
            to: gameEscrow.address,
            success: true
        });
        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_SETTLED);

        // Top up again so rejection is due to settled flag, not balance.
        await fundEscrow(fundAmount);

        const second = await settleFrom(oracle);
        expect(second.transactions).toHaveTransaction({
            from: oracle.address,
            to: gameEscrow.address,
            success: false
        });

        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_SETTLED);
    });
});
