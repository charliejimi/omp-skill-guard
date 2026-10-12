// Decisions the guard and its self-test share. Nothing here reads files or imports omp.
import { type ApprovalRule, isValidSkillName } from "./manifest";
import { findInstruction, neutralizeLine } from "./text";

export const DESCRIPTION_REMOVED = "[omp-skill-guard: description removed because it read like an instruction]";
export const DESCRIPTION_WITHHELD = "[omp-skill-guard: description withheld; this skill is not approved or changed since approval]";
export const SKILL_PROMPT_WITHHELD =
	"[omp-skill-guard: this skill's text was not inserted because the skill is not approved or changed since approval]";
export const RESULT_WITHHELD = "[omp-skill-guard: this result held skill content that could not be checked, so it was withheld]";
export const REMOVED_MATCHES = "[omp-skill-guard: removed output from a skill that is not approved or changed since approval]";

/** How a loaded skill stands: an approval rule, or `unreadable` when its directory could not be hashed. */
export type SkillRule = ApprovalRule | "unreadable";

/** A skill as the guard lists it: omp's name and description, and its standing. */
export interface ListedSkill {
	name: string;
	description: string;
	rule: SkillRule;
}

export interface BlockChange {
	skill?: string;
	rule: string;
	action: "rewrite" | "withhold";
}

export interface BlockScrub {
	text: string;
	changes: BlockChange[];
}

interface EntryMatch {
	start: number;
	end: number;
	skill: ListedSkill;
	tagged: boolean;
}

const OPENER = /(?:^|\n)<skills>\n/;
const CLOSER = "\n</skills>";
const DASH_ENTRY = /^- ([^:\n]{1,200}): /;

/** omp's two renderings of one `<skills>` entry: `- name: description` and `<skill name="…">` blocks. */
function renderings(skill: ListedSkill): Array<[string, boolean]> {
	return [
		[`- ${skill.name}: ${skill.description}`, false],
		[`<skill name="${skill.name}">\n${skill.description}\n</skill>`, true],
	];
}

function findEntries(region: string, skills: readonly ListedSkill[]): EntryMatch[] {
	const found: EntryMatch[] = [];
	for (const skill of skills) {
		for (const [entry, tagged] of renderings(skill)) {
			for (let at = region.indexOf(entry); at >= 0; at = region.indexOf(entry, at + 1)) {
				const end = at + entry.length;
				const startsLine = at === 0 || region[at - 1] === "\n";
				const endsLine = end === region.length || region[end] === "\n" || entry.endsWith("\n");
				if (startsLine && endsLine) found.push({ start: at, end, skill, tagged });
			}
		}
	}
	// A longer entry wins an overlap: an unapproved description that embeds a copy of an approved
	// entry is withheld whole, copy included.
	found.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
	const accepted: EntryMatch[] = [];
	for (const match of found) {
		if (!accepted.some(other => match.start < other.end && other.start < match.end)) accepted.push(match);
	}
	return accepted.sort((a, b) => a.start - b.start);
}

function guardEntry(match: EntryMatch, patterns: readonly RegExp[], changes: BlockChange[], original: string): string {
	const { skill, tagged } = match;
	let marker: string;
	if (skill.rule !== "approved") {
		marker = DESCRIPTION_WITHHELD;
		changes.push({ skill: skill.name, rule: skill.rule, action: "withhold" });
	} else if (findInstruction(skill.description, patterns)) {
		marker = DESCRIPTION_REMOVED;
		changes.push({ skill: skill.name, rule: "instruction-like", action: "rewrite" });
	} else {
		return original;
	}
	const trailing = original.endsWith("\n") ? "\n" : "";
	return tagged ? `<skill name="${skill.name}">\n${marker}\n</skill>${trailing}` : `- ${skill.name}: ${marker}${trailing}`;
}

/** Lines in the block that belong to no recognized entry. */
function guardLoose(text: string, known: ReadonlySet<string>, patterns: readonly RegExp[], changes: BlockChange[]): string {
	if (text.length === 0) return text;
	return text
		.split("\n")
		.map(line => {
			const entry = DASH_ENTRY.exec(line);
			if (entry && !known.has(entry[1]!)) {
				const name = isValidSkillName(entry[1]) ? entry[1] : undefined;
				changes.push({ skill: name, rule: "not-loaded", action: "withhold" });
				return `- ${entry[1]}: ${DESCRIPTION_WITHHELD}`;
			}
			if (!findInstruction(line, patterns)) return line;
			changes.push({ rule: "instruction-like", action: "rewrite" });
			return neutralizeLine(line);
		})
		.join("\n");
}

/**
 * The text with its `<skills>` block guarded: an unapproved or changed skill's description is
 * withheld, an approved description that reads like an instruction is removed, and stray lines in
 * the block are checked one by one. The block runs from `<skills>` to the last `</skills>`, so a
 * closing tag inside a description cannot end it early. `undefined` when nothing changed.
 */
export function scrubSkillsBlock(text: string, skills: readonly ListedSkill[], patterns: readonly RegExp[]): BlockScrub | undefined {
	const opener = OPENER.exec(text);
	if (!opener) return undefined;
	const start = opener.index + opener[0].length;
	const closer = text.lastIndexOf(CLOSER);
	const end = closer >= start - 1 ? Math.max(closer, start) : text.length;
	const region = text.slice(start, end);
	const known = new Set(skills.map(skill => skill.name));
	const changes: BlockChange[] = [];
	let guarded = "";
	let cursor = 0;
	for (const match of findEntries(region, skills)) {
		guarded += guardLoose(region.slice(cursor, match.start), known, patterns, changes);
		guarded += guardEntry(match, patterns, changes, region.slice(match.start, match.end));
		cursor = match.end;
	}
	guarded += guardLoose(region.slice(cursor), known, patterns, changes);
	if (changes.length === 0) return undefined;
	return { text: `${text.slice(0, start)}${guarded}${text.slice(end)}`, changes };
}
