/**
 * R17.8V.2P.M — Deployment reimbursement feature flag.
 */

export const DEPLOYMENT_REIMBURSEMENT_ENABLED_ENV =
    "DEPLOYMENT_REIMBURSEMENT_ENABLED";

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isDeploymentReimbursementEnabled(env = process.env) {

    const raw = String(env?.[DEPLOYMENT_REIMBURSEMENT_ENABLED_ENV] ?? "")
        .trim()
        .toLowerCase();

    return raw === "true" || raw === "1" || raw === "yes";

}
