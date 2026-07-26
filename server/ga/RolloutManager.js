/**
 * R9.0A — Staged rollout coordinator (observational).
 */

import {
    ROLLOUT_STAGES,
    ROLLOUT_STAGE_ORDER,
    ROLLOUT_MODES
} from "./ProductionConfiguration.js";
import { createRolloutStage } from "./models/RolloutStage.js";

export class RolloutManager {

    /**
     * @param {{ mode?: string }} [options]
     */
    constructor(options = {}) {

        this._mode = options.mode === ROLLOUT_MODES.STAGED
            ? ROLLOUT_MODES.STAGED
            : ROLLOUT_MODES.SINGLE;

        this._stage = null;

        this._history = [];

        this._startedAt = null;

        this._completedAt = null;

    }

    getMode() {

        return this._mode;

    }

    getCurrentStage() {

        return this._stage;

    }

    getHistory() {

        return [...this._history];

    }

    reset() {

        this._stage = null;

        this._history = [];

        this._startedAt = null;

        this._completedAt = null;

    }

    start() {

        this.reset();

        this._startedAt = Date.now();

        if (this._mode === ROLLOUT_MODES.SINGLE) {

            this._enter(ROLLOUT_STAGES.INTERNAL);

            this._completeCurrent();

            this._enter(ROLLOUT_STAGES.COMPLETED);

            this._completedAt = Date.now();

            return this.getSafeStatus();

        }

        this._enter(ROLLOUT_STAGES.INTERNAL);

        return this.getSafeStatus();

    }

    /**
     * Advance to next staged rollout step.
     */
    advance(notes = null) {

        if (!this._stage) {

            throw new Error("Rollout has not started");

        }

        if (this._stage.stage === ROLLOUT_STAGES.COMPLETED) {

            return this.getSafeStatus();

        }

        this._completeCurrent(notes);

        const idx = ROLLOUT_STAGE_ORDER.indexOf(this._stage.stage);

        const next = ROLLOUT_STAGE_ORDER[idx + 1];

        if (!next) {

            this._enter(ROLLOUT_STAGES.COMPLETED);

            this._completedAt = Date.now();

            return this.getSafeStatus();

        }

        this._enter(next);

        if (next === ROLLOUT_STAGES.COMPLETED) {

            this._completedAt = Date.now();

        }

        return this.getSafeStatus();

    }

    /**
     * Complete remaining stages (single-shot completion).
     */
    completeAll() {

        if (!this._stage) {

            this.start();

        }

        while (this._stage?.stage !== ROLLOUT_STAGES.COMPLETED) {

            this.advance("auto-complete");

        }

        return this.getSafeStatus();

    }

    isComplete() {

        return this._stage?.stage === ROLLOUT_STAGES.COMPLETED;

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
            mode: this._mode,
            stage: this._stage?.stage ?? null,
            startedAt: this._startedAt,
            completedAt: this._completedAt,
            durationMs: this.getDurationMs(),
            complete: this.isComplete(),
            history: Object.freeze(
                this._history.map((h) => Object.freeze({ ...h }))
            )
        });

    }

    _enter(stage) {

        this._stage = createRolloutStage({
            stage,
            enteredAt: Date.now()
        });

        this._history.push(this._stage);

    }

    _completeCurrent(notes = null) {

        if (!this._stage) {

            return;

        }

        this._stage = createRolloutStage({
            ...this._stage,
            completedAt: Date.now(),
            notes: notes ?? this._stage.notes
        });

        this._history[this._history.length - 1] = this._stage;

    }

}
