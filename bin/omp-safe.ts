#!/usr/bin/env -S bun --no-env-file
// omp-safe: check every skill omp would load against the signed manifest, then start omp with only
// the approved, unchanged skills and the guard loaded last. Run it through bin/omp-safe, which
// starts Bun in an empty directory; the user's directory is restored here before omp's modules
// load, because some of them read the working directory when they are imported.
import * as fs from "node:fs";

const launchCwd = process.env.OMP_SKILL_GUARD_LAUNCH_CWD;
if (launchCwd) {
	process.chdir(launchCwd);
	delete process.env.OMP_SKILL_GUARD_LAUNCH_CWD;
} else if (fs.existsSync("bunfig.toml")) {
	process.stderr.write("omp-safe: warning: started by Bun in a directory with a bunfig.toml; its preload ran inside the launcher. Use bin/omp-safe.\n");
}
const { runOmpSafe, terminalIO } = await import("../src/launcher");
process.exit(await runOmpSafe(process.argv.slice(2), terminalIO()));
