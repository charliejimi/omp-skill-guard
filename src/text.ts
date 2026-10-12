// Text checks shared by the guard's handlers. Nothing here imports omp.
//
// The rewriting handlers run where omp ships the original text on a timeout, so every pattern is
// linear in its input: literal anchors, bounded repetition, nothing nested that can backtrack.

/**
 * Lines that read like an instruction to the agent rather than skill documentation: an override,
 * a secrecy marker, an every-session cadence, or an injection delimiter. These are the Day20
 * article's patterns minus `onboarded\.txt`, which only matched its demonstration bait. Bare
 * imperatives such as "run the build" are not here; ordinary skill steps use them.
 */
export const INSTRUCTION_PATTERNS: readonly RegExp[] = [
	/ignore\s+(?:all\s+)?previous/i,
	/disregard\s+(?:all\s+)?(?:previous|prior|earlier)/i,
	/\bnew\s+instructions?\b/i,
	/\bsystem\s+prompt\b/i,
	/in\s+every\s+session/i,
	/before\s+(?:responding|doing\s+anything|you\s+answer)/i,
	/\bsilently\b/i,
	/\bdo\s+not\s+mention\b/i,
	/<\/?(?:system|tool_call|tool|instructions?)>/i,
];

export const NEUTRALIZED_LINE = "[omp-skill-guard: removed a line that read like an instruction]";

export interface Rewrite {
	text: string;
	/** How many lines were replaced. */
	count: number;
}

export function findInstruction(text: string, patterns: readonly RegExp[] = INSTRUCTION_PATTERNS): RegExp | undefined {
	return patterns.find(pattern => pattern.test(text));
}

/** Copies a pattern without the `g` and `y` flags, whose `lastIndex` would make `test` stateful. */
export function stateless(pattern: RegExp): RegExp {
	return pattern.global || pattern.sticky ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")) : pattern;
}

// What a replaced line keeps: its indentation, then a grep gutter (`*12|`, ` 12|`, `12:`), a
// `path:line:` prefix from a shell search, or a list marker.
const LINE_PREFIX = /^(\s*)((?:[*>]?\d{1,7}[|:])|(?:[^\s:|]{1,512}:\d{1,7}:)|(?:(?:[-*+]|\d{1,3}[.)])\s+))?/;

export function neutralizeLine(line: string): string {
	const carriage = line.endsWith("\r") ? "\r" : "";
	const body = carriage ? line.slice(0, -1) : line;
	const prefix = LINE_PREFIX.exec(body);
	return `${prefix?.[1] ?? ""}${prefix?.[2] ?? ""}${NEUTRALIZED_LINE}${carriage}`;
}

/** Replaces every line that reads like an instruction, keeping the others byte for byte. */
export function neutralizeLines(text: string, patterns: readonly RegExp[] = INSTRUCTION_PATTERNS): Rewrite {
	let count = 0;
	const lines = text.split("\n").map(line => {
		if (!findInstruction(line, patterns)) return line;
		count++;
		return neutralizeLine(line);
	});
	return { text: count > 0 ? lines.join("\n") : text, count };
}
