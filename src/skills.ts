// Which skill a tool input or a tool result touches. Nothing here imports omp: the guard passes in
// the skills omp loaded, and every check works on paths and strings.
import * as fs from "node:fs";
import * as path from "node:path";
import { isValidSkillName } from "./manifest";

/** A skill omp loaded, as `loadSkills` reports it. */
export interface SkillEntry {
	name: string;
	description: string;
	baseDir: string;
	filePath: string;
	source: string;
	hide: boolean;
}

/**
 * What a tool input points at. A `skill` has a directory to hash; `loaded` is false for a
 * skill-shaped directory omp did not load. `rel` is the POSIX path inside the skill directory.
 */
export type SkillRef =
	| { kind: "skill"; name: string; dir: string; loaded: boolean; rel: string }
	| { kind: "unknown-skill"; name?: string }
	| { kind: "unverifiable" };

export interface PathContext {
	cwd: string;
	home: string;
	skills: readonly SkillEntry[];
	/** `skills.customDirectories`, absolute. */
	customRoots: readonly string[];
}

// Directories whose children are skills: omp's own, the compatible providers', and the managed
// (auto-learn) directory under the agent directory.
const ROOT_SEGMENTS: readonly string[][] = [
	[".omp", "agent", "managed-skills"],
	[".omp", "agent", "skills"],
	[".omp", "skills"],
	[".claude", "skills"],
	[".agents", "skills"],
	[".codex", "skills"],
	[".github", "skills"],
	[".opencode", "skills"],
	[".opencode", "skill"],
];
const ROOT_MENTION = /(?:^|[^A-Za-z0-9_-])\.(?:omp\/agent\/managed-skills|omp\/agent\/skills|omp\/skills|claude\/skills|agents\/skills|codex\/skills|github\/skills|opencode\/skills?)(?![A-Za-z0-9_-])/;
const SHELL_EXPANSION = /[*?[\]{}$`~]/;
// A token the shell expands that may land in skill files: anything under .omp, a skills segment, a
// SKILL file, an expanded segment right after a compatible provider's directory, or an expanded
// hidden directory with more path after it.
const SKILLISH_EXPANSION = [
	/(?:^|\/)\.omp(?:\/|$)/,
	/(?:^|\/)\.(?:claude|agents|codex|github|opencode)\/(?:skills?(?:\/|$)|[^/]*[*?[\]{}$`])/,
	/(?:^|\/)(?:managed-)?skills?(?:\/|$)/,
	/SKILL/,
	/(?:^|\/)\.[^/]*[*?[\]{}$`][^/]*\//,
];
const SKILL_URL = /^skill:\/\/([^/?#]+)(\/[^?#]*)?/i;
const SKILL_URL_TOKEN = /skill:\/\/[^\s'"`;&|<>()\\]+/gi;
const OTHER_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const TOKEN_SPLIT = /[\s;&|<>()`'"]+/;

function isInside(child: string, parent: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** The real path of `p`, or of its nearest existing ancestor joined with the rest. */
export function realpathLoose(p: string): string {
	const missing: string[] = [];
	let current = p;
	for (;;) {
		try {
			return path.join(fs.realpathSync(current), ...missing.reverse());
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return p;
			missing.push(path.basename(current));
			current = parent;
		}
	}
}

function toPosix(rel: string): string {
	return rel.split(path.sep).join("/");
}

export function resolvePath(value: string, cwd: string, home: string): string {
	const expanded = value === "~" || value.startsWith("~/") ? path.join(home, value.slice(1)) : value;
	return path.resolve(cwd, expanded);
}

/** omp's resolution of `skill://name[/path]`: exact name first, then longest prefix before a `:`. */
export function classifySkillUrl(url: string, skills: readonly SkillEntry[]): SkillRef {
	const parsed = SKILL_URL.exec(url);
	if (!parsed) return { kind: "unknown-skill" };
	let segment = parsed[1]!;
	try {
		segment = decodeURIComponent(segment);
	} catch {}
	let rawPath = parsed[2] ?? "";
	let entry = skills.find(skill => skill.name === segment);
	if (!entry) {
		for (let colon = segment.lastIndexOf(":"); colon > 0; colon = segment.lastIndexOf(":", colon - 1)) {
			const candidate = skills.find(skill => skill.name === segment.slice(0, colon));
			if (candidate) {
				entry = candidate;
				rawPath = `${rawPath}/${segment.slice(colon + 1)}`;
				break;
			}
		}
	}
	if (!entry) return { kind: "unknown-skill", name: isValidSkillName(segment) ? segment : undefined };
	let rel = rawPath.replace(/^\/+/, "");
	try {
		rel = decodeURIComponent(rel);
	} catch {}
	return { kind: "skill", name: entry.name, dir: entry.baseDir, loaded: true, rel };
}

/** A path inside a skills root: the skill directory and name, or `root` for the root itself. */
function skillDirFromRoots(abs: string, customRoots: readonly string[]): { name: string; dir: string } | "root" | undefined {
	for (const root of customRoots) {
		if (!isInside(abs, root)) continue;
		const [name] = path.relative(root, abs).split(path.sep);
		return name ? { name, dir: path.join(root, name) } : "root";
	}
	const segments = abs.split(path.sep);
	for (let i = segments.length - 1; i >= 0; i--) {
		for (const root of ROOT_SEGMENTS) {
			if (!root.every((part, offset) => segments[i + offset] === part)) continue;
			const name = segments[i + root.length];
			if (!name) return "root";
			return { name, dir: segments.slice(0, i + root.length + 1).join(path.sep) || path.sep };
		}
	}
	return undefined;
}

/**
 * The skill a filesystem path or `skill://` URL points at, if any. Paths resolve like omp does
 * (`~`, relative to `cwd`, a leading `@`), and through symlinks; a trailing read selector such as
 * `:1-20` stays part of the last segment, which is still inside the same directory.
 */
export function classifyPath(raw: string, context: PathContext): SkillRef | undefined {
	let value = raw.trim();
	if (value.startsWith("@")) value = value.slice(1);
	if (value.length === 0) return undefined;
	if (/^skill:\/\//i.test(value)) return classifySkillUrl(value, context.skills);
	if (OTHER_URL.test(value)) return undefined;
	const abs = resolvePath(value, context.cwd, context.home);
	const candidates = [...new Set([abs, realpathLoose(abs)])];
	let best: { entry: SkillEntry; base: string; candidate: string } | undefined;
	for (const entry of context.skills) {
		for (const base of new Set([path.resolve(entry.baseDir), realpathLoose(path.resolve(entry.baseDir))])) {
			for (const candidate of candidates) {
				if (isInside(candidate, base) && (!best || base.length > best.base.length)) best = { entry, base, candidate };
			}
		}
	}
	if (best) {
		const rel = toPosix(path.relative(best.base, best.candidate));
		return { kind: "skill", name: best.entry.name, dir: best.entry.baseDir, loaded: true, rel };
	}
	for (const candidate of candidates) {
		const found = skillDirFromRoots(candidate, context.customRoots);
		if (found === undefined || found === "root") continue;
		if (!isValidSkillName(found.name) || SHELL_EXPANSION.test(found.name)) return { kind: "unverifiable" };
		return { kind: "skill", name: found.name, dir: found.dir, loaded: false, rel: toPosix(path.relative(found.dir, candidate)) };
	}
	return undefined;
}

/** Whether a path is a skills root itself, such as `.omp/skills`. */
function isSkillsRoot(raw: string, context: PathContext): boolean {
	const abs = resolvePath(raw, context.cwd, context.home);
	return [abs, realpathLoose(abs)].some(candidate => skillDirFromRoots(candidate, context.customRoots) === "root");
}

/** Skills named by the `path` input of `read`, `grep`, or `ast_grep`; the latter two take `;`-separated lists. */
export function pathInputTargets(toolName: string, input: unknown, context: PathContext): SkillRef[] {
	const value = input !== null && typeof input === "object" ? (input as { path?: unknown }).path : undefined;
	if (typeof value !== "string") return [];
	const entries = toolName === "read" ? [value] : value.split(";");
	return entries.map(entry => classifyPath(entry, context)).filter((ref): ref is SkillRef => ref !== undefined);
}

function tokensOf(command: string): string[] {
	const tokens: string[] = [];
	for (const token of command.split(TOKEN_SPLIT)) {
		if (!token) continue;
		tokens.push(token);
		const assigned = token.indexOf("=");
		if (assigned > 0 && assigned < token.length - 1) tokens.push(token.slice(assigned + 1));
	}
	return tokens;
}

function mentionsSkillDir(token: string, context: PathContext): boolean {
	if (ROOT_MENTION.test(token)) return true;
	return context.skills.some(skill => token.includes(path.basename(skill.baseDir)) && token.includes(path.basename(path.dirname(skill.baseDir))));
}

/**
 * Skills a `bash` call touches: `skill://` URLs (omp expands them to paths before running), path
 * tokens inside skill directories, relative to the call's `cwd` input when it is set, and an
 * `unverifiable` reference for skills-root mentions it cannot pin to one skill (globs, variables,
 * the root itself).
 */
export function bashTargets(input: unknown, context: PathContext): SkillRef[] {
	const fields = input !== null && typeof input === "object" ? (input as { command?: unknown; cwd?: unknown }) : {};
	const command = typeof fields.command === "string" ? fields.command : "";
	const refs: SkillRef[] = [];
	let base = context.cwd;
	if (typeof fields.cwd === "string" && fields.cwd.trim()) {
		const ref = classifyPath(fields.cwd, context);
		if (ref) refs.push(ref);
		base = ref?.kind === "skill" ? path.join(ref.dir, ref.rel) : resolvePath(fields.cwd.trim(), context.cwd, context.home);
	}
	const inner = { ...context, cwd: base };
	for (const match of command.matchAll(SKILL_URL_TOKEN)) refs.push(classifySkillUrl(match[0], context.skills));
	for (const token of tokensOf(command)) {
		if (/^skill:\/\//i.test(token)) continue;
		const named = mentionsSkillDir(token, inner);
		const expands = SHELL_EXPANSION.test(token.replace(/^~(?=\/|$)/, ""));
		if (expands && (named || SKILLISH_EXPANSION.some(pattern => pattern.test(token)))) {
			refs.push({ kind: "unverifiable" });
			continue;
		}
		const ref = classifyPath(token, inner);
		if (ref) refs.push(ref);
		else if (named && ROOT_MENTION.test(token) && isSkillsRoot(token, inner)) refs.push({ kind: "unverifiable" });
	}
	return refs;
}

/** Path forms a skill directory can appear under in command output. */
export function displayForms(dir: string, cwd: string, home: string): string[] {
	const forms = new Set([dir, realpathLoose(dir)]);
	const relative = path.relative(cwd, dir);
	if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
		forms.add(relative);
		forms.add(`./${relative}`);
	}
	const fromHome = path.relative(home, dir);
	if (fromHome && !fromHome.startsWith("..") && !path.isAbsolute(fromHome)) forms.add(`~/${fromHome}`);
	return [...forms];
}

/** One file's section of grep or ast_grep grouped output; `file` is undefined for lines outside any file. */
export interface OutputSection {
	file?: string;
	header?: string;
	lines: string[];
}

const GROUPED_HEADER = /^(#+)\s+(.*)$/;
const HEADER_SUFFIX = /\s+\([^)]*\)\s*$/;
const HEADER_TAG = /#[0-9a-f]+$/i;

/**
 * Splits grep or ast_grep output into per-file sections. Multi-file results are a prefix-folded
 * path tree, one `#` per level (`# .omp/skills/`, `## deploy-helper/`, `### SKILL.md`); a blank
 * line ends a file's matches. Returns `undefined` when the text has no file headers.
 */
export function parseGroupedOutput(text: string): OutputSection[] | undefined {
	const sections: OutputSection[] = [];
	const dirs: string[] = [];
	let current: OutputSection = { lines: [] };
	sections.push(current);
	let sawFile = false;
	for (const line of text.split("\n")) {
		const header = GROUPED_HEADER.exec(line);
		if (header) {
			const depth = header[1]!.length - 1;
			const name = header[2]!.replace(HEADER_SUFFIX, "").replace(HEADER_TAG, "");
			if (name.endsWith("/")) {
				dirs.length = depth;
				dirs[depth] = name;
				current = { header: line, lines: [] };
			} else {
				dirs.length = depth;
				current = { file: `${dirs.join("")}${name}`, header: line, lines: [] };
				sawFile = true;
			}
			sections.push(current);
			continue;
		}
		if (line === "" && current.file !== undefined) {
			current = { lines: [line] };
			sections.push(current);
			continue;
		}
		current.lines.push(line);
	}
	return sawFile ? sections : undefined;
}

export function joinSections(sections: readonly OutputSection[]): string {
	const lines: string[] = [];
	for (const section of sections) {
		if (section.header !== undefined) lines.push(section.header);
		lines.push(...section.lines);
	}
	return lines.join("\n");
}
