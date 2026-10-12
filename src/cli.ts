// omp-skill-guard: the CI side of the approval flow. `inventory` lists the skills omp would load;
// `check` applies the repository rules; `manifest` builds the approval manifest from a reviewed
// approvals file; `sign` and `verify` handle its Ed25519 signature; `keygen` makes the key pair.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type InventoryItem, inventory } from "./launcher";
import { MANIFEST_SCHEMA, type Manifest, generateKeyPair, isValidSkillName, loadTrustedManifest, parseManifest, signManifest } from "./manifest";

export interface CliIO {
	out(line: string): void;
	err(line: string): void;
}

const USAGE = `usage: omp-skill-guard <command> [options]
  keygen <dir>                                      write skill-guard.key.pem (keep it in CI) and skill-guard.pub.pem
  inventory [--cwd <dir>] [--json]                  list the skills omp would load, with digests
  check [--cwd <dir>]                               check skill directories against the repository rules
  manifest --approvals <file> [--cwd <dir>] [--out <file>] [--expires-in-days <n>]
                                                    build the approval manifest from the reviewed approvals
  sign --key <private.pem> <manifest> [--out <file>]
  verify --public-key <public.pem> [...] <manifest> [--signature <file>]`;

const PROJECT_SKILL_ROOTS = [".omp/skills", ".claude/skills", ".agents/skills", ".codex/skills", ".github/skills"];
const FRONTMATTER = /^---\n([\s\S]*?)\n---(?:\n|$)/;

class UsageError extends Error {}

interface Flags {
	values: Map<string, string[]>;
	booleans: Set<string>;
	positionals: string[];
}

function parseFlags(args: readonly string[], valueFlags: readonly string[], booleanFlags: readonly string[] = []): Flags {
	const flags: Flags = { values: new Map(), booleans: new Set(), positionals: [] };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (valueFlags.includes(arg)) {
			const value = args[++i];
			if (value === undefined) throw new UsageError(`${arg} needs a value`);
			flags.values.set(arg, [...(flags.values.get(arg) ?? []), value]);
		} else if (booleanFlags.includes(arg)) {
			flags.booleans.add(arg);
		} else if (arg.startsWith("--")) {
			throw new UsageError(`unknown option ${arg}`);
		} else {
			flags.positionals.push(arg);
		}
	}
	return flags;
}

function one(flags: Flags, name: string): string | undefined {
	return flags.values.get(name)?.at(-1);
}

/** A directory as people read it: relative to the project when inside it, `~/…` under home. */
function display(dir: string, cwd: string): string {
	const relative = path.relative(cwd, dir);
	if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative.split(path.sep).join("/");
	const fromHome = path.relative(os.homedir(), dir);
	if (fromHome && !fromHome.startsWith("..") && !path.isAbsolute(fromHome)) return `~/${fromHome.split(path.sep).join("/")}`;
	return dir;
}

function frontmatter(text: string): Record<string, unknown> | undefined {
	const block = FRONTMATTER.exec(text);
	if (!block) return undefined;
	try {
		const parsed = Bun.YAML.parse(block[1]!) as unknown;
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return undefined;
	}
}

function linkProblems(dir: string, shown: string): string[] {
	const problems: string[] = [];
	const visit = (abs: string, rel: string) => {
		for (const name of fs.readdirSync(abs)) {
			const childAbs = path.join(abs, name);
			const childRel = rel ? `${rel}/${name}` : name;
			const stat = fs.lstatSync(childAbs);
			if (stat.isSymbolicLink()) problems.push(`${shown}: symlink: ${childRel} is a symlink; vendor the file itself`);
			else if (stat.isDirectory()) visit(childAbs, childRel);
			else if (!stat.isFile()) problems.push(`${shown}: special-file: ${childRel} is not a regular file`);
		}
	};
	visit(dir, "");
	return problems;
}

/** The repository rules for one skill directory; each problem is `<dir>: <rule>: <message>`. */
export function checkSkillDir(dir: string, cwd: string): string[] {
	const shown = display(dir, cwd);
	const problems: string[] = [];
	const name = path.basename(dir);
	let text: string | undefined;
	try {
		text = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
	} catch {
		problems.push(`${shown}: skill-file: SKILL.md is missing`);
	}
	if (text !== undefined) {
		if (text.includes("\r")) problems.push(`${shown}: line-endings: SKILL.md uses CRLF; use LF, or omp leaves the frontmatter in /skill: messages`);
		const front = frontmatter(text.replaceAll("\r\n", "\n"));
		if (!front) {
			problems.push(`${shown}: frontmatter: SKILL.md has no readable frontmatter`);
		} else {
			const declared = typeof front.name === "string" ? front.name : undefined;
			if (declared !== undefined && declared !== name) {
				problems.push(`${shown}: name: name "${declared}" differs from the directory name "${name}", so overriding it fails silently`);
			}
			const effective = declared ?? name;
			if (!isValidSkillName(effective)) problems.push(`${shown}: name: "${effective}" has characters other than letters, digits, ".", "_", ":", "-"`);
			if (typeof front.description !== "string" || front.description.trim() === "") problems.push(`${shown}: description: SKILL.md has no description`);
		}
	}
	try {
		problems.push(...linkProblems(dir, shown));
	} catch (err) {
		problems.push(`${shown}: unreadable: ${err instanceof Error ? err.message : String(err)}`);
	}
	return problems;
}

async function skillDirs(cwd: string, loaded: readonly InventoryItem[]): Promise<string[]> {
	const seen = new Map<string, string>();
	const add = (dir: string) => {
		let real = dir;
		try {
			real = fs.realpathSync(dir);
		} catch {}
		if (!seen.has(real)) seen.set(real, dir);
	};
	for (const item of loaded) add(item.dir);
	for (const root of PROJECT_SKILL_ROOTS) {
		const abs = path.join(cwd, root);
		let names: string[] = [];
		try {
			names = fs.readdirSync(abs);
		} catch {}
		for (const name of names) {
			if (fs.statSync(path.join(abs, name), { throwIfNoEntry: false })?.isDirectory()) add(path.join(abs, name));
		}
	}
	return [...seen.values()].sort();
}

function keygen(flags: Flags, io: CliIO): number {
	const [dir] = flags.positionals;
	if (!dir) throw new UsageError("keygen needs a directory");
	const keys = generateKeyPair();
	const privateFile = path.resolve(dir, "skill-guard.key.pem");
	const publicFile = path.resolve(dir, "skill-guard.pub.pem");
	fs.mkdirSync(path.dirname(privateFile), { recursive: true });
	for (const file of [privateFile, publicFile]) {
		if (fs.existsSync(file)) {
			io.err(`${file} exists; not overwriting it`);
			return 1;
		}
	}
	fs.writeFileSync(privateFile, keys.privateKeyPem, { mode: 0o600, flag: "wx" });
	fs.writeFileSync(publicFile, keys.publicKeyPem, { mode: 0o644, flag: "wx" });
	io.out(`wrote ${privateFile} (keep it in CI only) and ${publicFile} (give it to every omp-safe user)`);
	return 0;
}

async function inventoryCommand(flags: Flags, io: CliIO): Promise<number> {
	const cwd = path.resolve(one(flags, "--cwd") ?? process.cwd());
	const items = await inventory(cwd);
	const rows = items.map(item => ({ name: item.name, source: item.source, path: display(item.dir, cwd), digest: item.digest ?? null, scripts: item.scripts, ...(item.error ? { error: item.error } : {}) }));
	if (flags.booleans.has("--json")) {
		io.out(JSON.stringify(rows, null, 2));
	} else {
		for (const row of rows) io.out(`${row.name}\t${row.digest ?? `unreadable: ${row.error}`}\t${row.path}`);
	}
	return items.some(item => item.error) ? 1 : 0;
}

async function checkCommand(flags: Flags, io: CliIO): Promise<number> {
	const cwd = path.resolve(one(flags, "--cwd") ?? process.cwd());
	const dirs = await skillDirs(cwd, await inventory(cwd));
	const problems = dirs.flatMap(dir => checkSkillDir(dir, cwd));
	for (const problem of problems) io.err(problem);
	if (problems.length > 0) return 1;
	io.out(`check passed: ${dirs.length} skill director${dirs.length === 1 ? "y" : "ies"}`);
	return 0;
}

interface Approval {
	source?: unknown;
	commit?: unknown;
	owner?: unknown;
	scripts?: unknown;
}

async function manifestCommand(flags: Flags, io: CliIO): Promise<number> {
	const approvalsFile = one(flags, "--approvals");
	if (!approvalsFile) throw new UsageError("manifest needs --approvals <file>");
	const cwd = path.resolve(one(flags, "--cwd") ?? process.cwd());
	const out = path.resolve(one(flags, "--out") ?? "skills.manifest.json");
	const days = one(flags, "--expires-in-days");
	if (days !== undefined && !(Number(days) > 0)) throw new UsageError("--expires-in-days needs a positive number");
	const approvals = JSON.parse(fs.readFileSync(approvalsFile, "utf8")) as { skills?: Record<string, Approval>; revoked?: unknown };
	const approved = approvals.skills ?? {};
	const items = await inventory(cwd);
	const problems = items.flatMap(item => checkSkillDir(item.dir, cwd));
	for (const item of items) {
		if (item.error || item.digest === undefined) {
			problems.push(`${item.name}: could not be hashed (${item.error})`);
			continue;
		}
		const approval = approved[item.name];
		if (!approval) {
			problems.push(`${item.name}: not in the approvals file; approve it or remove it`);
			continue;
		}
		for (const field of ["source", "commit", "owner"] as const) {
			const value = approval[field];
			if (typeof value !== "string" || value.trim() === "") problems.push(`${item.name}: approval has no ${field}`);
		}
		const declared = (Array.isArray(approval.scripts) ? approval.scripts.map(String) : []).sort();
		const actual = Object.keys(item.scripts).sort();
		if (JSON.stringify(declared) !== JSON.stringify(actual)) {
			problems.push(`${item.name}: scripts on disk (${actual.join(", ") || "none"}) differ from the declared scripts (${declared.join(", ") || "none"})`);
		}
	}
	if (problems.length > 0) {
		for (const problem of problems) io.err(problem);
		return 1;
	}
	const now = new Date();
	const manifest: Manifest = {
		schema: MANIFEST_SCHEMA,
		issuedAt: now.toISOString(),
		...(days !== undefined ? { expiresAt: new Date(now.getTime() + Number(days) * 86_400_000).toISOString() } : {}),
		skills: items.map(item => {
			const approval = approved[item.name]!;
			return {
				name: item.name,
				digest: item.digest!,
				scripts: item.scripts,
				source: String(approval.source),
				commit: String(approval.commit),
				owner: String(approval.owner),
				path: display(item.dir, cwd),
			};
		}),
		revoked: Array.isArray(approvals.revoked) ? approvals.revoked.map(String) : [],
	};
	const text = `${JSON.stringify(manifest, null, 2)}\n`;
	parseManifest(text);
	fs.writeFileSync(out, text);
	io.out(`wrote ${out}: ${manifest.skills.length} approved skills, ${manifest.revoked.length} revoked`);
	return 0;
}

function signCommand(flags: Flags, io: CliIO): number {
	const key = one(flags, "--key");
	const [manifest] = flags.positionals;
	if (!key || !manifest) throw new UsageError("sign needs --key <private.pem> and a manifest");
	const out = one(flags, "--out") ?? `${manifest}.sig`;
	fs.writeFileSync(out, `${signManifest(fs.readFileSync(manifest), fs.readFileSync(key, "utf8"))}\n`);
	io.out(`wrote ${out}`);
	return 0;
}

function verifyCommand(flags: Flags, io: CliIO): number {
	const keys = flags.values.get("--public-key") ?? [];
	const [manifest] = flags.positionals;
	if (keys.length === 0 || !manifest) throw new UsageError("verify needs --public-key <public.pem> and a manifest");
	const loaded = loadTrustedManifest({ manifest, signature: one(flags, "--signature"), publicKeys: keys.map(key => path.resolve(key)) });
	if (!loaded.ok) {
		io.err(`not verified: ${loaded.reason}`);
		return 1;
	}
	io.out(`verified: ${loaded.manifest.skills.length} approved skills, ${loaded.manifest.revoked.length} revoked`);
	return 0;
}

/** The `omp-skill-guard` command; returns the exit code. */
export async function runSkillGuardCli(argv: readonly string[], io: CliIO): Promise<number> {
	const [command, ...args] = argv;
	try {
		switch (command) {
			case "keygen":
				return keygen(parseFlags(args, []), io);
			case "inventory":
				return await inventoryCommand(parseFlags(args, ["--cwd"], ["--json"]), io);
			case "check":
				return await checkCommand(parseFlags(args, ["--cwd"]), io);
			case "manifest":
				return await manifestCommand(parseFlags(args, ["--approvals", "--cwd", "--out", "--expires-in-days"]), io);
			case "sign":
				return signCommand(parseFlags(args, ["--key", "--out"]), io);
			case "verify":
				return verifyCommand(parseFlags(args, ["--public-key", "--signature"]), io);
			case "help":
			case "--help":
			case "-h":
				io.out(USAGE);
				return 0;
			default:
				throw new UsageError(command ? `unknown command ${command}` : "no command given");
		}
	} catch (err) {
		if (err instanceof UsageError) {
			io.err(`omp-skill-guard: ${err.message}`);
			io.err(USAGE);
			return 2;
		}
		io.err(`omp-skill-guard: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
}
