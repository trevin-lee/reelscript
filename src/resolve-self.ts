/**
 * Module resolution hook registered by the CLI so that user scripts can
 * `import "@reelscript/cli"` even when the package is not installed next to
 * the script (global install, the container, or `npx`). The import resolves
 * to the copy of the library that is running the CLI.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Built package: index.js sits next to this file. Running from source (tsx): index.ts.
const built = new URL("./index.js", import.meta.url);
const SELF = (existsSync(fileURLToPath(built)) ? built : new URL("./index.ts", import.meta.url)).href;

type Resolve = (
  specifier: string,
  context: { parentURL?: string },
  next: (specifier: string, context: { parentURL?: string }) => Promise<{ url: string }>,
) => Promise<{ url: string; shortCircuit?: boolean }>;

export const resolve: Resolve = async (specifier, context, next) => {
  if (specifier === "@reelscript/cli") return { url: SELF, shortCircuit: true };
  return next(specifier, context);
};
