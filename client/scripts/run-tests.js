import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative } from "node:path";

const currentDir = dirname(fileURLToPath(import.meta.url));

const srcDir = join(currentDir, "..", "src");

const registerHook = pathToFileURL(join(currentDir, "register.js")).href;

function collectTestFiles(directory) {

    const entries = readdirSync(directory, { withFileTypes: true });

    const files = [];

    for (const entry of entries) {

        const fullPath = join(directory, entry.name);

        if (entry.isDirectory()) {

            files.push(...collectTestFiles(fullPath));

            continue;

        }

        if (entry.name.endsWith(".test.js")) {

            files.push(fullPath);

        }

    }

    return files;

}

const testFiles = collectTestFiles(srcDir).sort();

for (const filePath of testFiles) {

    const label = relative(srcDir, filePath);

    process.stdout.write(`Running ${label}...\n`);

    const result = spawnSync(
        process.execPath,
        ["--import", registerHook, filePath],
        { stdio: "inherit" }
    );

    if (result.status !== 0) {

        process.exit(result.status ?? 1);

    }

}

process.stdout.write("All client tests passed\n");
