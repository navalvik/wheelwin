/**
 * R17.9L.11 — DepositContract sandbox tests (frozen R17.9L.10 semantics).
 */
import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { Address, contractAddress, toNano } from "@ton/core";
import "@ton/test-utils";
import {
    DepositContract,
    DEPOSIT_CONTRACT_VERSION,
    STATUS_UNINITIALIZED,
    STATUS_AWAITING_FUNDS,
    STATUS_PARTIALLY_FUNDED,
    STATUS_FULL,
    STATUS_RELEASED,
    STATUS_REFUNDED,
    STATUS_EXPIRED,
    ALL_SEATS_MASK
} from "../wrappers/DepositContract";

function sandboxNow(blockchain: Blockchain) {
    return blockchain.now ?? Math.floor(Date.now() / 1000);
}

const ZERO_ADDRESS = new Address(0, Buffer.alloc(32));

const depositIdHash = 0x1111111111111111111111111111111111111111111111111111111111111111n;
const roomIdHash = 0x2222222222222222222222222222222222222222222222222222222222222222n;
const gameIdHash = 0x3333333333333333333333333333333333333333333333333333333333333333n;

const stake = toNano("1");
const creationFee = toNano("0.1");
const expectedAmount = stake + creationFee;

type PlayerBundle = {
    deployer: SandboxContract<TreasuryContract>;
    oracle: SandboxContract<TreasuryContract>;
    playerA: SandboxContract<TreasuryContract>;
    playerB: SandboxContract<TreasuryContract>;
    playerC: SandboxContract<TreasuryContract>;
    gameContract: SandboxContract<TreasuryContract>;
    attacker: SandboxContract<TreasuryContract>;
};

type DepositInitConfig = {
    depositIdHash?: bigint;
    roomIdHash?: bigint;
    gameIdHash?: bigint;
    player0?: Address;
    player1?: Address;
    player2?: Address;
    expectedStake0?: bigint;
    expectedStake1?: bigint;
    expectedStake2?: bigint;
    creationFeePerSeat?: bigint;
    expiresAt?: bigint;
    releaseAuthority?: Address;
    networkTag?: bigint;
};

function freshMutableFields() {
    return {
        status: STATUS_UNINITIALIZED,
        paidMask: 0n,
        creditedAmount0: 0n,
        creditedAmount1: 0n,
        creditedAmount2: 0n,
        surplusNano: 0n,
        refundMask: 0n,
        releasedTo: ZERO_ADDRESS,
        totalCredited: 0n
    };
}

async function buildDepositFromInit(
    players: PlayerBundle,
    config: DepositInitConfig = {},
    blockchainNow = 1_700_000_000
) {
    const mutable = freshMutableFields();
    const expiresAt = config.expiresAt ?? BigInt(blockchainNow + 3600);

    return DepositContract.fromInit(
        DEPOSIT_CONTRACT_VERSION,
        config.depositIdHash ?? depositIdHash,
        config.roomIdHash ?? roomIdHash,
        config.gameIdHash ?? gameIdHash,
        config.player0 ?? players.playerA.address,
        config.player1 ?? players.playerB.address,
        config.player2 ?? players.playerC.address,
        config.expectedStake0 ?? stake,
        config.expectedStake1 ?? stake,
        config.expectedStake2 ?? stake,
        config.creationFeePerSeat ?? creationFee,
        expiresAt,
        config.releaseAuthority ?? players.oracle.address,
        config.networkTag ?? 0n,
        mutable.status,
        mutable.paidMask,
        mutable.creditedAmount0,
        mutable.creditedAmount1,
        mutable.creditedAmount2,
        mutable.surplusNano,
        mutable.refundMask,
        mutable.releasedTo,
        mutable.totalCredited
    );
}

async function deployDeposit(
    blockchain: Blockchain,
    players: PlayerBundle,
    config: DepositInitConfig = {}
) {
    const chainNow = sandboxNow(blockchain);
    const resolvedConfig = {
        ...config,
        expiresAt: config.expiresAt ?? BigInt(chainNow + 86400 * 30)
    };
    const opened = await buildDepositFromInit(players, resolvedConfig, chainNow);
    const contract = blockchain.openContract(opened);

    const deployResult = await contract.send(
        players.deployer.getSender(),
        { value: toNano("0.2") },
        null
    );

    expect(deployResult.transactions).toHaveTransaction({
        from: players.deployer.address,
        to: contract.address,
        deploy: true,
        success: true
    });

    expect(await contract.getGetStatus()).toEqual(STATUS_AWAITING_FUNDS);

    return contract;
}

async function fundSeat(
    contract: SandboxContract<DepositContract>,
    player: SandboxContract<TreasuryContract>,
    seatIndex: number,
    value: bigint
) {
    return contract.send(
        player.getSender(),
        { value },
        {
            $$type: "FundSeat",
            seatIndex: BigInt(seatIndex)
        }
    );
}

async function fundAllSeats(
    contract: SandboxContract<DepositContract>,
    players: PlayerBundle
) {
    await fundSeat(contract, players.playerA, 0, expectedAmount);
    await fundSeat(contract, players.playerB, 1, expectedAmount);
    await fundSeat(contract, players.playerC, 2, expectedAmount);
}

describe("DepositContract", () => {
    let blockchain: Blockchain;
    let players: PlayerBundle;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        players = {
            deployer: await blockchain.treasury("deployer"),
            oracle: await blockchain.treasury("oracle"),
            playerA: await blockchain.treasury("playerA"),
            playerB: await blockchain.treasury("playerB"),
            playerC: await blockchain.treasury("playerC"),
            gameContract: await blockchain.treasury("gameContract"),
            attacker: await blockchain.treasury("attacker")
        };
    });

    it("Test 1 — deterministic initialization", async () => {
        const a = await buildDepositFromInit(players);
        const b = await buildDepositFromInit(players);

        expect(a.address.toString()).toEqual(b.address.toString());
        expect(a.init?.code.toString()).toEqual(b.init?.code.toString());
        expect(a.init?.data.toString()).toEqual(b.init?.data.toString());
    });

    it("Test 2 — changed depositId changes address", async () => {
        const a = await buildDepositFromInit(players);
        const b = await buildDepositFromInit(players, {
            depositIdHash: depositIdHash + 1n
        });

        expect(a.address.toString()).not.toEqual(b.address.toString());
    });

    it("Test 3 — changed roomId changes address", async () => {
        const a = await buildDepositFromInit(players);
        const b = await buildDepositFromInit(players, {
            roomIdHash: roomIdHash + 1n
        });

        expect(a.address.toString()).not.toEqual(b.address.toString());
    });

    it("Test 4 — changed gameId changes address", async () => {
        const a = await buildDepositFromInit(players);
        const b = await buildDepositFromInit(players, {
            gameIdHash: gameIdHash + 1n
        });

        expect(a.address.toString()).not.toEqual(b.address.toString());
    });

    it("Test 5 — changed player wallet changes address", async () => {
        const a = await buildDepositFromInit(players);
        const b = await buildDepositFromInit(players, {
            player0: players.attacker.address
        });

        expect(a.address.toString()).not.toEqual(b.address.toString());
    });

    it("Test 6 — changed expected amount changes address", async () => {
        const a = await buildDepositFromInit(players);
        const b = await buildDepositFromInit(players, {
            expectedStake0: stake + toNano("0.01")
        });

        expect(a.address.toString()).not.toEqual(b.address.toString());
    });

    it("Test 7 — first partial funding", async () => {
        const contract = await deployDeposit(blockchain, players);

        const partial = toNano("0.4");
        const result = await fundSeat(contract, players.playerA, 0, partial);

        expect(result.transactions).toHaveTransaction({
            from: players.playerA.address,
            to: contract.address,
            success: true
        });

        expect(await contract.getGetCreditedAmount0()).toEqual(partial);
        expect(await contract.getGetPaidMask()).toEqual(0n);
        expect(await contract.getGetStatus()).toEqual(STATUS_PARTIALLY_FUNDED);
    });

    it("Test 8 — completion of one seat", async () => {
        const contract = await deployDeposit(blockchain, players);

        await fundSeat(contract, players.playerA, 0, toNano("0.4"));
        await fundSeat(contract, players.playerA, 0, expectedAmount - toNano("0.4"));

        expect(await contract.getGetCreditedAmount0()).toEqual(expectedAmount);
        expect(await contract.getGetPaidMask()).toEqual(1n);
    });

    it("Test 9 — three funded seats", async () => {
        const contract = await deployDeposit(blockchain, players);

        await fundAllSeats(contract, players);

        expect(await contract.getGetPaidMask()).toEqual(ALL_SEATS_MASK);
        expect(await contract.getGetStatus()).toEqual(STATUS_FULL);
    });

    it("Test 10 — wrong wallet rejected", async () => {
        const contract = await deployDeposit(blockchain, players);

        const result = await fundSeat(contract, players.attacker, 0, expectedAmount);

        expect(result.transactions).toHaveTransaction({
            from: players.attacker.address,
            to: contract.address,
            success: false
        });
    });

    it("Test 11 — wrong seat rejected", async () => {
        const contract = await deployDeposit(blockchain, players);

        const result = await fundSeat(contract, players.playerA, 1, expectedAmount);

        expect(result.transactions).toHaveTransaction({
            from: players.playerA.address,
            to: contract.address,
            success: false
        });
    });

    it("Test 12 — duplicate fully funded seat rejected", async () => {
        const contract = await deployDeposit(blockchain, players);

        await fundSeat(contract, players.playerA, 0, expectedAmount);

        const result = await fundSeat(contract, players.playerA, 0, expectedAmount);

        expect(result.transactions).toHaveTransaction({
            from: players.playerA.address,
            to: contract.address,
            success: false
        });
    });

    it("Test 13 — underpayment accumulation", async () => {
        const contract = await deployDeposit(blockchain, players);

        await fundSeat(contract, players.playerA, 0, toNano("0.3"));
        await fundSeat(contract, players.playerA, 0, toNano("0.3"));
        await fundSeat(contract, players.playerA, 0, expectedAmount - toNano("0.6"));

        expect(await contract.getGetCreditedAmount0()).toEqual(expectedAmount);
        expect(await contract.getGetPaidMask()).toEqual(1n);
    });

    it("Test 14 — overpayment", async () => {
        const contract = await deployDeposit(blockchain, players);
        const excess = toNano("0.5");

        await fundSeat(contract, players.playerA, 0, expectedAmount + excess);

        expect(await contract.getGetCreditedAmount0()).toEqual(expectedAmount);
        expect(await contract.getGetSurplusNano()).toEqual(excess);
    });

    it("Test 15 — arbitrary empty transfer rejected", async () => {
        const contract = await deployDeposit(blockchain, players);

        const result = await contract.send(
            players.attacker.getSender(),
            { value: toNano("1") },
            null
        );

        expect(result.transactions).toHaveTransaction({
            from: players.attacker.address,
            to: contract.address,
            success: false
        });
    });

    it("Test 16 — timeout blocks funding", async () => {
        const chainNow = sandboxNow(blockchain);
        const expiresAt = BigInt(chainNow + 5);
        const contract = await deployDeposit(blockchain, players, { expiresAt });

        blockchain.now = Number(expiresAt) + 1;

        const result = await fundSeat(contract, players.playerA, 0, expectedAmount);

        expect(result.transactions).toHaveTransaction({
            from: players.playerA.address,
            to: contract.address,
            success: false
        });
    });

    it("Test 17 — unauthorized Release rejected", async () => {
        const contract = await deployDeposit(blockchain, players);
        await fundAllSeats(contract, players);

        const result = await contract.send(
            players.attacker.getSender(),
            { value: toNano("0.05") },
            {
                $$type: "Release",
                gameContract: players.gameContract.address,
                gameIdHash
            }
        );

        expect(result.transactions).toHaveTransaction({
            from: players.attacker.address,
            to: contract.address,
            success: false
        });
    });

    it("Test 18 — Release requires FULL", async () => {
        const contract = await deployDeposit(blockchain, players);
        await fundSeat(contract, players.playerA, 0, expectedAmount);

        const result = await contract.send(
            players.oracle.getSender(),
            { value: toNano("0.05") },
            {
                $$type: "Release",
                gameContract: players.gameContract.address,
                gameIdHash
            }
        );

        expect(result.transactions).toHaveTransaction({
            from: players.oracle.address,
            to: contract.address,
            success: false
        });
    });

    it("Test 19 — Release cannot happen twice", async () => {
        const contract = await deployDeposit(blockchain, players);
        await fundAllSeats(contract, players);

        await contract.send(
            players.oracle.getSender(),
            { value: toNano("0.05") },
            {
                $$type: "Release",
                gameContract: players.gameContract.address,
                gameIdHash
            }
        );

        const second = await contract.send(
            players.oracle.getSender(),
            { value: toNano("0.05") },
            {
                $$type: "Release",
                gameContract: players.gameContract.address,
                gameIdHash
            }
        );

        expect(second.transactions).toHaveTransaction({
            from: players.oracle.address,
            to: contract.address,
            success: false
        });
        expect(await contract.getGetStatus()).toEqual(STATUS_RELEASED);
    });

    it("Test 20 — wrong game binding rejected", async () => {
        const contract = await deployDeposit(blockchain, players);
        await fundAllSeats(contract, players);

        const result = await contract.send(
            players.oracle.getSender(),
            { value: toNano("0.05") },
            {
                $$type: "Release",
                gameContract: players.gameContract.address,
                gameIdHash: gameIdHash + 1n
            }
        );

        expect(result.transactions).toHaveTransaction({
            from: players.oracle.address,
            to: contract.address,
            success: false
        });
    });

    it("Test 21 — unauthorized refund rejected before timeout", async () => {
        const contract = await deployDeposit(blockchain, players);
        await fundSeat(contract, players.playerA, 0, expectedAmount);

        const result = await contract.send(
            players.attacker.getSender(),
            { value: toNano("0.1") },
            { $$type: "Refund" }
        );

        expect(result.transactions).toHaveTransaction({
            from: players.attacker.address,
            to: contract.address,
            success: false
        });
    });

    it("Test 22 — permissionless refund after timeout", async () => {
        const chainNow = sandboxNow(blockchain);
        const expiresAt = BigInt(chainNow + 5);
        const contract = await deployDeposit(blockchain, players, { expiresAt });
        await fundSeat(contract, players.playerA, 0, expectedAmount);

        blockchain.now = Number(expiresAt) + 1;

        await contract.send(
            players.attacker.getSender(),
            { value: toNano("0.05") },
            { $$type: "Expire" }
        );

        expect(await contract.getGetStatus()).toEqual(STATUS_EXPIRED);

        const refund = await contract.send(
            players.attacker.getSender(),
            { value: toNano("0.1") },
            { $$type: "Refund" }
        );

        expect(refund.transactions).toHaveTransaction({
            from: players.attacker.address,
            to: contract.address,
            success: true
        });
        expect(await contract.getGetStatus()).toEqual(STATUS_REFUNDED);
    });

    it("Test 23 — refund replay rejected", async () => {
        const chainNow = sandboxNow(blockchain);
        const expiresAt = BigInt(chainNow + 5);
        const contract = await deployDeposit(blockchain, players, { expiresAt });
        await fundSeat(contract, players.playerA, 0, expectedAmount);

        blockchain.now = Number(expiresAt) + 1;
        await contract.send(players.oracle.getSender(), { value: toNano("0.05") }, { $$type: "Expire" });
        await contract.send(players.oracle.getSender(), { value: toNano("0.1") }, { $$type: "Refund" });

        const replay = await contract.send(
            players.oracle.getSender(),
            { value: toNano("0.1") },
            { $$type: "Refund" }
        );

        expect(replay.transactions).toHaveTransaction({
            from: players.oracle.address,
            to: contract.address,
            success: false
        });
    });

    it("Test 24 — refund destinations are immutable player wallets", async () => {
        const chainNow = sandboxNow(blockchain);
        const expiresAt = BigInt(chainNow + 5);
        const contract = await deployDeposit(blockchain, players, { expiresAt });
        await fundAllSeats(contract, players);

        blockchain.now = Number(expiresAt) + 1;
        await contract.send(players.oracle.getSender(), { value: toNano("0.05") }, { $$type: "Expire" });

        const refund = await contract.send(
            players.oracle.getSender(),
            { value: toNano("0.2") },
            { $$type: "Refund" }
        );

        expect(refund.transactions).toHaveTransaction({
            from: contract.address,
            to: players.playerA.address,
            success: true
        });
        expect(refund.transactions).toHaveTransaction({
            from: contract.address,
            to: players.playerB.address,
            success: true
        });
        expect(refund.transactions).toHaveTransaction({
            from: contract.address,
            to: players.playerC.address,
            success: true
        });
        expect(refund.transactions).not.toHaveTransaction({
            from: contract.address,
            to: players.attacker.address,
            success: true
        });
    });

    describe("security", () => {
        it("immutable binding fields cannot change after funding", async () => {
            const contract = await deployDeposit(blockchain, players);
            const snapshot = {
                depositId: await contract.getGetDepositId(),
                roomId: await contract.getGetRoomIdHash(),
                gameId: await contract.getGetGameIdHash(),
                player0: await contract.getGetPlayer0(),
                player1: await contract.getGetPlayer1(),
                player2: await contract.getGetPlayer2(),
                stake0: await contract.getGetExpectedStake0(),
                stake1: await contract.getGetExpectedStake1(),
                stake2: await contract.getGetExpectedStake2(),
                fee: await contract.getGetCreationFeePerSeat(),
                expiresAt: await contract.getGetExpiresAt(),
                authority: await contract.getGetReleaseAuthority(),
                networkTag: await contract.getGetNetworkTag()
            };

            await fundAllSeats(contract, players);

            expect(await contract.getGetDepositId()).toEqual(snapshot.depositId);
            expect(await contract.getGetRoomIdHash()).toEqual(snapshot.roomId);
            expect(await contract.getGetGameIdHash()).toEqual(snapshot.gameId);
            expect(await contract.getGetPlayer0().then((a) => a.toString())).toEqual(snapshot.player0.toString());
            expect(await contract.getGetPlayer1().then((a) => a.toString())).toEqual(snapshot.player1.toString());
            expect(await contract.getGetPlayer2().then((a) => a.toString())).toEqual(snapshot.player2.toString());
            expect(await contract.getGetExpectedStake0()).toEqual(snapshot.stake0);
            expect(await contract.getGetExpectedStake1()).toEqual(snapshot.stake1);
            expect(await contract.getGetExpectedStake2()).toEqual(snapshot.stake2);
            expect(await contract.getGetCreationFeePerSeat()).toEqual(snapshot.fee);
            expect(await contract.getGetExpiresAt()).toEqual(snapshot.expiresAt);
            expect(await contract.getGetReleaseAuthority().then((a) => a.toString())).toEqual(snapshot.authority.toString());
            expect(await contract.getGetNetworkTag()).toEqual(snapshot.networkTag);
        });

        it("balance alone cannot create FULL", async () => {
            const contract = await deployDeposit(blockchain, players);

            const donate = await contract.send(
                players.attacker.getSender(),
                { value: expectedAmount * 3n },
                null
            );

            expect(donate.transactions).toHaveTransaction({
                from: players.attacker.address,
                to: contract.address,
                success: false
            });
            expect(await contract.getGetPaidMask()).toEqual(0n);
            expect(await contract.getGetStatus()).toEqual(STATUS_AWAITING_FUNDS);
        });

        it("partial funding cannot create FULL", async () => {
            const contract = await deployDeposit(blockchain, players);

            await fundSeat(contract, players.playerA, 0, toNano("0.4"));
            await fundSeat(contract, players.playerB, 1, toNano("0.4"));

            expect(await contract.getGetStatus()).not.toEqual(STATUS_FULL);
            expect(await contract.getGetPaidMask()).toEqual(0n);
        });

        it("contains no gameplay logic in contract source", () => {
            const source = require("node:fs").readFileSync(
                require("node:path").join(__dirname, "../deposit/DepositContract.tact"),
                "utf8"
            );

            const forbidden = ["winner", "wheel", "sector", "spin", "physics", "RTP", "house edge"];
            for (const term of forbidden) {
                expect(source.toLowerCase()).not.toContain(term);
            }
        });
    });
});

describe("DepositContract address derivation", () => {
    it("matches contractAddress(workchain, stateInit)", async () => {
        const blockchain = await Blockchain.create();
        const players: PlayerBundle = {
            deployer: await blockchain.treasury("deployer"),
            oracle: await blockchain.treasury("oracle"),
            playerA: await blockchain.treasury("playerA"),
            playerB: await blockchain.treasury("playerB"),
            playerC: await blockchain.treasury("playerC"),
            gameContract: await blockchain.treasury("gameContract"),
            attacker: await blockchain.treasury("attacker")
        };

        const opened = await buildDepositFromInit(players);
        const derived = contractAddress(0, opened.init!);

        expect(opened.address.toString()).toEqual(derived.toString());
    });
});
