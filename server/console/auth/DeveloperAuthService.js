import { createHash, randomBytes } from "node:crypto";

import { canAccessDeveloperConsole } from "./developerRoles.js";
import { passwordsMatch } from "./developerAuthConfig.js";
import { createDeveloperAuthAudit } from "./developerAuthAudit.js";
import { signHs256Jwt, verifyHs256Jwt } from "./jwtTokens.js";

/**
 * R6.1 — Developer Authentication service.
 *
 * Completely independent of Players / Rooms / Games / Wallets / Contracts.
 * Issues access JWTs + refresh tokens. Never mutates gameplay.
 */
export class DeveloperAuthService {

    constructor({ config, logger }) {

        this._config = config;

        this._logger = logger;

        this._audit = createDeveloperAuthAudit(logger);

        // refreshTokenHash → { username, role, expiresAt, createdAt }
        this._refreshSessions = new Map();

    }

    isEnabled() {

        return this._config.enabled === true && this._config.configured === true;

    }

    getEnvironment() {

        return this._config.environment;

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

        const normalizedUser = String(username || "").trim();

        const passwordOk = normalizedUser === this._config.username
            && passwordsMatch(
                String(password || ""),
                this._config.passwordHash,
                this._config.secret
            );

        if (!passwordOk) {

            this._audit.loginFailed({
                reason: "invalid_credentials",
                username: normalizedUser || "(empty)",
                ip: clientIp
            });

            return {
                ok: false,
                status: 401,
                error: "Invalid username or password"
            };

        }

        const role = this._config.defaultRole;

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

        // Rotate refresh token.
        this._refreshSessions.delete(this._hashToken(refreshToken));

        const session = this._issueSession({
            username: record.username,
            role: record.role
        });

        this._audit.refreshSuccess({
            username: record.username,
            role: record.role,
            ip: clientIp,
            expiresAt: session.expiresAt
        });

        return { ok: true, session };

    }

    logout({ refreshToken = null, accessToken = null, clientIp = null } = {}) {

        let username = null;

        if (refreshToken) {

            const hash = this._hashToken(refreshToken);

            const record = this._refreshSessions.get(hash);

            username = record?.username ?? null;

            this._refreshSessions.delete(hash);

        }

        if (!username && accessToken) {

            const payload = this.verifyAccessToken(accessToken);

            username = payload?.username ?? null;

        }

        this._audit.logout({
            username: username ?? "unknown",
            ip: clientIp
        });

        return { ok: true };

    }

    /**
     * Verify bearer access token. Returns claims or null.
     */
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
            environment: payload.env ?? this._config.environment,
            expiresAt: payload.exp * 1000,
            readOnly: payload.readOnly !== false
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

    shutdown() {

        this._refreshSessions.clear();

    }

    _issueSession({ username, role }) {

        const accessToken = signHs256Jwt(
            {
                typ: "access",
                sub: username,
                role,
                env: this._config.environment,
                readOnly: true,
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
            expiresAt: refreshExpiresAt,
            createdAt: Date.now()
        });

        const accessClaims = verifyHs256Jwt(accessToken, this._config.secret);

        return Object.freeze({
            accessToken,
            refreshToken,
            tokenType: "Bearer",
            expiresAt: accessClaims.exp * 1000,
            refreshExpiresAt,
            user: Object.freeze({
                username,
                role,
                environment: this._config.environment,
                readOnly: true
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

}
