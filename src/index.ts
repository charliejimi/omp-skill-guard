// omp-skill-guard: the Day20 skills supply-chain sequence as one omp extension with four guards.
//
// - Description guard (`before_agent_start`): in the system prompt's `<skills>` block, an approved
//   description that reads like an instruction is removed, and the description of a skill the
//   signed manifest does not approve, or that changed since approval, is withheld.
// - Access policy (`tool_call`): `read`, `grep`, `ast_grep`, and `bash` may touch a skill only while
//   the manifest approves it and its directory hashes to the approved digest; `bash` may touch a
//   skill script only if the manifest lists it. omp blocks a call whose handler throws or times
//   out, which makes this the fail-closed layer.
// - Body guard (`tool_result`): skill content those tools return has instruction-like lines
//   replaced, and output from unapproved skills in a workspace search is removed.
// - /skill guard (`context`): a `/skill:<name>` message is checked the same way before the model
//   sees it, and so is the skill listing omp sends when `skillful` is turned on mid-session.
//
// omp ships the original text when a rewriting handler throws or times out, so those never throw.
// Nothing is imported from omp at runtime: omp's own skill discovery is reached through `pi.pi`.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type GuardConfig, defaultAuditLog, defaultConfigPath, loadConfig } from "./config";
import { type Manifest, approvalRule, digestFile, digestSkillDir, isScript, isValidSkillName, loadTrustedManifest } from "./manifest";
import {
	type BlockChange,
	type ListedSkill,
	REMOVED_MATCHES,
	RESULT_WITHHELD,
	SKILL_PROMPT_WITHHELD,
	type SkillRule,
	scrubSkillsBlock,
} from "./policy";
import {
	type OutputSection,
	type PathContext,
	type SkillEntry,
	type SkillRef,
	bashTargets,
	classifyPath,
	displayForms,
	joinSections,
	parseGroupedOutput,
	pathInputTargets,
	resolvePath,
} from "./skills";
import { INSTRUCTION_PATTERNS, neutralizeLines, stateless } from "./text";

export * from "./policy";
export { NEUTRALIZED_LINE } from "./text";

const PREFIX = "omp-skill-guard:";
const PACKAGE_DIR = path.resolve(import.meta.dir, "..");
const WATCHED_TOOLS = new Set(["read", "grep", "ast_grep", "bash"]);
const SEARCH_TOOLS = new Set(["grep", "ast_grep"]);
const CHECK_FAILED = `${PREFIX} could not check this skill access, so it was blocked. Tell the user.`;
const ROOT_PATH_IN_TEXT =
	/(?:\.{1,2}\/|~\/|\/)?(?:[^\s:'"`]*\/)?\.(?:omp\/agent\/managed-skills|omp\/agent\/skills|omp\/skills|claude\/skills|agents\/skills|codex\/skills|github\/skills|opencode\/skills?)\/[A-Za-z0-9][A-Za-z0-9._:-]*/g;

export interface SkillGuardOptions {
	/** The user-level config file; `null` reads none. Defaults to `~/.config/omp-skill-guard/config.json`. */
	configPath?: string | null;
	/** The approval manifest; overrides the config file. */
	manifest?: string;
	signature?: string;
	/** Trusted CI public keys, as PEM text or paths to PEM files. */
	publicKeys?: string[];
	auditLog?: string;
	/** Tags every audit line, so omp-safe can find this run's decisions. */
	runId?: string;
	/** Patterns added to the defaults; a match marks a line as an instruction. */
	extraPatterns?: RegExp[];
	/** The path the guard is loaded from when that is not this package, for the load-order check. */
	entry?: string;
}

interface GuardState {
	cwd: string;
	home: string;
	manifest?: Manifest;
	manifestProblem?: string;
	discoveryProblem?: string;
	skills: SkillEntry[];
	/** Each loaded skill's standing at session start. */
	rules: Map<string, SkillRule>;
	customRoots: string[];
}

interface Decision {
	allow: boolean;
	rule: string;
	skill?: string;
	digest?: string;
}

interface AuditRecord {
	event: string;
	tool?: string;
	skill?: string;
	digest?: string;
	rule: string;
	action: string;
	lines?: number;
}

type Part = { type: string; text?: unknown };

const WHY: Record<string, string> = {
	"not-approved": "it is not in the approved skill manifest",
	modified: "its files changed after it was approved",
	revoked: "its approval was revoked",
	"no-manifest": "there is no valid approved skill manifest",
	"unknown-skill": "no loaded skill has that name",
	"script-not-approved": "that script is not an approved script of this skill",
	unverifiable:
		"the command names skill files in a form the guard cannot check (a glob, a variable, or a whole skills directory); use skill://<name>/<path> for one approved skill",
};

const RULE_TEXT: Record<string, string> = {
	"not-approved": "not approved",
	modified: "changed since approval",
	revoked: "revoked",
	unreadable: "could not be hashed",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function resolveOptions(options: SkillGuardOptions): GuardConfig & { problem?: string } {
	let file: GuardConfig = {};
	let problem: string | undefined;
	if (options.configPath !== null) {
		try {
			file = loadConfig(options.configPath ?? defaultConfigPath());
		} catch (err) {
			problem = `the guard's config file could not be read: ${errorText(err)}`;
		}
	}
	return {
		...file,
		...(options.manifest !== undefined ? { manifest: options.manifest } : {}),
		...(options.signature !== undefined ? { signature: options.signature } : {}),
		...(options.publicKeys !== undefined ? { publicKeys: options.publicKeys } : {}),
		...(options.auditLog !== undefined ? { auditLog: options.auditLog } : {}),
		...(problem ? { problem } : {}),
	};
}

/** Decides one skill reference against the manifest, hashing the directory now. */
function decide(ref: SkillRef, state: GuardState, bash: boolean, digests: Map<string, string>): Decision {
	if (ref.kind === "unverifiable") return { allow: false, rule: "unverifiable" };
	if (ref.kind === "unknown-skill") return { allow: false, rule: "unknown-skill", skill: ref.name };
	const skill = ref.name;
	if (!state.manifest) return { allow: false, rule: "no-manifest", skill };
	if (state.manifest.revoked.includes(skill)) return { allow: false, rule: "revoked", skill };
	const approved = state.manifest.skills.find(entry => entry.name === skill);
	if (!approved) return { allow: false, rule: "not-approved", skill };
	let digest = digests.get(ref.dir);
	if (digest === undefined) {
		try {
			digest = digestSkillDir(ref.dir);
		} catch {
			return { allow: false, rule: "error", skill };
		}
		digests.set(ref.dir, digest);
	}
	if (digest !== approved.digest) return { allow: false, rule: "modified", skill, digest };
	const rel = ref.rel.replace(/^\.\//, "");
	if (bash && rel) {
		const file = path.join(ref.dir, rel);
		let stat: fs.Stats | undefined;
		try {
			stat = fs.lstatSync(file);
		} catch {}
		if (stat && isScript(rel, stat)) {
			let current: string | undefined;
			try {
				current = digestFile(file);
			} catch {}
			const listed = approved.scripts[rel];
			if (!listed || listed !== current) return { allow: false, rule: "script-not-approved", skill, digest };
			return { allow: true, rule: "script-approved", skill, digest };
		}
	}
	return { allow: true, rule: "approved", skill, digest };
}

function blockReason(tool: string, decision: Decision, state: GuardState): string {
	if (decision.rule === "error") return CHECK_FAILED;
	const what = decision.skill ? `skill "${decision.skill}"` : "skill files";
	const why = decision.rule === "no-manifest" && state.manifestProblem ? `${WHY[decision.rule]} (${state.manifestProblem})` : WHY[decision.rule];
	return `${PREFIX} blocked ${tool} on ${what}: ${why}. Do not look for another way to read or run it; tell the user.`;
}

function rewriteParts(content: unknown[], rewrite: (text: string) => string): Part[] {
	return content.map(part => {
		const candidate = part as Part;
		return candidate?.type === "text" && typeof candidate.text === "string" ? { ...candidate, text: rewrite(candidate.text) } : candidate;
	});
}

function partsAreReadable(content: unknown): content is Part[] {
	return Array.isArray(content) && content.every(part => isRecord(part) && (part.type !== "text" || typeof part.text === "string"));
}

function withheldResult(content: unknown): Part[] {
	const images = Array.isArray(content) ? content.filter(part => isRecord(part) && part.type === "image") : [];
	return [{ type: "text", text: RESULT_WITHHELD }, ...(images as Part[])];
}

function messageText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const texts: string[] = [];
	for (const part of content) {
		if (!isRecord(part)) return undefined;
		if (part.type === "text") {
			if (typeof part.text !== "string") return undefined;
			texts.push(part.text);
		}
	}
	return texts.join("\n");
}

/** omp's own `/skill:` body: the file without its frontmatter, trimmed. */
function skillBody(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
	} catch {
		return undefined;
	}
}

function extensionArgs(argv: readonly string[]): string[] {
	const found: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--") break;
		if ((arg === "-e" || arg === "--extension") && i + 1 < argv.length) found.push(argv[++i]!);
		else if (arg.startsWith("--extension=")) found.push(arg.slice("--extension=".length));
	}
	return found;
}

/** The guard as an omp extension factory; the package's default export is `createSkillGuard()`. */
export function createSkillGuard(options: SkillGuardOptions = {}): (pi: ExtensionAPI) => void {
	const patterns = [...INSTRUCTION_PATTERNS, ...(options.extraPatterns ?? []).map(stateless)];
	const selfPaths = [PACKAGE_DIR, path.join(PACKAGE_DIR, "src", "index.ts"), ...(options.entry ? [options.entry] : [])].map(p =>
		path.resolve(p),
	);

	return function skillGuard(pi: ExtensionAPI): void {
		pi.setLabel("omp-skill-guard");
		const config = resolveOptions(options);
		const runId = options.runId ?? `pid-${process.pid}`;
		const auditFile = config.auditLog ?? defaultAuditLog();
		const audited = new Set<string>();
		let auditBroken = false;
		let state: Promise<GuardState> | undefined;

		const log = (message: string, context: Record<string, unknown> = {}) => {
			try {
				pi.logger.warn(`${PREFIX} ${message}`, context);
			} catch {}
		};

		const audit = (record: AuditRecord, onceKey?: string) => {
			if (onceKey !== undefined) {
				if (audited.has(onceKey)) return;
				audited.add(onceKey);
			}
			try {
				fs.mkdirSync(path.dirname(auditFile), { recursive: true, mode: 0o700 });
				fs.appendFileSync(auditFile, `${JSON.stringify({ ts: new Date().toISOString(), run: runId, ...record })}\n`, { mode: 0o600 });
			} catch (err) {
				if (!auditBroken) log("could not write the audit log", { error: errorText(err) });
				auditBroken = true;
			}
		};

		const computeState = async (cwd: string): Promise<GuardState> => {
			const home = os.homedir();
			const trusted = config.problem
				? { ok: false as const, reason: config.problem }
				: loadTrustedManifest({ manifest: config.manifest, signature: config.signature, publicKeys: config.publicKeys });
			const next: GuardState = {
				cwd,
				home,
				...(trusted.ok ? { manifest: trusted.manifest } : { manifestProblem: trusted.reason }),
				skills: [],
				rules: new Map(),
				customRoots: [],
			};
			try {
				const host = pi.pi;
				const group = host.settings.getGroup("skills");
				const { skills } = await host.loadSkills({ ...group, disabledExtensions: host.settings.get("disabledExtensions") ?? [], cwd });
				next.skills = skills.map(skill => ({
					name: skill.name,
					description: skill.description,
					baseDir: path.resolve(skill.baseDir),
					filePath: skill.filePath,
					source: skill.source,
					hide: skill.hide === true,
				}));
				next.customRoots = (group.customDirectories ?? []).map(dir => resolvePath(dir, cwd, home));
			} catch (err) {
				next.discoveryProblem = errorText(err);
			}
			for (const skill of next.skills) {
				let rule: SkillRule;
				try {
					rule = approvalRule(skill.name, next.manifest ? digestSkillDir(skill.baseDir) : "", next.manifest);
				} catch {
					rule = "unreadable";
				}
				next.rules.set(skill.name, rule);
			}
			return next;
		};

		const ensureState = (cwd: string): Promise<GuardState> => {
			state ??= computeState(cwd);
			return state;
		};

		const pathContext = (s: GuardState, cwd = s.cwd): PathContext => ({ cwd, home: s.home, skills: s.skills, customRoots: s.customRoots });

		const listed = (s: GuardState): ListedSkill[] =>
			s.skills.filter(skill => !skill.hide).map(skill => ({ name: skill.name, description: skill.description, rule: s.rules.get(skill.name) ?? "not-approved" }));

		const auditChanges = (event: string, changes: BlockChange[]) => {
			for (const change of changes) audit({ event, skill: change.skill, rule: change.rule, action: change.action }, `${event}:${change.skill}:${change.action}`);
		};

		pi.on("session_start", async (_event, ctx) => {
			try {
				state = computeState(ctx.cwd);
				const s = await state;
				const notices: string[] = [];
				if (s.manifestProblem) {
					notices.push(`${PREFIX} no valid approved skill manifest (${s.manifestProblem}). Every skill read is blocked and skill descriptions are withheld.`);
				}
				if (s.discoveryProblem) notices.push(`${PREFIX} could not list the loaded skills (${s.discoveryProblem}); skill:// reads are blocked.`);
				const untrusted = s.skills.filter(skill => s.rules.get(skill.name) !== "approved");
				if (s.manifest && untrusted.length > 0) {
					const list = untrusted.map(skill => `${skill.name} (${RULE_TEXT[s.rules.get(skill.name) ?? "not-approved"]})`).join(", ");
					notices.push(
						`${PREFIX} ${untrusted.length === 1 ? "1 loaded skill is" : `${untrusted.length} loaded skills are`} not approved or changed since approval: ${list}. Their descriptions are withheld and reads are blocked; start omp through omp-safe so they are not loaded at all.`,
					);
				}
				const settings = pi.pi.settings;
				if (settings.get("skills.enableSkillCommands") !== false) {
					notices.push(
						`${PREFIX} skills.enableSkillCommands is on, so /skill:<name> inserts a skill's text without a tool call. The /skill guard checks those messages, but omp-safe turns the setting off.`,
					);
				}
				let active: string[] = [];
				try {
					active = pi.getActiveTools();
				} catch {}
				if (active.includes("eval")) {
					notices.push(`${PREFIX} the eval tool is active; it can read any file, and the access policy cannot see what it reads. Leave it out of --tools.`);
				}
				const configured = (settings.get("extensions") ?? []).filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
				const listedExtensions = configured.length > 0 ? configured : extensionArgs(process.argv);
				const last = listedExtensions.at(-1);
				if (last !== undefined && !selfPaths.includes(resolvePath(last, ctx.cwd, s.home))) {
					const where = configured.length > 0 ? "the settings extensions list" : "the -e extensions on the command line";
					notices.push(
						`${PREFIX} load order: the guard is not the last entry in ${where}, so extensions loaded after it can change the system prompt, tool results, and messages without being checked. Move it to the end.`,
					);
				}
				for (const notice of notices) ctx.ui.notify(notice, "warning");
			} catch (err) {
				log("could not run the startup checks", { error: errorText(err) });
			}
		});

		pi.on("before_agent_start", async (event, ctx) => {
			try {
				if (!Array.isArray(event.systemPrompt)) return undefined;
				const s = await ensureState(ctx.cwd);
				const skills = listed(s);
				let changed = false;
				const systemPrompt = event.systemPrompt.map(part => {
					if (typeof part !== "string") return part;
					const scrubbed = scrubSkillsBlock(part, skills, patterns);
					if (!scrubbed) return part;
					changed = true;
					auditChanges("before_agent_start", scrubbed.changes);
					return scrubbed.text;
				});
				return changed ? { systemPrompt } : undefined;
			} catch (err) {
				log("could not check the system prompt", { error: errorText(err) });
				return undefined;
			}
		});

		pi.on("tool_call", async (event, ctx) => {
			if (!WATCHED_TOOLS.has(event.toolName)) return undefined;
			try {
				const s = await ensureState(ctx.cwd);
				const context = pathContext(s, ctx.cwd);
				const refs = event.toolName === "bash" ? bashTargets(event.input, context) : pathInputTargets(event.toolName, event.input, context);
				if (refs.length === 0) return undefined;
				const digests = new Map<string, string>();
				const allowed = new Map<string, Decision>();
				for (const ref of refs) {
					const decision = decide(ref, s, event.toolName === "bash", digests);
					if (!decision.allow) {
						audit({ event: "tool_call", tool: event.toolName, skill: decision.skill, digest: decision.digest, rule: decision.rule, action: "block" });
						if (decision.rule === "error") log("could not check a skill access", { tool: event.toolName, skill: decision.skill });
						return { block: true, reason: blockReason(event.toolName, decision, s) };
					}
					allowed.set(`${decision.skill}:${decision.rule}`, decision);
				}
				for (const decision of allowed.values()) {
					audit({ event: "tool_call", tool: event.toolName, skill: decision.skill, digest: decision.digest, rule: decision.rule, action: "allow" });
				}
				return undefined;
			} catch (err) {
				log("could not check a skill access", { tool: event.toolName, error: errorText(err) });
				audit({ event: "tool_call", tool: event.toolName, rule: "error", action: "block" });
				return { block: true, reason: CHECK_FAILED };
			}
		});

		/** Rewrites one tool result; `undefined` when it holds no skill content. */
		const guardResult = (toolName: string, input: unknown, content: unknown, details: unknown, s: GuardState, cwd: string): Part[] | undefined => {
			const context = pathContext(s, cwd);
			const digests = new Map<string, string>();
			const refs = toolName === "bash" ? bashTargets(input, context) : pathInputTargets(toolName, input, context);
			const decisions = refs.map(ref => decide(ref, s, false, digests));
			const blocked = decisions.find(decision => !decision.allow);
			const record = (decision: Decision, action: string, lines?: number) =>
				audit({ event: "tool_result", tool: toolName, skill: decision.skill, digest: decision.digest, rule: decision.rule, action, lines });
			const searchFiles =
				SEARCH_TOOLS.has(toolName) && isRecord(details) && Array.isArray(details.files)
					? details.files.filter((file): file is string => typeof file === "string")
					: [];
			const searchBase = isRecord(details) && typeof details.cwd === "string" ? details.cwd : cwd;
			const decideText = (target: string, base: string): Decision | undefined => {
				const ref = classifyPath(target, pathContext(s, base));
				return ref?.kind === "skill" ? decide(ref, s, false, digests) : undefined;
			};
			const fileDecisions = searchFiles.map(file => decideText(file, searchBase)).filter(decision => decision !== undefined);
			const involved = refs.length > 0 || fileDecisions.length > 0;
			if (toolName !== "bash" && !involved) return undefined;
			if (involved && !partsAreReadable(content)) {
				if (blocked) record(blocked, "withhold");
				else audit({ event: "tool_result", tool: toolName, rule: "unreadable", action: "withhold" });
				return withheldResult(content);
			}
			if (blocked) {
				record(blocked, "withhold");
				return withheldResult(content);
			}
			if (!partsAreReadable(content)) return undefined;
			const counts = new Map<string, { decision: Decision; lines: number; removed: number }>();
			const note = (decision: Decision, lines: number, removed: number) => {
				const key = decision.skill ?? "";
				const entry = counts.get(key) ?? { decision, lines: 0, removed: 0 };
				entry.lines += lines;
				entry.removed += removed;
				counts.set(key, entry);
			};
			const scrubAll = (text: string, decision: Decision) => {
				const scrubbed = neutralizeLines(text, patterns);
				if (scrubbed.count > 0) note(decision, scrubbed.count, 0);
				return scrubbed.text;
			};
			let rewritten: Part[];
			if (toolName === "read") {
				rewritten = rewriteParts(content, text => scrubAll(text, decisions[0]!));
			} else if (SEARCH_TOOLS.has(toolName)) {
				rewritten = rewriteParts(content, text => {
					const sections = parseGroupedOutput(text);
					if (!sections) {
						const denied = fileDecisions.find(decision => !decision.allow);
						if (denied) {
							note(denied, 0, text.split("\n").length);
							return RESULT_WITHHELD;
						}
						const owner = decisions[0] ?? fileDecisions[0];
						return owner ? scrubAll(text, owner) : text;
					}
					const guarded = sections.map((section): OutputSection => {
						const decision = section.file === undefined ? undefined : decideText(section.file, searchBase);
						if (!decision) return section;
						if (!decision.allow) {
							note(decision, 0, section.lines.length);
							return { ...section, lines: [REMOVED_MATCHES] };
						}
						const scrubbed = neutralizeLines(section.lines.join("\n"), patterns);
						if (scrubbed.count > 0) note(decision, scrubbed.count, 0);
						return { ...section, lines: scrubbed.text.split("\n") };
					});
					return joinSections(guarded);
				});
			} else {
				const base = context.cwd;
				const loadedForms = s.skills.map(skill => ({ skill, forms: displayForms(skill.baseDir, base, s.home).map(form => `${form}/`) }));
				rewritten = rewriteParts(content, text =>
					text
						.split("\n")
						.map(line => {
							const mentioned = [...line.matchAll(ROOT_PATH_IN_TEXT)].map(match => decideText(match[0], base));
							for (const { skill, forms } of loadedForms) {
								if (forms.some(form => line.includes(form))) {
									mentioned.push(decide({ kind: "skill", name: skill.name, dir: skill.baseDir, loaded: true, rel: "" }, s, false, digests));
								}
							}
							const denied = mentioned.find(decision => decision && !decision.allow);
							if (denied) {
								note(denied, 0, 1);
								return REMOVED_MATCHES;
							}
							const owner = mentioned.find(decision => decision !== undefined) ?? decisions[0];
							if (!owner) return line;
							const scrubbed = neutralizeLines(line, patterns);
							if (scrubbed.count > 0) note(owner, scrubbed.count, 0);
							return scrubbed.text;
						})
						.join("\n"),
				);
			}
			if (counts.size === 0) return undefined;
			for (const { decision, lines, removed } of counts.values()) {
				if (removed > 0) record(decision, "remove", removed);
				if (lines > 0) record(decision, "rewrite", lines);
			}
			return rewritten;
		};

		pi.on("tool_result", async (event, ctx) => {
			if (!WATCHED_TOOLS.has(event.toolName)) return undefined;
			try {
				const s = await ensureState(ctx.cwd);
				const content = guardResult(event.toolName, event.input, event.content, event.details, s, ctx.cwd);
				return content ? { content: content as typeof event.content } : undefined;
			} catch (err) {
				log("withheld a result it could not check", { tool: event.toolName, error: errorText(err) });
				audit({ event: "tool_result", tool: event.toolName, rule: "error", action: "withhold" });
				return { content: withheldResult(event.content) as typeof event.content };
			}
		});

		const guardSkillPrompt = (message: Record<string, unknown>, s: GuardState): Record<string, unknown> | undefined => {
			const details = message.details;
			const timestamp = String(message.timestamp ?? "");
			const withhold = (rule: string, skill?: string, digest?: string) => {
				audit({ event: "context", skill, digest, rule, action: "withhold" }, `context:${timestamp}:${skill}:${rule}`);
				return { ...message, content: SKILL_PROMPT_WITHHELD };
			};
			if (!isRecord(details) || typeof details.name !== "string" || typeof details.path !== "string") return withhold("unverifiable");
			const name = isValidSkillName(details.name) ? details.name : undefined;
			if (!name) return withhold("unknown-skill");
			const decision = decide({ kind: "skill", name, dir: path.dirname(details.path), loaded: true, rel: "SKILL.md" }, s, false, new Map());
			if (!decision.allow) return withhold(decision.rule, name, decision.digest);
			const text = messageText(message.content);
			const body = skillBody(details.path);
			if (text === undefined || body === undefined || !text.includes(body)) return withhold("body-mismatch", name, decision.digest);
			let lines = 0;
			const scrub = (value: string) => {
				const scrubbed = neutralizeLines(value, patterns);
				lines += scrubbed.count;
				return scrubbed.text;
			};
			const content = typeof message.content === "string" ? scrub(message.content) : rewriteParts(message.content as unknown[], scrub);
			if (lines === 0) return undefined;
			audit({ event: "context", skill: name, digest: decision.digest, rule: "approved", action: "rewrite", lines }, `context:${timestamp}:${name}:rewrite`);
			return { ...message, content };
		};

		const guardNotice = (message: Record<string, unknown>, s: GuardState): Record<string, unknown> | undefined => {
			const skills = listed(s);
			let changed = false;
			const scrub = (value: string) => {
				const scrubbed = scrubSkillsBlock(value, skills, patterns);
				if (!scrubbed) return value;
				changed = true;
				auditChanges("context", scrubbed.changes);
				return scrubbed.text;
			};
			if (typeof message.content === "string") {
				const content = scrub(message.content);
				return changed ? { ...message, content } : undefined;
			}
			if (!partsAreReadable(message.content)) return undefined;
			const content = rewriteParts(message.content, scrub);
			return changed ? { ...message, content } : undefined;
		};

		pi.on("context", async (event, ctx) => {
			try {
				if (!Array.isArray(event.messages)) return undefined;
				const s = await ensureState(ctx.cwd);
				let changed = false;
				const messages = event.messages.map(message => {
					if (!isRecord(message) || message.role !== "custom") return message;
					let replacement: Record<string, unknown> | undefined;
					try {
						if (message.customType === "skill-prompt") replacement = guardSkillPrompt(message, s);
						else if (message.customType === "skillful-notice") replacement = guardNotice(message, s);
					} catch (err) {
						if (message.customType !== "skill-prompt") return message;
						log("withheld a /skill message it could not check", { error: errorText(err) });
						replacement = { ...message, content: SKILL_PROMPT_WITHHELD };
					}
					if (!replacement) return message;
					changed = true;
					return replacement;
				});
				return changed ? { messages: messages as typeof event.messages } : undefined;
			} catch (err) {
				log("could not check the messages", { error: errorText(err) });
				return undefined;
			}
		});
	};
}

export default createSkillGuard();
