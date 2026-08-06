/**
 * R7.66B — GameEscrow v1 Blueprint sandbox tests.
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

describe("GameEscrow v1", () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let oracle: SandboxContract<TreasuryContract>;
    let owner: SandboxContract<TreasuryContract>;
    let winner: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;
    let gameEscrow: SandboxContract<GameEscrow>;

    const contractIdHash = 0x1111111111111111111111111111111111111111111111111111111111111111n;
    const snapshotHash = 0x2222222222222222222222222222222222222222222222222222222222222222n;
    const winnerAmount = toNano("2.85");
    const ownerAmount = toNano("0.15");

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury("deployer");
        oracle = await blockchain.treasury("oracle");
        owner = await blockchain.treasury("owner");
        winner = await blockchain.treasury("winner");
        stranger = await blockchain.treasury("stranger");

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

    it("deploys contract", async () => {
        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_UNINITIALIZED);
    });

    it("INIT_GAME stores oracle/owner/hashes and sets DEPLOYED", async () => {
        const result = await initGame();

        expect(result.transactions).toHaveTransaction({
            from: deployer.address,
            to: gameEscrow.address,
            success: true
        });

        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_DEPLOYED);
        expect(await gameEscrow.getGetContractIdHash()).toEqual(contractIdHash);
        expect(await gameEscrow.getGetSnapshotHash()).toEqual(snapshotHash);
    });

    it("SETTLE from oracle stores settlement and sets SETTLED", async () => {
        await initGame();

        const result = await settleFrom(oracle);

        expect(result.transactions).toHaveTransaction({
            from: oracle.address,
            to: gameEscrow.address,
            success: true
        });

        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_SETTLED);

        const info = await gameEscrow.getGetSettlementInfo();
        expect(info.winner.equals(winner.address)).toBe(true);
        expect(info.winnerAmount).toEqual(winnerAmount);
        expect(info.ownerAmount).toEqual(ownerAmount);
        expect(info.settled).toBe(true);
    });

    it("rejects SETTLE from invalid sender", async () => {
        await initGame();

        const result = await settleFrom(stranger);

        expect(result.transactions).toHaveTransaction({
            from: stranger.address,
            to: gameEscrow.address,
            success: false
        });

        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_DEPLOYED);
        const info = await gameEscrow.getGetSettlementInfo();
        expect(info.settled).toBe(false);
    });

    it("rejects double SETTLE", async () => {
        await initGame();

        const first = await settleFrom(oracle);
        expect(first.transactions).toHaveTransaction({
            from: oracle.address,
            to: gameEscrow.address,
            success: true
        });

        const second = await settleFrom(oracle);
        expect(second.transactions).toHaveTransaction({
            from: oracle.address,
            to: gameEscrow.address,
            success: false
        });

        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_SETTLED);
    });
});
