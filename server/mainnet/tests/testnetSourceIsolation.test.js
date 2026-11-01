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
    for (const { path: file, blob } of entries) {
        const original = baselineBytes.get(blob);
        let current;
        try {
            current = readFileSync(resolve(repoRoot, file));
        } catch {
            mismatches.push(`${file}: missing`);
            continue;
        }
        if (sha256(original) !== sha256(canonicalCheckoutBytes(current))) mismatches.push(file);
    }
    assert.deepEqual(mismatches, [], `Testnet baseline file hash differences: ${mismatches.join(", ")}`);
});

test("all changes from Testnet baseline are confined to server/mainnet", () => {
    const changed = execFileSync("git", ["diff", "--name-only", baseline, "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8"
    }).trim().split(/\r?\n/).filter(Boolean);
    const status = execFileSync("git", ["status", "--short"], { cwd: repoRoot, encoding: "utf8" });
    const worktreePaths = status.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3));
    const paths = [...changed, ...worktreePaths];
    const outside = [...new Set(paths)].filter((file) => !file.startsWith("server/mainnet/"));
    assert.deepEqual(outside, [], `non-Mainnet paths changed: ${outside.join(", ")}`);
});
