/**
 * Append-only audit trail for the bridge's security-relevant events.
 *
 * One JSON object per line in `<storageDir>/audit.jsonl`. What is recorded
 * is deliberately shallow: WHO (a masked WeChat id), WHAT happened, and the
 * SIZE of a payload — never the message body, never a token, never a full
 * file content. The trail exists so an operator can answer "was a stranger
 * turned away?", "who raised the global permission default?", "which file did
 * the agent push to WeChat?" after the fact, without turning the log itself
 * into a second copy of the conversation.
 *
 * Bounded by construction: the file is capped at {@link AUDIT_MAX_BYTES} and
 * rotated to a single `<name>.1` predecessor, so the sink can never grow
 * without limit — the same rule the outbound queue follows ("a memory bound
 * must be enforced by code that removes memory on every path; retry is never
 * the bound"). Every rotation is logged loudly.
 *
 * Failure policy: auditing is best-effort and MUST NOT break the message
 * path — a read-only storage directory would otherwise turn every send into a
 * failure. The first failure is reported through the injected logger, then
 * further failures are counted and reported only on the way back up (so a
 * permanently broken sink does not flood the console).
 */

import fs from "node:fs";
import path from "node:path";
import { appendPrivateFile, chmodPrivate, ensurePrivateDir } from "./secure-fs.js";

/** Cap of one audit file before it is rotated. Keep the previous file too. */
export const AUDIT_MAX_BYTES = 1 << 20; // 1 MiB
/** Longest single JSONL line kept — a runaway value must not eat the cap alone. */
export const AUDIT_MAX_LINE_CHARS = 2000;

export class AuditLog {
  private readonly filePath: string;
  private readonly previousPath: string;
  private bytes = -1;
  private failures = 0;

  constructor(
    private readonly storageDir: string,
    private readonly log: (message: string) => void,
    /** Injectable for tests; defaults to the module constant. */
    private readonly maxBytes: number = AUDIT_MAX_BYTES,
  ) {
    this.filePath = path.join(storageDir, "audit.jsonl");
    this.previousPath = `${this.filePath}.1`;
  }

  /** Absolute path of the live audit file (reported on failure by the caller's log line). */
  path(): string {
    return this.filePath;
  }

  /** Current on-disk size, or 0 when the file does not exist yet. */
  private currentBytes(): number {
    if (this.bytes >= 0) return this.bytes;
    try {
      this.bytes = fs.statSync(this.filePath).size;
    } catch {
      this.bytes = 0;
    }
    return this.bytes;
  }

  /**
   * Append one event. Adds `time` (ISO-8601) to the record; the caller owns
   * every other field and must already have masked identifiers and dropped
   * bodies.
   */
  record(event: Record<string, unknown>): void {
    let line: string;
    try {
      line = `${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`;
    } catch {
      // A circular / non-serializable value must not break the caller.
      this.fail("serialize");
      return;
    }
    if (line.length > AUDIT_MAX_LINE_CHARS) {
      line = `${line.slice(0, AUDIT_MAX_LINE_CHARS - 2)}"}\n`;
    }
    try {
      ensurePrivateDir(this.storageDir);
      if (this.currentBytes() + line.length > this.maxBytes) this.rotate();
      appendPrivateFile(this.filePath, line);
      this.bytes = this.currentBytes() + line.length;
      if (this.failures > 0) {
        this.log(`audit sink recovered after ${this.failures} failure(s)`);
        this.failures = 0;
      }
    } catch (err) {
      this.fail(`append: ${String(err)}`);
    }
  }

  /**
   * Rename the live file to `<name>.1`, replacing any previous rotation, and
   * start a new one. Logged loudly: an audit trail that silently loses its
   * history is worse than no trail at all.
   */
  private rotate(): void {
    try {
      fs.renameSync(this.filePath, this.previousPath);
      chmodPrivate(this.previousPath);
    } catch (err) {
      // Rename failed (e.g. the file vanished): truncate instead so the cap
      // still holds.
      this.log(`audit rotation failed, truncating instead: ${String(err)}`);
      try {
        fs.truncateSync(this.filePath, 0);
      } catch {
        // The append below will report whatever is really wrong.
      }
    }
    this.log(`audit log reached ${this.maxBytes} bytes; rotated to ${path.basename(this.previousPath)}`);
    this.bytes = 0;
  }

  private fail(what: string): void {
    this.failures += 1;
    if (this.failures === 1) {
      this.log(`audit ${what} failed; auditing is degraded (further failures are counted, not logged)`);
    }
  }
}
