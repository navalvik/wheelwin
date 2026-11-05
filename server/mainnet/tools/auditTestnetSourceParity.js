import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const testnetRepository = process.env.TESTNET_REPOSITORY ?? "G:/WheelWin-Testnet-59-3";
const testnetRevision = process.env.TESTNET_REVISION ?? "25b506b30ebe1b1b73f82afe896d81d08bc34645";
const copiedRoot = resolve(repository, "server/mainnet/testnet_source");
const explicitAdaptations = new Set([
    "payment/incoming/IncomingTransferConstants.js",
    "payment/refund/RefundObligation.js",
    "payment/runtime/RoomPaymentSessionAdapter.js",
    "payment/roomWallet/RoomWalletRuntimeResolver.js",
    "payment/runtime/PaymentRuntimeFactory.js",
    "payment/roomWallet/RoomWalletRegistry.js",
    "payment/runtime/deriveTestnetRoomPaymentRequirements.js",
    "payment/index.js",
    "payment/refund/TestnetOutgoingRefundProvider.js",
    "payment/roomWallet/TestnetNativeTonService.js",
    "payment/RoomWalletPaymentService.js",
    "payment/runtime/TestnetNativeRoomPayoutTransport.js",
    "payment/runtime/TestnetWinnerPayoutCoordinator.js",
    "payment/WalletPoolRegistry.js",
    "forensic/ClientPage5DeviceReportStore.js"
]);

function walk(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? walk(path) : [path];
    });
}

function normalizeMainnetCopy(source) {
    return source
        .replaceAll("https://toncenter.com", "https://testnet.toncenter.com")
        .replaceAll("https://tonapi.io", "https://testnet.tonapi.io")
        .replaceAll("MAINNET_TONCENTER_API_KEY", "TON_API_KEY")
        .replaceAll("ROOM_WALLETS_MAINNET_JSON", "ROOM_WALLETS_TESTNET_JSON")
        .replaceAll("OWNER_WALLET_MAINNET", "OWNER_WALLET_TESTNET")
        .replaceAll("MAINNET", "TESTNET")
        .replaceAll("Mainnet", "Testnet")
        .replaceAll("mainnet", "testnet")
        .replaceAll("-239", "-3")
        .replace(/\r\n/g, "\n");
}

const copied = walk(copiedRoot).filter(path => /\.(?:js|json)$/.test(path));
const mismatches = [];
for (const path of copied) {
    const relativePath = relative(copiedRoot, path).replaceAll("\\", "/");
    const sourcePath = `server/${relativePath}`;
    let source;
    try {
        source = execFileSync("git", ["show", `${testnetRevision}:${sourcePath}`], {
            cwd: testnetRepository,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024
        });
    } catch {
        mismatches.push({ path: relativePath, reason: "missing Testnet source" });
        continue;
    }
    if (explicitAdaptations.has(relativePath)) continue;
    const normalized = normalizeMainnetCopy(readFileSync(path, "utf8"));
    if (normalized !== source.replace(/\r\n/g, "\n")) {
        const expectedLines = source.replace(/\r\n/g, "\n").split("\n");
        const actualLines = normalized.split("\n");
        const firstDifferentLine = expectedLines.findIndex((line, index) => line !== actualLines[index]);
        mismatches.push({ path: relativePath, reason: "unexpected source difference",
            firstDifferentLine: firstDifferentLine + 1,
            expected: expectedLines[firstDifferentLine]?.slice(0, 180),
            actual: actualLines[firstDifferentLine]?.slice(0, 180) });
    }
}

const result = {
    testnetRepository,
    testnetRevision,
    copiedSourceFiles: copied.length,
    checkedForNormalizedIdentity: copied.length - explicitAdaptations.size,
    explicitNetworkAdaptations: [...explicitAdaptations],
    mismatches
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (mismatches.length) process.exitCode = 1;
