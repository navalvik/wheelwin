import { existsSync, lstatSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";

/**
 * Remove only local game ZIPs whose corresponding non-empty R2 object has
 * been confirmed. Without an object verifier this function is read-only.
 */
export async function purgeLocalForensicArchiveZips({
    stagingDir,
    volumeRoot = process.env.RAILWAY_VOLUME_MOUNT_PATH,
    temporaryRoot = tmpdir(),
    applicationDataDir = join(process.cwd(), "data"),
    verifyObject = null,
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
    add(temporaryRoot, false);
    add(applicationDataDir, false);

    let deleted = 0, bytes = 0, failed = 0, scanned = 0, unconfirmed = 0;
    const visited = new Set();
    const candidates = [];
    function walk(dir, deleteAnyZip) {
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
                        walk(path, deleteAnyZip || /(?:^|[-_])(?:r2[-_]archive|archive[-_]staging)/i.test(entry.name));
                    }
                    continue;
                }
                if (!entry.isFile()) continue;
                scanned++;
                const isZip = /\.zip$/i.test(entry.name);
                const gameArchive = /(?:^|_)ROOM_[^/\\]+\.zip$/i.test(entry.name)
                    || /(?:^|_)ROOM_[^/\\]+_FIN_[0-9a-f]+\.zip$/i.test(entry.name);
                if (isZip && (deleteAnyZip || gameArchive)) candidates.push(path);
            } catch { failed++; }
        }
    }
    for (const [root, deleteAnyZip] of [...roots].sort((a,b)=>b[0].length-a[0].length)) {
        if (!existsSync(root)) continue;
        if (root === resolve("/")) throw new Error("FORENSIC_ZIP_CLEANUP_REFUSED_FILESYSTEM_ROOT");
        walk(root, deleteAnyZip);
    }

    for (const path of candidates) {
        if (typeof verifyObject !== "function") { unconfirmed++; continue; }
        try {
            if (await verifyObject(basename(path)) !== true) { unconfirmed++; continue; }
            // Re-check the path after the network request and never follow a symlink.
            if (!lstatSync(path).isFile()) { failed++; continue; }
            const size = statSync(path).size;
            unlinkSync(path);
            deleted++;
            bytes += size;
        } catch { failed++; }
    }
    logger?.info?.(`RAILWAY_FORENSIC_ZIP_PURGE | deleted=${deleted} | bytes=${bytes}`
        + ` | unconfirmed=${unconfirmed} | failed=${failed} | scanned=${scanned}`);
    return { deleted, bytes, failed, scanned, unconfirmed };
}
