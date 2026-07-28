/**
 * R6.1 / R6.2 — Application environment control (administrator-only, persisted).
 */

import {
    APP_ENVIRONMENT,
    isValidAppEnvironment,
    normalizeAppEnvironment,
    resolveAppEnvironment,
    tonNetworkForAppEnvironment
} from "./AppEnvironment.js";
import {
    readEnvironmentState,
    writeEnvironmentState
} from "./environmentStateStore.js";
import { createDeveloperAuthAudit } from "../auth/developerAuthAudit.js";
import { verifyAdministratorPassword } from "../auth/developerAuthConfig.js";

const MAINNET_CONFIRMATION_PHRASE = "ENABLE MAINNET";

const FINAL_UNDERSTAND_PHRASE = "I UNDERSTAND";

export class AppEnvironmentService {

    constructor({ developerConfig, logger, env = process.env }) {

        this._developerConfig = developerConfig;

        this._logger = logger;

        this._env = env;

        this._audit = createDeveloperAuthAudit(logger);

        this._current = resolveAppEnvironment(env);

    }

    getCurrent() {

        const persisted = readEnvironmentState(this._env);

        if (persisted?.appEnvironment) {

            return persisted.appEnvironment;

        }

        return this._current;

    }

    getStatus() {

        const current = this.getCurrent();

        const persisted = readEnvironmentState(this._env);

        return Object.freeze({
            appEnvironment: current,
            tonNetwork: tonNetworkForAppEnvironment(current),
            persisted: persisted !== null,
            restartRequired: false,
            mainnetProtectionRequired: current !== APP_ENVIRONMENT.MAINNET
        });

    }

    buildSummary({ authEnabled = false, authenticated = false, role = null } = {}) {

        const current = this.getCurrent();

        const tonNetwork = tonNetworkForAppEnvironment(current);

        const isMainnet = current === APP_ENVIRONMENT.MAINNET;

        return Object.freeze({
            appEnvironment: current,
            tonNetwork,
            blockchainLabel: isMainnet ? "TON Mainnet" : "TON Testnet",
            paymentsMode: isMainnet ? "LIVE PAYMENTS" : "TEST MODE",
            contractsLabel: isMainnet ? "Mainnet" : "Testnet",
            consoleAuthState: !authEnabled
                ? "Open"
                : (authenticated ? "Authenticated" : "Not authenticated"),
            consoleRole: role,
            realMoneyMode: isMainnet,
            startedAt: Number(this._env.SERVER_STARTED_AT || 0) || null,
            uptimeMs: Number(this._env.SERVER_STARTED_AT || 0)
                ? Math.max(0, Date.now() - Number(this._env.SERVER_STARTED_AT))
                : null
        });

    }

    /**
     * @param {{
     *   targetEnvironment: string,
     *   password?: string,
     *   confirmationPhrase?: string,
     *   finalConfirmationPhrase?: string,
     *   username: string,
     *   role?: string,
     *   sessionId?: string | null,
     *   clientIp?: string | null
     * }} input
     */
    switchEnvironment(input) {

        const auditBase = {
            username: input?.username,
            role: input?.role ?? null,
            sessionId: input?.sessionId ?? null,
            ip: input?.clientIp
        };

        const target = normalizeAppEnvironment(input?.targetEnvironment);

        if (!target) {

            return {
                ok: false,
                status: 400,
                error: "Invalid target environment"
            };

        }

        const current = this.getCurrent();

        if (target === current) {

            return {
                ok: true,
                appEnvironment: current,
                tonNetwork: tonNetworkForAppEnvironment(current),
                restartRequired: false,
                message: "Environment is already active"
            };

        }

        const switchingToMainnet = target === APP_ENVIRONMENT.MAINNET
            && current !== APP_ENVIRONMENT.MAINNET;

        const switchingFromMainnet = current === APP_ENVIRONMENT.MAINNET
            && target !== APP_ENVIRONMENT.MAINNET;

        if (switchingToMainnet || switchingFromMainnet) {

            const passwordOk = verifyAdministratorPassword(
                String(input?.password || ""),
                this._developerConfig
            );

            if (!passwordOk) {

                this._audit.environmentSwitchFailed({
                    ...auditBase,
                    from: current,
                    to: target,
                    reason: "invalid_password"
                });

                return {
                    ok: false,
                    status: 401,
                    error: "Administrator password verification failed"
                };

            }

            this._audit.passwordConfirmation({
                ...auditBase,
                from: current,
                to: target,
                result: "pass"
            });

        }

        if (switchingToMainnet) {

            const phrase = String(input?.confirmationPhrase || "").trim();

            if (phrase !== MAINNET_CONFIRMATION_PHRASE) {

                this._audit.environmentSwitchFailed({
                    ...auditBase,
                    from: current,
                    to: target,
                    reason: "enable_mainnet_phrase_required"
                });

                return {
                    ok: false,
                    status: 400,
                    error: `Confirmation phrase must be exactly "${MAINNET_CONFIRMATION_PHRASE}"`
                };

            }

            this._audit.enableMainnetConfirmation({
                ...auditBase,
                from: current,
                to: target,
                result: "pass"
            });

            const finalPhrase = String(input?.finalConfirmationPhrase || "").trim();

            if (finalPhrase !== FINAL_UNDERSTAND_PHRASE) {

                this._audit.environmentSwitchFailed({
                    ...auditBase,
                    from: current,
                    to: target,
                    reason: "final_understand_phrase_required"
                });

                return {
                    ok: false,
                    status: 400,
                    error: `Final confirmation must be exactly "${FINAL_UNDERSTAND_PHRASE}"`
                };

            }

            this._audit.understandConfirmation({
                ...auditBase,
                from: current,
                to: target,
                result: "pass"
            });

        }

        const tonNetwork = tonNetworkForAppEnvironment(target);

        writeEnvironmentState({
            appEnvironment: target,
            tonNetwork,
            updatedBy: input?.username ?? null
        }, this._env);

        this._audit.environmentSwitch({
            ...auditBase,
            from: current,
            to: target
        });

        this._audit.configurationChange({
            ...auditBase,
            change: "app_environment",
            from: current,
            to: target
        });

        return {
            ok: true,
            appEnvironment: target,
            tonNetwork,
            previousEnvironment: current,
            restartRequired: true,
            message: "Environment updated. Restart the server to apply blockchain network changes."
        };

    }

}

export {
    MAINNET_CONFIRMATION_PHRASE,
    FINAL_UNDERSTAND_PHRASE,
    isValidAppEnvironment
};
