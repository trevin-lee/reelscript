/**
 * Clean-up on Ctrl-C and termination. Anything that leaves something behind
 * while it runs (a code-server process tree, a half-written video, a
 * temporary copy of a script) registers a clean-up here, and removes it once
 * it has cleaned up normally.
 *
 * The registry lives on the process, not in this module, so that two copies
 * of reelscript loaded at once (the CLI from one build, the library from
 * another) share one set of handlers instead of racing each other to exit.
 */
type Task = () => unknown;

interface Registry {
  tasks: Set<Task>;
  /** Clean-ups registered after the interrupt began: they run at once, and exit waits for them. */
  late: Promise<unknown>[];
  installed: boolean;
  stopping: boolean;
}

const KEY = Symbol.for("reelscript.cleanup.v2");
const registry: Registry = ((globalThis as Record<symbol, Registry>)[KEY] ??= {
  tasks: new Set(),
  late: [],
  installed: false,
  stopping: false,
});

const EXIT_CODES: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
const run = (t: Task) => Promise.resolve().then(t).catch(() => {});

/** Whether an interrupt is in progress: work that's starting up should stop at its next step. */
export function interrupted(): boolean {
  return registry.stopping;
}

/**
 * Handle Ctrl-C and termination from now on, even with nothing to clean up
 * yet. The CLI calls this at start-up: as PID 1 in a container, a process has
 * no default signal handling, so without it `docker stop` and Ctrl-C would be
 * ignored until the first clean-up registered.
 */
export function installInterruptHandlers(): void {
  if (registry.installed) return;
  registry.installed = true;
  for (const signal of Object.keys(EXIT_CODES) as NodeJS.Signals[]) {
    process.on(signal, () => void stop(signal));
  }
}

/** Run `task` if the process is interrupted. Returns a function that unregisters it. */
export function onInterrupt(task: Task): () => void {
  if (registry.stopping) {
    // Something got as far as creating what it cleans up after the interrupt began.
    registry.late.push(run(task));
    return () => {};
  }
  registry.tasks.add(task);
  installInterruptHandlers();
  return () => registry.tasks.delete(task);
}

async function stop(signal: NodeJS.Signals): Promise<void> {
  if (registry.stopping) return;
  registry.stopping = true;
  process.stderr.write(`\nreelscript: interrupted, cleaning up\n`);
  const deadline = Date.now() + 8000;
  const until = (p: Promise<unknown>) => Promise.race([p, new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())).unref())]);
  await until(Promise.all([...registry.tasks].map(run)));
  // Work already in flight may register (and so run) its clean-up a moment
  // later; wait for those, and give stragglers a brief chance to register.
  for (let quiet = 0; quiet < 3 && Date.now() < deadline; ) {
    const late = registry.late.splice(0);
    if (late.length) {
      quiet = 0;
      await until(Promise.all(late));
    } else {
      quiet++;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  // Wind down rather than process.exit(): the voice model's native threads abort
  // the process if it's torn down under them. A timer that doesn't keep the
  // process alive forces the exit if something else would (an MCP client's stdin).
  const code = EXIT_CODES[signal] ?? 1;
  process.exitCode = code;
  setTimeout(() => process.exit(code), 3000).unref();
}
