import { existsSync, lstatSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
 * Delete ONLY local WheelWin forensic ZIP files. Preserve every financial
 * JSON store, all game history/diagnostic records and all Cloudflare objects.
 * Follow no symlinks. Designed for startup before archive recovery.
 */
export function purgeLocalForensicArchiveZips({
    stagingDir,
    volumeRoot = process.env.RAILWAY_VOLUME_MOUNT_PATH,
    applicationDataDir = join(process.cwd(), "data"),
    logger = null
} = {}) {
    const roots = new Map();
    const add = (value, allZip = false) => {
        if (typeof value !== "string" || !value.trim()) return;
        const root = resolve(value);
        roots.set(root, Boolean(roots.get(root)) || allZip);
    };
    add(stagingDir, true);
    add(volumeRoot, false);
    add(applicationDataDir, false);

    let deleted = 0, bytes = 0, failed = 0, scanned = 0;
    const visited = new Set();
    // Traversal remains inside explicit Railway storage roots, never /.
    function walk(dir, deleteAnyZip, root) {
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); }
        catch (error) {
            if (error?.code !== "ENOENT") failed++;
            return;
        }
        for (const entry of entries) {
            const path = join(dir, entry.name);
            try {
                if (entry.isSymbolicLink()) continue;
                if (entry.isDirectory()) {
                    if (!visited.has(path)) {
                        visited.add(path);
                        walk(path, deleteAnyZip || /(?:^|[-_])(?:r2[-_]archive|archive[-_]staging)/i.test(entry.name), root);
                    }
                    continue;
                }
                if (!entry.isFile()) continue;
                scanned++;
                const isZip = /\.zip$/i.test(entry.name);
                const gameArchive = /(?:^|_)ROOM_[^/\\]+\.zip$/i.test(entry.name)
                    || /(?:^|_)ROOM_[^/\\]+_FIN_[0-9a-f]+\.zip$/i.test(entry.name);
                if (!isZip || !(deleteAnyZip || gameArchive)) continue;
                const size = statSync(path).size;
                unlinkSync(path);
                deleted++; bytes += size;
            } catch (error) { failed++; }
        }
    }
    // Visit narrower roots first; a broad root then still finds siblings.
    for (const [root, deleteAnyZip] of [...roots].sort((a,b)=>b[0].length-a[0].length)) {
        if (!existsSync(root)) continue;
        if (root === resolve("/")) throw new Error("FORENSIC_ZIP_CLEANUP_REFUSED_FILESYSTEM_ROOT");
        walk(root, deleteAnyZip, root);
    }
    logger?.info?.(`RAILWAY_FORENSIC_ZIP_PURGE | deleted=${deleted} | bytes=${bytes} | failed=${failed} | scanned=${scanned}`);
    return { deleted, bytes, failed, scanned };
}
