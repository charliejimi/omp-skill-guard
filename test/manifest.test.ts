import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type TrustedManifestOptions,
	digestFile,
	digestSkillDir,
	listScripts,
	loadTrustedManifest,
	parseManifest,
	signManifest,
	verifyManifestSignature,
} from "../src/manifest";
import { DEPLOY_HELPER, approve, removeTemps, tempDir, writeSkill } from "./fixtures";
import { KEYS, OTHER_KEYS, manifestOf, writeManifest } from "./helpers";

afterAll(removeTemps);

function skillCopy(): string {
	const cwd = tempDir("sg-digest-");
	return writeSkill(cwd, DEPLOY_HELPER);
}

describe("directory digest", () => {
	it("is the same for the same files written in a different order", () => {
		const a = tempDir("sg-order-a-");
		const b = tempDir("sg-order-b-");
		const files: Array<[string, string]> = [
			["SKILL.md", "---\nname: x\ndescription: y\n---\nbody\n"],
			["scripts/run.sh", "#!/bin/sh\necho hi\n"],
			["docs/notes.md", "notes\n"],
		];
		for (const [rel, content] of files) {
			fs.mkdirSync(path.dirname(path.join(a, rel)), { recursive: true });
			fs.writeFileSync(path.join(a, rel), content);
		}
		for (const [rel, content] of [...files].reverse()) {
			fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true });
			fs.writeFileSync(path.join(b, rel), content);
		}
		expect(digestSkillDir(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(digestSkillDir(a)).toBe(digestSkillDir(b));
	});

	it("changes when content, a name, the executable bit, a symlink target, or the file set changes", () => {
		const dir = skillCopy();
		const seen = new Set([digestSkillDir(dir)]);
		const changed = (what: string) => {
			const next = digestSkillDir(dir);
			expect(seen.has(next), what).toBe(false);
			seen.add(next);
		};
		fs.appendFileSync(path.join(dir, "SKILL.md"), "one more line\n");
		changed("content");
		fs.renameSync(path.join(dir, "scripts", "release.sh"), path.join(dir, "scripts", "ship.sh"));
		changed("rename");
		fs.chmodSync(path.join(dir, "scripts", "ship.sh"), 0o644);
		changed("executable bit");
		fs.writeFileSync(path.join(dir, "extra.md"), "x\n");
		changed("added file");
		fs.symlinkSync("SKILL.md", path.join(dir, "link"));
		changed("added symlink");
		fs.unlinkSync(path.join(dir, "link"));
		fs.symlinkSync("extra.md", path.join(dir, "link"));
		changed("symlink target");
		fs.rmSync(path.join(dir, "extra.md"));
		changed("removed file");
	});

	it("ignores an empty directory, which git cannot carry", () => {
		const dir = skillCopy();
		const before = digestSkillDir(dir);
		fs.mkdirSync(path.join(dir, "empty"));
		expect(digestSkillDir(dir)).toBe(before);
	});

	it("refuses a special file and a directory beyond the limits", () => {
		const dir = skillCopy();
		const fifo = path.join(dir, "pipe");
		execFileSync("mkfifo", [fifo]);
		expect(() => digestSkillDir(dir)).toThrow(/special file/);
		fs.rmSync(fifo);
		expect(() => digestSkillDir(dir, { maxFiles: 1 })).toThrow(/more than 1 files/);
		expect(() => digestSkillDir(dir, { maxBytes: 10 })).toThrow(/more than 10 bytes/);
		expect(() => digestSkillDir(path.join(dir, "missing"))).toThrow();
	});

	it("lists scripts: files under scripts/ and executable files elsewhere", () => {
		const dir = skillCopy();
		fs.writeFileSync(path.join(dir, "tool.py"), "print(1)\n");
		fs.chmodSync(path.join(dir, "tool.py"), 0o755);
		fs.writeFileSync(path.join(dir, "scripts", "helper.txt"), "data\n");
		expect(listScripts(dir)).toEqual(["scripts/helper.txt", "scripts/release.sh", "tool.py"]);
		expect(digestFile(path.join(dir, "tool.py"))).toMatch(/^sha256:[0-9a-f]{64}$/);
	});
});

describe("signature", () => {
	const text = `${JSON.stringify(manifestOf([]), null, 2)}\n`;

	it("verifies against the signing key and no other", () => {
		const signature = signManifest(text, KEYS.privateKeyPem);
		expect(verifyManifestSignature(text, signature, [KEYS.publicKeyPem])).toBe(true);
		expect(verifyManifestSignature(text, signature, [OTHER_KEYS.publicKeyPem])).toBe(false);
		expect(verifyManifestSignature(text, signature, [OTHER_KEYS.publicKeyPem, KEYS.publicKeyPem])).toBe(true);
	});

	it("rejects a changed byte and a malformed signature", () => {
		const signature = signManifest(text, KEYS.privateKeyPem);
		expect(verifyManifestSignature(text.replace("[]", "[ ]"), signature, [KEYS.publicKeyPem])).toBe(false);
		expect(verifyManifestSignature(text, "not base64!", [KEYS.publicKeyPem])).toBe(false);
		expect(verifyManifestSignature(text, signature, ["not a key"])).toBe(false);
	});
});

describe("manifest validation", () => {
	const valid = () => manifestOf([approve(skillCopy(), "deploy-helper")]);
	const parse = (value: unknown) => () => parseManifest(JSON.stringify(value));

	it("accepts a well-formed manifest", () => {
		const manifest = valid();
		expect(parseManifest(JSON.stringify(manifest)).skills[0]!.name).toBe("deploy-helper");
	});

	it("rejects each malformed field with a reason naming it", () => {
		const base = valid();
		const skill = base.skills[0]!;
		expect(parse({ ...base, schema: "other@1" })).toThrow(/schema/);
		expect(parse({ ...base, skills: [{ ...skill, digest: "sha256:abc" }] })).toThrow(/digest/);
		for (const name of ["a/b", "a\\b", "deploy*", "../x", " lead", ""]) {
			expect(parse({ ...base, skills: [{ ...skill, name }] })).toThrow(/name/);
		}
		expect(parse({ ...base, skills: [skill, skill] })).toThrow(/duplicate/);
		expect(parse({ ...base, revoked: ["deploy-helper"] })).toThrow(/revoked/);
		expect(parse({ ...base, skills: [{ ...skill, owner: "" }] })).toThrow(/owner/);
		expect(parse({ ...base, skills: [{ ...skill, scripts: { "../evil.sh": skill.digest } }] })).toThrow(/script/);
		expect(parse({ ...base, expiresAt: "2001-01-01T00:00:00Z" })).toThrow(/expired/);
		expect(() => parseManifest("{not json")).toThrow(/JSON/);
	});
});

describe("trusted manifest loading", () => {
	it("loads a manifest signed by a trusted key, given as PEM text or as a key file", () => {
		const dir = tempDir("sg-trust-");
		const signed = writeManifest(dir, manifestOf([]));
		const keyFile = path.join(dir, "ci.pub.pem");
		fs.writeFileSync(keyFile, KEYS.publicKeyPem);
		for (const key of [KEYS.publicKeyPem, keyFile]) {
			const loaded = loadTrustedManifest({ manifest: signed.manifest, publicKeys: [key] });
			expect(loaded.ok).toBe(true);
		}
	});

	it("names the problem when the manifest cannot be trusted", () => {
		const dir = tempDir("sg-trust-");
		const signed = writeManifest(dir, manifestOf([]));
		const reason = (options: TrustedManifestOptions) => {
			const loaded = loadTrustedManifest(options);
			return loaded.ok ? "ok" : loaded.reason;
		};
		expect(reason({ publicKeys: [KEYS.publicKeyPem] })).toMatch(/no manifest/);
		expect(reason({ manifest: path.join(dir, "missing.json"), publicKeys: [KEYS.publicKeyPem] })).toMatch(/not found/);
		expect(reason({ manifest: signed.manifest, publicKeys: [] })).toMatch(/public key/);
		expect(reason({ manifest: signed.manifest, publicKeys: [OTHER_KEYS.publicKeyPem] })).toMatch(/signature/);
		fs.rmSync(signed.signature);
		expect(reason({ manifest: signed.manifest, publicKeys: [KEYS.publicKeyPem] })).toMatch(/signature/);
	});
});
