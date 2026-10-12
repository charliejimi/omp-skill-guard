#!/usr/bin/env -S bun --no-env-file
// omp-skill-guard: the CI side. Inventory and check the skills, build the approval manifest from the
// reviewed approvals, and sign or verify it.
import { runSkillGuardCli } from "../src/cli";

process.exit(
	await runSkillGuardCli(process.argv.slice(2), {
		out: line => process.stdout.write(`${line}\n`),
		err: line => process.stderr.write(`${line}\n`),
	}),
);
