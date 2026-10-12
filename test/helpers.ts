import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings, resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { discoverAndLoadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { SkillGuardOptions } from "../src/index";
import { type ApprovedSkill, MANIFEST_SCHEMA, type Manifest, generateKeyPair, signManifest } from "../src/manifest";
import { safeRemove } from "./fixtures";

export const PACKAGE = path.resolve(import.meta.dir, "..");

/** The CI key pair the tests trust, and one they do not. */
export const KEYS = generateKeyPair();
export const OTHER_KEYS = generateKeyPair();

export function manifestOf(skills: ApprovedSkill[], extra: Partial<Manifest> = {}): Manifest {
	return { schema: MANIFEST_SCHEMA, issuedAt: new Date().toISOString(), skills, revoked: [], ...extra };
}

/** Writes `skills.manifest.json` and its detached signature into `dir`. */
export function writeManifest(
	dir: string,
	manifest: Manifest | string,
	privateKeyPem: string = KEYS.privateKeyPem,
): { manifest: string; signature: string } {
	const file = path.join(dir, "skills.manifest.json");
	const text = typeof manifest === "string" ? manifest : `${JSON.stringify(manifest, null, 2)}\n`;
	fs.writeFileSync(file, text);
	fs.writeFileSync(`${file}.sig`, `${signManifest(text, privateKeyPem)}\n`);
	return { manifest: file, signature: `${file}.sig` };
}

let entries = 0;

/** An extension entry that loads the guard with explicit options, the way omp-safe does. */
export function writeGuardEntry(dir: string, options: SkillGuardOptions): string {
	const entry = path.join(dir, `guard-${++entries}.ts`);
	const config = { configPath: path.join(dir, "no-user-config.json"), ...options, entry };
	const source = [
		`import { createSkillGuard } from ${JSON.stringify(path.join(PACKAGE, "src", "index.ts"))};`,
		`export default createSkillGuard(${JSON.stringify(config, null, "\t")});`,
		"",
	].join("\n");
	fs.writeFileSync(entry, source);
	return entry;
}

let registry: { auth: AuthStorage; models: ModelRegistry; dir: string } | undefined;

async function models(): Promise<ModelRegistry> {
	if (!registry) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sg-auth-"));
		const auth = await AuthStorage.create(path.join(dir, "auth.db"));
		registry = { auth, models: new ModelRegistry(auth), dir };
	}
	return registry.models;
}

export function closeRegistry(): void {
	if (!registry) return;
	registry.auth.close();
	safeRemove(registry.dir);
	registry = undefined;
}

/** omp's global settings, in memory, for `cwd`, with optional overrides and overlays. */
export async function initSettings(
	cwd: string,
	overrides: Record<string, unknown> = {},
	configFiles: string[] = [],
): Promise<Settings> {
	resetSettingsForTest();
	return Settings.init({ inMemory: true, cwd, overrides, configFiles });
}

export interface Notice {
	message: string;
	type: string | undefined;
}

type Emitted = Promise<Record<string, unknown> | undefined>;

export interface Guard {
	runner: ExtensionRunner;
	notices: Notice[];
	handlerErrors: string[];
	toolCall(toolName: string, input: unknown): Emitted;
	toolResult(toolName: string, input: unknown, content: unknown, details?: unknown): Emitted;
	beforeAgentStart(systemPrompt: unknown): Emitted;
	context(messages: unknown[]): Promise<unknown[]>;
}

/**
 * Loads extension entries, in order, through omp's own loader and runner, wires a UI that records
 * notices and an active tool list, and starts the session.
 */
export async function loadGuard(
	paths: string[],
	cwd: string,
	options: { activeTools?: string[]; startSession?: boolean } = {},
): Promise<Guard> {
	const result = await discoverAndLoadExtensions(paths, cwd, undefined, undefined, { ambient: false });
	const extensions = result.extensions.filter(ext => paths.includes(ext.path));
	const loadErrors = result.errors.filter(err => paths.includes(err.path));
	if (loadErrors.length > 0 || extensions.length !== paths.length) {
		throw new Error(`extensions did not load: ${JSON.stringify(loadErrors)} (${extensions.length} loaded)`);
	}
	const runner = new ExtensionRunner(extensions, result.runtime, cwd, SessionManager.inMemory(cwd), await models());
	const notices: Notice[] = [];
	const ui = { notify: (message: string, type?: string) => notices.push({ message, type }) };
	const tools = options.activeTools ?? ["read", "grep", "bash", "write", "edit"];
	runner.initialize({ getActiveTools: () => tools } as never, {} as never, undefined, ui as never, "rpc");
	const handlerErrors: string[] = [];
	runner.onError(e => handlerErrors.push(`${e.event}: ${e.error}`));
	if (options.startSession !== false) await runner.emit({ type: "session_start" } as never);
	return {
		runner,
		notices,
		handlerErrors,
		toolCall: (toolName, input) =>
			runner.emitToolCall({ type: "tool_call", toolCallId: "call-1", toolName, input } as never) as Emitted,
		toolResult: (toolName, input, content, details) =>
			runner.emitToolResult({
				type: "tool_result",
				toolCallId: "call-1",
				toolName,
				input,
				content,
				details,
				isError: false,
			} as never) as Emitted,
		beforeAgentStart: systemPrompt => runner.emitBeforeAgentStart("hello", undefined, systemPrompt as never) as Emitted,
		context: messages => runner.emitContext(messages as never) as Promise<unknown[]>,
	};
}

export function readAudit(file: string): Array<Record<string, unknown>> {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(line => line.trim())
		.map(line => JSON.parse(line) as Record<string, unknown>);
}

/** The text parts of a tool result, joined. */
export function textOf(result: { content?: unknown } | undefined): string {
	const content = result?.content;
	if (!Array.isArray(content)) throw new Error(`no content array: ${JSON.stringify(result)}`);
	return content
		.filter(part => part?.type === "text")
		.map(part => String(part.text))
		.join("\n");
}

export const text = (value: string) => [{ type: "text", text: value }];
