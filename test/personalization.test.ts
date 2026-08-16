import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import {
	access,
	link,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rename,
	rm,
	symlink,
	truncate,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	createPersonalizationSnapshot,
	hashTree,
	MAX_RESOURCE_FILE_BYTES,
	resolvePackageSpecs,
	sanitizeModels,
	sanitizeSettings,
	scanResourceContent,
	syncOptions,
} from "../src/personalization.ts";

const exec = promisify(execFile);

const resourcePolicy = {
	settings: false,
	models: false,
	packages: false,
	skills: true,
	prompts: false,
	themes: false,
	extensions: false,
	sessions: "managed" as const,
};

const extensionPolicy = {
	...resourcePolicy,
	skills: false,
	extensions: true,
};

const safePolicy = {
	settings: true,
	models: true,
	packages: false,
	skills: false,
	prompts: false,
	themes: false,
	extensions: false,
	sessions: "managed" as const,
};

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function createNativePackage(
	agent: string,
	name: string,
): Promise<string> {
	const packageRoot = join(agent, "npm", "node_modules", name);
	await mkdir(packageRoot, { recursive: true });
	await writeFile(
		join(packageRoot, "package.json"),
		JSON.stringify({
			name,
			dependencies: { "better-sqlite3": "^12.0.0" },
		}),
	);
	return packageRoot;
}

test("npm and git package specs cross the platform boundary", () => {
	const result = resolvePackageSpecs([
		"npm:example@1.2.3",
		"npm:@scope/pkg@2.0.0-beta.1",
		"npm:latest-package",
		"git:github.com/obra/superpowers",
		"git:https://example.com/owner/repo",
		"../../Development/Personal/headroom/integrations/pi-extension",
	]);
	assert.deepEqual(result.value, [
		"npm:example@1.2.3",
		"npm:@scope/pkg@2.0.0-beta.1",
		"npm:latest-package",
		"git:github.com/obra/superpowers",
		"git:https://example.com/owner/repo",
	]);
	assert.equal(result.warnings.length, 1);
	assert.match(result.warnings[0] ?? "", /host path/);
});

test("git package specs fail closed against Pi's parser without echoing rejections", async () => {
	const acceptedGit = [
		{
			source: "git:github.com/obra/superpowers",
			host: "github.com",
			path: "obra/superpowers",
		},
		{
			source: "git:github.com/DietrichGebert/ponytail",
			host: "github.com",
			path: "DietrichGebert/ponytail",
		},
		{
			source: "git:example.com/Owner/repo",
			host: "example.com",
			path: "Owner/repo",
		},
		{
			source: "git:example.com/owner/Repo",
			host: "example.com",
			path: "owner/Repo",
		},
		{
			source: "git:example.com/Owner/Repo@FeatureRef",
			host: "example.com",
			path: "Owner/Repo",
			ref: "FeatureRef",
		},
		{
			source: "git:https://example.com/Owner/Repo.git@FeatureRef",
			host: "example.com",
			path: "Owner/Repo",
			ref: "FeatureRef",
		},
		{
			source: "git:git@example.com:Owner/Repo.git@FeatureRef",
			host: "example.com",
			path: "Owner/Repo",
			ref: "FeatureRef",
		},
		{
			source: "git:https://example.com/owner/repo",
			host: "example.com",
			path: "owner/repo",
		},
		{
			source: "git:http://example.com/owner/repo.git",
			host: "example.com",
			path: "owner/repo",
		},
		{
			source: "git:git://example.com/owner/repo.git@v1.2.3",
			host: "example.com",
			path: "owner/repo",
			ref: "v1.2.3",
		},
		{
			source: "git:ssh://example.com/owner/repo@feature",
			host: "example.com",
			path: "owner/repo",
			ref: "feature",
		},
		{
			source: "git:git@example.com:owner/repo.git@feature",
			host: "example.com",
			path: "owner/repo",
			ref: "feature",
		},
		{
			source: "git:codeberg.org/owner/repo@feature",
			host: "codeberg.org",
			path: "owner/repo",
			ref: "feature",
		},
		{
			source: "git:gitlab.com/group/repo@main",
			host: "gitlab.com",
			path: "group/repo",
			ref: "main",
		},
		{
			source: "git:github.com/obra/superpowers.git@release-1",
			host: "github.com",
			path: "obra/superpowers",
			ref: "release-1",
		},
	];
	const accepted = [
		"npm:example@1.2.3",
		"npm:@scope/pkg@2.0.0-beta.1",
		...acceptedGit.map(({ source }) => source),
	];
	const rejected = [
		"NPM:example",
		"NpM:@scope/pkg@1.0.0",
		"git:example.com/foo/../..",
		"git:example.com/owner/./repo",
		"git:git@example.com:owner/../repo",
		"git:git@example.com:owner/./repo",
		"git:https://example.com/owner/../repo",
		"git:ssh://example.com/owner/./repo",
		"git:example.com/owner/...git",
		"git:example.com/owner/.git",
		"git:example.com/.git",
		"git:example.com/owner/repo/..git",
		"git:example.com/owner/repo.git.git",
		"git:example.com/owner/repo.git.git.git@main",
		"git:git@example.com:owner/repo.git.git",
		"git:https://example.com/owner/repo.git.git@main",
		"git:git@example.com:owner/...git",
		"git:git@example.com:owner/.git",
		"git:git@example.com:.git",
		"git:https://example.com/owner/...git",
		"git:https://example.com/owner/.git",
		"git:https://example.com/.git",
		"git:example.com/owner/%2e%2e/repo",
		"git:example.com/owner%2Frepo/package",
		"git:example.com/owner/repo%00",
		"git:example.com/owner/repo%5Csecret",
		"git:github.com/owner/repo/tree/main",
		"git:https://bitbucket.org/owner/repo/src/main",
		"git:git://git.sr.ht/owner/repo/tree/main",
		"git:ssh://gist.github.com/owner/repo/raw/main",
		"git:git@gitlab.com:group/subgroup/repo",
		"git:https://gitlab.com/group/repo/-/tree/main",
		"git:example.com/owner/repo/extra",
		"git:git@example.com:owner/repo/extra",
		"git:https://example.com/owner/repo/extra",
		"git:example.com/repo",
		"git:Example.com/owner/repo",
		"git:git@Example.com:owner/repo",
		"git:https://Example.com/owner/repo",
		"git:www.github.com/owner/repo",
		"git:www.gitlab.com/owner/repo",
		"git:www.bitbucket.org/owner/repo",
		"git:https://www.github.com/owner/repo",
		"git:https://www.gitlab.com/owner/repo",
		"git:https://www.bitbucket.org/owner/repo",
		"git:git@www.github.com:owner/repo",
		"git:git@www.gitlab.com:owner/repo",
		"git:git@www.bitbucket.org:owner/repo",
		"git:https://example.com/repo",
		"git:git@example.com:repo",
		"git:example.com//repo",
		"git:example.com/owner//repo",
		"git:git@example.com:/owner/repo",
		"GIT:example.com/owner/repo",
		"Git:example.com/owner/repo",
		"git:HTTPS://example.com/owner/repo",
		"git:Http://example.com/owner/repo",
		"git:http://user@example.com/owner/repo",
		"git:https://user@example.com/owner/repo",
		"git:https://user:password@example.com/owner/repo",
		"git:https://example.com:443/owner/repo",
		"git:https://0x7f.1/owner/repo",
		"git:https://127.1/owner/repo",
		"git:https://999.999/owner/repo",
		"git:https://256.256.256.256/owner/repo",
		"git:https://[example.com/owner/repo",
		"git:https://safe.example\\user:password@evil.example/owner/repo",
		"git:git://user@example.com/owner/repo",
		"git:ssh://git@example.com/owner/repo",
		"git:https://example.com/owner/\u001b[31mrepo",
		"git:https://example.com/owner/\u0007repo",
		"git:https://example.com/owner/\u0085repo",
		"git:https://example.com/owner/\u007frepo",
		"git:https://example.com/owner/\u202erepo",
		"git:https://example.com/owner/repo?token=secret-value",
		"git:example.com/owner/repo@feature/main",
		"git:https://example.com/owner/repo@feature/main",
		"git:git@example.com:owner/repo@feature/main",
		"git:gitlab.com/owner/repo@feature/main",
		"git:https://gitlab.com/owner/repo@feature/main",
		"git:git@gitlab.com:owner/repo@feature/main",
		"git:example.com/owner/repo@",
		"git:example.com/owner/repo@@main",
		"git:example.com/owner/repo#v1.0.0",
		"git:git@example.com:owner/repo#main",
		"git:https://example.com/owner/repo#feature/main",
	];
	const result = resolvePackageSpecs([...accepted, ...rejected, accepted[0]]);
	assert.deepEqual(result.value, accepted);
	assert.equal(result.warnings.length, rejected.length);
	for (const [offset, source] of rejected.entries()) {
		assert.equal(result.value.includes(source), false);
		assert.equal(result.warnings.join("\n").includes(source), false);
		assert.equal(
			result.warnings[offset],
			`settings.packages[${accepted.length + offset}]: unsafe remote package spec not imported`,
		);
	}
	assert.equal(
		/[\u0000-\u001f\u007f-\u009f]/u.test(result.warnings.join("")),
		false,
	);
	assert.equal(result.warnings.join("\n").includes("secret-value"), false);

	const piIndex = import.meta.resolve("@earendil-works/pi-coding-agent");
	const piPackage = JSON.parse(
		await readFile(new URL("../package.json", piIndex), "utf8"),
	) as { version?: string };
	assert.equal(piPackage.version, "0.84.1");
	type ParsedGit = {
		type: string;
		host: string;
		path: string;
		ref?: string;
	};
	const { parseGitUrl } = (await import(
		new URL("./utils/git.js", piIndex).href
	)) as { parseGitUrl(source: string): ParsedGit | null };
	for (const fixture of acceptedGit) {
		const parsed = parseGitUrl(fixture.source);
		assert.notEqual(parsed, null, fixture.source);
		assert.equal(parsed?.type, "git", fixture.source);
		assert.equal(parsed?.host, fixture.host, fixture.source);
		assert.equal(parsed?.path, fixture.path, fixture.source);
		assert.equal(parsed?.ref, fixture.ref, fixture.source);
	}
});

test("snapshot collapses settings-key and host-path skips", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-collapse-"));
	const agent = join(root, "agent");
	const destination = join(root, "snapshot");
	await mkdir(agent);
	await writeFile(
		join(agent, "settings.json"),
		JSON.stringify({
			theme: "dark",
			subagents: {},
			lastChangelogVersion: "1",
			packages: ["npm:pi-subagents", "../../Development/Personal/headroom"],
		}),
	);
	const snapshot = await createPersonalizationSnapshot(
		agent,
		destination,
		"mirror",
	);
	assert.equal(
		snapshot.warnings.includes("settings.subagents: not imported"),
		false,
	);
	assert.ok(
		snapshot.warnings.some((warning) =>
			/^skipped 2 settings keys$/.test(warning),
		),
	);
	assert.ok(
		snapshot.warnings.some((warning) =>
			/^skipped 1 host-path packages$/.test(warning),
		),
	);
	await rm(root, { recursive: true, force: true });
});

test("snapshot collapses every resource-scan secret warning only", async () => {
	for (const count of [1, 2]) {
		const root = await mkdtemp(join(tmpdir(), "pi-dsbx-secret-collapse-"));
		const agent = join(root, "agent");
		const destination = join(root, "snapshot");
		await mkdir(join(agent, "skills"), { recursive: true });
		await writeFile(
			join(agent, "settings.json"),
			JSON.stringify({ subagents: {} }),
		);
		for (let index = 0; index < count; index++)
			await writeFile(
				join(agent, "skills", `secret-${index}.txt`),
				"Authorization: Bearer host-secret-value\n",
			);
		const snapshot = await createPersonalizationSnapshot(
			agent,
			destination,
			"custom",
			{ ...resourcePolicy, settings: true },
		);
		assert.ok(
			snapshot.warnings.includes(
				`skipped ${count} secret-bearing files during custom sync`,
			),
		);
		assert.ok(snapshot.warnings.includes("skipped 1 settings keys"));
		assert.equal(
			snapshot.warnings.some((warning) => warning.includes("secret-0.txt")),
			false,
		);
		await rm(root, { recursive: true, force: true });
	}
});

test("mirror skips native npm packages and copies their skills", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-native-pkg-"));
	const agent = join(root, "agent");
	const destination = join(root, "snapshot");
	await mkdir(
		join(agent, "npm", "node_modules", "context-mode", "skills", "ctx-doctor"),
		{
			recursive: true,
		},
	);
	await writeFile(
		join(agent, "npm", "node_modules", "context-mode", "package.json"),
		JSON.stringify({
			name: "context-mode",
			dependencies: { "better-sqlite3": "^12.0.0" },
			pi: { skills: ["./skills"] },
		}),
	);
	await writeFile(
		join(
			agent,
			"npm",
			"node_modules",
			"context-mode",
			"skills",
			"ctx-doctor",
			"SKILL.md",
		),
		"# ctx-doctor\n",
	);
	await writeFile(
		join(agent, "settings.json"),
		JSON.stringify({
			theme: "dark",
			packages: [
				"npm:context-mode",
				"npm:pi-subagents",
				"git:github.com/obra/superpowers",
			],
		}),
	);
	const snapshot = await createPersonalizationSnapshot(
		agent,
		destination,
		"mirror",
	);
	const settings = JSON.parse(
		await readFile(join(destination, "settings.json"), "utf8"),
	);
	assert.deepEqual(settings.packages, [
		"npm:pi-subagents",
		"git:github.com/obra/superpowers",
	]);
	assert.equal(settings.theme, "dark");
	assert.equal(
		snapshot.warnings.includes("settings.packages: not imported"),
		false,
	);
	assert.ok(
		snapshot.warnings.some(
			(warning) => warning === "skipped 1 native packages (no compiler)",
		),
	);
	assert.equal(
		await readFile(
			join(destination, "skills", "ctx-doctor", "SKILL.md"),
			"utf8",
		),
		"# ctx-doctor\n",
	);
	await rm(root, { recursive: true, force: true });
});

test("mirror merges ordinary host skills with native fallback skills", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-native-host-skills-"));
	const agent = join(root, "agent");
	const destination = join(root, "snapshot");
	await mkdir(join(agent, "skills", "host-skill"), { recursive: true });
	await writeFile(
		join(agent, "skills", "host-skill", "SKILL.md"),
		"# host skill\n",
	);
	await mkdir(
		join(agent, "npm", "node_modules", "context-mode", "skills", "ctx-doctor"),
		{ recursive: true },
	);
	await writeFile(
		join(agent, "npm", "node_modules", "context-mode", "package.json"),
		JSON.stringify({
			name: "context-mode",
			dependencies: { "better-sqlite3": "^12.0.0" },
		}),
	);
	await writeFile(
		join(
			agent,
			"npm",
			"node_modules",
			"context-mode",
			"skills",
			"ctx-doctor",
			"SKILL.md",
		),
		"# ctx-doctor\n",
	);
	await writeFile(
		join(agent, "settings.json"),
		JSON.stringify({ packages: ["npm:context-mode"] }),
	);

	await createPersonalizationSnapshot(agent, destination, "mirror");

	assert.equal(
		await readFile(
			join(destination, "skills", "host-skill", "SKILL.md"),
			"utf8",
		),
		"# host skill\n",
	);
	assert.equal(
		await readFile(
			join(destination, "skills", "ctx-doctor", "SKILL.md"),
			"utf8",
		),
		"# ctx-doctor\n",
	);

	await mkdir(join(agent, "skills", "ctx-doctor"));
	await writeFile(
		join(agent, "skills", "ctx-doctor", "SKILL.md"),
		"# colliding host skill\n",
	);
	await assert.rejects(
		() =>
			createPersonalizationSnapshot(
				agent,
				join(root, "collision-snapshot"),
				"mirror",
			),
		/destination collision/i,
	);
	await rm(root, { recursive: true, force: true });
});

test("native fallback skill collisions fail closed", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-native-collision-"));
	const agent = join(root, "agent");
	for (const name of ["first-native", "second-native"]) {
		const packageRoot = await createNativePackage(agent, name);
		await mkdir(join(packageRoot, "skills", "shared-skill"), {
			recursive: true,
		});
		await writeFile(
			join(packageRoot, "skills", "shared-skill", "SKILL.md"),
			`# ${name}\n`,
		);
	}
	await writeFile(
		join(agent, "settings.json"),
		JSON.stringify({
			packages: ["npm:first-native", "npm:second-native"],
		}),
	);

	await assert.rejects(
		() =>
			createPersonalizationSnapshot(agent, join(root, "snapshot"), "mirror"),
		/destination collision/i,
	);
	await rm(root, { recursive: true, force: true });
});

test("native fallback skill symlinks fail closed", async () => {
	for (const kind of ["root", "entry"] as const) {
		const root = await mkdtemp(join(tmpdir(), `pi-dsbx-native-${kind}-link-`));
		const agent = join(root, "agent");
		const packageRoot = await createNativePackage(agent, "linked-native");
		const target = join(root, "linked-skills");
		await mkdir(join(target, "linked-skill"), { recursive: true });
		await writeFile(join(target, "linked-skill", "SKILL.md"), "# linked\n");
		if (kind === "root") await symlink(target, join(packageRoot, "skills"));
		else {
			await mkdir(join(packageRoot, "skills"));
			await symlink(
				join(target, "linked-skill"),
				join(packageRoot, "skills", "linked-skill"),
			);
		}
		await writeFile(
			join(agent, "settings.json"),
			JSON.stringify({ packages: ["npm:linked-native"] }),
		);

		await assert.rejects(
			() =>
				createPersonalizationSnapshot(agent, join(root, "snapshot"), "mirror"),
			/symbolic link/i,
		);
		await rm(root, { recursive: true, force: true });
	}
});

test("native fallback skills root must be a directory", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-native-skills-file-"));
	const agent = join(root, "agent");
	const packageRoot = await createNativePackage(agent, "file-skills-native");
	await writeFile(join(packageRoot, "skills"), "not a directory\n");
	await writeFile(
		join(agent, "settings.json"),
		JSON.stringify({ packages: ["npm:file-skills-native"] }),
	);

	await assert.rejects(
		() =>
			createPersonalizationSnapshot(agent, join(root, "snapshot"), "mirror"),
		/non-directory resource/i,
	);
	await rm(root, { recursive: true, force: true });
});

test("native package without fallback skills remains allowed", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-native-no-skills-"));
	const agent = join(root, "agent");
	await createNativePackage(agent, "no-skills-native");
	await writeFile(
		join(agent, "settings.json"),
		JSON.stringify({
			theme: "dark",
			packages: ["npm:no-skills-native"],
		}),
	);

	const snapshot = await createPersonalizationSnapshot(
		agent,
		join(root, "snapshot"),
		"mirror",
	);
	assert.deepEqual(snapshot.nativePackages, ["npm:no-skills-native"]);
	assert.equal(await exists(join(root, "snapshot", "skills")), false);
	await rm(root, { recursive: true, force: true });
});

test("mirror keeps approved natives or defers them with fallback skills", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-native-allow-"));
	const agent = join(root, "agent");
	const destination = join(root, "snapshot");
	const deferredDestination = join(root, "deferred-snapshot");
	await mkdir(
		join(agent, "npm", "node_modules", "context-mode", "skills", "ctx-doctor"),
		{ recursive: true },
	);
	await writeFile(
		join(agent, "npm", "node_modules", "context-mode", "package.json"),
		JSON.stringify({
			name: "context-mode",
			dependencies: { "better-sqlite3": "^12.0.0" },
		}),
	);
	await writeFile(
		join(
			agent,
			"npm",
			"node_modules",
			"context-mode",
			"skills",
			"ctx-doctor",
			"SKILL.md",
		),
		"# ctx-doctor\n",
	);
	await writeFile(
		join(agent, "settings.json"),
		JSON.stringify({
			packages: [
				"npm:context-mode",
				"git:github.com/obra/superpowers",
				"npm:pi-subagents",
			],
		}),
	);
	const snapshot = await createPersonalizationSnapshot(
		agent,
		destination,
		"mirror",
		undefined,
		{ allowNativePackages: true },
	);
	const settings = JSON.parse(
		await readFile(join(destination, "settings.json"), "utf8"),
	);
	assert.deepEqual(settings.packages, [
		"npm:context-mode",
		"git:github.com/obra/superpowers",
		"npm:pi-subagents",
	]);
	assert.deepEqual(snapshot.nativePackages, ["npm:context-mode"]);
	assert.equal(
		snapshot.warnings.some((warning) => /context-mode.*native/.test(warning)),
		false,
	);

	const deferred = await createPersonalizationSnapshot(
		agent,
		deferredDestination,
		"mirror",
		undefined,
		{ deferAllPackages: true },
	);
	const deferredSettings = JSON.parse(
		await readFile(join(deferredDestination, "settings.json"), "utf8"),
	);
	assert.equal(deferredSettings.packages, undefined);
	assert.deepEqual(deferred.packageSpecs, [
		"npm:context-mode",
		"git:github.com/obra/superpowers",
		"npm:pi-subagents",
	]);
	assert.deepEqual(deferred.nativePackages, ["npm:context-mode"]);
	assert.equal(
		deferred.warnings.some((warning) => /native packages/.test(warning)),
		false,
	);
	assert.equal(
		await readFile(
			join(deferredDestination, "skills", "ctx-doctor", "SKILL.md"),
			"utf8",
		),
		"# ctx-doctor\n",
	);
	await rm(root, { recursive: true, force: true });
});

test("custom safe policy and mirror remain explicit", () => {
	assert.deepEqual(syncOptions("custom", safePolicy), safePolicy);
	assert.deepEqual(syncOptions("mirror"), {
		settings: true,
		models: true,
		packages: true,
		skills: true,
		prompts: true,
		themes: true,
		extensions: true,
		sessions: "managed",
	});
});

test("custom sync policy is explicit and independent", () => {
	const policy = syncOptions("custom", {
		settings: false,
		models: true,
		packages: false,
		skills: true,
		prompts: false,
		themes: false,
		extensions: false,
		sessions: "sandbox",
	});
	assert.equal(policy.settings, false);
	assert.equal(policy.models, true);
	assert.equal(policy.sessions, "sandbox");
	assert.throws(() => syncOptions("custom"), /requires explicit/);
});

test("settings sanitizer recursively strips normalized credential fields", () => {
	const credentialKeys = [
		"clientSecret",
		"CLIENT_SECRET",
		"client-secret",
		"secretAccessKey",
		"privateKey",
		"private_key_data",
		"passphrase",
		"token",
		"clientToken",
		"device_token",
		"nestedTokensField",
		"sessionToken",
		"auth_token",
		"id-token",
		"bearerToken",
		"access_token",
		"refresh-token",
		"oauthToken",
		"apiKey",
		"x_api_key",
		"password",
		"passwd",
		"credential",
		"credentials",
		"authorization",
		"proxy_authorization",
		"cookie",
		"set-cookie",
		"providerClientSecretValue",
		"accessKeyId",
		"awsAccessKeyId",
		"awsSecretAccessKeyValue",
		"tlsPrivateKeyDataPath",
	];
	const secret = "reviewer-credential-canary";
	const result = sanitizeSettings({
		theme: "dark",
		defaultModel: "gpt",
		retry: {
			...Object.fromEntries(
				credentialKeys.map((key, index) => [
					key,
					index === 0 ? "$SECRET_REFERENCE" : `${secret}-${index}`,
				]),
			),
			privateKey: "-----BEGIN PRIVATE KEY----- ordinary scanner miss",
			nested: {
				baseUrl: "https://user:pass@example.com/v1",
				resolver: "!security find-generic-password",
				cachePath: "/Users/example/.cache/pi",
				safe: {
					attempts: 3,
					maxTokens: 100,
					inputTokens: 20,
					outputTokens: 80,
					tokenBudget: 100,
				},
			},
		},
		npmCommand: ["evil"],
		futureSetting: "x",
	});
	assert.deepEqual(result.value, {
		theme: "dark",
		defaultModel: "gpt",
		retry: {
			nested: {
				safe: {
					attempts: 3,
					maxTokens: 100,
					inputTokens: 20,
					outputTokens: 80,
					tokenBudget: 100,
				},
			},
		},
	});
	assert.equal(JSON.stringify(result.value).includes(secret), false);
	assert.equal(
		JSON.stringify(result.value).includes("$SECRET_REFERENCE"),
		false,
	);
	assert.ok(result.warnings.every((warning) => !warning.includes(secret)));
	assert.ok(result.warnings.some((warning) => warning.includes("npmCommand")));
	assert.ok(
		result.warnings.some((warning) => warning.includes("futureSetting")),
	);
});

test("settings keep only enabledModels whose provider exists in sbx", () => {
	const result = sanitizeSettings(
		{
			enabledModels: [
				"openai-codex/gpt-5.6-sol",
				"xai/grok-4.6",
				"openrouter/deepseek/deepseek-v4-flash-0731",
			],
			defaultProvider: "openai-codex",
			defaultModel: "gpt-5.6-sol",
		},
		new Set(["xai", "openrouter", "openai-codex"]),
	);
	assert.deepEqual(result.value.enabledModels, [
		"openai-codex/gpt-5.6-sol",
		"xai/grok-4.6",
		"openrouter/deepseek/deepseek-v4-flash-0731",
	]);
	assert.equal(result.value.defaultProvider, "openai-codex");
	assert.equal(result.value.defaultModel, "gpt-5.6-sol");
});

test("models sanitizer handles normalized credentials without overbroad token rejection", () => {
	const credentialKeys = [
		"clientSecret",
		"secret_access_key",
		"private-key",
		"privateKeyData",
		"PASSPHRASE",
		"TOKEN",
		"client-token",
		"deviceToken",
		"nested_tokens_field",
		"sessionToken",
		"auth-token",
		"id_token",
		"bearerToken",
		"access-token",
		"refresh_token",
		"oauthToken",
		"api-key",
		"xApiKey",
		"password",
		"passwd",
		"credential",
		"credentials",
		"authorization",
		"proxyAuthorization",
		"cookies",
		"setCookie",
		"providerClientSecretValue",
		"access_key_id",
		"AWSAccessKeyId",
		"aws_secret_access_key_value",
		"tlsPrivateKeyDataPath",
	];
	const fake = "reviewer-model-credential-canary";
	const environmentCredentials = Object.fromEntries(
		credentialKeys.map((key, index) => [key, `$MODEL_SECRET_${index}`]),
	);
	const result = sanitizeModels({
		providers: {
			safe: {
				baseUrl: "https://api.example.com/v1",
				...environmentCredentials,
				maxTokens: 100,
				inputTokens: 20,
				outputTokens: 80,
				tokenBudget: 100,
				models: [{ id: "m" }],
			},
			literal: Object.fromEntries(
				credentialKeys.map((key, index) => [key, `${fake}-${index}`]),
			),
			pem: {
				privateKey: "-----BEGIN PRIVATE KEY----- ordinary scanner miss",
			},
			command: { apiKey: "!security find-generic-password" },
			url: { baseUrl: "https://user:password@example.com/v1" },
			headers: { headers: { "x-safe": "ok" } },
			embedded: { harmlessName: "ghp_1234567890abcdef" },
		},
	});
	const serialized = JSON.stringify(result.value);
	assert.equal(serialized.includes(fake), false);
	assert.equal(serialized.includes("BEGIN PRIVATE KEY"), false);
	assert.equal(serialized.includes("security find"), false);
	assert.equal(serialized.includes("user:password"), false);
	assert.equal(serialized.includes("ghp_1234567890abcdef"), false);
	assert.deepEqual((result.value.providers as any).safe, {
		baseUrl: "https://api.example.com/v1",
		...environmentCredentials,
		maxTokens: 100,
		inputTokens: 20,
		outputTokens: 80,
		tokenBudget: 100,
		models: [{ id: "m" }],
	});
	assert.equal((result.value.providers as any).headers.headers["x-safe"], "ok");
	assert.ok(result.warnings.every((warning) => !warning.includes(fake)));
});

test("file boundary rejects existing and replacement FIFOs without blocking", async (context) => {
	for (const name of ["settings.json", "models.json", "skills/pipe"] as const) {
		for (const replacement of [false, true]) {
			const root = await mkdtemp(
				join(tmpdir(), "pi-dsbx-profile-fifo-boundary-"),
			);
			const agent = join(root, "agent");
			const source = join(agent, name);
			await mkdir(join(agent, "skills"), { recursive: true });
			if (replacement) await writeFile(source, "{}");
			else {
				try {
					await exec("mkfifo", [source]);
				} catch {
					await rm(root, { recursive: true, force: true });
					context.skip("mkfifo unavailable");
					return;
				}
			}
			const operation = createPersonalizationSnapshot(
				agent,
				join(root, "snapshot"),
				"custom",
				name.startsWith("skills/") ? resourcePolicy : safePolicy,
				{
					testHook: async (boundary, path) => {
						const expectedPath = name.startsWith("skills/") ? "pipe" : name;
						if (
							replacement &&
							boundary === "beforeFileOpen" &&
							path === expectedPath
						) {
							await rm(source);
							await exec("mkfifo", [source]);
						}
					},
				},
			);
			await assert.rejects(
				Promise.race([
					operation,
					new Promise((_, reject) =>
						setTimeout(() => reject(new Error("FIFO open timed out")), 500),
					),
				]),
				(error: unknown) => {
					assert.doesNotMatch((error as Error).message, /timed out/);
					assert.match(
						(error as Error).message,
						new RegExp(
							`Resource ${name.startsWith("skills/") ? "pipe" : name}.*(?:non-regular file|filesystem validation failed)`,
						),
					);
					return true;
				},
			);
			assert.equal(await exists(join(root, "snapshot")), false);
			await rm(root, { recursive: true, force: true });
		}
	}
});

test("settings and models are read through the validated file boundary", async () => {
	for (const name of ["settings.json", "models.json"] as const) {
		const root = await mkdtemp(join(tmpdir(), "pi-dsbx-profile-json-race-"));
		const agent = join(root, "agent");
		const source = join(agent, name);
		await mkdir(agent);
		await writeFile(source, "{}");
		await assert.rejects(
			() =>
				createPersonalizationSnapshot(
					agent,
					join(root, "snapshot"),
					"custom",
					safePolicy,
					{
						testHook: async (boundary, path) => {
							if (boundary === "beforeFileOpen" && path === name) {
								await rm(source);
								await symlink(join(root, "outside.json"), source);
							}
						},
					},
				),
			(error: unknown) => {
				assert.equal(
					(error as Error).message,
					`Resource ${name}: filesystem validation failed`,
				);
				assert.equal((error as Error).message.includes(root), false);
				return true;
			},
		);
		assert.equal(await exists(join(root, "snapshot")), false);
		await rm(root, { recursive: true, force: true });
	}
});

test("safe default ignores resources and stages writable sanitized settings", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-profile-safe-"));
	const agent = join(root, "agent");
	const destination = join(root, "snapshot");
	await mkdir(join(agent, "skills"), { recursive: true });
	await writeFile(join(agent, "settings.json"), '{"theme":"dark"}');
	await writeFile(join(agent, "models.json"), "{}");
	await writeFile(
		join(agent, "skills", "SKILL.md"),
		"sk-test-1234567890abcdef",
	);
	const snapshot = await createPersonalizationSnapshot(
		agent,
		destination,
		"custom",
		safePolicy,
	);
	assert.deepEqual(snapshot.manifest, []);
	await assert.rejects(() => lstat(join(destination, "skills")), {
		code: "ENOENT",
	});
	assert.equal((await lstat(destination)).mode & 0o777, 0o700);
	assert.equal(
		(await lstat(join(destination, "settings.json"))).mode & 0o777,
		0o600,
	);
	await rm(root, { recursive: true, force: true });
});

test("models-store sync sanitizes nested credentials and preserves catalog metadata", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-profile-store-secrets-"));
	const agent = join(root, "agent");
	const destination = join(root, "snapshot");
	await mkdir(agent);
	const secrets = [
		"nested-token-value",
		"nested-api-key-value",
		"nested-authorization-value",
		"userinfo-password-value",
	];
	await writeFile(
		join(agent, "models-store.json"),
		JSON.stringify({
			xai: {
				checkedAt: 1,
				models: [
					{
						id: "grok-4.6",
						name: "Grok 4.6",
						contextWindow: 128_000,
						metadata: {
							token: secrets[0],
							apiKey: secrets[1],
							authorization: secrets[2],
							baseUrl: `https://catalog:${secrets[3]}@example.com/v1`,
						},
					},
				],
			},
		}),
	);

	const snapshot = await createPersonalizationSnapshot(
		agent,
		destination,
		"custom",
		safePolicy,
	);
	const store = JSON.parse(
		await readFile(join(destination, "models-store.json"), "utf8"),
	);
	assert.deepEqual(store, {
		xai: {
			checkedAt: 1,
			models: [
				{
					id: "grok-4.6",
					name: "Grok 4.6",
					contextWindow: 128_000,
					metadata: {},
				},
			],
		},
	});
	for (const secret of secrets) {
		assert.equal(JSON.stringify(store).includes(secret), false);
		assert.ok(snapshot.warnings.every((warning) => !warning.includes(secret)));
	}
	assert.ok(
		snapshot.warnings.some((warning) =>
		warning.includes("credential-bearing URL not imported"),
		),
	);
	await rm(root, { recursive: true, force: true });
});

test("safe custom sync copies models-store and oauth auth without api keys", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-profile-store-"));
	const agent = join(root, "agent");
	const destination = join(root, "snapshot");
	await mkdir(agent);
	await writeFile(
		join(agent, "models-store.json"),
		JSON.stringify({
			xai: { models: [{ id: "grok-4.6" }], checkedAt: 1 },
		}),
	);
	await writeFile(
		join(agent, "auth.json"),
		JSON.stringify({
			xai: { type: "oauth", access: "host-oauth-access", refresh: "refresh" },
			openrouter: { type: "api_key", key: "should-not-copy" },
		}),
	);
	const snapshot = await createPersonalizationSnapshot(
		agent,
		destination,
		"custom",
		safePolicy,
		{ availableProviders: new Set(["xai"]), copyOAuth: true },
	);
	const store = JSON.parse(
		await readFile(join(destination, "models-store.json"), "utf8"),
	);
	assert.deepEqual(store.xai.models, [{ id: "grok-4.6" }]);
	const auth = JSON.parse(
		await readFile(join(destination, "auth.json"), "utf8"),
	);
	assert.deepEqual(auth, {
		xai: { type: "oauth", access: "host-oauth-access", refresh: "refresh" },
	});
	assert.equal(JSON.stringify(auth).includes("should-not-copy"), false);
	assert.ok(
		snapshot.warnings.every((warning) => !warning.includes("should-not-copy")),
	);
	await rm(root, { recursive: true, force: true });
});

test("explicit resource opt-in creates deterministic byte manifest", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-profile-manifest-"));
	const agent = join(root, "agent");
	const destination = join(root, "snapshot");
	await mkdir(join(agent, "skills", "safe"), { recursive: true });
	await mkdir(join(agent, "prompts"), { recursive: true });
	await writeFile(
		join(agent, "skills", "safe", "z.bin"),
		Buffer.from([0, 255]),
	);
	await writeFile(join(agent, "skills", "safe", "SKILL.md"), "# Safe\n");
	await writeFile(join(agent, "prompts", "a.txt"), "hello\n");
	const snapshot = await createPersonalizationSnapshot(
		agent,
		destination,
		"custom",
		{
			settings: false,
			models: false,
			packages: false,
			skills: true,
			prompts: true,
			themes: false,
			extensions: false,
			sessions: "managed",
		},
	);
	assert.deepEqual(
		snapshot.manifest.map(({ resource, relativePath, bytes }) => ({
			resource,
			relativePath,
			bytes,
		})),
		[
			{ resource: "skills", relativePath: "safe/SKILL.md", bytes: 7 },
			{ resource: "skills", relativePath: "safe/z.bin", bytes: 2 },
			{ resource: "prompts", relativePath: "a.txt", bytes: 6 },
		],
	);
	for (const entry of snapshot.manifest) {
		assert.match(entry.sha256, /^[0-9a-f]{64}$/);
		const copied = await readFile(
			join(destination, entry.resource, entry.relativePath),
		);
		assert.equal(copied.byteLength, entry.bytes);
		assert.equal(
			(await import("node:crypto"))
				.createHash("sha256")
				.update(copied)
				.digest("hex"),
			entry.sha256,
		);
	}
	const profile = JSON.parse(
		await readFile(join(destination, "docker-sandboxes-profile.json"), "utf8"),
	);
	assert.deepEqual(profile.manifest, snapshot.manifest);
	await rm(root, { recursive: true, force: true });
});

test("extension sync skips runtime state that Pi cannot auto-discover", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-extension-state-"));
	const agent = join(root, "agent");
	const extensions = join(agent, "extensions");
	const runtimeState = join(extensions, "pi-permission-system");
	const validExtension = join(extensions, "valid");
	const packagedExtension = join(extensions, "packaged");
	const mixedManifest = join(extensions, "mixed-manifest");
	const traversalManifest = join(extensions, "traversal-manifest");
	await mkdir(join(runtimeState, "logs"), { recursive: true });
	await mkdir(validExtension);
	await mkdir(join(packagedExtension, "src"), { recursive: true });
	await mkdir(join(mixedManifest, "src"), { recursive: true });
	await mkdir(traversalManifest);
	await writeFile(join(runtimeState, "config.json"), "{}\n");
	const log = join(runtimeState, "logs", "permission-review.jsonl");
	await writeFile(log, "x");
	await truncate(log, MAX_RESOURCE_FILE_BYTES + 1);
	await writeFile(join(validExtension, "index.ts"), "export default () => {};\n");
	await writeFile(join(extensions, "top-level.js"), "export default () => {};\n");
	await writeFile(
		join(packagedExtension, "package.json"),
		JSON.stringify({ pi: { extensions: ["src/index.ts"] } }),
	);
	await writeFile(
		join(packagedExtension, "src", "index.ts"),
		"export default () => {};\n",
	);
	await writeFile(
		join(mixedManifest, "package.json"),
		JSON.stringify({ pi: { extensions: ["src/index.ts", 1] } }),
	);
	await writeFile(
		join(mixedManifest, "src", "index.ts"),
		"export default () => {};\n",
	);
	await writeFile(
		join(traversalManifest, "package.json"),
		JSON.stringify({ pi: { extensions: ["../valid/index.ts"] } }),
	);

	const snapshot = await createPersonalizationSnapshot(
		agent,
		join(root, "snapshot"),
		"custom",
		extensionPolicy,
	);

	assert.equal(
		await exists(join(root, "snapshot", "extensions", "pi-permission-system")),
		false,
	);
	assert.equal(
		await exists(join(root, "snapshot", "extensions", "mixed-manifest")),
		false,
	);
	assert.equal(
		await exists(join(root, "snapshot", "extensions", "traversal-manifest")),
		false,
	);
	assert.equal(
		await readFile(join(root, "snapshot", "extensions", "valid", "index.ts"), "utf8"),
		"export default () => {};\n",
	);
	assert.equal(
		await readFile(
			join(root, "snapshot", "extensions", "packaged", "src", "index.ts"),
			"utf8",
		),
		"export default () => {};\n",
	);
	assert.deepEqual(
		snapshot.manifest.map(({ relativePath }) => relativePath),
		[
			"packaged/package.json",
			"packaged/src/index.ts",
			"top-level.js",
			"valid/index.ts",
		],
	);
	assert.ok(
		snapshot.warnings.includes(
			"skipped extensions/pi-permission-system: not a Pi extension",
		),
	);
	assert.ok(
		snapshot.warnings.includes(
			"skipped extensions/mixed-manifest: not a Pi extension",
		),
	);
	assert.ok(
		snapshot.warnings.includes(
			"skipped extensions/traversal-manifest: not a Pi extension",
		),
	);
	await rm(root, { recursive: true, force: true });
});

test("discoverable extension entrypoints remain fail-closed on symlinks", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-extension-link-"));
	const agent = join(root, "agent");
	const extension = join(agent, "extensions", "linked");
	await mkdir(extension, { recursive: true });
	await symlink("/etc/passwd", join(extension, "index.ts"));
	await assert.rejects(
		() =>
			createPersonalizationSnapshot(
				agent,
				join(root, "snapshot"),
				"custom",
				extensionPolicy,
			),
		/linked\/index\.ts.*symbolic link/i,
	);
	await rm(root, { recursive: true, force: true });
});

test("extension sync rejects entrypoints removed after classification", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-extension-race-"));
	const agent = join(root, "agent");
	const extension = join(agent, "extensions", "raced");
	await mkdir(extension, { recursive: true });
	await writeFile(join(extension, "index.ts"), "export default () => {};\n");
	await writeFile(join(extension, "config.json"), "{}\n");
	await assert.rejects(
		() =>
			createPersonalizationSnapshot(
				agent,
				join(root, "snapshot"),
				"custom",
				extensionPolicy,
				{
					testHook: async (
						boundary:
							| "beforeDestinationClaim"
							| "afterDestinationClaim"
							| "beforeSnapshotWrite"
							| "beforeSnapshotCleanup"
							| "beforeFileOpen"
							| "afterFileOpen"
							| "duringFileRead"
							| "afterDirectoryEnumerate"
							| "afterExtensionClassification",
						path: string,
					) => {
						if (
							boundary === "afterExtensionClassification" &&
							path === "raced"
						)
							await rm(join(extension, "index.ts"));
					},
				},
			),
		/raced.*entrypoint changed during copy/i,
	);
	await rm(root, { recursive: true, force: true });
});

test("text extensions use the shared bounded secret scanner", () => {
	for (const extension of [
		"md",
		"mdx",
		"txt",
		"json",
		"yaml",
		"yml",
		"toml",
		"js",
		"mjs",
		"cjs",
		"ts",
		"tsx",
		"jsx",
		"sh",
	]) {
		assert.deepEqual(
			scanResourceContent(
				`safe.${extension}`,
				Buffer.from("sk-test-1234567890abcdef"),
			),
			["secret token"],
			extension,
		);
	}
	assert.deepEqual(
		scanResourceContent("safe.bin", Buffer.from("sk-test-1234567890abcdef")),
		[],
	);
	assert.deepEqual(
		scanResourceContent("safe.md", Buffer.from("# Ordinary\n")),
		[],
	);
});

test("explicit resources fail closed on unsafe names, types, sizes, links, and secrets", async () => {
	const cases: Array<[string, (skills: string) => Promise<void>, RegExp]> = [
		[
			"env",
			(skills) => writeFile(join(skills, ".env.local"), "safe"),
			/\.env\.local.*environment file/i,
		],
		[
			"uppercase env",
			(skills) => writeFile(join(skills, ".ENV"), "safe"),
			/\.ENV.*environment file/i,
		],
		[
			"envrc",
			(skills) => writeFile(join(skills, ".envrc"), "safe"),
			/\.envrc.*environment file/i,
		],
		[
			"rsa",
			(skills) => writeFile(join(skills, "id_rsa"), "safe"),
			/id_rsa.*private key filename/i,
		],
		[
			"ed25519",
			(skills) => writeFile(join(skills, "id_ed25519"), "safe"),
			/id_ed25519.*private key filename/i,
		],
		[
			"pem",
			(skills) => writeFile(join(skills, "client.pem"), "safe"),
			/client\.pem.*private key filename/i,
		],
		[
			"key",
			(skills) => writeFile(join(skills, "client.key"), "safe"),
			/client\.key.*private key filename/i,
		],
		[
			"auth",
			(skills) => writeFile(join(skills, "auth.json"), "{}"),
			/auth\.json.*credential store filename/i,
		],
		[
			"credentials",
			(skills) => writeFile(join(skills, "credentials"), "safe"),
			/credentials.*credential store filename/i,
		],

		[
			"symlink file",
			(skills) => symlink("/etc/passwd", join(skills, "link")),
			/link.*symbolic link/i,
		],
		[
			"symlink directory",
			async (skills) => {
				const outside = join(skills, "..", "outside");
				await mkdir(outside);
				await symlink(outside, join(skills, "linked"));
			},
			/linked.*symbolic link/i,
		],
		[
			"oversized",
			async (skills) => {
				const path = join(skills, "large.bin");
				await writeFile(path, "x");
				await truncate(path, MAX_RESOURCE_FILE_BYTES + 1);
			},
			/large\.bin.*file too large/i,
		],
	];
	for (const [name, setup, expected] of cases) {
		const root = await mkdtemp(join(tmpdir(), "pi-dsbx-profile-reject-"));
		const agent = join(root, "agent");
		const skills = join(agent, "skills");
		await mkdir(skills, { recursive: true });
		await setup(skills);
		await assert.rejects(
			() =>
				createPersonalizationSnapshot(agent, join(root, "snapshot"), "custom", {
					settings: false,
					models: false,
					packages: false,
					skills: true,
					prompts: false,
					themes: false,
					extensions: false,
					sessions: "managed",
				}),
			(error: unknown) => {
				assert.match((error as Error).message, expected, name);
				assert.equal((error as Error).message.includes(root), false, name);
				assert.equal(
					(error as Error).message.includes("sk-test-1234567890abcdef"),
					false,
					name,
				);
				return true;
			},
		);
		await rm(root, { recursive: true, force: true });
	}
});

test("explicit resources reject hard-linked files", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-profile-hardlink-"));
	const agent = join(root, "agent");
	const skills = join(agent, "skills");
	await mkdir(skills, { recursive: true });
	const outside = join(root, "outside");
	await writeFile(outside, "safe bytes");
	await link(outside, join(skills, "linked.txt"));
	await assert.rejects(
		() =>
			createPersonalizationSnapshot(
				agent,
				join(root, "snapshot"),
				"custom",
				resourcePolicy,
			),
		/linked\.txt.*hard link/i,
	);
	await rm(root, { recursive: true, force: true });
});

test("resource replacement races reject without copying outside bytes", async () => {
	for (const race of ["file-symlink", "parent-swap", "growth"] as const) {
		const root = await mkdtemp(join(tmpdir(), `pi-dsbx-profile-race-${race}-`));
		const agent = join(root, "agent");
		const skills = join(agent, "skills");
		const parent = join(skills, "nested");
		const source = join(parent, "safe.txt");
		const outside = join(root, "outside.txt");
		await mkdir(parent, { recursive: true });
		await writeFile(source, "safe bytes");
		await writeFile(outside, "outside canary bytes");
		const hooks = {
			testHook: async (
				boundary:
					| "beforeDestinationClaim"
					| "afterDestinationClaim"
					| "beforeSnapshotWrite"
					| "beforeSnapshotCleanup"
					| "beforeFileOpen"
					| "afterFileOpen"
					| "duringFileRead"
					| "afterDirectoryEnumerate"
					| "afterExtensionClassification",
				path: string,
			) => {
				if (path !== "nested/safe.txt") return;
				if (race === "file-symlink" && boundary === "beforeFileOpen") {
					await rename(source, `${source}-old`);
					await writeFile(source, "replacement bytes");
				}
				if (race === "parent-swap" && boundary === "afterFileOpen") {
					await rename(parent, `${parent}-old`);
					await symlink(root, parent);
				}
				if (race === "growth" && boundary === "duringFileRead")
					await truncate(source, MAX_RESOURCE_FILE_BYTES + 1);
			},
		};
		await assert.rejects(
			Promise.race([
				createPersonalizationSnapshot(
					agent,
					join(root, "snapshot"),
					"custom",
					resourcePolicy,
					hooks,
				),
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error("race test timed out")), 2_000),
				),
			]),
			(error: unknown) => {
				assert.match(
					(error as Error).message,
					race === "growth"
						? /Resource nested\/safe\.txt: file too large/
						: /Resource nested\/safe\.txt: filesystem validation failed/,
				);
				assert.equal((error as Error).message.includes(root), false);
				return true;
			},
		);
		assert.equal(await exists(join(root, "snapshot")), false);
		await rm(root, { recursive: true, force: true });
	}
});

test("resource filesystem errors expose only relative validation detail", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-profile-fs-error-"));
	const agent = join(root, "agent");
	const source = join(agent, "skills", "safe.txt");
	await mkdir(join(agent, "skills"), { recursive: true });
	await writeFile(source, "safe");
	await assert.rejects(
		() =>
			createPersonalizationSnapshot(
				agent,
				join(root, "snapshot"),
				"custom",
				resourcePolicy,
				{
					testHook: async (boundary) => {
						if (boundary === "beforeFileOpen") await rm(source);
					},
				},
			),
		(error: unknown) => {
			assert.equal(
				(error as Error).message,
				"Resource safe.txt: filesystem validation failed",
			);
			assert.equal((error as Error).message.includes(root), false);
			return true;
		},
	);
	await rm(root, { recursive: true, force: true });
});

test("destination replacement is rejected without writing or deleting the replacement", async () => {
	for (const boundary of [
		"beforeSnapshotWrite",
		"beforeSnapshotCleanup",
	] as const) {
		const root = await mkdtemp(join(tmpdir(), "pi-dsbx-profile-ownership-"));
		const agent = join(root, "agent");
		const destination = join(root, "snapshot");
		const displaced = join(root, "displaced");
		await mkdir(join(agent, "skills"), { recursive: true });
		await writeFile(join(agent, "settings.json"), '{"theme":"dark"}');
		await writeFile(
			join(
				agent,
				"skills",
				boundary === "beforeSnapshotCleanup" ? "id_rsa" : "z.txt",
			),
			"safe skill bytes",
		);
		let swapped = false;
		const operation = createPersonalizationSnapshot(
			agent,
			destination,
			"custom",
			boundary === "beforeSnapshotCleanup" ? resourcePolicy : safePolicy,
			{
				testHook: async (current) => {
					if (current !== boundary || swapped) return;
					swapped = true;
					await rename(destination, displaced);
					await mkdir(destination);
					await writeFile(join(destination, "sentinel"), "replacement bytes");
				},
			},
		);
		await assert.rejects(
			Promise.race([
				operation,
				new Promise((_, reject) =>
					setTimeout(
						() => reject(new Error("destination race timed out")),
						500,
					),
				),
			]),
			(error: unknown) => {
				assert.equal(
					(error as Error).message,
					"Personalization destination ownership changed",
				);
				assert.equal((error as Error).message.includes(root), false);
				return true;
			},
		);
		assert.equal(
			await readFile(join(destination, "sentinel"), "utf8"),
			"replacement bytes",
		);
		assert.equal(await exists(join(destination, "settings.json")), false);
		await rm(root, { recursive: true, force: true });
	}
});

test("mirror copies skill docs that only mention secrets and skips real secrets", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-profile-skip-"));
	const agent = join(root, "agent");
	const destination = join(root, "snapshot");
	await mkdir(join(agent, "skills", "wrangler"), { recursive: true });
	await writeFile(
		join(agent, "skills", "wrangler", "SKILL.md"),
		"```\nAPI_KEY=local-dev-key\n```\n",
	);
	await writeFile(join(agent, "skills", "safe.md"), "# Ordinary\n");
	await writeFile(join(agent, "skills", "notes.txt"), "password=hunter2\n");
	const snapshot = await createPersonalizationSnapshot(
		agent,
		destination,
		"custom",
		resourcePolicy,
	);
	assert.equal(
		await readFile(join(destination, "skills", "wrangler", "SKILL.md"), "utf8"),
		"```\nAPI_KEY=local-dev-key\n```\n",
	);
	assert.equal(
		await readFile(join(destination, "skills", "safe.md"), "utf8"),
		"# Ordinary\n",
	);
	assert.equal(await exists(join(destination, "skills", "notes.txt")), false);
	assert.ok(
		snapshot.warnings.includes(
			"skipped 1 secret-bearing files during custom sync",
		),
	);
	await rm(root, { recursive: true, force: true });
});

test("snapshot publication exclusively claims the destination and cleans failures", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-profile-atomic-"));
	const agent = join(root, "agent");
	const destination = join(root, "snapshot");
	await mkdir(join(agent, "skills"), { recursive: true });
	await writeFile(join(agent, "skills", "a.txt"), "safe");
	await writeFile(join(agent, "skills", "z.txt"), "password=hunter2");
	const skipped = await createPersonalizationSnapshot(
		agent,
		destination,
		"custom",
		resourcePolicy,
	);
	assert.ok(
		skipped.warnings.includes(
			"skipped 1 secret-bearing files during custom sync",
		),
	);
	assert.equal(await exists(join(destination, "skills", "z.txt")), false);
	assert.equal(
		await readFile(join(destination, "skills", "a.txt"), "utf8"),
		"safe",
	);
	await rm(destination, { recursive: true, force: true });

	await mkdir(destination);
	await writeFile(join(destination, "preserved"), "original bytes");
	await assert.rejects(
		() => createPersonalizationSnapshot(agent, destination, "clean"),
		(error: unknown) => {
			assert.equal((error as NodeJS.ErrnoException).code, "EEXIST");
			return true;
		},
	);
	assert.equal(
		await readFile(join(destination, "preserved"), "utf8"),
		"original bytes",
	);

	await rm(destination, { recursive: true });
	await assert.rejects(
		() =>
			createPersonalizationSnapshot(agent, destination, "clean", undefined, {
				testHook: async (boundary) => {
					if (boundary === "beforeDestinationClaim") {
						await mkdir(destination);
						await writeFile(join(destination, "sentinel"), "competitor bytes");
					}
				},
			}),
		(error: unknown) => {
			assert.equal((error as NodeJS.ErrnoException).code, "EEXIST");
			return true;
		},
	);
	assert.equal(
		await readFile(join(destination, "sentinel"), "utf8"),
		"competitor bytes",
	);
	assert.deepEqual(
		(await readdir(root)).filter((name) => name.includes("snapshot.tmp-")),
		[],
	);
	await rm(root, { recursive: true, force: true });
});

test("manifest uses fixed resource order and codepoint path order", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-profile-order-"));
	const agent = join(root, "agent");
	await mkdir(join(agent, "skills"), { recursive: true });
	await mkdir(join(agent, "prompts"), { recursive: true });
	for (const name of ["a.txt", "a", "z"])
		await writeFile(join(agent, "skills", name), name);
	await writeFile(join(agent, "prompts", "a"), "prompt");
	const snapshot = await createPersonalizationSnapshot(
		agent,
		join(root, "snapshot"),
		"custom",
		{ ...resourcePolicy, prompts: true },
	);
	assert.deepEqual(
		snapshot.manifest.map(({ resource, relativePath }) => ({
			resource,
			relativePath,
		})),
		[
			{ resource: "skills", relativePath: "a" },
			{ resource: "skills", relativePath: "a.txt" },
			{ resource: "skills", relativePath: "z" },
			{ resource: "prompts", relativePath: "a" },
		],
	);
	await rm(root, { recursive: true, force: true });
});

test("explicit resources reject FIFOs when supported", async (context) => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-profile-fifo-"));
	const skills = join(root, "agent", "skills");
	await mkdir(skills, { recursive: true });
	try {
		await exec("mkfifo", [join(skills, "pipe")]);
	} catch {
		context.skip("mkfifo unavailable");
		return;
	}
	await assert.rejects(
		() =>
			createPersonalizationSnapshot(
				join(root, "agent"),
				join(root, "snapshot"),
				"custom",
				{
					settings: false,
					models: false,
					packages: false,
					skills: true,
					prompts: false,
					themes: false,
					extensions: false,
					sessions: "managed",
				},
			),
		/pipe: non-regular file/i,
	);
	await rm(root, { recursive: true, force: true });
});

test("hash tree remains deterministic", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-profile-hash-"));
	await writeFile(join(root, "safe"), "bytes");
	const before = await hashTree(root);
	assert.equal(before, await hashTree(root));
	await rm(root, { recursive: true, force: true });
});
