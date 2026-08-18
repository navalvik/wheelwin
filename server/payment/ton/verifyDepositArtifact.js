/**
 * R17.9L.12 — DepositContract.code.boc integrity (SHA256 + StateInit loadability).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cell } from "@ton/core";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DEPOSIT_CONTRACT_ARTIFACT_BOC_PATH = join(
    __dirname,
    "artifacts",
    "DepositContract.code.boc"
);

export const DEPOSIT_CONTRACT_ARTIFACT_META_PATH = join(
    __dirname,
    "artifacts",
    "DepositContract.code.json"
);

export class DepositArtifactVerificationError extends Error {

    constructor(message, details = {}) {

        super(message);

        this.name = "DepositArtifactVerificationError";

        this.details = Object.freeze({ ...details });

    }

}

/**
 * @param {string} [bocPath]
 * @returns {{ present: boolean, path: string, sha256: string|null, bytes: number|null }}
 */
export function hashDepositArtifactBoc(
    bocPath = DEPOSIT_CONTRACT_ARTIFACT_BOC_PATH
) {

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
export function loadDepositArtifactExpectedMeta(
    metaPath = DEPOSIT_CONTRACT_ARTIFACT_META_PATH
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
 * @param {string|null|undefined} configuredSha256
 * @param {string} [metaPath]
 * @returns {string|null}
 */
export function resolveExpectedDepositArtifactSha256(
    configuredSha256,
    metaPath = DEPOSIT_CONTRACT_ARTIFACT_META_PATH
) {

    if (typeof configuredSha256 === "string" && configuredSha256.trim()) {

        return configuredSha256.trim().toLowerCase();

    }

    const meta = loadDepositArtifactExpectedMeta(metaPath);

    return meta?.sha256 ?? null;

}

/**
 * @param {string} [bocPath]
 * @returns {{ loadable: boolean, reason: string|null }}
 */
export function assertDepositArtifactLoadable(
    bocPath = DEPOSIT_CONTRACT_ARTIFACT_BOC_PATH
) {

    if (!existsSync(bocPath)) {

        return {
            loadable: false,
            reason: `DepositContract artifact missing: ${bocPath}`
        };

    }

    try {

        const boc = readFileSync(bocPath);
        const cells = Cell.fromBoc(boc);

        if (!cells.length || !cells[0]) {

            return {
                loadable: false,
                reason: `DepositContract artifact empty / unloadable: ${bocPath}`
            };

        }

        cells[0].hash();

        return {
            loadable: true,
            reason: null
        };

    } catch (error) {

        return {
            loadable: false,
            reason:
                `DepositContract artifact not loadable by StateInit builder: `
                + `${error?.message ?? error}`
        };

    }

}

/**
 * Fail-closed verification. Never derives expected hash from the loaded artifact.
 *
 * @param {{
 *   expectedSha256?: string|null,
 *   requirePresent?: boolean,
 *   requireLoadable?: boolean,
 *   bocPath?: string,
 *   metaPath?: string
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
export function verifyDepositArtifact(options = {}) {

    const bocPath = options.bocPath ?? DEPOSIT_CONTRACT_ARTIFACT_BOC_PATH;
    const metaPath = options.metaPath ?? DEPOSIT_CONTRACT_ARTIFACT_META_PATH;
    const requirePresent = options.requirePresent === true;
    const requireLoadable = options.requireLoadable === true;
    const expectedSha256 = resolveExpectedDepositArtifactSha256(
        options.expectedSha256,
        metaPath
    );
    const hashed = hashDepositArtifactBoc(bocPath);
    const reasons = [];

    if (!hashed.present) {

        reasons.push(`DepositContract artifact missing: ${hashed.path}`);

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
                `DepositContract artifact SHA256 mismatch | actual=${actualSha256} | `
                    + `expected=${expectedSha256}`
            );

        }

    } else if (requirePresent || requireLoadable) {

        reasons.push("DepositContract expected artifact SHA256 missing from metadata/config");

    }

    let loadable = null;

    if (requireLoadable || requirePresent || expectedSha256) {

        const loaded = assertDepositArtifactLoadable(hashed.path);
        loadable = loaded.loadable;

        if (!loaded.loadable) {

            reasons.push(loaded.reason ?? "DepositContract artifact not loadable");

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

/**
 * @param {{
 *   expectedSha256?: string|null,
 *   requirePresent?: boolean,
 *   requireLoadable?: boolean,
 *   bocPath?: string,
 *   metaPath?: string
 * }} [options]
 */
export function assertVerifiedDepositArtifact(options = {}) {

    const result = verifyDepositArtifact({
        requirePresent: true,
        requireLoadable: true,
        ...options
    });

    if (!result.ok) {

        throw new DepositArtifactVerificationError(
            result.reasons.join("; ") || "DepositContract artifact verification failed",
            result
        );

    }

    return result;

}
