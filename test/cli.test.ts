import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { runSkillGuardCli } from "../src/cli";
import { digestFile, digestSkillDir, parseManifest, verifyManifestSignature } from "../src/manifest";
import { DEPLOY_HELPER, RELEASE_NOTES, makeProject, removeTemps, tempDir } from "./fixtures";
import { KEYS, OTHER_KEYS, PACKAGE } from "./helpers";

afterAll(removeTemps);

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runSkillGuardCli(args, { out: line => out.push(line), err: line => err.push(line) });
	return { code, out: out.join("\n"), err: err.join("\n") };
}

const ORIGIN = { source: "https://github.com/example/skills", commit: "0123456789abcdef0123456789abcdef01234567", owner: "release-team" };

function writeJson(dir: string, name: string, value: unknown): string {
	const file = path.join(dir, name);
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
	return file;
}

describe("keygen", () => {
	it("writes an Ed25519 key pair, the private key readable only by its owner, and never overwrites", async () => {
		const dir = tempDir("sg-keys-");
		expect((await run(["keygen", dir])).code).toBe(0);
		expect(fs.statSync(path.join(dir, "skill-guard.key.pem")).mode & 0o777).toBe(0o600);
		expect(fs.readFileSync(path.join(dir, "skill-guard.pub.pem"), "utf8")).toContain("BEGIN PUBLIC KEY");
		const again = await run(["keygen", dir]);
		expect(again.code).toBe(1);
		expect(again.err).toContain("exists");
	});
});

describe("inventory", () => {
	it("lists the skills omp would load, with their directory and script digests", async () => {
		const project = makeProject([DEPLOY_HELPER, RELEASE_NOTES]);
		const result = await run(["inventory", "--cwd", project.cwd, "--json"]);
		expect(result.code).toBe(0);
		const list = JSON.parse(result.out) as Array<{ name: string; path: string; digest: string; scripts: Record<string, string> }>;
		expect(list.map(skill => skill.name)).toEqual(["deploy-helper", "release-notes"]);
		const dir = project.skillDir("deploy-helper");
		expect(list[0]).toMatchObject({ path: ".omp/skills/deploy-helper", digest: digestSkillDir(dir) });
		expect(list[0]!.scripts).toEqual({ "scripts/release.sh": digestFile(path.join(dir, "scripts", "release.sh")) });
	});
});

describe("check", () => {
	it("passes a clean skill", async () => {
		const project = makeProject([DEPLOY_HELPER]);
		const result = await run(["check", "--cwd", project.cwd]);
		expect(result.code, result.err).toBe(0);
	});

	it("fails and names the rule for CRLF, a name that differs from its directory, a symlink, and a missing description", async () => {
		const project = makeProject([
			DEPLOY_HELPER,
			{ name: "crlf-skill", description: "Uses CRLF.", body: "# CRLF", crlf: true },
			{ name: "original", dirName: "renamed", description: "Renamed.", body: "# Renamed" },
			{ name: "no-description", description: "", body: "# No description" },
		]);
		fs.symlinkSync("SKILL.md", path.join(project.skillDir("deploy-helper"), "alias.md"));
		const result = await run(["check", "--cwd", project.cwd]);
		expect(result.code).toBe(1);
		const lines = result.err.split("\n");
		const ruleFor = (skill: string) => lines.filter(line => line.includes(skill)).join("\n");
		expect(ruleFor("crlf-skill")).toMatch(/LF/);
		expect(ruleFor("renamed")).toMatch(/name/);
		expect(ruleFor("deploy-helper")).toMatch(/symlink/);
		expect(ruleFor("no-description")).toMatch(/description/);
	});
});

describe("manifest, sign, verify", () => {
	it("refuses a skill without an owner, source, or commit, a skill missing from the approvals, and undeclared scripts", async () => {
		const project = makeProject([DEPLOY_HELPER, RELEASE_NOTES]);
		const dir = tempDir("sg-ci-");
		const out = path.join(dir, "skills.manifest.json");
		const cases: Array<[unknown, RegExp]> = [
			[{ skills: { "deploy-helper": { ...ORIGIN, scripts: ["scripts/release.sh"] }, "release-notes": { ...ORIGIN, owner: "" } } }, /release-notes: approval has no owner/],
			[{ skills: { "deploy-helper": { ...ORIGIN, scripts: ["scripts/release.sh"] } } }, /release-notes.*not in the approvals/],
			[{ skills: { "deploy-helper": { ...ORIGIN, scripts: [] }, "release-notes": ORIGIN } }, /deploy-helper.*scripts/],
		];
		for (const [approvals, message] of cases) {
			const result = await run(["manifest", "--cwd", project.cwd, "--approvals", writeJson(dir, "approvals.json", approvals), "--out", out]);
			expect(result.code).toBe(1);
			expect(result.err).toMatch(message);
			expect(fs.existsSync(out)).toBe(false);
		}
	});

	it("builds a manifest that signs and verifies against the CI key only", async () => {
		const project = makeProject([DEPLOY_HELPER, RELEASE_NOTES]);
		const dir = tempDir("sg-ci-");
		const approvals = writeJson(dir, "approvals.json", {
			skills: { "deploy-helper": { ...ORIGIN, scripts: ["scripts/release.sh"] }, "release-notes": { ...ORIGIN, scripts: [] } },
			revoked: ["old-skill"],
		});
		const out = path.join(dir, "skills.manifest.json");
		const built = await run(["manifest", "--cwd", project.cwd, "--approvals", approvals, "--out", out, "--expires-in-days", "30"]);
		expect(built.code, built.err).toBe(0);
		const manifest = parseManifest(fs.readFileSync(out, "utf8"));
		expect(manifest.skills.map(skill => skill.name)).toEqual(["deploy-helper", "release-notes"]);
		expect(manifest.skills[0]).toMatchObject({ digest: digestSkillDir(project.skillDir("deploy-helper")), owner: "release-team" });
		expect(manifest.revoked).toEqual(["old-skill"]);
		expect(Date.parse(manifest.expiresAt ?? "") - Date.now()).toBeGreaterThan(29 * 86_400_000);

		const key = path.join(dir, "ci.key.pem");
		const pub = path.join(dir, "ci.pub.pem");
		const otherPub = path.join(dir, "other.pub.pem");
		fs.writeFileSync(key, KEYS.privateKeyPem);
		fs.writeFileSync(pub, KEYS.publicKeyPem);
		fs.writeFileSync(otherPub, OTHER_KEYS.publicKeyPem);
		expect((await run(["sign", "--key", key, out])).code).toBe(0);
		const signature = fs.readFileSync(`${out}.sig`, "utf8").trim();
		expect(verifyManifestSignature(fs.readFileSync(out, "utf8"), signature, [KEYS.publicKeyPem])).toBe(true);
		const verified = await run(["verify", "--public-key", pub, out]);
		expect(verified.code).toBe(0);
		expect(verified.out).toContain("verified");
		expect((await run(["verify", "--public-key", otherPub, out])).code).toBe(1);
	});

	it("builds a manifest from the example approvals for a project that ships deploy-helper", async () => {
		const project = makeProject([DEPLOY_HELPER]);
		const out = path.join(tempDir("sg-ci-"), "skills.manifest.json");
		const approvals = path.join(PACKAGE, "examples", "approvals.example.json");
		const result = await run(["manifest", "--cwd", project.cwd, "--approvals", approvals, "--out", out]);
		expect(result.code, result.err).toBe(0);
		expect(parseManifest(fs.readFileSync(out, "utf8"))).toMatchObject({ revoked: ["old-deploy-helper"] });
	});

	it("prints usage and exits 2 for an unknown command", async () => {
		const result = await run(["frobnicate"]);
		expect(result.code).toBe(2);
		expect(result.err).toContain("usage");
	});
});

describe("executables", () => {
	// Both load omp's own discovery code, which takes a few seconds on a busy machine.
	it("both bin entries start and print their usage", () => {
		for (const [bin, flag] of [["omp-skill-guard.ts", "help"], ["omp-safe.ts", "--help"]] as const) {
			const run = Bun.spawnSync(["bun", path.join(PACKAGE, "bin", bin), flag], { stdout: "pipe", stderr: "pipe" });
			expect(run.exitCode, bin).toBe(0);
			expect(`${run.stdout.toString()}${run.stderr.toString()}`, bin).toContain("usage:");
		}
	}, 60_000);
});
