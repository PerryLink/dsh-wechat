/**
 * Filesystem hygiene for the plugin's own storage directory.
 *
 * Everything under `~/.dsh-wechat` is sensitive: the iLink bot token, the
 * WeChat↔session mapping, the outbound queue, and the audit trail. The
 * directory therefore gets `0o700` and every file `0o600`, applied
 * unconditionally at creation time AND re-applied with an explicit `chmod`
 * (a pre-existing file keeps its old, possibly world-readable, mode —
 * `{ mode }` on `writeFileSync` only applies when the file is created).
 *
 * ⚠️ Windows: Node ignores the `mode` argument on Windows, and `chmod`
 * there can only toggle the read-only bit. The hardening therefore relies on
 * the inherited ACLs of `%USERPROFILE%` (only the user, `SYSTEM` and
 * `Administrators` can read it) — documented in the README. On POSIX the
 * modes above are real.
 *
 * Every helper here is best-effort about the CHMOD (a filesystem that does
 * not support it must not break persistence) but NOT about the write itself:
 * a caller that cannot persist must see the error.
 */

import fs from "node:fs";
import path from "node:path";

/** Directory mode for the storage dir and its subdirectories. */
export const PRIVATE_DIR_MODE = 0o700;
/** File mode for every file this plugin writes. */
export const PRIVATE_FILE_MODE = 0o600;

/**
 * Create `dir` (recursively) with `0o700` and tighten an existing directory
 * to the same mode. Never throws: a storage directory that cannot be created
 * surfaces on the following write, where the caller already has error
 * handling; failing here would turn plugin load into a crash.
 */
export function ensurePrivateDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  } catch {
    return;
  }
  try {
    fs.chmodSync(dir, PRIVATE_DIR_MODE);
  } catch {
    // Windows / unsupported filesystem: inherited ACLs apply.
  }
}

/** Tighten one existing file to `0o600`; silently ignores unsupported filesystems. */
export function chmodPrivate(filePath: string): void {
  try {
    fs.chmodSync(filePath, PRIVATE_FILE_MODE);
  } catch {
    // Windows / unsupported filesystem.
  }
}

/**
 * Write a file with `0o600`, creating its parent directory with `0o700`.
 * `data` may be a string or a Buffer.
 */
export function writePrivateFile(filePath: string, data: string | Buffer): void {
  ensurePrivateDir(path.dirname(filePath));
  fs.writeFileSync(filePath, data, { encoding: "utf-8", mode: PRIVATE_FILE_MODE });
  chmodPrivate(filePath);
}

/**
 * Append to a file with `0o600`, creating it (and its parent) private on
 * first use. Used by the audit sink, which appends one line at a time.
 */
export function appendPrivateFile(filePath: string, data: string): void {
  ensurePrivateDir(path.dirname(filePath));
  fs.appendFileSync(filePath, data, { encoding: "utf-8", mode: PRIVATE_FILE_MODE });
  chmodPrivate(filePath);
}
