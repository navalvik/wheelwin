/**
 * R17.8V.2P.H — Deployment cost snapshot feature flag.
 *
 * Default: disabled. Stage A has no runtime consumers of this flag.
 */

export const DEPLOYMENT_COST_SNAPSHOT_ENABLED_ENV =
    "DEPLOYMENT_COST_SNAPSHOT_ENABLED";

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isDeploymentCostSnapshotEnabled(env = process.env) {

    const raw = String(env?.[DEPLOYMENT_COST_SNAPSHOT_ENABLED_ENV] ?? "")
        .trim()
        .toLowerCase();

    return raw === "true" || raw === "1" || raw === "yes";

}
