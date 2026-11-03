import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const mainnetDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(mainnetDir, "..", "..");
const baseline = "643050aad9f48ebf16993f2bf99cbff4edc85a0b";
const allowedSharedIntegrationFiles = new Set([
    "server/app.js",
    "server/socket/RoomLobbyBridge.js",
    "client/src/pages/Page4Payment.jsx",
    "client/src/tests/page4Payment.render.test.js",
    // Shared UI/helpers have network-conditional Mainnet branches; their
    // Testnet behavior is covered by the corresponding focused regressions.
    "client/src/console/panels/WalletQuarantinePanel.jsx",
    "client/src/pages/Page3VerifyPlayers.jsx",
    "client/src/pages/page3WalletAddress.js",
    "client/src/pages/page3WalletAddress.test.js",
    "client/src/payment/buildRoomWalletTonConnectRequest.test.js",
    "client/src/payment/mainnetPaymentRequest.js",
    "client/src/payment/mainnetPaymentRequest.test.js",
    "server/tests/page3WalletNetworkValidation.test.js",
    // Task 58.1 network-specific Finance display and its exact focused helper/test.
    "client/src/console/panels/FinancePanel.jsx",
    "client/src/console/panels/financeBalance.js",
    "client/src/console/panels/financeBalance.test.js",
    // Mainnet-specific console balance endpoint wiring and its focused contract test.
    "server/console/registerDeveloperConsoleRoutes.js",
    "server/console/registerDeveloperConsoleRoutes.finance.test.js",
    // Companion regression for the already-allowlisted Page4 network integration.
    "client/src/tests/mainnetPage4PaymentSession.test.js",
    // CI-only source audit workflow; it does not exempt any source path from the audit.
    ".github/workflows/mainnet-source-parity.yml"
]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonicalCheckoutBytes = (bytes) => {
    if (bytes.includes(0)) return bytes;
    return Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
};

test("all files present at Testnet baseline retain identical canonical SHA-256", () => {
    const tree = execFileSync("git", ["ls-tree", "-r", "-z", baseline], {
        cwd: repoRoot,
        maxBuffer: 128 * 1024 * 1024
    });
    const entries = tree.toString("utf8").split("\0").filter(Boolean).map((entry) => {
        const match = /^(\d+) blob ([0-9a-f]+)\t(.+)$/.exec(entry);
        assert.ok(match, `unexpected Testnet tree entry: ${entry.slice(0, 100)}`);
        return { mode: match[1], blob: match[2], path: match[3] };
    });
    const blobs = [...new Set(entries.map((entry) => entry.blob))];
    const batch = execFileSync("git", ["cat-file", "--batch"], {
        cwd: repoRoot,
        input: Buffer.from(`${blobs.join("\n")}\n`),
        maxBuffer: 256 * 1024 * 1024
    });
    const baselineBytes = new Map();
    for (let offset = 0; offset < batch.length;) {
        const headerEnd = batch.indexOf(0x0a, offset);
        assert.notEqual(headerEnd, -1, "incomplete git cat-file header");
        const [blob, type, sizeText] = batch.subarray(offset, headerEnd).toString("ascii").split(" ");
        assert.equal(type, "blob");
        const size = Number.parseInt(sizeText, 10);
        const bodyStart = headerEnd + 1;
        baselineBytes.set(blob, batch.subarray(bodyStart, bodyStart + size));
        offset = bodyStart + size + 1;
    }
    const mismatches = [];
    const protectedFinancialAlgorithms = [
        "server/payment/ledger/RoomLedger.js",
        "server/payment/ledger/RoomPayoutCalculator.js",
        "server/payment/ledger/PayoutAllocationConfig.js",
        "server/payment/incoming/IncomingReceiptAccounting.js",
        "server/payment/refund/RefundLifecycleCoordinator.js"
    ];
    for (const file of protectedFinancialAlgorithms) {
        assert.ok(entries.some(entry => entry.path === file), `protected Testnet algorithm must be tracked: ${file}`);
        assert.equal(allowedSharedIntegrationFiles.has(file), false,
            `protected Testnet algorithm must remain SHA-checked: ${file}`);
    }
    for (const { path: file, blob } of entries) {
        const original = baselineBytes.get(blob);
        let current;
        try {
            current = readFileSync(resolve(repoRoot, file));
        } catch {
            mismatches.push(`${file}: missing`);
            continue;
        }
        if (!allowedSharedIntegrationFiles.has(file)
            && sha256(original) !== sha256(canonicalCheckoutBytes(current))) mismatches.push(file);
    }
    assert.deepEqual(mismatches, [], `Testnet baseline file hash differences: ${mismatches.join(", ")}`);
});

test("only Mainnet runtime and Page4 integration paths changed outside server/mainnet", () => {
    const changed = execFileSync("git", ["diff", "--name-only", baseline, "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8"
    }).trim().split(/\r?\n/).filter(Boolean);
    const status = execFileSync("git", ["status", "--short"], { cwd: repoRoot, encoding: "utf8" });
    const worktreePaths = status.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3));
    const paths = [...changed, ...worktreePaths];
    const outside = [...new Set(paths)].filter((file) =>
        !file.startsWith("server/mainnet/") && !allowedSharedIntegrationFiles.has(file));
    assert.deepEqual(outside, [], `non-Mainnet paths changed: ${outside.join(", ")}`);
});

test("Testnet payment runtime setup remains byte-for-byte unchanged inside app.js", () => {
    const baselineApp = execFileSync("git", ["show", `${baseline}:server/app.js`], {
        cwd: repoRoot,
        encoding: "utf8"
    });
    const currentApp = readFileSync(resolve(repoRoot, "server/app.js"), "utf8");
    const extract = (source, isCurrent) => {
        const start = source.indexOf("// Transfers stay closed by default.");
        const endMarker = isCurrent
            ? "\n            }\n\n        } catch (error) {"
            : "\n        } catch (error) {";
        const end = source.indexOf(endMarker, start);
        assert.ok(start >= 0 && end > start, "Testnet payment runtime block must be present");
        let block = source.slice(start, end);
        if (isCurrent) {
            block = block.replace(/^ {4}/gm, "");
        }
        return block.replace(/\r\n/g, "\n");
    };

    assert.equal(extract(currentApp, true), extract(baselineApp, false));
});

test("Testnet and Mainnet PAYMENT_REQUEST payloads remain network-specific", async () => {
    const baselineBridge = execFileSync("git", ["show", `${baseline}:server/socket/RoomLobbyBridge.js`], {
        cwd: repoRoot,
        encoding: "utf8"
    });
    const currentBridge = readFileSync(resolve(repoRoot, "server/socket/RoomLobbyBridge.js"), "utf8");
    const extract = (source, startMarker, endMarker) => {
        source = source.replace(/\r\n/g, "\n");
        const start = source.indexOf(startMarker);
        const end = source.indexOf(endMarker, start);
        assert.ok(start >= 0 && end > start, `expected section ${startMarker}`);
        return source.slice(start, end);
    };
    const statusStart = "        const paymentService = runtime ? runtime.paymentService : null;";
    const statusEnd = "    _isAuthoritativeSettledPrincipal(entry, intent) {";
    assert.equal(extract(currentBridge, statusStart, statusEnd),
        extract(baselineBridge, statusStart, statusEnd));

    const currentPage4 = readFileSync(resolve(repoRoot, "client/src/pages/Page4Payment.jsx"), "utf8");
    assert.match(currentPage4, /payment\.paymentAcceptanceEnabled && !mainnetMode/);
    assert.match(currentPage4, /uri = buildRoomWalletTransferUri\(\{/);

    const oldNetwork = process.env.TON_NETWORK;
    const oldAcceptance = process.env.ROOM_WALLET_PAYMENTS_ENABLED;
    process.env.TON_NETWORK = "testnet";
    process.env.ROOM_WALLET_PAYMENTS_ENABLED = "true";
    try {
        const [{ RoomLobbyBridge }, { LOBBY_SERVER_EVENTS }] = await Promise.all([
            import("../../socket/RoomLobbyBridge.js"),
            import("../../socket/lobbyProtocol.js")
        ]);
        const players = ["seat-a", "seat-b", "seat-c"];
        const roomId = "network-contract-room";
        const room = { roomId, players };
        const destinationWalletAddress = `0:${"f".repeat(64)}`;
        const identities = new Map(players.map((playerId, index) => [playerId, {
            playerId,
            wallet: `0:${String(index + 1).padStart(64, "0")}`,
            baseStake: 1,
            sectorCount: 1
        }]));
        const deliverForNetwork = (network) => {
            const delivered = [];
            const runtime = {
                network,
                paymentService: {
                    listPaymentIntentsForRoom: () => [],
                    getWalletForRoom: () => null
                },
                incomingLedger: {
                    listRoomIntents: () => players.map((playerId, index) => ({
                        playerId,
                        expectedSender: `0:${String(index + 1).padStart(64, "0")}`
                    }))
                }
            };
            const bridge = Object.create(RoomLobbyBridge.prototype);
            bridge._roomManager = { getRoom: id => id === roomId ? room : null };
            bridge._playerManager = { getIdentity: playerId => identities.get(playerId) };
            bridge._paymentApplicationBinding = {
                runtime,
                prepareRoomPaymentSession: (_roomId, requirements) => ({
                    payments: requirements.map((requirement, index) => ({
                        ...requirement,
                        paymentReference: `WW_${network}_${index + 1}`,
                        destinationWalletAddress,
                        asset: "TON",
                        network,
                        expiresAt: 1_900_000_000_000
                    }))
                })
            };
            bridge._playerToSocket = new Map(players.map((playerId, index) => [playerId, `socket-${index}`]));
            bridge._logger = { info() {}, warn() {} };
            bridge._deliverToSocket = (...args) => delivered.push(args);
            bridge._preparePaymentSessionIfEnabled(roomId, room);
            return delivered.filter(([, event]) => event === LOBBY_SERVER_EVENTS.PAYMENT_REQUEST);
        };

        const testnetRequests = deliverForNetwork("testnet");
        assert.equal(testnetRequests.length, 3);
        for (const [, , payload] of testnetRequests) {
            assert.deepEqual(Object.keys(payload).sort(), [
                "amount", "amountAtomic", "asset", "destination", "expiresAt",
                "network", "paymentReference", "playerId", "roomId"
            ]);
            assert.equal(payload.network, "testnet");
        }

        const mainnetRequests = deliverForNetwork("mainnet");
        assert.equal(mainnetRequests.length, 3);
        for (const [, , payload] of mainnetRequests) {
            assert.deepEqual(Object.keys(payload).sort(), [
                "amount", "amountAtomic", "asset", "destination", "destinationWalletAddress",
                "expiresAt", "network", "payerAddress", "paymentReference", "playerId", "roomId"
            ]);
            assert.equal(payload.network, "mainnet");
            assert.match(payload.payerAddress, /^0:/);
            assert.equal(payload.destinationWalletAddress, destinationWalletAddress);
        }
    } finally {
        if (oldNetwork === undefined) delete process.env.TON_NETWORK;
        else process.env.TON_NETWORK = oldNetwork;
        if (oldAcceptance === undefined) delete process.env.ROOM_WALLET_PAYMENTS_ENABLED;
        else process.env.ROOM_WALLET_PAYMENTS_ENABLED = oldAcceptance;
    }
});
