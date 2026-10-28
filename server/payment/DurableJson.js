import { openSync, closeSync, fsyncSync, writeFileSync, renameSync, linkSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Publish only fully flushed records. Never delete the old destination to
// work around a Windows rename failure: it may be the only copy of a debt.
export function durableWriteJson(path, value, { exclusive = false, indent = 2 } = {}) {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try {
        writeFileSync(fd, `${JSON.stringify(value, null, indent)}\n`, 'utf8');
        fsyncSync(fd);
    } finally { closeSync(fd); }
    try {
        for (let attempt = 0; ; attempt++) {
            try {
                if (exclusive) linkSync(temporary, path);
                else renameSync(temporary, path);
                break;
            } catch (error) {
                if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 30) throw error;
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(200, 20 * (attempt + 1)));
            }
        }
        if (process.platform !== 'win32') {
            const directoryFd = openSync(directory, 'r');
            try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
        }
    } finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
