import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const BASELINE = "643050aad9f48ebf16993f2bf99cbff4edc85a0b";
const root = process.cwd();
const args = process.argv.slice(2);
const reportIndex = args.indexOf("--report");
const reportPath = reportIndex >= 0 ? args[reportIndex + 1] : null;
const check = args.includes("--check");

function git(...argv) {
    return execFileSync("git", argv, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trimEnd();
}

const head = git("rev-parse", "HEAD");
const names = git("diff", "--name-status", "--find-renames", `${BASELINE}...${head}`)
    .split(/\r?\n/).filter(Boolean).map(line => {
        const [status, ...paths] = line.split("\t");
        return { status, path: paths.at(-1), oldPath: paths.length > 1 ? paths[0] : null };
    });
const commonProduction = names.filter(item => item.status !== "A" && item.status !== "D"
    && !item.path.startsWith("server/mainnet/") && !item.path.startsWith("server/mainnet-")
    && !item.path.startsWith("client/src/tests/") && !item.path.endsWith(".test.js")
    && !item.path.endsWith(".test.jsx") && item.path !== "server/mainnet/tools/sourceParityAudit.js");
const counts = Object.fromEntries(["A", "M", "D", "R"].map(status => [status, names.filter(item => item.status === status).length]));
const list = git("ls-tree", "-r", `${BASELINE}`, "--", "client", "server")
    .split(/\r?\n/).filter(Boolean);
const baselineBlobs = new Map(list.map(line => {
    const [meta, path] = line.split("\t");
    return [path, meta.split(" ")[2]];
}));
const headBlobs = new Map(git("ls-tree", "-r", head, "--", "client", "server").split(/\r?\n/).filter(Boolean).map(line => {
    const [meta, path] = line.split("\t");
    return [path, meta.split(" ")[2]];
}));
const blobLines = [...new Set([...baselineBlobs.keys(), ...headBlobs.keys()])].sort().map(path => {
    const before = baselineBlobs.get(path) ?? "—";
    const after = headBlobs.get(path) ?? "—";
    return `| \`${path}\` | ${before} | ${after} | ${before === after ? "IDENTICAL" : "DIFF"} |`;
});
const decisions = new Map([
    ["client/src/console/panels/FinancePanel.jsx", "Network-specific API key selection and TON/GRAM label. Testnet component has no injected network formatter/data-source seam; exact identity needs a Testnet extension point."],
    ["client/src/console/panels/WalletQuarantinePanel.jsx", "Mainnet labels and balance/runtime bindings. Testnet panel is hard-wired to Testnet event/data vocabulary; this needs an injected network adapter to remove the branch."],
    ["client/src/pages/Page3VerifyPlayers.jsx", "Network-aware address validation and recovery. Frozen Page3 validates the Testnet address form and has no network policy injection seam; preserve Mainnet EQ/UQ checks and raw-address recovery."],
    ["client/src/pages/Page4Payment.jsx", "Mainnet payment request, TonConnect chain, wallet selection, and status merge. Task 54 behavior depends on Mainnet server contract not present in frozen Testnet Page4; preserve fix, requires shared component seam."],
    ["server/app.js", "Selects Mainnet bootstrap and composes Mainnet runtime into the existing server. Frozen Testnet app has no Mainnet runtime composition point; isolate composition in an injected runtime selector to restore parity."],
    ["server/console/registerDeveloperConsoleRoutes.js", "Registers Mainnet Finance/quarantine data routes and uses MAINNET_TONCENTER_API_KEY. Testnet-only route registration has no runtime adapter hook."],
    ["server/socket/RoomLobbyBridge.js", "Routes both payment runtimes, network-scoped PAYMENT_REQUEST fields, Mainnet observation/gate, and Page3 identity. Frozen bridge lacks a network strategy interface; Task 54 event contract must remain."],
    ["server/mainnet/payment/MainnetIncomingPaymentService.js", "Provider-specific scan/finality and settlement remain Mainnet-owned; candidate matching now delegates to shared IncomingTransferMatcher."],
    ["server/mainnet/payment/MainnetRefundLifecycle.js", "Creates Mainnet obligations and performs submission/two-provider finality. Testnet RefundLifecycleCoordinator is hard-coded to TESTNET/-3 and Testnet obligation/provider schemas."],
    ["server/mainnet/payment/MainnetPayoutLifecycle.js", "Submission ordering and dual-provider finality state machine are Mainnet-specific copies; Testnet lifecycle is bound to Testnet ledger and evidence providers."],
    ["server/mainnet/payment/MainnetGameStartPaymentGate.js", "Updated in this task to project Mainnet evidence into shared assessThreePlayerPaymentGate; the gate decision is no longer independently implemented."],
    ["server/mainnet/payment/MainnetPayoutPolicy.js", "Updated in this task to call shared RoomPayoutCalculator; only Mainnet storage rule label remains local."],
    ["server/mainnet/payment/MainnetRoomWalletAdapter.js", "Removed in this task. Production Mainnet transport already injects the shared RoomWalletAdapter; duplicate seqno/sign/idempotency implementation was unnecessary."]
]);
const decisionLines = names.map(({ path, status }) => {
    const defaultReason = path.startsWith("server/mainnet/tests/")
        ? "Mainnet offline regression coverage for the corresponding adapter/runtime; test-only addition."
        : path.startsWith("server/mainnet/")
            ? "Mainnet network adapter, configuration, durable store, provider, worker, or integration test; inspect full patch below for its contract and call sites."
            : path.startsWith("client/src/tests/") || path.endsWith(".test.js") || path.endsWith(".test.jsx")
                ? "Targeted Mainnet/Testnet contract regression test; test-only change/addition."
                : path.startsWith("client/src/payment/")
                    ? "Mainnet payment request/TON Connect network adapter or focused test."
                    : "Shared source difference; exact Testnet hash is required for source parity, so this remains a parity blocker unless migrated behind an adapter seam.";
    return `| \`${status}\` | \`${path}\` | ${decisions.get(path) ?? defaultReason} |`;
});
const diff = git("diff", "--no-ext-diff", "--full-index", "--find-renames", "--unified=3", `${BASELINE}...${head}`, "--", "client", "server");
const report = [
    "# Mainnet/Testnet source audit",
    "",
    `- Testnet baseline: \`${BASELINE}\``,
    `- Mainnet HEAD: \`${head}\``,
    `- Changed paths: ${names.length}`,
    `- Added: ${counts.A}; modified: ${counts.M}; deleted: ${counts.D}; renamed: ${counts.R}`,
    `- Modified/common production paths that differ: ${commonProduction.length}`,
    `- Result: ${commonProduction.length === 0 ? "PASS — no differing common production paths" : "FAIL — common production source differs"}`,
    "",
    "## Path inventory and Git blob identity",
    "",
    "| Path | Testnet blob | Mainnet blob | Comparison |",
    "|---|---|---|---|",
    ...blobLines,
    "",
    "## Difference disposition",
    "",
    "| Change | Path | Technical reason and current decision |",
    "|---|---|---|",
    ...decisionLines,
    "",
    "## Complete unified diff",
    "",
    "The following is the complete Git diff for all client/server paths, including added and deleted files.",
    "",
    "```diff",
    diff || "(no differences)",
    "```",
    ""
].join("\n");

if (reportPath) writeFileSync(reportPath, report, "utf8");
else process.stdout.write(report);

if (check && commonProduction.length) {
    process.stderr.write(`SOURCE PARITY FAIL: ${commonProduction.length} shared production path(s) differ from Testnet.\n`);
    process.exitCode = 1;
} else if (check) {
    process.stdout.write("SOURCE PARITY PASS\n");
}
