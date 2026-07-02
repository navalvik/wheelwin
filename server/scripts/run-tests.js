import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const currentDir = dirname(fileURLToPath(import.meta.url));

const testsDir = join(currentDir, "..", "tests");

const testFiles = readdirSync(testsDir)
    .filter((fileName) => fileName.endsWith(".test.js"))
    .sort();

for (const fileName of testFiles) {

    process.stdout.write(`Running ${fileName}...\n`);

    const result = spawnSync(
        process.execPath,
        [join(testsDir, fileName)],
        { stdio: "inherit" }
    );

    if (result.status !== 0) {

        process.exit(result.status ?? 1);

    }

}

process.stdout.write("All tests passed\n");
