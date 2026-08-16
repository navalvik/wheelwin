/**
 * R17.8V.2P.M — Transfer boundary placeholder (no chain sends).
 */

import { DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT } from "./deploymentReimbursementServiceResults.js";

export class ReimbursementTransferService {

    /**
     * @param {{ logger?: object|null }} [options]
     */
    constructor({ logger = null } = {}) {

        this._logger = logger;

    }

    /**
     * Stage M: intentionally unimplemented.
     *
     * @param {object} _record
     * @returns {{ ok: false, code: string, message: string }}
     */
    sendReimbursement(_record) {

        this._logger?.debug?.(
            "ReimbursementTransferService.sendReimbursement NOT_IMPLEMENTED (Stage M)"
        );

        return {
            ok: false,
            code: DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.NOT_IMPLEMENTED,
            message: "TON transfer not implemented in Stage M"
        };

    }

}
