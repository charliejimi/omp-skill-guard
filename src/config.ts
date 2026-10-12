// User-level settings shared by omp-safe and the guard. They come from a file under the home
// directory, never from environment variables: Bun loads a project's .env into the process before
// omp's code runs, so a repository could otherwise point the guard at its own key.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type UntrustedPolicy = "ask" | "refuse" | "exclude" | "disable";

export const UNTRUSTED_POLICIES: readonly UntrustedPolicy[] = ["ask", "refuse", "exclude", "disable"];

export interface GuardConfig {
	/** The approval manifest (JSON) CI signed. */
	manifest?: string;
	/** Its detached signature; `<manifest>.sig` when omitted. */
	signature?: string;
	/** Trusted CI public keys: PEM text or paths to PEM files. */
	publicKeys?: string[];
	/** Where decisions are appended as JSON lines; see {@link defaultAuditLog}. */
	auditLog?: string;
	/** omp-safe: the tools to enable (`--tools`); omp's defaults when omitted. */
	tools?: string[];
	/** omp-safe: keep `/skill:<name>` commands on. */
	allowSkillCommands?: boolean;
	/** omp-safe: what to do when a loaded skill is not approved; `ask` at a terminal, otherwise refuse. */
	onUntrusted?: UntrustedPolicy;
	/** omp-safe: how to run omp, `["omp"]` by default. */
	omp?: string[];
}

export function defaultConfigPath(): string {
	return path.join(os.homedir(), ".config", "omp-skill-guard", "config.json");
}

export function defaultAuditLog(): string {
	return path.join(os.homedir(), ".local", "state", "omp-skill-guard", "audit.jsonl");
}

export function defaultStateDir(): string {
	return path.join(os.homedir(), ".local", "state", "omp-skill-guard", "runs");
}

/** `~` and `~/…` expand to the home directory; other relative paths resolve against `base`. */
export function resolveConfigPath(value: string, base: string): string {
	const home = value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
	return path.resolve(base, home);
}

function stringList(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || !value.every(item => typeof item === "string" && item.length > 0)) {
		throw new Error(`${field} must be a list of strings`);
	}
	return value;
}

/** Validates a parsed config object; relative paths resolve against `base`. */
export function normalizeConfig(raw: unknown, base: string): GuardConfig {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("the config must be a JSON object");
	const input = raw as Record<string, unknown>;
	const config: GuardConfig = {};
	for (const field of ["manifest", "signature", "auditLog"] as const) {
		const value = input[field];
		if (value === undefined) continue;
		if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a path`);
		config[field] = resolveConfigPath(value, base);
	}
	if (input.publicKeys !== undefined) {
		config.publicKeys = stringList(input.publicKeys, "publicKeys").map(key =>
			key.trimStart().startsWith("-----BEGIN") ? key : resolveConfigPath(key, base),
		);
	}
	if (input.tools !== undefined) config.tools = stringList(input.tools, "tools");
	if (input.omp !== undefined) config.omp = stringList(input.omp, "omp");
	if (input.allowSkillCommands !== undefined) {
		if (typeof input.allowSkillCommands !== "boolean") throw new Error("allowSkillCommands must be true or false");
		config.allowSkillCommands = input.allowSkillCommands;
	}
	if (input.onUntrusted !== undefined) {
		if (!UNTRUSTED_POLICIES.includes(input.onUntrusted as UntrustedPolicy)) {
			throw new Error(`onUntrusted must be one of ${UNTRUSTED_POLICIES.join(", ")}`);
		}
		config.onUntrusted = input.onUntrusted as UntrustedPolicy;
	}
	return config;
}

/** Reads a config file. A missing file is an empty config; an invalid one throws. */
export function loadConfig(file: string): GuardConfig {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw err;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		throw new Error(`${file} is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
	}
	return normalizeConfig(raw, path.dirname(file));
}
