# omp-skill-guard

An [oh-my-pi](https://github.com/can1357/oh-my-pi) (omp) package that lets the agent use only the skills your CI approved, and only while they are unchanged. CI builds and signs a manifest of approved skills; `omp-safe` checks every skill omp would load against it before omp starts; and one extension guards the four ways skill text reaches the model.

[中文說明](README.zh-TW.md)

> **Not tested with a real model.** The live tests run real omp end to end, but with a scripted test model, so they show what reaches the model, not what a model does next. Whether a real model follows skill text that passes the guard has not been measured.

## Why

A skill is text written by someone else that omp puts in front of the model. Its description sits in the system prompt of every session, whether or not the task has anything to do with it. Its body arrives when the model reads `skill://<name>`, and also through `grep`, `bash`, a plain `read` of the file, and the `/skill:<name>` command, which inserts the body without any tool call. A cloned repository, a vendored skill pack, or a skill that updates itself can change that text at any time.

Rewriting the text on its way in is useful, but in omp those rewriting hooks let the original through when they fail or time out. The only hook where omp blocks on failure is `tool_call`. So this package moves the decision of *which* skills may be used out of the agent's reach: CI approves a skill by the digest of its directory, signs the list with a key the agent never sees, and every access is checked against that digest at the moment it happens. The rewriting hooks then clean what is left.

## How it fits together

1. **CI** inventories the skills, checks them against the repository rules, and, after a named owner reviewed each one, writes `skills.manifest.json` with a digest of every skill directory and script, and signs it with an Ed25519 key that only CI holds.
2. **`omp-safe`** runs on the developer's machine. It verifies the signature with the CI public key from the user's own config, finds every skill omp would load with omp's own discovery code, hashes each directory, runs the guard's self-test, and asks what to do when something is not approved. Then it starts omp with a settings overlay that loads only the approved, unchanged skills, turns `/skill:` commands off, and loads the guard last.
3. **The guard** runs inside omp and checks every access again, because a file can change after startup.

## What it does

| Part | Where | What it does | If it fails |
|---|---|---|---|
| CI tool `omp-skill-guard` | CI | `keygen` makes the key pair. `inventory` lists the skills omp would load, with digests. `check` enforces the rules: `name:` equals the directory name; names use only letters, digits, `.`, `_`, `:`, `-`; `SKILL.md` uses LF line endings; a description is present; no symlinks or special files. `manifest` refuses a skill that has no owner, source, or commit in the approvals file, or whose scripts differ from the declared list. `sign` and `verify` handle the signature. | Exits non-zero; the manifest is not written. |
| Launcher `omp-safe` | the developer's machine, before omp starts | Verifies the manifest, inventories with omp's own discovery (including skills bundled with `-e` extensions), hashes each skill directory, catches a same-named skill from a higher-priority location shadowing the approved copy, runs the self-test, and asks: do not start (the default), start with only the approved skills, or start with skills off. Without a terminal it refuses unless `--on-untrusted` says otherwise. It writes a settings overlay and a per-run guard entry, starts omp from an empty directory with `--cwd` and only an allowlisted environment, and afterwards prints the guard's decisions and alerts on any guard handler that failed or timed out. | Refuses to start (exit 3). |
| Description guard | `before_agent_start` | In the `<skills>` block of the system prompt, the description of a skill that is not approved, or changed since approval, is withheld, and an approved description that reads like an instruction is removed. Entries are matched exactly as omp renders them, so a description that imitates another skill's entry is withheld whole. | omp sends the original prompt, so the handler never throws. omp-safe's overlay already keeps unapproved skills out of the prompt. |
| Access policy | `tool_call` | `read`, `grep`, `ast_grep`, and `bash` may touch a skill only while the manifest approves it and its directory hashes to the approved digest, checked again on every call. It recognizes `skill://` URLs, real paths (relative, absolute, `~`, through symlinks, with read selectors), `;`-separated path lists, and `bash` commands and their `cwd`. `bash` may touch a skill script only if the manifest lists it. A skill directory omp did not load is checked by its digest too. A `bash` command that reaches skill files through a glob, a variable, or a whole skills directory is blocked as unverifiable. | omp blocks the call, and so does the guard. |
| Body guard | `tool_result` | Skill content returned by those tools has its instruction-like lines replaced by a marker; other lines are kept. In a workspace-wide `grep`, `ast_grep`, or shell search, output from an approved skill is scrubbed and output from an unapproved or changed skill is removed, while results from ordinary files are left alone. | omp passes the original result on, so the handler never throws; a skill result it cannot check is withheld. |
| `/skill` guard | `context` | A `/skill:<name>` message is inserted only if the skill is approved, unchanged, and the message carries the current `SKILL.md` body; then its instruction-like lines are replaced. Otherwise the message is replaced by a notice. The skill listing omp sends when `skillful` is turned on mid-session gets the description rules. omp-safe turns `/skill:` commands off unless you pass `--allow-skill-commands`. | omp sends the original messages, so the handler never throws. |
| Startup check | `session_start` | Warns when there is no valid manifest, when a loaded skill is not approved, when `/skill:` commands are on, when the `eval` tool is active, or when the guard is not loaded last. | The error is logged. |
| Audit log | every decision | One JSON line per decision: time, run id, event, tool, skill, digest, rule, action. No skill content, no paths. | A write error is logged once. |

The instruction patterns are an override ("ignore previous", "disregard prior", "new instructions"), the words "system prompt", an every-session cadence, "before responding", a secrecy marker ("silently", "do not mention"), and injection tags such as `<system>`. Ordinary skill steps such as "run the build" are not matched. `createSkillGuard({ extraPatterns })` adds your own.

## Requirements

- [Bun](https://bun.sh) 1.3.14 or newer, and a POSIX shell for the two bin wrappers.
- omp 18.2.8. The package was written and tested against that version; later versions change skill discovery (see [Limits](#limits)).
- `omp-safe` and `omp-skill-guard` import omp's own discovery code, so install this package next to omp: clone it and run `bun install`. Loading omp's code adds a few seconds before omp starts.

## Setup

### Once: the CI key

```bash
omp-skill-guard keygen ./keys
```

Store `skill-guard.key.pem` as a CI secret and nowhere else. Give `skill-guard.pub.pem` to everyone who runs omp-safe.

### In CI, whenever a skill changes

Every new or updated skill arrives through a pull request that names its source, the pinned commit, a named owner, and its scripts. Record that in an approvals file (see [`examples/approvals.example.json`](examples/approvals.example.json)):

```json
{
	"skills": {
		"deploy-helper": {
			"source": "https://github.com/example/skills",
			"commit": "0123456789abcdef0123456789abcdef01234567",
			"owner": "release-team",
			"scripts": ["scripts/release.sh"]
		}
	},
	"revoked": ["old-deploy-helper"]
}
```

Then, in the job that runs after the owner's review:

```bash
omp-skill-guard check
# run your skill scanners here and fail the job on high-severity findings
omp-skill-guard manifest --approvals approvals.json --out skills.manifest.json --expires-in-days 30
omp-skill-guard sign --key "$SKILL_GUARD_KEY_FILE" skills.manifest.json
```

Publish `skills.manifest.json` and `skills.manifest.json.sig` somewhere outside the repository, such as a CI artifact or a settings repository that only CI writes to. A manifest kept in the repository is input the repository controls, so the guard trusts only the signature.

To withdraw a skill, remove it from `skills` (and add it to `revoked` if it might come back), rebuild, and re-sign. The next start no longer loads it.

### On each developer machine

Put the public key and the downloaded manifest where you like, and write `~/.config/omp-skill-guard/config.json` (see [`examples/config.example.json`](examples/config.example.json)):

```json
{
	"manifest": "~/.cache/omp-skill-guard/skills.manifest.json",
	"publicKeys": ["~/.config/omp-skill-guard/skill-guard.pub.pem"],
	"auditLog": "~/.local/state/omp-skill-guard/audit.jsonl",
	"tools": ["read", "write", "edit", "grep", "find"],
	"allowSkillCommands": false,
	"onUntrusted": "ask",
	"omp": ["omp"],
	"passEnv": []
}
```

Then start omp through the launcher, with omp's own arguments after `--`:

```bash
omp-safe -- --model <your model>
```

The guard reads its trust anchor only from this file or from explicit options, never from environment variables: Bun loads a project's `.env` into the process before omp's code runs, so a repository could otherwise point the guard at its own key.

omp-safe starts omp from an empty directory and names the project with `--cwd`. When omp is installed from npm, Bun runs the `bunfig.toml` preload and loads the `.env` of the directory it starts in before omp's own code, so a repository's preload would otherwise run ahead of every guard. omp gets an empty environment plus `PATH`, `HOME`, locale, terminal, temp, XDG, and `PI_CODING_AGENT_DIR`; pass anything else omp needs, such as your provider's key variable, with `passEnv` or `--pass-env`. Code omp loads can read every variable omp has. The two commands themselves start Bun the same way: `bin/omp-safe` and `bin/omp-skill-guard` are small shell wrappers that start it in an empty directory, so run those, not the `.ts` files.

`omp-safe --help` lists the flags. Every config field has a flag that overrides it, and `--on-untrusted refuse|exclude|disable` decides what happens without a terminal. Exit codes: omp's own, 2 for a usage error, 3 when it refuses to start.

What omp-safe passes to omp is an overlay like [`examples/overlay.example.yml`](examples/overlay.example.yml). Note that omp reads an empty `includeSkills` list as "every skill", so with nothing approved omp-safe turns skills off instead.

### Without omp-safe

Loading the guard directly (`omp -e <this package>`, with the config file above) still enforces the manifest on every access and withholds unapproved descriptions, but unapproved skills are loaded and listed, `/skill:` commands stay on unless you turn them off, and nothing checks the skills before the session starts.

## Tests

```bash
bun run test
```

The suite runs through omp's own loader, runner, settings, and skill discovery, with no network: each guard's allow and block paths for every way a skill can be named, the manifest and its signature, the launcher's decisions and overlay (loaded back through omp's settings), and the CI tool. `bun run test` starts Bun with a temporary `HOME` and `TMPDIR`; plain `bun test` refuses to run, because the suite creates projects and logs under the home directory and Bun fixes the home directory when it starts.

The live tests run real omp with a scripted test-only model provider (`test/scripted-provider.ts`) and record what the model would receive:

```bash
SKILL_GUARD_LIVE=1 OMP_CLI=/path/to/oh-my-pi/packages/coding-agent/src/cli.ts \
SKILL_GUARD_LIVE_OUT=/tmp/skill-guard-evidence bun run test test/live.test.ts
```

`OMP_BIN=/path/to/omp` runs an installed omp instead; an existing evidence folder is never overwritten. The eight scenarios cover descriptions (no guard, omp-safe, guard only), reads (approved, unapproved, changed after startup), `grep` and `bash` (scoped, workspace-wide, blocked), `/skill:` (guard, no guard, omp-safe), scripts (approved, changed after startup), omp-safe refusing to start plus its audit lines and report, a repository's `bunfig.toml` preload and `.env` (they reach plain omp, not omp started by omp-safe, which also drops unlisted variables), and the CI tool with and without its wrapper.

## To do before a public release

- **Threat model.** Not run. A STRIDE, OWASP LLM Top 10, and OWASP Agentic walkthrough of the manifest, launcher, and guard is still open.
- **Security audit.** Not run. The guard code has had no independent adversarial review.
- **Real-model runs.** Not run; the machine it was built on had no network. They would show whether a model follows skill text that passes the patterns.
- **First CI run.** The GitHub Actions workflow has not run yet; `bun.lock` was produced offline from Bun's cache.
- **Newer omp versions.** Only 18.2.8 was tested (see Limits).

## Limits

- **The rewriting guards fail open in omp.** If the description, body, or `/skill` guard throws or times out (30 seconds by default), omp uses the original text. The access policy fails closed, omp-safe's overlay keeps unapproved skills from loading at all, and omp-safe reports timeouts after the run, but an approved skill's text that the guard failed to clean can still reach the model.
- **The patterns are keywords.** An approved skill whose text is paraphrased to avoid them passes. The real gate is the review before approval; skill scanners help but are best effort.
- **`bash` is read statically.** A command that reaches skill files without naming them (`find … -exec cat`, a path assembled at run time, another script) is not seen, and what an approved script does once it runs is not checked. The `eval` tool can read anything. Leave `bash` and `eval` out of `--tools` unless you need them.
- **Other extensions.** omp gives every `tool_call` handler the original input and runs the last rewrite, so an extension that rewrites a call after the guard checked it is not seen. Handlers that rewrite results run in load order, which is why the guard should load last. Load only extensions you trust.
- **Writes into skill directories are not blocked.** A changed skill is blocked at its next access and left out at the next start, because its digest no longer matches.
- **Replayed manifests.** An older, validly signed manifest can be used again unless CI sets `--expires-in-days`.
- **The audit log is local** and not tamper-evident.
- **Outside this package:** skill scanners, the owner's review, and the release gate that should verify CI's signed results while the agent's credentials stay read-only. Subagent `autoloadSkills` and repository-supplied settings and extensions are not handled.
- **omp versions.** Written against omp 18.2.8. From v18.3.0, omp summarizes skill descriptions with a small model through no hook; with omp-safe only approved descriptions are loaded, but that path was not tested. Namespaced skill names and `omp skill list` arrived later as well.
- **Platforms.** Tested on Linux only.

## Background

This package implements the integrated sequence written for Day 20 of an omp-versus-Cursor hardening series, "skills as a supply chain". The original Day 20 guards scrubbed descriptions in `before_agent_start` and `skill://` reads in `tool_result`, both of which fail open; reading omp 18.2.8's source showed that `bash`, `grep`, plain reads of the file, and `/skill:` also deliver skill bodies. This package adds the fail-closed access policy, the guards for those paths, the signed manifest, and the launcher. CI scanning, human review, and the release gate from that sequence stay outside it.

## License

[MIT](LICENSE)
