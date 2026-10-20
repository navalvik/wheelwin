import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const currentDir = dirname(fileURLToPath(import.meta.url));
const testsDir = join(currentDir, "..", "tests");

function discoverTestFiles(directory) {
    const discovered = [];

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolutePath = join(directory, entry.name);

        if (entry.isDirectory()) {
            discovered.push(...discoverTestFiles(absolutePath));
            continue;
        }

        if (entry.isFile() && entry.name.endsWith(".test.js")) {
            discovered.push(absolutePath);
        }
    }

    return discovered.sort((left, right) =>
        relative(testsDir, left).split(sep).join("/")
            .localeCompare(relative(testsDir, right).split(sep).join("/"))
    );
}

const testFiles = discoverTestFiles(testsDir);

if (testFiles.length === 0) {
    process.stderr.write("No test files found under server/tests\n");
    process.exit(1);
}

for (const testPath of testFiles) {
    const displayPath = relative(testsDir, testPath).split(sep).join("/");
    process.stdout.write(`Running ${displayPath}...\n`);

    const result = spawnSync(
        process.execPath,
        [testPath],
        { stdio: "inherit" }
    );

    if (result.error) {
        process.stderr.write(`Failed to start ${displayPath}: ${result.error.message}\n`);
        process.exit(1);
    }

    if (result.status !== 0) {
        process.exit(Number.isInteger(result.status) ? result.status : 1);
    }
}

process.stdout.write(`All ${testFiles.length} discovered tests passed\n`);
