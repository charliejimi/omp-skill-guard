import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initializeWithSettings } from "@oh-my-pi/pi-coding-agent/discovery";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { getLogsDir } from "@oh-my-pi/pi-utils/dirs";
import { type GuardConfig, loadConfig } from "../src/config";
import {
	EXIT_REFUSED,
	EXIT_USAGE,
	type LaunchIO,
	type Preflight,
	buildCommand,
	decide,
	launch,
	preflight,
	renderOverlay,
	runOmpSafe,
} from "../src/launcher";
import type { ApprovedSkill } from "../src/manifest";
import { DEPLOY_HELPER, type Project, RELEASE_NOTES, type SkillSpec, approve, makeProject, removeTemps, tempDir, writeSkill } from "./fixtures";
import { KEYS, OTHER_KEYS, PACKAGE, manifestOf, writeManifest } from "./helpers";

afterAll(removeTemps);

interface Setup {
	project: Project;
	config: GuardConfig;
	trust: string;
}

interface SetupOptions {
	skills?: SkillSpec[];
	approve?: (project: Project) => ApprovedSkill[];
	key?: string;
}

function setup(options: SetupOptions = {}): Setup {
	const project = makeProject(options.skills ?? [DEPLOY_HELPER, RELEASE_NOTES]);
	const trust = tempDir("sg-trust-");
	const approved = options.approve?.(project) ?? [approve(project.skillDir("deploy-helper"), "deploy-helper")];
	const signed = writeManifest(trust, manifestOf(approved), options.key);
	const config: GuardConfig = {
		manifest: signed.manifest,
		signature: signed.signature,
		publicKeys: [KEYS.publicKeyPem],
		auditLog: path.join(trust, "audit.jsonl"),
	};
	return { project, config, trust };
}

/** Records the launcher's output; with `tty`, answers its questions from `answers` in order. */
function recordingIO(answers: string[] = [], tty = false): LaunchIO & { lines: string[]; questions: string[] } {
	const lines: string[] = [];
	const questions: string[] = [];
	const ask = async (question: string) => {
		questions.push(question);
		return answers.shift();
	};
	return { lines, questions, err: line => lines.push(line), ...(tty ? { ask } : {}) };
}

const statusOf = (pre: Preflight, name: string) => pre.skills.find(skill => skill.name === name)?.status;

describe("pre-start check", () => {
	it("verifies the manifest and classifies every skill omp would load", async () => {
		const s = setup();
		const pre = await preflight({ cwd: s.project.cwd, config: s.config, io: recordingIO() });
		expect(pre.manifestProblem).toBeUndefined();
		expect(statusOf(pre, "deploy-helper")).toBe("approved");
		expect(statusOf(pre, "release-notes")).toBe("not-approved");
		expect(pre.untrusted.map(skill => skill.name)).toEqual(["release-notes"]);
		expect(pre.selfTest.ok).toBe(true);
	});

	it("catches a same-named skill from a higher-priority root shadowing the approved copy", async () => {
		const copy: SkillSpec = { ...DEPLOY_HELPER, root: ".claude/skills", body: "# Approved copy\n\nRun the build." };
		const s = setup({
			skills: [DEPLOY_HELPER, copy],
			approve: project => [approve(project.skillDir("deploy-helper", ".claude/skills"), "deploy-helper")],
		});
		const pre = await preflight({ cwd: s.project.cwd, config: s.config, io: recordingIO() });
		expect(statusOf(pre, "deploy-helper")).toBe("modified");
		expect(pre.untrusted.map(skill => skill.name)).toEqual(["deploy-helper"]);
	});

	it("counts skills bundled next to an -e extension, as omp does", async () => {
		const pkg = tempDir("sg-ext-");
		fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "ext-with-skill", omp: { extensions: ["./index.ts"] } }));
		fs.writeFileSync(path.join(pkg, "index.ts"), "export default function () {}\n");
		writeSkill(pkg, { name: "bundled-helper", root: "skills", description: "Bundled with an extension.", body: "# Bundled" });
		const plain = setup({ skills: [DEPLOY_HELPER] });
		const withExtension = setup({ skills: [DEPLOY_HELPER] });
		const without = await preflight({ cwd: plain.project.cwd, config: plain.config, io: recordingIO() });
		const loaded = await preflight({ cwd: withExtension.project.cwd, config: withExtension.config, io: recordingIO(), ompArgs: ["-e", pkg, "--mode", "rpc"] });
		expect(without.skills.map(skill => skill.name)).toEqual(["deploy-helper"]);
		expect(statusOf(loaded, "bundled-helper")).toBe("not-approved");
	});

	it("treats every skill as untrusted when the manifest is not signed by a trusted key", async () => {
		const s = setup({ key: OTHER_KEYS.privateKeyPem });
		const pre = await preflight({ cwd: s.project.cwd, config: s.config, io: recordingIO() });
		expect(pre.manifestProblem).toMatch(/signature/);
		expect(pre.untrusted.map(skill => skill.name).sort()).toEqual(["deploy-helper", "release-notes"]);
	});
});

describe("decision", () => {
	const base = async () => {
		const s = setup();
		return preflight({ cwd: s.project.cwd, config: s.config, io: recordingIO() });
	};

	it("starts without asking when every loaded skill is approved", async () => {
		const s = setup({ skills: [DEPLOY_HELPER] });
		const io = recordingIO(["1"], true);
		const pre = await preflight({ cwd: s.project.cwd, config: s.config, io });
		expect(await decide(pre, "ask", io)).toBe("start");
		expect(io.questions).toEqual([]);
	});

	it("follows the non-interactive policy, and refuses when nobody can answer", async () => {
		const pre = await base();
		expect(await decide(pre, "refuse", recordingIO())).toBe("refuse");
		expect(await decide(pre, "exclude", recordingIO())).toBe("exclude");
		expect(await decide(pre, "disable", recordingIO())).toBe("disable");
		expect(await decide(pre, "ask", recordingIO())).toBe("refuse");
	});

	it("asks at a terminal, listing the untrusted skills, and refuses by default", async () => {
		const pre = await base();
		for (const [answer, outcome] of [["2", "exclude"], ["3", "disable"], ["1", "refuse"], ["", "refuse"], [undefined, "refuse"]] as const) {
			const io = recordingIO(answer === undefined ? [] : [answer], true);
			expect(await decide(pre, "ask", io)).toBe(outcome);
			expect(io.questions[0]).toContain("release-notes");
		}
	});

	it("never offers approved-only when the guard self-test fails", async () => {
		const pre = { ...(await base()), selfTest: { ok: false, failures: ["description guard"] } };
		expect(await decide(pre, "exclude", recordingIO())).toBe("refuse");
		expect(await decide(pre, "disable", recordingIO())).toBe("disable");
		const io = recordingIO(["2"], true);
		expect(await decide(pre, "ask", io)).toBe("refuse");
		expect(io.questions[0]).toContain("self-test");
		expect(io.questions[0]).not.toContain("only the approved");
	});
});

describe("overlay", () => {
	async function loadedWith(cwd: string, overlay: string): Promise<{ names: string[]; commands: boolean | undefined }> {
		const file = path.join(tempDir("sg-overlay-"), "overlay.yml");
		fs.writeFileSync(file, overlay);
		const settings = await Settings.loadReadOnly({ cwd, configFiles: [file] });
		initializeWithSettings(settings);
		const group = settings.getGroup("skills");
		const { skills } = await loadSkills({ ...group, cwd });
		return { names: skills.map(skill => skill.name).sort(), commands: group.enableSkillCommands };
	}

	it("makes omp load exactly the approved, unchanged skills, with /skill: off", async () => {
		const s = setup();
		const pre = await preflight({ cwd: s.project.cwd, config: s.config, io: recordingIO() });
		expect(await loadedWith(s.project.cwd, renderOverlay(pre, "exclude", s.config))).toEqual({ names: ["deploy-helper"], commands: false });
		const allowed = renderOverlay(pre, "exclude", { ...s.config, allowSkillCommands: true });
		expect((await loadedWith(s.project.cwd, allowed)).commands).toBe(true);
		expect((await loadedWith(s.project.cwd, renderOverlay(pre, "disable", s.config))).names).toEqual([]);
	});

	it("turns skills off instead of writing an empty include list, which would load every skill", async () => {
		const s = setup({ approve: () => [] });
		const pre = await preflight({ cwd: s.project.cwd, config: s.config, io: recordingIO() });
		const overlay = renderOverlay(pre, "exclude", s.config);
		expect(overlay).toMatch(/enabled: false/);
		expect((await loadedWith(s.project.cwd, overlay)).names).toEqual([]);
	});
});

describe("examples", () => {
	it("the example config loads, with ~ expanded", () => {
		const config = loadConfig(path.join(PACKAGE, "examples", "config.example.json"));
		expect(config.manifest).toBe(path.join(os.homedir(), ".cache", "omp-skill-guard", "skills.manifest.json"));
		expect(config.publicKeys).toEqual([path.join(os.homedir(), ".config", "omp-skill-guard", "skill-guard.pub.pem")]);
		expect(config).toMatchObject({ tools: ["read", "write", "edit", "grep", "find"], allowSkillCommands: false, onUntrusted: "ask" });
	});

	it("the example overlay makes omp load only deploy-helper, with /skill: off", async () => {
		const retired: SkillSpec = { name: "old-deploy-helper", description: "Retired.", body: "# Retired" };
		const project = makeProject([DEPLOY_HELPER, RELEASE_NOTES, retired]);
		const settings = await Settings.loadReadOnly({ cwd: project.cwd, configFiles: [path.join(PACKAGE, "examples", "overlay.example.yml")] });
		initializeWithSettings(settings);
		const group = settings.getGroup("skills");
		const { skills } = await loadSkills({ ...group, cwd: project.cwd });
		expect(skills.map(skill => skill.name)).toEqual(["deploy-helper"]);
		expect(group.enableSkillCommands).toBe(false);
	});
});

describe("launch", () => {
	/** A stand-in for omp that records what it was started with, then exits with 7. */
	function fakeOmp(dir: string): { command: string[]; record: string } {
		const record = path.join(dir, "record.json");
		const script = path.join(dir, "fake-omp.ts");
		fs.writeFileSync(
			script,
			[
				'import * as fs from "node:fs";',
				'import * as path from "node:path";',
				"const argv = process.argv.slice(2);",
				'const overlay = fs.readFileSync(argv[argv.indexOf("--config") + 1]!, "utf8");',
				'const entryPath = argv[argv.indexOf("-e") + 1]!;',
				'const entry = fs.readFileSync(entryPath, "utf8");',
				`fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv, cwd: process.cwd(), launchDir: fs.readdirSync(process.cwd()), env: Object.keys(process.env), overlay, entry }));`,
				`const logs = ${JSON.stringify(getLogsDir())};`,
				"fs.mkdirSync(logs, { recursive: true });",
				'const line = { timestamp: new Date().toISOString(), level: "warn", pid: process.pid, message: "Extension handler timed out", extensionPath: entryPath, event: "tool_result", timeoutMs: 30000 };',
				'fs.appendFileSync(path.join(logs, `omp.${new Date().toISOString().slice(0, 10)}.${process.pid}.log`), JSON.stringify(line) + "\\n");',
				"process.exit(7);",
				"",
			].join("\n"),
		);
		return { command: ["bun", script], record };
	}

	it("starts omp with the overlay, the tool list, and a per-run guard entry, then reports and alerts", async () => {
		const s = setup();
		const fake = fakeOmp(s.trust);
		const io = recordingIO();
		const stateDir = tempDir("sg-state-");
		const code = await launch({
			cwd: s.project.cwd,
			config: { ...s.config, omp: fake.command, tools: ["read", "grep"], onUntrusted: "exclude", passEnv: ["SG_PASSED"] },
			ompArgs: ["--mode", "rpc"],
			stateDir,
			io,
			env: { ...process.env, SG_PASSED: "1", SG_SECRET_TOKEN: "not-for-omp" },
		});
		expect(code).toBe(7);
		const record = JSON.parse(fs.readFileSync(fake.record, "utf8")) as {
			argv: string[];
			cwd: string;
			launchDir: string[];
			env: string[];
			overlay: string;
			entry: string;
		};
		expect(record.cwd.startsWith(fs.realpathSync(stateDir))).toBe(true);
		expect(record.launchDir).toEqual([]);
		expect(record.argv.slice(0, 2)).toEqual(["--cwd", s.project.cwd]);
		expect(record.env).toContain("SG_PASSED");
		expect(record.env).not.toContain("SG_SECRET_TOKEN");
		expect(record.argv.slice(-4, -1)).toEqual(["--mode", "rpc", "-e"]);
		expect(record.argv[record.argv.indexOf("--tools") + 1]).toBe("read,grep");
		expect(record.overlay).toContain('"deploy-helper"');
		expect(record.overlay).not.toContain("release-notes");
		expect(record.entry).toContain(JSON.stringify(path.join(PACKAGE, "src", "index.ts")));
		expect(record.entry).toContain(JSON.stringify(s.config.manifest));
		expect(record.entry).toContain("BEGIN PUBLIC KEY");
		expect(fs.readdirSync(stateDir)).toEqual([]);
		const output = io.lines.join("\n");
		expect(output).toContain("release-notes");
		expect(output).toMatch(/ALERT/);
		expect(output).toContain("timed out");
	});

	it("names the project with --cwd and puts the guard last among the extensions, before omp's own --, after which omp reads message text", () => {
		const config: GuardConfig = { omp: ["omp"], tools: ["read"] };
		expect(buildCommand(config, "/o.yml", "/g.ts", ["-e", "/other.ts", "--", "-e is literal text"], "/work/shipit")).toEqual([
			"omp",
			"--cwd",
			"/work/shipit",
			"--config",
			"/o.yml",
			"--tools",
			"read",
			"-e",
			"/other.ts",
			"-e",
			"/g.ts",
			"--",
			"-e is literal text",
		]);
	});

	it("treats a --cwd among omp's arguments as the project and passes omp one absolute --cwd", async () => {
		const s = setup();
		const fake = fakeOmp(s.trust);
		const io = recordingIO();
		const code = await launch({
			cwd: s.project.root,
			config: { ...s.config, omp: fake.command, onUntrusted: "exclude" },
			ompArgs: ["--cwd", "shipit", "--mode", "rpc"],
			stateDir: tempDir("sg-state-"),
			io,
		});
		expect(code).toBe(7);
		const record = JSON.parse(fs.readFileSync(fake.record, "utf8")) as { argv: string[] };
		expect(record.argv.filter(arg => arg === "--cwd")).toHaveLength(1);
		expect(record.argv[record.argv.indexOf("--cwd") + 1]).toBe(s.project.cwd);
		expect(io.lines.join("\n")).toContain("release-notes");
	});

	it("does not start omp when it refuses", async () => {
		const s = setup();
		const fake = fakeOmp(s.trust);
		const io = recordingIO();
		const code = await launch({ cwd: s.project.cwd, config: { ...s.config, omp: fake.command, onUntrusted: "refuse" }, io });
		expect(code).toBe(EXIT_REFUSED);
		expect(fs.existsSync(fake.record)).toBe(false);
		expect(io.lines.join("\n")).toContain("release-notes");
	});

	it("reads its defaults from a config file and lets flags override them", async () => {
		const s = setup();
		const fake = fakeOmp(s.trust);
		const configFile = path.join(s.trust, "config.json");
		fs.writeFileSync(configFile, JSON.stringify({ ...s.config, omp: fake.command, onUntrusted: "refuse" }));
		const io = recordingIO();
		const code = await runOmpSafe(
			["--config", configFile, "--on-untrusted", "exclude", "--tools", "read", "--cwd", s.project.cwd, "--", "--mode", "rpc"],
			io,
		);
		expect(code).toBe(7);
		const record = JSON.parse(fs.readFileSync(fake.record, "utf8")) as { argv: string[] };
		expect(record.argv[record.argv.indexOf("--tools") + 1]).toBe("read");
		expect(await runOmpSafe(["--no-such-flag"], recordingIO())).toBe(EXIT_USAGE);
	});
});
