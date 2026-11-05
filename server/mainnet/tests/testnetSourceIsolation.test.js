import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = resolve(serverRoot, "..");
const testnetRepository = "G:/WheelWin-Testnet-59-3";
const testnetRevision = "25b506b30ebe1b1b73f82afe896d81d08bc34645";

test("Testnet source checkout remains at the recorded revision and has no edits", () => {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: testnetRepository, encoding: "utf8"
    }).trim();
    const status = execFileSync("git", ["status", "--short"], {
        cwd: testnetRepository, encoding: "utf8"
    }).trim();
    assert.equal(revision, testnetRevision);
    assert.equal(status, "");
});

test("Mainnet source copies match Testnet after network normalization or explicit adaptation", () => {
    const output = execFileSync(process.execPath,
        [resolve(serverRoot, "mainnet/tools/auditTestnetSourceParity.js")], {
            cwd: repositoryRoot,
            encoding: "utf8",
            maxBuffer: 2 * 1024 * 1024
        });
    const result = JSON.parse(output);
    assert.equal(result.copiedSourceFiles, 91);
    assert.equal(result.mismatches.length, 0, JSON.stringify(result.mismatches));
    assert.ok(result.explicitNetworkAdaptations.length >= 7);
});

test("Mainnet app branch uses the source runtime and leaves Testnet app setup available", () => {
    const app = readFileSync(resolve(serverRoot, "app.js"), "utf8");
    const mode = app.indexOf("const paymentMode = resolveServerPaymentMode(process.env)");
    const mainnet = app.indexOf('if (paymentMode === "mainnet")', mode);
    const testnet = app.indexOf("} else {", mainnet);
    const branch = app.slice(mainnet, testnet);
    assert.ok(mainnet > mode && testnet > mainnet);
    const bootstrap = readFileSync(resolve(serverRoot, "mainnet/MainnetBootstrap.js"), "utf8");
    assert.match(bootstrap, /testnet_source\/payment\/runtime\/PaymentRuntimeFactory\.js/);
    assert.match(branch, /initializeMainnetServerRuntime\(/);
    assert.match(branch, /configurePaymentGate\(paymentRuntime\.paymentGate\)/);
    assert.doesNotMatch(branch, /new MainnetPaymentRuntime\(/);
    assert.doesNotMatch(branch, /financialLedger|incomingLedger|incomingPayments/);
    assert.match(app.slice(testnet), /buildPaymentRuntime\(/);
});
