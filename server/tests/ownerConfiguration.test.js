import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
    OWNER_CONFIG_EXAMPLE_PATH,
    OwnerConfiguration
} from "../config/OwnerConfiguration.js";

const EXAMPLE_WALLET = "EQOwnerConfigExampleWalletDoNotUseInProductionXX";

/** config/ directory; repo root is one level up. */
const CONFIG_DIR = dirname(OWNER_CONFIG_EXAMPLE_PATH);

const REPO_ROOT = join(CONFIG_DIR, "..");

function writeOwnerFile(dir, body) {

    const path = join(dir, "owner.json");

    writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));

    return path;

}

function withReset(run) {

    OwnerConfiguration.resetForTests();

    try {

        return run();

    } finally {

        OwnerConfiguration.resetForTests();

    }

}

{
    withReset(() => {

        const dir = mkdtempSync(join(tmpdir(), "ww-owner-"));

        const path = writeOwnerFile(dir, { ownerWallet: EXAMPLE_WALLET });

        const loaded = OwnerConfiguration.load({ configPath: path });

        assert.equal(loaded.ownerWallet, EXAMPLE_WALLET);

        assert.equal(OwnerConfiguration.getOwnerWallet(), EXAMPLE_WALLET);

        assert.equal(OwnerConfiguration.isLoaded(), true);

        assert.equal(Object.isFrozen(loaded), true);

        assert.throws(
            () => {

                loaded.ownerWallet = "EQChangedWalletShouldNotStickXXXXXXXXXX";

            },
            TypeError,
            "frozen configuration must reject mutation"
        );

        assert.equal(
            OwnerConfiguration.getOwnerWallet(),
            EXAMPLE_WALLET,
            "mutation attempt must not change owner wallet"
        );

        assert.throws(
            () => OwnerConfiguration.load({ configPath: path }),
            /already loaded/,
            "second load must be rejected"
        );

    });

    console.log("  valid configuration loads + immutable passed");

}

{
    withReset(() => {

        const dir = mkdtempSync(join(tmpdir(), "ww-owner-bad-"));

        const path = writeOwnerFile(dir, { ownerWallet: "not-a-wallet" });

        assert.throws(
            () => OwnerConfiguration.load({ configPath: path }),
            /not a valid TON address/,
            "invalid wallet must block load"
        );

        assert.equal(OwnerConfiguration.isLoaded(), false);

        assert.throws(
            () => OwnerConfiguration.getOwnerWallet(),
            /has not been loaded/
        );

    });

    console.log("  invalid wallet rejected passed");

}

{
    withReset(() => {

        const missing = join(
            mkdtempSync(join(tmpdir(), "ww-owner-missing-")),
            "owner.json"
        );

        let message = "";

        assert.throws(
            () => OwnerConfiguration.load({ configPath: missing }),
            /Owner wallet configuration missing/,
            "missing file must block startup load"
        );

        try {

            OwnerConfiguration.load({ configPath: missing });

        } catch (error) {

            message = error.message;

        }

        assert.match(
            message,
            /Create config\/owner\.json/,
            "missing-file error must instruct creating config/owner.json"
        );

    });

    console.log("  missing file blocks startup passed");

}

{
    withReset(() => {

        const loaded = OwnerConfiguration.load({
            env: { OWNER_WALLET: EXAMPLE_WALLET },
            configPath: join(
                mkdtempSync(join(tmpdir(), "ww-owner-env-skip-")),
                "missing-owner.json"
            )
        });

        assert.equal(loaded.ownerWallet, EXAMPLE_WALLET);

        assert.equal(loaded.configPath, "env:OWNER_WALLET");

        assert.equal(OwnerConfiguration.getOwnerWallet(), EXAMPLE_WALLET);

    });

    console.log("  OWNER_WALLET env loads without owner.json passed");

}

{
    withReset(() => {

        const dir = mkdtempSync(join(tmpdir(), "ww-owner-env-wins-"));

        const path = writeOwnerFile(dir, {
            ownerWallet: "EQFileWalletShouldBeIgnoredWhenEnvIsSetXXXX"
        });

        const loaded = OwnerConfiguration.load({
            configPath: path,
            env: { OWNER_WALLET: EXAMPLE_WALLET }
        });

        assert.equal(
            loaded.ownerWallet,
            EXAMPLE_WALLET,
            "OWNER_WALLET must take priority over owner.json"
        );

        assert.equal(loaded.configPath, "env:OWNER_WALLET");

    });

    console.log("  OWNER_WALLET takes priority over owner.json passed");

}

{
    withReset(() => {

        assert.throws(
            () => OwnerConfiguration.load({
                env: { OWNER_WALLET: "not-a-wallet" },
                configPath: join(
                    mkdtempSync(join(tmpdir(), "ww-owner-env-bad-")),
                    "missing-owner.json"
                )
            }),
            /not a valid TON address/,
            "invalid OWNER_WALLET must block load"
        );

        assert.equal(OwnerConfiguration.isLoaded(), false);

    });

    console.log("  invalid OWNER_WALLET rejected passed");

}

{
    withReset(() => {

        const loaded = OwnerConfiguration.load({
            configPath: OWNER_CONFIG_EXAMPLE_PATH
        });

        assert.equal(loaded.ownerWallet, EXAMPLE_WALLET);

        const raw = JSON.parse(readFileSync(OWNER_CONFIG_EXAMPLE_PATH, "utf8"));

        assert.equal(raw.ownerWallet, EXAMPLE_WALLET);

    });

    console.log("  owner.example.json works as template passed");

}

{
    const rootIgnore = readFileSync(join(REPO_ROOT, ".gitignore"), "utf8");

    assert.match(
        rootIgnore,
        /config\/owner\.json/,
        "root .gitignore must ignore config/owner.json"
    );

    const check = execSync(
        "git check-ignore -v config/owner.json",
        {
            cwd: REPO_ROOT,
            encoding: "utf8"
        }
    );

    assert.match(
        check,
        /config\/owner\.json/,
        "git check-ignore must match config/owner.json"
    );

    console.log("  owner.json ignored by Git passed");

}

console.log("ownerConfiguration.test.js: all assertions passed");
