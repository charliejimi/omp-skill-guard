// The approval manifest: which skills CI approved, pinned to a digest of each skill directory and
// signed with an Ed25519 key that only CI holds. Nothing here imports omp.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const MANIFEST_SCHEMA = "omp-skill-guard/manifest@1";

export interface ApprovedSkill {
	/** The name omp resolves the skill by (`skill://<name>`, `/skill:<name>`). */
	name: string;
	/** `sha256:` digest of the whole skill directory; see {@link digestSkillDir}. */
	digest: string;
	/** Each script's `sha256:` digest, keyed by its POSIX path inside the skill directory. */
	scripts: Record<string, string>;
	/** Where the skill came from: a repository URL or package name. */
	source: string;
	/** The commit, tag, or version that was reviewed. */
	commit: string;
	/** The named owner (a team or role) who approved it. */
	owner: string;
	/** Where the skill sits in the repository. Informational; matching uses the name and digest. */
	path?: string;
}

export interface Manifest {
	schema: typeof MANIFEST_SCHEMA;
	issuedAt: string;
	expiresAt?: string;
	skills: ApprovedSkill[];
	/** Names whose approval was withdrawn. */
	revoked: string[];
}

export class ManifestError extends Error {}
export class SkillDigestError extends Error {}

export interface DigestLimits {
	maxFiles: number;
	maxBytes: number;
	maxDepth: number;
}

export const DEFAULT_DIGEST_LIMITS: DigestLimits = { maxFiles: 10_000, maxBytes: 64 * 1024 * 1024, maxDepth: 32 };

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const ED25519_SIGNATURE_BYTES = 64;

/** Letters, digits, `.`, `_`, `:`, `-`; no path separators, glob characters, or `..`. */
export function isValidSkillName(name: unknown): name is string {
	return typeof name === "string" && SKILL_NAME.test(name) && !name.includes("..");
}

function sha256(data: string | Uint8Array): string {
	return crypto.createHash("sha256").update(data).digest("hex");
}

interface DirEntry {
	rel: string;
	abs: string;
	stat: fs.Stats;
}

/** Every file and symlink under `dir`, sorted by POSIX path. Throws on a special file or beyond the limits. */
function walk(dir: string, limits: DigestLimits): DirEntry[] {
	const entries: DirEntry[] = [];
	let bytes = 0;
	const visit = (abs: string, rel: string, depth: number) => {
		if (depth > limits.maxDepth) throw new SkillDigestError(`nested deeper than ${limits.maxDepth} directories`);
		for (const name of fs.readdirSync(abs)) {
			const childAbs = path.join(abs, name);
			const childRel = rel ? `${rel}/${name}` : name;
			const stat = fs.lstatSync(childAbs);
			if (stat.isDirectory()) {
				visit(childAbs, childRel, depth + 1);
				continue;
			}
			if (!stat.isFile() && !stat.isSymbolicLink()) throw new SkillDigestError(`${JSON.stringify(childRel)} is a special file`);
			if (entries.length >= limits.maxFiles) throw new SkillDigestError(`more than ${limits.maxFiles} files`);
			if (stat.isFile()) {
				bytes += stat.size;
				if (bytes > limits.maxBytes) throw new SkillDigestError(`more than ${limits.maxBytes} bytes`);
			}
			entries.push({ rel: childRel, abs: childAbs, stat });
		}
	};
	visit(dir, "", 0);
	return entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/**
 * The `sha256:` digest of a skill directory: each regular file's path, executable bit, and content
 * hash, and each symlink's path and target, in path order. Directories are not recorded, so an
 * empty directory, which git cannot carry, does not change it.
 */
export function digestSkillDir(dir: string, limits: Partial<DigestLimits> = {}): string {
	const lines = walk(dir, { ...DEFAULT_DIGEST_LIMITS, ...limits }).map(({ rel, abs, stat }) =>
		stat.isSymbolicLink()
			? `l ${JSON.stringify(rel)} ${sha256(fs.readlinkSync(abs))}`
			: `f ${(stat.mode & 0o111) !== 0 ? "x" : "-"} ${JSON.stringify(rel)} ${sha256(fs.readFileSync(abs))}`,
	);
	return `sha256:${sha256(lines.join("\n"))}`;
}

/** The `sha256:` digest of one regular file. */
export function digestFile(file: string): string {
	const stat = fs.lstatSync(file);
	if (!stat.isFile()) throw new SkillDigestError(`${path.basename(file)} is not a regular file`);
	return `sha256:${sha256(fs.readFileSync(file))}`;
}

/** Whether a path inside a skill directory counts as a script: under `scripts/`, or executable. */
export function isScript(rel: string, stat: fs.Stats): boolean {
	return stat.isFile() && (rel.startsWith("scripts/") || (stat.mode & 0o111) !== 0);
}

/** The skill's scripts, as POSIX paths relative to `dir`. */
export function listScripts(dir: string, limits: Partial<DigestLimits> = {}): string[] {
	return walk(dir, { ...DEFAULT_DIGEST_LIMITS, ...limits })
		.filter(entry => isScript(entry.rel, entry.stat))
		.map(entry => entry.rel);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRelativeScriptPath(rel: string): boolean {
	if (rel.length === 0 || rel.includes("\\") || rel.includes("\0") || rel.startsWith("/")) return false;
	return rel.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..");
}

function requiredText(value: unknown, what: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new ManifestError(`${what} is missing`);
	return value;
}

function parseSkill(value: unknown): ApprovedSkill {
	if (!isRecord(value)) throw new ManifestError("every skill entry must be an object");
	if (!isValidSkillName(value.name)) {
		throw new ManifestError(`skill name ${JSON.stringify(value.name)} is not valid (letters, digits, ".", "_", ":", "-")`);
	}
	const name = value.name;
	if (typeof value.digest !== "string" || !DIGEST.test(value.digest)) {
		throw new ManifestError(`${name}: digest must be sha256:<64 lowercase hex>`);
	}
	if (!isRecord(value.scripts)) throw new ManifestError(`${name}: scripts must be an object`);
	const scripts: Record<string, string> = {};
	for (const [rel, digest] of Object.entries(value.scripts)) {
		if (!isRelativeScriptPath(rel)) throw new ManifestError(`${name}: script path ${JSON.stringify(rel)} is not a relative path`);
		if (typeof digest !== "string" || !DIGEST.test(digest)) throw new ManifestError(`${name}: script ${rel} has no valid digest`);
		scripts[rel] = digest;
	}
	const skill: ApprovedSkill = {
		name,
		digest: value.digest,
		scripts,
		source: requiredText(value.source, `${name}: source`),
		commit: requiredText(value.commit, `${name}: commit`),
		owner: requiredText(value.owner, `${name}: owner`),
	};
	if (typeof value.path === "string") skill.path = value.path;
	return skill;
}

function timestamp(value: unknown, what: string): string {
	if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new ManifestError(`${what} must be an ISO date`);
	return value;
}

/** Parses and validates a manifest; throws {@link ManifestError} naming the first problem. */
export function parseManifest(text: string, now: Date = new Date()): Manifest {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		throw new ManifestError(`not valid JSON (${err instanceof Error ? err.message : String(err)})`);
	}
	if (!isRecord(raw)) throw new ManifestError("not a JSON object");
	if (raw.schema !== MANIFEST_SCHEMA) throw new ManifestError(`schema must be "${MANIFEST_SCHEMA}"`);
	const issuedAt = timestamp(raw.issuedAt, "issuedAt");
	const expiresAt = raw.expiresAt === undefined ? undefined : timestamp(raw.expiresAt, "expiresAt");
	if (expiresAt !== undefined && Date.parse(expiresAt) <= now.getTime()) throw new ManifestError(`manifest expired at ${expiresAt}`);
	if (!Array.isArray(raw.skills)) throw new ManifestError("skills must be an array");
	const skills = raw.skills.map(parseSkill);
	const names = new Set<string>();
	for (const skill of skills) {
		if (names.has(skill.name)) throw new ManifestError(`duplicate skill name ${skill.name}`);
		names.add(skill.name);
	}
	const revokedRaw = raw.revoked ?? [];
	if (!Array.isArray(revokedRaw) || !revokedRaw.every(isValidSkillName)) throw new ManifestError("revoked must be a list of skill names");
	for (const name of revokedRaw) {
		if (names.has(name)) throw new ManifestError(`${name} is both approved and revoked`);
	}
	return { schema: MANIFEST_SCHEMA, issuedAt, ...(expiresAt ? { expiresAt } : {}), skills, revoked: [...revokedRaw] };
}

/** A detached Ed25519 signature over the manifest's exact bytes, base64-encoded. */
export function signManifest(content: string | Uint8Array, privateKeyPem: string): string {
	return crypto.sign(null, Buffer.from(content), crypto.createPrivateKey(privateKeyPem)).toString("base64");
}

/** Whether `signature` is a valid Ed25519 signature of `content` by any of the given public keys. */
export function verifyManifestSignature(content: string | Uint8Array, signature: string, publicKeyPems: readonly string[]): boolean {
	const encoded = signature.trim();
	if (!BASE64.test(encoded)) return false;
	const bytes = Buffer.from(encoded, "base64");
	if (bytes.length !== ED25519_SIGNATURE_BYTES) return false;
	const data = Buffer.from(content);
	for (const pem of publicKeyPems) {
		try {
			const key = crypto.createPublicKey(pem);
			if (key.asymmetricKeyType === "ed25519" && crypto.verify(null, data, key, bytes)) return true;
		} catch {}
	}
	return false;
}

export function generateKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
	const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
	return {
		privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
		publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
	};
}

/** Public keys given as PEM text or as paths to PEM files; unreadable files are skipped. */
export function resolvePublicKeys(entries: readonly string[]): string[] {
	const keys: string[] = [];
	for (const entry of entries) {
		if (entry.trimStart().startsWith("-----BEGIN")) {
			keys.push(entry);
			continue;
		}
		try {
			keys.push(fs.readFileSync(entry, "utf8"));
		} catch {}
	}
	return keys;
}

export interface TrustedManifestOptions {
	manifest?: string;
	/** `<manifest>.sig` when omitted. */
	signature?: string;
	/** PEM text or paths to PEM files. */
	publicKeys?: readonly string[];
	now?: Date;
}

export type TrustedManifest = { ok: true; manifest: Manifest } | { ok: false; reason: string };

/** The manifest, if its signature verifies against a trusted key and it is valid and unexpired. */
export function loadTrustedManifest(options: TrustedManifestOptions): TrustedManifest {
	if (!options.manifest) return { ok: false, reason: "no manifest is configured" };
	const keys = resolvePublicKeys(options.publicKeys ?? []);
	if (keys.length === 0) return { ok: false, reason: "no trusted public key is configured" };
	let text: string;
	try {
		text = fs.readFileSync(options.manifest, "utf8");
	} catch {
		return { ok: false, reason: `manifest not found (${path.basename(options.manifest)})` };
	}
	let signature: string;
	try {
		signature = fs.readFileSync(options.signature ?? `${options.manifest}.sig`, "utf8");
	} catch {
		return { ok: false, reason: "the manifest's signature file was not found" };
	}
	if (!verifyManifestSignature(text, signature, keys)) {
		return { ok: false, reason: "the manifest's signature does not verify against a trusted public key" };
	}
	try {
		return { ok: true, manifest: parseManifest(text, options.now) };
	} catch (err) {
		return { ok: false, reason: `the manifest was rejected: ${err instanceof Error ? err.message : String(err)}` };
	}
}

export type ApprovalRule = "approved" | "not-approved" | "modified" | "revoked" | "no-manifest";

/** How a skill with this name and current directory digest stands against the manifest. */
export function approvalRule(name: string, digest: string, manifest: Manifest | undefined): ApprovalRule {
	if (!manifest) return "no-manifest";
	if (manifest.revoked.includes(name)) return "revoked";
	const approved = manifest.skills.find(skill => skill.name === name);
	if (!approved) return "not-approved";
	return approved.digest === digest ? "approved" : "modified";
}
