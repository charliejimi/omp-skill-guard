#!/usr/bin/env -S bun --no-env-file
// omp-skill-guard: the CI side. Inventory and check the skills, build the approval manifest from the
// reviewed approvals, and sign or verify it. Run it through bin/omp-skill-guard, which starts Bun in
// an empty directory; the user's directory is restored here before omp's modules load, because
// some of them read the working directory when they are imported.
import * as fs from "node:fs";

const launchCwd = process.env.OMP_SKILL_GUARD_LAUNCH_CWD;
if (launchCwd) {
	process.chdir(launchCwd);
	delete process.env.OMP_SKILL_GUARD_LAUNCH_CWD;
} else if (fs.existsSync("bunfig.toml")) {
	process.stderr.write("omp-skill-guard: warning: started by Bun in a directory with a bunfig.toml; its preload ran inside this process. Use bin/omp-skill-guard.\n");
}
const { runSkillGuardCli } = await import("../src/cli");
process.exit(
	await runSkillGuardCli(process.argv.slice(2), {
		out: line => process.stdout.write(`${line}\n`),
		err: line => process.stderr.write(`${line}\n`),
	}),
);
