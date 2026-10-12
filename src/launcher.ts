// omp-safe: before omp starts, checks every skill omp would load against the signed manifest and
// runs the guard self-test; then starts omp with a settings overlay that loads only approved,
// unchanged skills and with the guard configured explicitly; afterwards reports the guard's
// decisions and alerts on any guard handler that failed or timed out. omp starts in an empty
// directory and reaches the project through --cwd, because Bun runs the bunfig.toml preload and
// loads the .env of the directory it starts in before omp's code; and it gets only an
// allowlisted environment.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings } from "@oh-my-pi/pi-coding-agent/discovery";
import { injectOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { getLogsDir } from "@oh-my-pi/pi-utils/dirs";
import {
	type GuardConfig,
	UNTRUSTED_POLICIES,
	type UntrustedPolicy,
	defaultAuditLog,
	defaultConfigPath,
	defaultStateDir,
	loadConfig,
	resolveConfigPath,
} from "./config";
import { childEnv } from "./env";
import type { SkillGuardOptions } from "./index";
import { type Manifest, approvalRule, digestFile, digestSkillDir, listScripts, loadTrustedManifest, resolvePublicKeys } from "./manifest";
import type { SkillRule } from "./policy";
import { type SelfTestResult, selfTest as builtInSelfTest } from "./selftest";

export const EXIT_USAGE = 2;
export const EXIT_REFUSED = 3;

const PACKAGE_DIR = path.resolve(import.meta.dir, "..");

export type Outcome = "start" | "exclude" | "disable" | "refuse";

export interface LaunchIO {
	/** One line of the launcher's own output. It goes to stderr, so it never mixes with omp's stdout. */
	err(line: string): void;
	/** Asks the person at the terminal; absent when there is none. */
	ask?(question: string): Promise<string | undefined>;
}

export interface LaunchOptions {
	/** The project omp runs in. */
	cwd: string;
	config: GuardConfig;
	/** Arguments for omp itself. */
	ompArgs?: string[];
	/** Where each run's overlay and guard entry are written; removed after the run. */
	stateDir?: string;
	io: LaunchIO;
	selfTest?: () => SelfTestResult;
	now?: Date;
	/** The environment omp's allowlisted variables come from; the process's own by default. */
	env?: Readonly<Record<string, string | undefined>>;
}

export interface InventoryItem {
	name: string;
	source: string;
	dir: string;
	digest?: string;
	scripts: Record<string, string>;
	/** Why the directory could not be hashed. */
	error?: string;
}

export interface SkillCheck {
	name: string;
	source: string;
	dir: string;
	digest?: string;
	status: SkillRule;
}

export interface Preflight {
	manifest?: Manifest;
	manifestProblem?: string;
	skills: SkillCheck[];
	untrusted: SkillCheck[];
	selfTest: SelfTestResult;
}

const STATUS_TEXT: Record<SkillRule, string> = {
	approved: "approved",
	"not-approved": "not in the approved manifest",
	modified: "files changed since approval",
	revoked: "approval revoked",
	"no-manifest": "no valid manifest",
	unreadable: "could not be hashed",
};

export interface InventoryOptions {
	/** omp settings overrides applied on top of the user's and the project's settings. */
	overrides?: Record<string, unknown>;
	/** `-e` extension paths omp will be started with; their bundled `skills/` count. */
	extensions?: string[];
	/** omp will be started with `--no-extensions`. */
	noExtensions?: boolean;
}

/** The skills omp would load in `cwd`, found by omp's own discovery, with their digests. */
export async function inventory(cwd: string, options: InventoryOptions = {}): Promise<InventoryItem[]> {
	const settings = await Settings.loadReadOnly({ cwd, overrides: options.overrides ?? {} });
	initializeWithSettings(settings);
	injectOmpExtensionCliRoots(options.extensions ?? [], os.homedir(), cwd, {
		replace: true,
		mode: options.noExtensions ? "explicit-only" : "merge",
	});
	const group = settings.getGroup("skills");
	const { skills } = await loadSkills({ ...group, disabledExtensions: settings.get("disabledExtensions") ?? [], cwd });
	return skills.map(skill => {
		const dir = path.resolve(skill.baseDir);
		try {
			const scripts: Record<string, string> = {};
			for (const rel of listScripts(dir)) scripts[rel] = digestFile(path.join(dir, rel));
			return { name: skill.name, source: skill.source, dir, digest: digestSkillDir(dir), scripts };
		} catch (err) {
			return { name: skill.name, source: skill.source, dir, scripts: {}, error: err instanceof Error ? err.message : String(err) };
		}
	});
}

/** Splits omp's arguments at its own `--`, after which everything is message text. */
function splitAtSeparator(args: readonly string[]): [string[], string[]] {
	const at = args.indexOf("--");
	return at < 0 ? [[...args], []] : [args.slice(0, at), args.slice(at)];
}

/** A `--cwd` among omp's own arguments names the project; it resolves against `base`, and omp gets the launcher's `--cwd` instead. */
function takeCwd(args: readonly string[], base: string): { cwd?: string; args: string[] } {
	const [flags, rest] = splitAtSeparator(args);
	const kept: string[] = [];
	let cwd: string | undefined;
	for (let i = 0; i < flags.length; i++) {
		const arg = flags[i]!;
		if (arg === "--cwd" && i + 1 < flags.length) cwd = resolveConfigPath(flags[++i]!, base);
		else if (arg.startsWith("--cwd=")) cwd = resolveConfigPath(arg.slice("--cwd=".length), base);
		else kept.push(arg);
	}
	return { ...(cwd ? { cwd } : {}), args: [...kept, ...rest] };
}

function extensionArgs(args: readonly string[]): { paths: string[]; none: boolean } {
	const [flags] = splitAtSeparator(args);
	const paths: string[] = [];
	for (let i = 0; i < flags.length; i++) {
		const arg = flags[i]!;
		if ((arg === "-e" || arg === "--extension") && i + 1 < flags.length) paths.push(flags[++i]!);
		else if (arg.startsWith("--extension=")) paths.push(arg.slice("--extension=".length));
	}
	return { paths, none: flags.includes("--no-extensions") };
}

/** Verifies the manifest, inventories the skills omp would load, and runs the self-test. */
export async function preflight(options: LaunchOptions): Promise<Preflight> {
	const { config } = options;
	const trusted = loadTrustedManifest({ manifest: config.manifest, signature: config.signature, publicKeys: config.publicKeys, now: options.now });
	const manifest = trusted.ok ? trusted.manifest : undefined;
	const extensions = extensionArgs(options.ompArgs ?? []);
	const items = await inventory(options.cwd, {
		overrides: { "skills.customDirectories": [] },
		extensions: extensions.paths,
		noExtensions: extensions.none,
	});
	const skills = items.map(
		(item): SkillCheck => ({
			name: item.name,
			source: item.source,
			dir: item.dir,
			digest: item.digest,
			status: item.digest === undefined ? "unreadable" : approvalRule(item.name, item.digest, manifest),
		}),
	);
	return {
		...(trusted.ok ? { manifest } : { manifestProblem: trusted.reason }),
		skills,
		untrusted: skills.filter(skill => skill.status !== "approved"),
		selfTest: (options.selfTest ?? builtInSelfTest)(),
	};
}

function untrustedQuestion(pre: Preflight): string {
	return [
		"omp-safe: these skills are not approved, or changed since approval:",
		...pre.untrusted.map(skill => `  - ${skill.name} (${STATUS_TEXT[skill.status]})`),
		"Start omp anyway?",
		"  1) No, do not start (default)",
		"  2) Start with only the approved skills",
		"  3) Start with skills turned off",
		"Choose 1, 2, or 3: ",
	].join("\n");
}

function selfTestQuestion(pre: Preflight): string {
	return [
		`omp-safe: the guard self-test failed (${pre.selfTest.failures.join("; ")}), so the guards may not work.`,
		"Start omp anyway?",
		"  1) No, do not start (default)",
		"  3) Start with skills turned off",
		"Choose 1 or 3: ",
	].join("\n");
}

/**
 * What to do. With every loaded skill approved and the self-test passing, start. Otherwise ask at
 * a terminal (`ask`; no terminal means refuse) or follow the policy. When the self-test fails,
 * starting with only the approved skills is never an option, since the guards themselves are in doubt.
 */
export async function decide(pre: Preflight, policy: UntrustedPolicy, io: LaunchIO): Promise<Outcome> {
	if (!pre.selfTest.ok) {
		if (policy === "disable") return "disable";
		if (policy !== "ask" || !io.ask) return "refuse";
		return (await io.ask(selfTestQuestion(pre)))?.trim() === "3" ? "disable" : "refuse";
	}
	if (pre.untrusted.length === 0) return "start";
	if (policy !== "ask") return policy;
	if (!io.ask) return "refuse";
	const answer = (await io.ask(untrustedQuestion(pre)))?.trim();
	return answer === "2" ? "exclude" : answer === "3" ? "disable" : "refuse";
}

/**
 * The settings overlay for one run. `includeSkills` lists only approved, unchanged skills; omp
 * reads an empty list as "every skill", so with none approved skills are turned off instead.
 * Arrays in an overlay replace the user's and the project's, so `customDirectories: []` also drops
 * directories a repository's settings added.
 */
export function renderOverlay(pre: Preflight, outcome: Outcome, config: GuardConfig): string {
	const approved = pre.skills.filter(skill => skill.status === "approved").map(skill => skill.name);
	const enabled = outcome !== "disable" && outcome !== "refuse" && approved.length > 0;
	return [
		"# Written by omp-safe for one run and passed to omp with --config.",
		"skills:",
		`  enabled: ${enabled}`,
		`  enableSkillCommands: ${config.allowSkillCommands === true}`,
		"  customDirectories: []",
		`  includeSkills: ${JSON.stringify(enabled ? approved : [])}`,
		`  ignoredSkills: ${JSON.stringify(pre.manifest?.revoked ?? [])}`,
		"",
	].join("\n");
}

/** The per-run extension entry: the guard with every setting spelled out. */
export function renderEntry(options: SkillGuardOptions): string {
	return [
		"// Written by omp-safe for one run and loaded with -e. It configures the guard explicitly, so no",
		"// environment variable or repository file can point it at another manifest or key.",
		`import { createSkillGuard } from ${JSON.stringify(path.join(PACKAGE_DIR, "src", "index.ts"))};`,
		`export default createSkillGuard(${JSON.stringify(options, null, "\t")});`,
		"",
	].join("\n");
}

/**
 * omp's command line. omp starts in an empty directory, so the project comes first with `--cwd`.
 * The guard entry goes last among the extensions, so it sees what the others add, and before omp's
 * own `--`, after which omp would read it as message text.
 */
export function buildCommand(config: GuardConfig, overlay: string, entry: string, ompArgs: readonly string[], cwd: string): string[] {
	const [flags, rest] = splitAtSeparator(ompArgs);
	const tools = config.tools && config.tools.length > 0 ? ["--tools", config.tools.join(",")] : [];
	return [...(config.omp ?? ["omp"]), "--cwd", cwd, "--config", overlay, ...tools, ...flags, "-e", entry, ...rest];
}

function readJsonLines(file: string): Array<Record<string, unknown>> {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const lines: Array<Record<string, unknown>> = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value = JSON.parse(line) as unknown;
			if (value !== null && typeof value === "object") lines.push(value as Record<string, unknown>);
		} catch {}
	}
	return lines;
}

/** Guard handler failures in omp's log for the run's process. */
function handlerAlerts(pid: number, entry: string): string[] {
	let dir: string;
	let names: string[];
	try {
		dir = getLogsDir();
		names = fs.readdirSync(dir).filter(name => name.includes(`.${pid}.log`));
	} catch {
		return [];
	}
	const alerts: string[] = [];
	for (const name of names) {
		for (const line of readJsonLines(path.join(dir, name))) {
			const message = typeof line.message === "string" ? line.message : "";
			if (message === "Extension handler timed out" && line.extensionPath === entry) {
				alerts.push(
					line.event === "tool_call"
						? "the guard's tool_call handler timed out; omp blocked that call."
						: `the guard's ${String(line.event)} handler timed out; omp passed the original content on, so it may not have been cleaned.`,
				);
			} else if (message.startsWith("omp-skill-guard:") && message.includes("could not")) {
				alerts.push(`${message.slice("omp-skill-guard:".length).trim()}.`);
			}
		}
	}
	return alerts;
}

function report(io: LaunchIO, auditLog: string, runId: string, pid: number, entry: string): void {
	const counts = new Map<string, number>();
	for (const line of readJsonLines(auditLog)) {
		if (line.run === runId && typeof line.action === "string") counts.set(line.action, (counts.get(line.action) ?? 0) + 1);
	}
	if (counts.size > 0) io.err(`omp-safe: guard decisions this run: ${[...counts].map(([action, n]) => `${n} ${action}`).join(", ")}.`);
	for (const alert of handlerAlerts(pid, entry)) io.err(`omp-safe: ALERT: ${alert}`);
}

/** The whole run: preflight, decision, overlay and entry, omp, report. Returns omp's exit code. */
export async function launch(options: LaunchOptions): Promise<number> {
	const { io, config } = options;
	const project = takeCwd(options.ompArgs ?? [], options.cwd);
	const cwd = project.cwd ?? path.resolve(options.cwd);
	const ompArgs = project.args;
	const pre = await preflight({ ...options, cwd, ompArgs });
	if (pre.manifestProblem) io.err(`omp-safe: ${pre.manifestProblem}`);
	for (const failure of pre.selfTest.failures) io.err(`omp-safe: self-test failed: ${failure}`);
	const outcome = await decide(pre, config.onUntrusted ?? "ask", io);
	const untrusted = pre.untrusted.map(skill => `${skill.name} (${STATUS_TEXT[skill.status]})`).join(", ");
	if (outcome === "refuse") {
		io.err(`omp-safe: not starting omp.${untrusted ? ` Not approved or changed: ${untrusted}.` : ""}`);
		return EXIT_REFUSED;
	}
	if (outcome === "exclude") io.err(`omp-safe: starting with only the approved skills; not loaded: ${untrusted}.`);
	if (outcome === "disable") io.err("omp-safe: starting with skills turned off.");

	const runId = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
	const runDir = path.join(options.stateDir ?? defaultStateDir(), runId);
	const launchDir = path.join(runDir, "launch");
	fs.mkdirSync(launchDir, { recursive: true, mode: 0o700 });
	try {
		const overlay = path.join(runDir, "overlay.yml");
		const entry = path.join(runDir, "guard.ts");
		const auditLog = path.resolve(config.auditLog ?? defaultAuditLog());
		fs.writeFileSync(overlay, renderOverlay(pre, outcome, config), { mode: 0o600 });
		const guard: SkillGuardOptions = {
			configPath: null,
			...(config.manifest ? { manifest: path.resolve(config.manifest) } : {}),
			...(config.signature ? { signature: path.resolve(config.signature) } : {}),
			publicKeys: resolvePublicKeys(config.publicKeys ?? []),
			auditLog,
			runId,
			entry,
		};
		fs.writeFileSync(entry, renderEntry(guard), { mode: 0o600 });
		const child = Bun.spawn(buildCommand(config, overlay, entry, ompArgs, cwd), {
			cwd: launchDir,
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
			env: childEnv(options.env ?? process.env, config.passEnv ?? []),
		});
		const ignore = () => {};
		process.on("SIGINT", ignore);
		let code: number;
		try {
			code = await child.exited;
		} finally {
			process.off("SIGINT", ignore);
		}
		report(io, auditLog, runId, child.pid, entry);
		return code;
	} finally {
		fs.rmSync(runDir, { recursive: true, force: true });
	}
}

const USAGE = `usage: omp-safe [options] [-- omp arguments...]
  --config <file>           config file (default ~/.config/omp-skill-guard/config.json)
  --manifest <file>         approval manifest; --signature <file> defaults to <manifest>.sig
  --public-key <pem>        trusted CI public key file (repeatable)
  --audit-log <file>        where the guard appends its decisions
  --tools <a,b,...>         tools omp may use (omp's --tools)
  --allow-skill-commands    keep /skill:<name> commands on
  --on-untrusted <policy>   ask (default) | refuse | exclude | disable
  --omp <command>           how to run omp (default "omp")
  --pass-env <NAME>         pass an environment variable to omp, such as a provider key (repeatable)
  --cwd <dir>               the project to start omp in (default: the current directory)
  --state-dir <dir>         where each run's overlay, guard entry, and empty start directory are written`;

interface ParsedArgs {
	configPath?: string;
	overrides: GuardConfig;
	cwd?: string;
	stateDir?: string;
	ompArgs: string[];
	help: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
	const parsed: ParsedArgs = { overrides: {}, ompArgs: [], help: false };
	const here = process.cwd();
	for (let i = 0; i < argv.length; i++) {
		let arg = argv[i]!;
		let inline: string | undefined;
		const equals = arg.indexOf("=");
		if (arg.startsWith("--") && equals > 0) {
			inline = arg.slice(equals + 1);
			arg = arg.slice(0, equals);
		}
		const value = () => {
			const next = inline ?? argv[++i];
			if (next === undefined) throw new Error(`${arg} needs a value`);
			return next;
		};
		switch (arg) {
			case "--":
				parsed.ompArgs = argv.slice(i + 1);
				return parsed;
			case "-h":
			case "--help":
				parsed.help = true;
				break;
			case "--config":
				parsed.configPath = resolveConfigPath(value(), here);
				break;
			case "--manifest":
				parsed.overrides.manifest = resolveConfigPath(value(), here);
				break;
			case "--signature":
				parsed.overrides.signature = resolveConfigPath(value(), here);
				break;
			case "--public-key":
				parsed.overrides.publicKeys = [...(parsed.overrides.publicKeys ?? []), resolveConfigPath(value(), here)];
				break;
			case "--audit-log":
				parsed.overrides.auditLog = resolveConfigPath(value(), here);
				break;
			case "--tools":
				parsed.overrides.tools = value()
					.split(",")
					.map(tool => tool.trim())
					.filter(Boolean);
				break;
			case "--allow-skill-commands":
				parsed.overrides.allowSkillCommands = true;
				break;
			case "--on-untrusted": {
				const policy = value();
				if (!UNTRUSTED_POLICIES.includes(policy as UntrustedPolicy)) throw new Error(`--on-untrusted must be one of ${UNTRUSTED_POLICIES.join(", ")}`);
				parsed.overrides.onUntrusted = policy as UntrustedPolicy;
				break;
			}
			case "--omp":
				parsed.overrides.omp = value().split(/\s+/).filter(Boolean);
				break;
			case "--pass-env":
				parsed.overrides.passEnv = [...(parsed.overrides.passEnv ?? []), value()];
				break;
			case "--cwd":
				parsed.cwd = resolveConfigPath(value(), here);
				break;
			case "--state-dir":
				parsed.stateDir = resolveConfigPath(value(), here);
				break;
			default:
				throw new Error(`unknown option ${arg}`);
		}
	}
	return parsed;
}

/** The `omp-safe` command. */
export async function runOmpSafe(argv: readonly string[], io: LaunchIO): Promise<number> {
	let parsed: ParsedArgs;
	let file: GuardConfig;
	try {
		parsed = parseArgs(argv);
		if (parsed.help) {
			io.err(USAGE);
			return 0;
		}
		file = loadConfig(parsed.configPath ?? defaultConfigPath());
	} catch (err) {
		io.err(`omp-safe: ${err instanceof Error ? err.message : String(err)}`);
		io.err(USAGE);
		return EXIT_USAGE;
	}
	const passEnv = parsed.overrides.passEnv ? { passEnv: [...(file.passEnv ?? []), ...parsed.overrides.passEnv] } : {};
	return launch({
		cwd: parsed.cwd ?? process.cwd(),
		config: { ...file, ...parsed.overrides, ...passEnv },
		ompArgs: parsed.ompArgs,
		stateDir: parsed.stateDir,
		io,
	});
}

/** stderr for output; a question at the terminal when both stdin and stderr are terminals. */
export function terminalIO(): LaunchIO {
	const io: LaunchIO = { err: line => process.stderr.write(`${line}\n`) };
	if (process.stdin.isTTY && process.stderr.isTTY) {
		io.ask = async question => {
			const prompt = readline.createInterface({ input: process.stdin, output: process.stderr });
			try {
				return await prompt.question(question);
			} finally {
				prompt.close();
			}
		};
	}
	return io;
}
