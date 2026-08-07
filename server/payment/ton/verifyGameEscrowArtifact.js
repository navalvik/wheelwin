/**
 * R7.68 / R8.1A — GameEscrow.code.boc integrity (SHA256 + StateInit loadability).
 * No contract/ABI changes. Does not rebuild the contract.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cell } from "@ton/core";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const GAME_ESCROW_ARTIFACT_BOC_PATH = join(
    __dirname,
    "artifacts",
    "GameEscrow.code.boc"
);

export const GAME_ESCROW_ARTIFACT_META_PATH = join(
    __dirname,
    "artifacts",
    "GameEscrow.code.json"
);

/**
 * @param {string} [bocPath]
 * @returns {{ present: boolean, path: string, sha256: string|null, bytes: number|null }}
 */
export function hashGameEscrowArtifactBoc(bocPath = GAME_ESCROW_ARTIFACT_BOC_PATH) {

    if (!existsSync(bocPath)) {

        return {
            present: false,
            path: bocPath,
            sha256: null,
            bytes: null
        };

    }

    const boc = readFileSync(bocPath);
    const sha256 = createHash("sha256").update(boc).digest("hex");

    return {
        present: true,
        path: bocPath,
        sha256,
        bytes: boc.length
    };

}

/**
 * @returns {{ sha256: string|null, codeHash: string|null, contract: string|null }|null}
 */
export function loadGameEscrowArtifactExpectedMeta(
    metaPath = GAME_ESCROW_ARTIFACT_META_PATH
) {

    if (!existsSync(metaPath)) {

        return null;

    }

    try {

        const meta = JSON.parse(readFileSync(metaPath, "utf8"));

        return {
            sha256: typeof meta.sha256 === "string" ? meta.sha256.toLowerCase() : null,
            codeHash: typeof meta.codeHash === "string"
                ? meta.codeHash.toLowerCase()
                : null,
            contract: meta.contract ?? null
        };

    } catch {

        return null;

    }

}

/**
 * Resolve expected SHA256: env config first, then artifact meta configuration.
 *
 * @param {string|null|undefined} configuredSha256
 * @returns {string|null}
 */
export function resolveExpectedArtifactSha256(configuredSha256) {

    if (typeof configuredSha256 === "string" && configuredSha256.trim()) {

        return configuredSha256.trim().toLowerCase();

    }

    const meta = loadGameEscrowArtifactExpectedMeta();

    return meta?.sha256 ?? null;

}

/**
 * Prove the committed BOC can be loaded as a code cell (StateInit builder input).
 * Does not rebuild or mutate the contract artifact.
 *
 * @param {string} [bocPath]
 * @returns {{ loadable: boolean, reason: string|null }}
 */
export function assertGameEscrowArtifactLoadable(
    bocPath = GAME_ESCROW_ARTIFACT_BOC_PATH
) {

    if (!existsSync(bocPath)) {

        return {
            loadable: false,
            reason: `GameEscrow artifact missing: ${bocPath}`
        };

    }

    try {

        const boc = readFileSync(bocPath);
        const cells = Cell.fromBoc(boc);

        if (!cells.length || !cells[0]) {

            return {
                loadable: false,
                reason: `GameEscrow artifact empty / unloadable: ${bocPath}`
            };

        }

        // Touch bits/hash so a corrupt cell fails here rather than later at deploy.
        cells[0].hash();

        return {
            loadable: true,
            reason: null
        };

    } catch (error) {

        return {
            loadable: false,
            reason:
                `GameEscrow artifact not loadable by StateInit builder: `
                + `${error?.message ?? error}`
        };

    }

}

/**
 * @param {{
 *   expectedSha256?: string|null,
 *   requirePresent?: boolean,
 *   requireLoadable?: boolean
 * }} [options]
 * @returns {{
 *   ok: boolean,
 *   present: boolean,
 *   path: string,
 *   actualSha256: string|null,
 *   expectedSha256: string|null,
 *   match: boolean|null,
 *   loadable: boolean|null,
 *   reasons: string[]
 * }}
 */
export function verifyGameEscrowArtifact(options = {}) {

    const requirePresent = options.requirePresent === true;
    const requireLoadable = options.requireLoadable === true;
    const expectedSha256 = resolveExpectedArtifactSha256(options.expectedSha256);
    const hashed = hashGameEscrowArtifactBoc();
    const reasons = [];

    if (!hashed.present) {

        reasons.push(`GameEscrow artifact missing: ${hashed.path}`);

        return {
            ok: !requirePresent && !expectedSha256,
            present: false,
            path: hashed.path,
            actualSha256: null,
            expectedSha256,
            match: null,
            loadable: false,
            reasons
        };

    }

    const actualSha256 = hashed.sha256;
    let match = null;

    if (expectedSha256) {

        match = actualSha256 === expectedSha256;

        if (!match) {

            reasons.push(
                `GameEscrow artifact SHA256 mismatch | actual=${actualSha256} | `
                    + `expected=${expectedSha256}`
            );

        }

    }

    let loadable = null;

    if (requireLoadable || requirePresent || expectedSha256) {

        const loaded = assertGameEscrowArtifactLoadable(hashed.path);
        loadable = loaded.loadable;

        if (!loaded.loadable) {

            reasons.push(loaded.reason ?? "GameEscrow artifact not loadable");

        }

    }

    const ok = reasons.length === 0
        && (expectedSha256 ? match === true : true)
        && (requirePresent ? hashed.present : true)
        && (requireLoadable ? loadable === true : true);

    return {
        ok,
        present: true,
        path: hashed.path,
        actualSha256,
        expectedSha256,
        match,
        loadable,
        reasons
    };

}
