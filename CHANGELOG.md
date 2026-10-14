# Changelog

## [0.1.2] - 2026-10-14

### Fixed

- The access policy and the body guard split a `read`, `grep`, or `ast_grep` path list at `;`, `,`, and whitespace, honoring `{…}` groups, the way omp fans it out into separate reads. `read README.md;.omp/skills/x/SKILL.md` no longer reaches an unapproved or changed skill unchecked. Before, a `read` path was never split, and `grep` and `ast_grep` paths were split only at `;`.

## [0.1.1] - 2026-10-12

### Changed

- `omp-safe` starts omp from an empty per-run directory and names the project with `--cwd`, so a repository's `bunfig.toml` preload and `.env` no longer run inside omp when omp is installed from npm. A `--cwd` among omp's own arguments names the project.
- `omp-safe` gives omp an empty environment plus an allowlist (`PATH`, `HOME`, locale, terminal, temp, XDG, `PI_CODING_AGENT_DIR`). Pass anything else omp needs, such as a provider's key variable, with the new `passEnv` setting or `--pass-env`; before, omp got the launcher's whole environment.
- `bin/omp-safe` and `bin/omp-skill-guard` are shell wrappers that start Bun in an empty directory, so a repository's `bunfig.toml` preload cannot run inside the launcher or the CI tool. The `.ts` entries warn when Bun was started in a directory with a `bunfig.toml`.

### Fixed

- The test suite no longer reaches the real home directory. Bun fixes `os.homedir()` when it starts, so the preload's change to `HOME` had no effect: one test created and removed a project under the real home, the launcher test wrote a log under the real `~/.omp/logs`, and omp's discovery read the real `~/.omp/plugins`. `bun run test` now starts Bun with a temporary `HOME` and `TMPDIR`, plain `bun test` refuses to run, and every recursive delete in the tests is checked to stay inside that temporary root.
- The live tests no longer delete an existing evidence folder before a run; they refuse to overwrite it.

## [0.1.0] - 2026-10-12

### Added

- Approval manifest: each approved skill's name, the `sha256:` digest of its whole directory, each script's digest, its source, pinned commit, and named owner, plus revoked names; a detached Ed25519 signature over the exact bytes; optional expiry.
- `omp-skill-guard` CI tool: `keygen`, `inventory` (the skills omp would load, found by omp's own discovery), `check` (`name:` equals the directory, safe names, LF line endings, a description, no symlinks or special files), `manifest` (refuses a skill without an owner, source, or commit, or with undeclared scripts), `sign`, and `verify`.
- `omp-safe` launcher: verifies the manifest with the user's own public key, inventories every skill omp would load (including skills bundled with `-e` extensions), catches a same-named skill shadowing the approved copy, runs the guard self-test, asks at a terminal and refuses without one unless `--on-untrusted` says otherwise, starts omp with an overlay that loads only approved, unchanged skills and turns `/skill:` off, loads the guard last, and reports the guard's decisions and any handler that failed or timed out.
- Description guard (`before_agent_start`): withholds unapproved or changed skills' descriptions in both `<skills>` formats and removes approved descriptions that read like instructions; an entry imitating another is withheld whole.
- Access policy (`tool_call`): `read`, `grep`, `ast_grep`, and `bash` may touch a skill only while it is approved and its directory hashes to the approved digest, checked on every call, for `skill://` URLs, real paths, `;`-lists, `bash` commands and their `cwd`; `bash` may touch only listed scripts; globs, variables, and whole skills directories in `bash` are blocked as unverifiable.
- Body guard (`tool_result`): scrubs skill content returned by those tools, and in workspace-wide searches removes output from unapproved skills while leaving other files alone.
- `/skill` guard (`context`): inserts a `/skill:<name>` body only for an approved, unchanged skill whose message carries the current body; applies the description rules to the `skillful` listing.
- Startup warnings, a content-free JSONL audit log, and tests through omp's own loader, runner, settings, and discovery, plus opt-in live tests on real omp with a scripted test model.

### Not yet done

- Threat model (STRIDE, OWASP LLM Top 10, OWASP Agentic): not run.
- Independent security audit of the guard code: not run.
- Live runs with a real model: not run.
- First run of the GitHub Actions workflow; `bun.lock` was produced offline.
- Tests against omp versions newer than 18.2.8.
