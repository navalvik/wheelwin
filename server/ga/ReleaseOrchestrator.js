/**
 * R9.0A — Release orchestration steps (deterministic, observational).
 */

import {
    createProductionRelease,
    withProductionReleasePatch
} from "./models/ProductionRelease.js";

export class ReleaseOrchestrator {

    constructor() {

        this._release = createProductionRelease();

        this._steps = [];

        this._startedAt = null;

        this._completedAt = null;

    }

    reset() {

        this._release = createProductionRelease();

        this._steps = [];

        this._startedAt = null;

        this._completedAt = null;

    }

    /**
     * Initialize release metadata from providers (read-only).
     * @param {object} ctx
     */
    initialize(ctx = {}) {

        this.reset();

        this._startedAt = Date.now();

        const release = ctx.release ?? {};

        const certification = ctx.certification ?? {};

        this._release = createProductionRelease({
            version: release.version ?? ctx.version ?? null,
            channel: release.channel ?? ctx.channel ?? "production",
            commit: release.commit ?? ctx.commit ?? null,
            fingerprint: release.fingerprint ?? null,
            certificationRef: certification.fingerprint
                ?? certification.status
                ?? null,
            startedAt: this._startedAt
        });

        this._recordStep("initialize", true, {
            version: this._release.version,
            channel: this._release.channel
        });

        return this._release;

    }

    /**
     * @param {{
     *   artifactOk?: boolean,
     *   manifestOk?: boolean,
     *   certificateOk?: boolean,
     *   deploymentOk?: boolean,
     *   verificationOk?: boolean,
     *   verificationRef?: string|null
     * }} flags
     */
    orchestrate(flags = {}) {

        if (!this._startedAt) {

            throw new Error("Release not initialized");

        }

        const steps = [
            ["artifact_verification", flags.artifactOk !== false],
            ["manifest_verification", flags.manifestOk !== false],
            ["certificate_verification", flags.certificateOk !== false],
            ["deployment_confirmation", flags.deploymentOk !== false],
            ["production_verification", flags.verificationOk !== false],
            ["launch_confirmation", flags.verificationOk !== false]
        ];

        let allOk = true;

        for (const [name, ok] of steps) {

            this._recordStep(name, ok === true, { ok: ok === true });

            if (!ok) {

                allOk = false;

            }

        }

        if (allOk) {

            this._completedAt = Date.now();

            this._release = withProductionReleasePatch(this._release, {
                completedAt: this._completedAt,
                verificationRef: flags.verificationRef ?? null
            });

            this._recordStep("completion", true, {
                durationMs: this.getDurationMs()
            });

        }

        return Object.freeze({
            ok: allOk,
            release: this._release,
            steps: Object.freeze([...this._steps]),
            durationMs: this.getDurationMs()
        });

    }

    getRelease() {

        return this._release;

    }

    getSteps() {

        return [...this._steps];

    }

    getDurationMs() {

        if (!this._startedAt) {

            return 0;

        }

        const end = this._completedAt ?? Date.now();

        return Math.max(0, end - this._startedAt);

    }

    getSafeStatus() {

        return Object.freeze({
            version: this._release.version,
            channel: this._release.channel,
            commit: this._release.commit
                ? String(this._release.commit).slice(0, 12)
                : null,
            fingerprint: this._release.fingerprint
                ? String(this._release.fingerprint).slice(0, 16)
                : null,
            startedAt: this._startedAt,
            completedAt: this._completedAt,
            durationMs: this.getDurationMs(),
            stepCount: this._steps.length,
            lastStep: this._steps.length
                ? this._steps[this._steps.length - 1].name
                : null
        });

    }

    /**
     * @param {object} patch
     */
    patchRelease(patch) {

        this._release = withProductionReleasePatch(this._release, patch);

        return this._release;

    }

    _recordStep(name, ok, details = {}) {

        this._steps.push(Object.freeze({
            name,
            ok: ok === true,
            at: Date.now(),
            details: Object.freeze({ ...details })
        }));

    }

}
