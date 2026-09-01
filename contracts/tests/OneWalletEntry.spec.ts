/**
 * R18-S16 — One-wallet entry sequencing against frozen DepositContract + GameEscrow.
 * GameEscrow is opened before player payments. SETTLE remains blocked until READY.
 */
import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { Address, toNano } from "@ton/core";
import "@ton/test-utils";
import {
    DepositContract,
    DEPOSIT_CONTRACT_VERSION,
    STATUS_AWAITING_FUNDS,
    STATUS_PARTIALLY_FUNDED,
    STATUS_FULL
} from "../wrappers/DepositContract";
import {
    GameEscrow,
    STATUS_PAYMENTS_OPEN,
    STATUS_READY
} from "../wrappers/GameEscrow";

const ZERO_ADDRESS = new Address(0, Buffer.alloc(32));
const depositIdHash = 0x1111111111111111111111111111111111111111111111111111111111111111n;
const roomIdHash = 0x2222222222222222222222222222222222222222222222222222222222222222n;
const gameIdHash = 0x3333333333333333333333333333333333333333333333333333333333333333n;
const contractIdHash = 0x4444444444444444444444444444444444444444444444444444444444444444n;
const snapshotHash = 0x5555555555555555555555555555555555555555555555555555555555555555n;

const stake = toNano("0.01");
const creationFee = toNano("0.001");
const expectedAmount = stake + creationFee;
const deployAttach = toNano("0.01");

function sandboxNow(blockchain: Blockchain) {
    return blockchain.now ?? Math.floor(Date.now() / 1000);
}

describe("R18-S16 one-wallet entry", () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let oracle: SandboxContract<TreasuryContract>;
    let owner: SandboxContract<TreasuryContract>;
    let playerA: SandboxContract<TreasuryContract>;
    let playerB: SandboxContract<TreasuryContract>;
    let playerC: SandboxContract<TreasuryContract>;
    let attacker: SandboxContract<TreasuryContract>;
    let gameEscrow: SandboxContract<GameEscrow>;
    let deposit: SandboxContract<DepositContract>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury("deployer");
        oracle = await blockchain.treasury("oracle");
        owner = await blockchain.treasury("owner");
        playerA = await blockchain.treasury("playerA");
        playerB = await blockchain.treasury("playerB");
        playerC = await blockchain.treasury("playerC");
        attacker = await blockchain.treasury("attacker");

        gameEscrow = blockchain.openContract(await GameEscrow.fromInit());
        await gameEscrow.send(deployer.getSender(), { value: toNano("0.05") }, null);

        await gameEscrow.send(
            oracle.getSender(),
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
                stake0: stake,
                player1: playerB.address,
                stake1: stake,
                player2: playerC.address,
                stake2: stake
            }
        );

        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_PAYMENTS_OPEN);

        const chainNow = sandboxNow(blockchain);
        const opened = await DepositContract.fromInit(
            DEPOSIT_CONTRACT_VERSION,
            depositIdHash,
            roomIdHash,
            gameIdHash,
            playerA.address,
            playerB.address,
            playerC.address,
            stake,
            stake,
            stake,
            creationFee,
            BigInt(chainNow + 86400 * 30),
            oracle.address,
            0n,
            0n,
            0n,
            0n,
            0n,
            0n,
            0n,
            0n,
            ZERO_ADDRESS,
            0n
        );
        deposit = blockchain.openContract(opened);
    });

    async function deployThenFundCreator() {
        const deployResult = await deposit.send(
            playerA.getSender(),
            { value: deployAttach },
            null
        );
        expect(deployResult.transactions).toHaveTransaction({
            from: playerA.address,
            to: deposit.address,
            deploy: true,
            success: true
        });
        expect(await deposit.getGetStatus()).toEqual(STATUS_AWAITING_FUNDS);

        const fundResult = await deposit.send(
            playerA.getSender(),
            { value: expectedAmount },
            { $$type: "FundSeat", seatIndex: 0n }
        );
        expect(fundResult.transactions).toHaveTransaction({
            from: playerA.address,
            to: deposit.address,
            success: true
        });
        expect(await deposit.getGetStatus()).toEqual(STATUS_PARTIALLY_FUNDED);
        return fundResult;
    }

    async function stakeSeat(
        player: SandboxContract<TreasuryContract>,
        index: number
    ) {
        return gameEscrow.send(
            player.getSender(),
            { value: stake },
            { $$type: "Stake", playerIndex: BigInt(index) }
        );
    }

    it("creator deploy then FundSeat then STAKE after GameEscrow is already OPEN", async () => {
        await deployThenFundCreator();
        const stakeResult = await stakeSeat(playerA, 0);
        expect(stakeResult.transactions).toHaveTransaction({
            from: playerA.address,
            to: gameEscrow.address,
            success: true
        });
        expect((await gameEscrow.getGetPaidMask())).toEqual(1n);
    });

    it("player 2 FundSeat + STAKE after deposit exists and GameEscrow is OPEN", async () => {
        await deployThenFundCreator();
        const fund = await deposit.send(
            playerB.getSender(),
            { value: expectedAmount },
            { $$type: "FundSeat", seatIndex: 1n }
        );
        expect(fund.transactions).toHaveTransaction({
            from: playerB.address,
            to: deposit.address,
            success: true
        });
        const stakeResult = await stakeSeat(playerB, 1);
        expect(stakeResult.transactions).toHaveTransaction({
            from: playerB.address,
            to: gameEscrow.address,
            success: true
        });
    });

    it("player 3 FundSeat + STAKE after deposit exists and GameEscrow is OPEN", async () => {
        await deployThenFundCreator();
        await deposit.send(
            playerB.getSender(),
            { value: expectedAmount },
            { $$type: "FundSeat", seatIndex: 1n }
        );
        const fund = await deposit.send(
            playerC.getSender(),
            { value: expectedAmount },
            { $$type: "FundSeat", seatIndex: 2n }
        );
        expect(fund.transactions).toHaveTransaction({
            from: playerC.address,
            to: deposit.address,
            success: true
        });
        expect(await deposit.getGetStatus()).toEqual(STATUS_FULL);
        const stakeResult = await stakeSeat(playerC, 2);
        expect(stakeResult.transactions).toHaveTransaction({
            from: playerC.address,
            to: gameEscrow.address,
            success: true
        });
    });

    it("wrong player index / wallet is rejected for STAKE", async () => {
        const wrongIndex = await stakeSeat(playerA, 1);
        expect(wrongIndex.transactions).toHaveTransaction({
            from: playerA.address,
            to: gameEscrow.address,
            success: false
        });
        const attackerStake = await stakeSeat(attacker, 0);
        expect(attackerStake.transactions).toHaveTransaction({
            from: attacker.address,
            to: gameEscrow.address,
            success: false
        });
    });

    it("wrong FundSeat seat / wallet is rejected", async () => {
        await deployThenFundCreator();
        const wrongWallet = await deposit.send(
            attacker.getSender(),
            { value: expectedAmount },
            { $$type: "FundSeat", seatIndex: 1n }
        );
        expect(wrongWallet.transactions).toHaveTransaction({
            from: attacker.address,
            to: deposit.address,
            success: false
        });
    });

    it("wrong stake amount is rejected", async () => {
        const result = await gameEscrow.send(
            playerA.getSender(),
            { value: stake + 1n },
            { $$type: "Stake", playerIndex: 0n }
        );
        expect(result.transactions).toHaveTransaction({
            from: playerA.address,
            to: gameEscrow.address,
            success: false
        });
    });

    it("duplicate FundSeat and duplicate STAKE are rejected", async () => {
        await deployThenFundCreator();
        const dupFund = await deposit.send(
            playerA.getSender(),
            { value: expectedAmount },
            { $$type: "FundSeat", seatIndex: 0n }
        );
        expect(dupFund.transactions).toHaveTransaction({
            from: playerA.address,
            to: deposit.address,
            success: false
        });
        await stakeSeat(playerA, 0);
        const dupStake = await stakeSeat(playerA, 0);
        expect(dupStake.transactions).toHaveTransaction({
            from: playerA.address,
            to: gameEscrow.address,
            success: false
        });
    });

    it("SETTLE is rejected before all STAKE even if GameEscrow opened early", async () => {
        await stakeSeat(playerA, 0);
        const settle = await gameEscrow.send(
            oracle.getSender(),
            { value: toNano("0.05") },
            {
                $$type: "Settle",
                snapshotHash,
                winner: playerA.address,
                winnerAmount: toNano("0.02"),
                ownerAmount: toNano("0.005")
            }
        );
        expect(settle.transactions).toHaveTransaction({
            from: oracle.address,
            to: gameEscrow.address,
            success: false
        });
        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_PAYMENTS_OPEN);
    });

    it("non-oracle SETTLE is rejected after READY", async () => {
        await stakeSeat(playerA, 0);
        await stakeSeat(playerB, 1);
        await stakeSeat(playerC, 2);
        expect(await gameEscrow.getGetStatus()).toEqual(STATUS_READY);
        const settle = await gameEscrow.send(
            playerA.getSender(),
            { value: toNano("0.05") },
            {
                $$type: "Settle",
                snapshotHash,
                winner: playerA.address,
                winnerAmount: toNano("0.02"),
                ownerAmount: toNano("0.005")
            }
        );
        expect(settle.transactions).toHaveTransaction({
            from: playerA.address,
            to: gameEscrow.address,
            success: false
        });
    });
});
