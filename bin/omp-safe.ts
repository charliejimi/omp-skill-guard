#!/usr/bin/env -S bun --no-env-file
// omp-safe: check every skill omp would load against the signed manifest, then start omp with only
// the approved, unchanged skills and the guard loaded last.
import { runOmpSafe, terminalIO } from "../src/launcher";

process.exit(await runOmpSafe(process.argv.slice(2), terminalIO()));
