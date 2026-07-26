/**
 * R8.0E — Shared gate evaluation helpers.
 */

import { GATE_STATUS, BLOCKER_SEVERITY } from "./LaunchConfiguration.js";
import { createLaunchGateResult } from "./models/LaunchGateResult.js";

/**
 * @param {{
 *   id: string,
 *   name: string,
 *   ok: boolean,
 *   category?: string,
 *   severity?: string,
 *   details?: object,
 *   recommendations?: string[],
 *   warn?: boolean,
 *   durationMs?: number
 * }} input
 */
export function evaluateGate(input) {

    const started = Date.now();

    let status = GATE_STATUS.FAIL;

    if (input.ok === true) {

        status = input.warn === true ? GATE_STATUS.WARN : GATE_STATUS.PASS;

    }

    return createLaunchGateResult({
        id: input.id,
        name: input.name,
        category: input.category ?? "gate",
        status,
        severity: input.severity ?? BLOCKER_SEVERITY.HIGH,
        details: input.details ?? {},
        recommendations: input.ok
            ? (input.recommendations ?? [])
            : (input.recommendations?.length
                ? input.recommendations
                : [`Resolve gate ${input.id}`]),
        durationMs: Number.isFinite(input.durationMs)
            ? input.durationMs
            : Math.max(0, Date.now() - started)
    });

}

/**
 * @param {ReturnType<typeof createLaunchGateResult>[]} gates
 */
export function blockersFromGates(gates) {

    return gates
        .filter((g) => g.status === GATE_STATUS.FAIL)
        .map((g) => Object.freeze({
            id: g.id,
            name: g.name,
            severity: g.severity,
            category: g.category,
            recommendations: g.recommendations
        }));

}

/**
 * @param {ReturnType<typeof createLaunchGateResult>[]} gates
 */
export function scoreGates(gates) {

    if (!gates.length) {

        return 0;

    }

    const passed = gates.filter(
        (g) => g.status === GATE_STATUS.PASS || g.status === GATE_STATUS.WARN
    ).length;

    return Math.round((100 * passed) / gates.length);

}

export class LaunchGateEvaluator {

    evaluate(input) {

        return evaluateGate(input);

    }

    summarize(gates) {

        const byStatus = Object.create(null);

        for (const s of Object.values(GATE_STATUS)) {

            byStatus[s] = 0;

        }

        for (const g of gates) {

            byStatus[g.status] = (byStatus[g.status] ?? 0) + 1;

        }

        const blockers = blockersFromGates(gates);

        return Object.freeze({
            total: gates.length,
            passed: byStatus[GATE_STATUS.PASS] ?? 0,
            warned: byStatus[GATE_STATUS.WARN] ?? 0,
            failed: byStatus[GATE_STATUS.FAIL] ?? 0,
            passRate: gates.length > 0
                ? Number(
                    (
                        ((byStatus[GATE_STATUS.PASS] ?? 0)
                            + (byStatus[GATE_STATUS.WARN] ?? 0))
                        / gates.length
                    ).toFixed(4)
                )
                : 0,
            score: scoreGates(gates),
            byStatus: Object.freeze({ ...byStatus }),
            blockers: Object.freeze(blockers),
            criticalBlockers: blockers.filter(
                (b) => b.severity === BLOCKER_SEVERITY.CRITICAL
            ).length,
            highBlockers: blockers.filter(
                (b) => b.severity === BLOCKER_SEVERITY.HIGH
            ).length
        });

    }

}
