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

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

test("only exact pinned npm packages cross the platform boundary", () => {
	const result = resolvePackageSpecs([
		"npm:example@1.2.3",
		"npm:@scope/pkg@2.0.0-beta.1",
		"npm:latest-package",
		"git:https://example.com/repo",
	]);
	assert.deepEqual(result.value, [
		"npm:example@1.2.3",
		"npm:@scope/pkg@2.0.0-beta.1",
	]);
	assert.equal(result.warnings.length, 2);
});

test("balanced is safe and mirror remains broad explicit opt-in", () => {
	assert.deepEqual(syncOptions("balanced"), {
		settings: true,
		models: true,
		packages: false,
		skills: false,
		prompts: false,
		themes: false,
		extensions: false,
		sessions: "managed",
	});
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
		sessions: "ephemeral",
	});
	assert.equal(policy.settings, false);
	assert.equal(policy.models, true);
	assert.equal(policy.sessions, "ephemeral");
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
				name.startsWith("skills/") ? "custom" : "balanced",
				name.startsWith("skills/") ? resourcePolicy : undefined,
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
					"balanced",
					undefined,
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
		"balanced",
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
			"secret content",
			(skills) =>
				writeFile(join(skills, "SKILL.md"), "sk-test-1234567890abcdef"),
			/SKILL\.md.*secret token/i,
		],
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
			"pem header",
			(skills) =>
				writeFile(join(skills, "safe.md"), "-----BEGIN PRIVATE KEY-----"),
			/safe\.md.*private key header/i,
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
					| "afterDirectoryEnumerate",
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
		await writeFile(join(agent, "skills", "z.txt"), "password=hunter2");
		let swapped = false;
		const operation = createPersonalizationSnapshot(
			agent,
			destination,
			boundary === "beforeSnapshotCleanup" ? "custom" : "balanced",
			boundary === "beforeSnapshotCleanup" ? resourcePolicy : undefined,
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

test("snapshot publication exclusively claims the destination and cleans failures", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-profile-atomic-"));
	const agent = join(root, "agent");
	const destination = join(root, "snapshot");
	await mkdir(join(agent, "skills"), { recursive: true });
	await writeFile(join(agent, "skills", "a.txt"), "safe");
	await writeFile(join(agent, "skills", "z.txt"), "password=hunter2");
	await assert.rejects(
		() =>
			createPersonalizationSnapshot(
				agent,
				destination,
				"custom",
				resourcePolicy,
			),
		/z\.txt.*secret assignment/i,
	);
	assert.equal(await exists(destination), false);
	assert.deepEqual(
		(await readdir(root)).filter((name) => name.includes("snapshot.tmp-")),
		[],
	);

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
