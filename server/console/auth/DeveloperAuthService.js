import { createHash, randomBytes } from "node:crypto";

import {
    canAccessDeveloperConsole,
    canPerformAdministratorActions,
    DEVELOPER_ROLES
} from "./developerRoles.js";
import {
    resolveLoginIdentity,
    verifyAdministratorPassword
} from "./developerAuthConfig.js";
import { createDeveloperAuthAudit } from "./developerAuthAudit.js";
import { signHs256Jwt, verifyHs256Jwt } from "./jwtTokens.js";

/**
 * R6.1 / R6.2 — Developer Authentication service.
 */
export class DeveloperAuthService {

    constructor({ config, logger }) {

        this._config = config;

        this._logger = logger;

        this._audit = createDeveloperAuthAudit(logger);

        this._refreshSessions = new Map();

    }

    isEnabled() {

        return this._config.enabled === true && this._config.configured === true;

    }

    /**
     * R6.2A — True only when DEVELOPER_AUTH_ENABLED=false.
     * Incomplete configuration must not unlock the console.
     */
    allowsOpenAccess() {

        return this._config.openAccess === true;

    }

    getEnvironment() {

        return this._config.appEnvironment;

    }

    verifyAdministratorPassword(password) {

        return verifyAdministratorPassword(password, this._config);

    }

    isAdministrator(claims) {

        return canPerformAdministratorActions(claims?.role);

    }

    /**
     * @returns {{ ok: true, session } | { ok: false, status: number, error: string }}
     */
    login({ username, password, clientIp = null } = {}) {

        if (!this.isEnabled()) {

            this._audit.loginFailed({
                reason: "auth_disabled_or_unconfigured",
                ip: clientIp
            });

            return {
                ok: false,
                status: 503,
                error: "Developer authentication is not configured"
            };

        }

        const identity = resolveLoginIdentity(username, password, this._config);

        if (!identity) {

            this._audit.loginFailed({
                reason: "invalid_credentials",
                username: String(username || "").trim() || "(empty)",
                ip: clientIp
            });

            return {
                ok: false,
                status: 401,
                error: "Invalid username or password"
            };

        }

        const { username: normalizedUser, role } = identity;

        if (!canAccessDeveloperConsole(role)) {

            this._audit.loginFailed({
                reason: "role_denied",
                username: normalizedUser,
                role,
                ip: clientIp
            });

            return {
                ok: false,
                status: 403,
                error: "Role is not permitted to access the Developer Console"
            };

        }

        const session = this._issueSession({
            username: normalizedUser,
            role
        });

        this._audit.loginSuccess({
            username: normalizedUser,
            role,
            sessionId: session.sessionId,
            ip: clientIp,
            expiresAt: session.expiresAt
        });

        return { ok: true, session };

    }

    refresh({ refreshToken, clientIp = null } = {}) {

        if (!this.isEnabled()) {

            return {
                ok: false,
                status: 503,
                error: "Developer authentication is not configured"
            };

        }

        const record = this._getRefreshRecord(refreshToken);

        if (!record) {

            this._audit.refreshFailed({
                reason: "invalid_or_expired_refresh",
                ip: clientIp
            });

            return {
                ok: false,
                status: 401,
                error: "Refresh token is invalid or expired"
            };

        }

        this._refreshSessions.delete(this._hashToken(refreshToken));

        const session = this._issueSession({
            username: record.username,
            role: record.role,
            sessionId: record.sessionId
        });

        this._audit.refreshSuccess({
            username: record.username,
            role: record.role,
            sessionId: session.sessionId,
            ip: clientIp,
            expiresAt: session.expiresAt
        });

        return { ok: true, session };

    }

    logout({
        refreshToken = null,
        accessToken = null,
        clientIp = null
    } = {}) {

        let username = null;

        let role = null;

        let sessionId = null;

        if (refreshToken) {

            const hash = this._hashToken(refreshToken);

            const record = this._refreshSessions.get(hash);

            username = record?.username ?? null;

            role = record?.role ?? null;

            sessionId = record?.sessionId ?? null;

            this._refreshSessions.delete(hash);

        }

        if (!username && accessToken) {

            const payload = this.verifyAccessToken(accessToken);

            username = payload?.username ?? null;

            role = payload?.role ?? null;

            sessionId = payload?.sessionId ?? null;

        }

        this._audit.logout({
            username: username ?? "unknown",
            role,
            sessionId,
            ip: clientIp
        });

        return { ok: true };

    }

    verifyAccessToken(token) {

        if (!this.isEnabled()) {

            return null;

        }

        const payload = verifyHs256Jwt(token, this._config.secret);

        if (!payload || payload.typ !== "access") {

            return null;

        }

        if (!canAccessDeveloperConsole(payload.role)) {

            return null;

        }

        return {
            username: payload.sub,
            role: payload.role,
            sessionId: payload.sid ?? null,
            environment: payload.env ?? this._config.appEnvironment,
            expiresAt: payload.exp * 1000,
            readOnly: payload.readOnly === true
        };

    }

    getPublicSessionFromAccessToken(token) {

        const claims = this.verifyAccessToken(token);

        if (!claims) {

            return null;

        }

        return Object.freeze({
            username: claims.username,
            role: claims.role,
            sessionId: claims.sessionId,
            environment: claims.environment,
            expiresAt: claims.expiresAt,
            readOnly: claims.readOnly === true
        });

    }

    auditUnauthorized(fields) {

        this._audit.unauthorized(fields);

    }

    auditSocketRejected(fields) {

        this._audit.socketRejected(fields);

    }

    auditPermissionDenied(fields) {

        this._audit.permissionDenied(fields);

    }

    _issueSession({ username, role, sessionId = null }) {

        const resolvedSessionId = sessionId || randomBytes(16).toString("hex");

        const readOnly = role === DEVELOPER_ROLES.VIEWER
            || role === DEVELOPER_ROLES.DEVELOPER;

        const accessToken = signHs256Jwt(
            {
                typ: "access",
                sub: username,
                role,
                sid: resolvedSessionId,
                env: this._config.appEnvironment,
                readOnly,
                scope: "developer-console"
            },
            this._config.secret,
            this._config.accessTokenTtlSeconds
        );

        const refreshToken = randomBytes(32).toString("base64url");

        const refreshExpiresAt = Date.now()
            + (this._config.refreshTokenTtlSeconds * 1000);

        this._refreshSessions.set(this._hashToken(refreshToken), {
            username,
            role,
            sessionId: resolvedSessionId,
            expiresAt: refreshExpiresAt,
            createdAt: Date.now()
        });

        const accessClaims = verifyHs256Jwt(accessToken, this._config.secret);

        return Object.freeze({
            accessToken,
            refreshToken,
            tokenType: "Bearer",
            sessionId: resolvedSessionId,
            expiresAt: accessClaims.exp * 1000,
            refreshExpiresAt,
            user: Object.freeze({
                username,
                role,
                sessionId: resolvedSessionId,
                environment: this._config.appEnvironment,
                readOnly
            })
        });

    }

    _getRefreshRecord(refreshToken) {

        if (!refreshToken || typeof refreshToken !== "string") {

            return null;

        }

        const hash = this._hashToken(refreshToken);

        const record = this._refreshSessions.get(hash);

        if (!record) {

            return null;

        }

        if (record.expiresAt <= Date.now()) {

            this._refreshSessions.delete(hash);

            return null;

        }

        return record;

    }

    _hashToken(token) {

        return createHash("sha256").update(token).digest("hex");

    }

    shutdown() {

        this._refreshSessions.clear();

    }

}
