/**
 * Warnings: something a demo may not mean, that doesn't stop it (a mock no
 * request used, a video that can't seek). Printed, and counted, so
 * `--strict` can fail a run in CI that had any.
 */
export function warn(message: string): void {
  const g = globalThis as { __reelscript_warnings?: number };
  g.__reelscript_warnings = (g.__reelscript_warnings ?? 0) + 1;
  process.stderr.write(`reelscript: warning: ${message}\n`);
}

/** How many warnings this process has printed. */
export function warningCount(): number {
  return (globalThis as { __reelscript_warnings?: number }).__reelscript_warnings ?? 0;
}
