/**
 * R6.2 — System information DTO (read-only diagnostics).
 */
import { execSync } from "node:child_process";

function resolveGitCommit() {

    try {

        return execSync("git rev-parse --short HEAD", {
            stdio: ["ignore", "pipe", "ignore"]
        }).toString().trim() || null;

    } catch {

        return null;

    }

}

export function buildSystemInformation({
    version,
    startedAt,
    runtimeConfig = null,
    healthService = null
}) {

    const health = healthService?.getHealthSnapshot?.() ?? null;

    const uptimeMs = Number.isFinite(health?.uptimeMs)
        ? health.uptimeMs
        : (startedAt != null ? Math.max(0, Date.now() - startedAt) : 0);

    return Object.freeze({
        applicationVersion: version ?? "unknown",
        buildTimestamp: runtimeConfig?.loadedAt ?? null,
        nodeVersion: process.version,
        platform: `${process.platform} ${process.arch}`,
        gitCommit: resolveGitCommit(),
        serverStartTime: startedAt ?? null,
        uptimeMs,
        environment: runtimeConfig?.developer?.appEnvironment ?? null,
        nodeEnvironment: runtimeConfig?.server?.nodeEnv ?? null,
        tonNetwork: runtimeConfig?.ton?.network ?? null,
        tonDeployMode: runtimeConfig?.ton?.deployMode ?? null
    });

}
