import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import {
	appendFile,
	lstat,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { launch } from "../src/launch.ts";
import { SbxClient } from "../src/sbx/client.ts";
import { runInherited } from "../src/sbx/inherited-runner.mjs";
import { applyPatch, exportPatch } from "../src/workspace.ts";

const enabled = process.env.PI_DOCKER_SANDBOX_E2E === "1";
const selectedImage = process.env.PI_DOCKER_SANDBOX_E2E_IMAGE;
const selectedTemplateStoreId =
	process.env.PI_DOCKER_SANDBOX_E2E_TEMPLATE_STORE_ID;
const expectedPackageVersion =
	process.env.PI_DOCKER_SANDBOX_E2E_PACKAGE_VERSION ?? "0.1.0";
const exec = promisify(execFile);
async function recordSandbox(name: string): Promise<void> {
	const path = process.env.PI_DOCKER_SANDBOX_E2E_NAMES;
	if (path) await appendFile(path, `${name}\n`);
}
function sandboxTest(
	name: string,
	options: { skip: boolean; timeout: number },
	body: () => Promise<void>,
): void {
	test(name, options, async () => {
		await body();
		console.log("E2E_TEST_PASSED=1");
	});
}
const e2eLaunch: typeof launch = async (options) => {
	const name = options.config?.sandbox?.name;
	if (name) await recordSandbox(name);
	return launch({
		...options,
		resolveImage: selectedImage
			? async () => ({
					image: selectedImage,
					...(selectedTemplateStoreId
						? { templateStoreId: selectedTemplateStoreId }
						: {}),
				})
			: options.resolveImage,
	});
};
async function host(
	command: string,
	args: string[],
	cwd?: string,
): Promise<string> {
	return (
		await exec(command, args, {
			cwd,
			encoding: "utf8",
			maxBuffer: 32 * 1024 * 1024,
		})
	).stdout.trim();
}

sandboxTest(
	"real Docker Sandbox enforces whole-Pi clone boundary",
	{
		skip: !enabled,
		timeout: 900_000,
	},
	async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-dsbx-e2e-"));
		const name = `pi-dsbx-e2e-${process.pid}`;
		const client = new SbxClient();
		try {
			await host("git", ["init", "-b", "main"], root);
			await host("git", ["config", "user.email", "e2e@example.com"], root);
			await host("git", ["config", "user.name", "E2E"], root);
			await writeFile(join(root, "tracked.txt"), "before\n");
			await writeFile(join(root, "deleted.txt"), "delete me\n");
			await host("git", ["add", "."], root);
			await host("git", ["commit", "-m", "initial"], root);

			const launched = await e2eLaunch({
				cwd: root,
				client,
				yes: true,
				projectTrusted: false,
				config: {
					syncProfile: "clean",
					auth: { mode: "proxy", providers: ["openai"] },
					sandbox: { name, keep: true },
				},
				piArgs: ["--help"],
			});
			assert.equal(launched.agentExitCode, 0);
			assert.ok(launched.state);
			const stagingProbe = join(root, "host-staging-probe");
			const cleanupProbe = await e2eLaunch({
				cwd: root,
				client,
				yes: true,
				projectTrusted: false,
				cleanup: {
					removeTemp: async (path) => {
						await writeFile(stagingProbe, path);
						await rm(path, { recursive: true, force: true });
					},
				},
				config: {
					syncProfile: "clean",
					auth: { mode: "proxy", providers: ["openai"] },
					sandbox: { name, keep: true },
				},
				piArgs: ["--help"],
			});
			assert.equal(cleanupProbe.agentExitCode, 0);
			const stagingPath = await readFile(stagingProbe, "utf8");
			await assert.rejects(() => lstat(stagingPath));
			await rm(stagingProbe);

			const runtime = await client.exec(name, [
				"sh",
				"-c",
				"env; printf '\\nPI_VERSION='; pi --version; npm list -g pi-docker-sandboxes --depth=0",
			]);
			assert.match(runtime.stdout, /PI_DOCKER_SANDBOX_ACTIVE=1/);
			assert.match(runtime.stdout, /PI_VERSION=0\.84\.1/);
			assert.match(
				runtime.stdout,
				new RegExp(
					`pi-docker-sandboxes@${expectedPackageVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
				),
			);
			for (const key of [
				"OPENAI_API_KEY",
				"ANTHROPIC_API_KEY",
				"AWS_SECRET_ACCESS_KEY",
				"GOOGLE_APPLICATION_CREDENTIALS",
			]) {
				const sandboxValue = runtime.stdout.match(
					new RegExp(`^${key}=(.*)$`, "m"),
				)?.[1];
				if (sandboxValue && process.env[key])
					assert.notEqual(sandboxValue, process.env[key]);
			}
			const githubProxy = runtime.stdout.match(/^GH_TOKEN=(.*)$/m)?.[1];
			if (githubProxy) {
				assert.match(githubProxy, /proxy/i);
				if (process.env.GH_TOKEN)
					assert.notEqual(githubProxy, process.env.GH_TOKEN);
			}

			const doctorScript =
				"import {attestSandbox,runDoctor,formatDoctor} from '/usr/local/share/npm-global/lib/node_modules/pi-docker-sandboxes/src/status.ts'; console.log(formatDoctor(await runDoctor(await attestSandbox())))";
			const doctor = await client.exec(name, [
				"sh",
				"-c",
				`node --experimental-strip-types --input-type=module -e ${JSON.stringify(
					doctorScript,
				)} 2>&1 || true`,
			]);
			assert.doesNotMatch(doctor.stdout, /^✗/m);
			const boundary = await client.exec(name, [
				"sh",
				"-c",
				"test ! -e ~/.ssh && test ! -e ~/.aws && test ! -e ~/.config/gcloud; grep '/run/sandbox/source' /proc/self/mountinfo; mount | grep -i skill || true",
			]);
			assert.match(boundary.stdout, /\/run\/sandbox\/source.*\bro[,\s]/);
			assert.doesNotMatch(boundary.stdout, /skill/i);
			await assert.rejects(() =>
				client.exec(name, [
					"sh",
					"-c",
					"echo escape > /run/sandbox/source/escape.txt",
				]),
			);
			await assert.rejects(() => readFile(join(root, "escape.txt")));

			const hostDockerId = await host("docker", [
				"info",
				"--format",
				"{{.ID}}",
			]);
			const sandboxDockerId = (
				await client.exec(name, ["docker", "info", "--format", "{{.ID}}"])
			).stdout.trim();
			assert.notEqual(sandboxDockerId, hostDockerId);
			await client.exec(name, [
				"sh",
				"-c",
				"mkdir -p /tmp/rootfs; echo x >/tmp/rootfs/x; tar -C /tmp/rootfs -cf /tmp/rootfs.tar .; docker import /tmp/rootfs.tar pi-dsbx-empty:test >/dev/null; docker create --name pi-dsbx-private-test pi-dsbx-empty:test true >/dev/null",
			]);
			assert.match(
				(
					await client.exec(name, [
						"docker",
						"ps",
						"-a",
						"--format",
						"{{.Names}}",
					])
				).stdout,
				/pi-dsbx-private-test/,
			);
			assert.doesNotMatch(
				await host("docker", ["ps", "-a", "--format", "{{.Names}}"]),
				/pi-dsbx-private-test/,
			);

			assert.equal(
				(await client.policyCheckNetwork("example.com", name)).allowed,
				false,
			);
			await assert.rejects(
				() =>
					client.exec(name, [
						"sh",
						"-c",
						"curl --connect-timeout 5 --max-time 10 -fsS https://example.com/",
					]),
				(error: Error) =>
					/denied|blocked|policy|curl|exit/i.test(error.message),
			);

			await client.exec(
				name,
				[
					"sh",
					"-c",
					"printf 'after\\n' > tracked.txt; rm deleted.txt; printf '\\000\\001\\377' > binary.dat; printf '#!/bin/sh\\necho ok\\n' > executable.sh; chmod +x executable.sh; ln -s tracked.txt link.txt; git config user.email e2e@example.com; git config user.name E2E; git add tracked.txt; git commit -m committed >/dev/null; printf 'untracked\\n' > untracked.txt",
				],
				{ workdir: launched.state!.hostRoot },
			);
			assert.equal(
				await readFile(join(root, "tracked.txt"), "utf8"),
				"before\n",
			);
			const patch = await exportPatch(
				client,
				launched.state!,
				".git/pi-docker-sandbox/patches",
			);
			assert.ok(patch.bytes > 0);
			await applyPatch(launched.state!, patch.path);
			assert.equal(
				await readFile(join(root, "tracked.txt"), "utf8"),
				"after\n",
			);
			await assert.rejects(() => readFile(join(root, "deleted.txt")));
			assert.deepEqual(
				await readFile(join(root, "binary.dat")),
				Buffer.from([0, 1, 255]),
			);
			assert.equal(
				(await lstat(join(root, "link.txt"))).isSymbolicLink(),
				true,
			);
			assert.equal(
				(await lstat(join(root, "executable.sh"))).mode & 0o111,
				0o111,
			);
		} finally {
			if (await client.exists(name)) await client.remove(name, true);
			await rm(root, { recursive: true, force: true });
		}
	},
);

sandboxTest(
	"real lifecycle preserves, exports, and discards only with authority",
	{
		skip: !enabled,
		timeout: 900_000,
	},
	async () => {
		const client = new SbxClient();
		const suffix = `${process.pid}-${Date.now()}`;
		const names = {
			preserve: `pi-dsbx-e2e-preserve-${suffix}`,
			export: `pi-dsbx-e2e-export-${suffix}`,
			discard: `pi-dsbx-e2e-discard-${suffix}`,
			exportFail: `pi-dsbx-e2e-export-fail-${suffix}`,
		};
		const roots: string[] = [];
		const prepare = async (name: string) => {
			const root = await mkdtemp(join(tmpdir(), "pi-dsbx-e2e-lifecycle-"));
			roots.push(root);
			await host("git", ["init", "-b", "main"], root);
			await host("git", ["config", "user.email", "e2e@example.com"], root);
			await host("git", ["config", "user.name", "E2E"], root);
			await writeFile(join(root, "tracked.txt"), "before\n");
			await host("git", ["add", "."], root);
			await host("git", ["commit", "-m", "initial"], root);
			const first = await e2eLaunch({
				cwd: root,
				client,
				yes: true,
				config: { syncProfile: "clean", sandbox: { name, keep: true } },
				piArgs: ["--help"],
			});
			assert.ok(first.state);
			await client.exec(name, ["sh", "-c", "printf 'after\\n' > tracked.txt"], {
				workdir: first.state.hostRoot,
			});
			return root;
		};
		try {
			const preservedRoot = await prepare(names.preserve);
			const preserved = await e2eLaunch({
				cwd: preservedRoot,
				client,
				yes: true,
				config: {
					syncProfile: "clean",
					sandbox: { name: names.preserve, keep: false },
					export: { onExit: "never" },
				},
				piArgs: ["--help"],
			});
			assert.equal(preserved.lifecycle.preserved, true);
			assert.equal(await client.exists(names.preserve), true);

			const exportRoot = await prepare(names.export);
			const exported = await e2eLaunch({
				cwd: exportRoot,
				client,
				yes: true,
				config: {
					syncProfile: "clean",
					sandbox: { name: names.export, keep: false },
					export: { onExit: "always" },
				},
				piArgs: ["--help"],
			});
			assert.equal(exported.lifecycle.exported, true);
			assert.equal(await client.exists(names.export), false);
			assert.match(
				await host("find", [
					join(exportRoot, ".git/pi-docker-sandbox/patches"),
					"-name",
					"*.patch",
					"-print",
				]),
				/\.patch$/,
			);

			const discardRoot = await prepare(names.discard);
			const discarded = await e2eLaunch({
				cwd: discardRoot,
				client,
				yes: true,
				discardChanges: true,
				config: {
					syncProfile: "clean",
					sandbox: { name: names.discard, keep: false },
					export: { onExit: "never" },
				},
				piArgs: ["--help"],
			});
			assert.equal(discarded.lifecycle.preserved, false);
			assert.equal(await client.exists(names.discard), false);

			const failedRoot = await prepare(names.exportFail);
			const failedClient = new Proxy(client, {
				get(target, property, receiver) {
					if (property !== "execBytes") {
						const value = Reflect.get(target, property, receiver);
						return typeof value === "function" ? value.bind(target) : value;
					}
					return async () => {
						throw new Error("forced E2E export failure");
					};
				},
			});
			const failed = await e2eLaunch({
				cwd: failedRoot,
				client: failedClient,
				yes: true,
				config: {
					syncProfile: "clean",
					sandbox: { name: names.exportFail, keep: false },
					export: { onExit: "always" },
				},
				piArgs: ["--help"],
			});
			assert.equal(failed.lifecycle.preserved, true);
			assert.match(failed.warnings.join("\n"), /forced E2E export failure/);
			assert.equal(await client.exists(names.exportFail), true);
		} finally {
			for (const name of Object.values(names))
				if (await client.exists(name)) await client.remove(name, true);
			for (const root of roots)
				await rm(root, { recursive: true, force: true });
		}
	},
);

sandboxTest(
	"inherited runner recovers from SIGINT without an orphan process group",
	{
		skip: !enabled,
		timeout: 30_000,
	},
	async () => {
		const status = runInherited(
			process.execPath,
			["--input-type=module", "-e", "setInterval(() => {}, 1000)"],
			process.env,
		);
		setTimeout(() => process.emit("SIGINT"), 100);
		assert.equal(await status, 130);
	},
);

sandboxTest(
	"empty Git onboarding creates exactly one empty initial commit",
	{
		skip: !enabled,
		timeout: 900_000,
	},
	async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-dsbx-e2e-empty-git-"));
		const name = `pi-dsbx-e2e-empty-git-${process.pid}`;
		const client = new SbxClient();
		try {
			await host("git", ["init", "-b", "main"], root);
			await host("git", ["config", "user.email", "e2e@example.com"], root);
			await host("git", ["config", "user.name", "E2E"], root);
			const launched = await e2eLaunch({
				cwd: root,
				client,
				yes: true,
				config: { syncProfile: "clean", sandbox: { name, keep: true } },
				piArgs: ["--help"],
			});
			assert.equal(launched.agentExitCode, 0);
			assert.equal(
				await host("git", ["rev-list", "--count", "HEAD"], root),
				"1",
			);
			assert.equal(
				await host("git", ["show", "--format=", "--name-only", "HEAD"], root),
				"",
			);
		} finally {
			if (await client.exists(name)) await client.remove(name, true);
			await rm(root, { recursive: true, force: true });
		}
	},
);

sandboxTest(
	"installed Pi extension re-execs through the companion launcher",
	{
		skip: !enabled,
		timeout: 900_000,
	},
	async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-dsbx-reexec-"));
		const agentDir = join(root, "agent");
		const repository = join(root, "repo");
		const name = `pi-dsbx-reexec-${process.pid}`;
		const client = new SbxClient();
		await recordSandbox(name);
		const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
		const run = async (command: string, args: string[], cwd?: string) => {
			const result = await exec(command, args, {
				cwd,
				env,
				encoding: "utf8",
				maxBuffer: 32 * 1024 * 1024,
			});
			return `${result.stdout}${result.stderr}`;
		};
		try {
			await (await import("node:fs/promises")).mkdir(repository);
			const packageSource =
				process.env.PI_DOCKER_SANDBOX_E2E_PACKAGE ?? process.cwd();
			let installSource = packageSource;
			if (packageSource.endsWith(".tgz")) {
				const packagePrefix = join(root, "package");
				await run("npm", [
					"install",
					"--ignore-scripts",
					"--prefix",
					packagePrefix,
					packageSource,
				]);
				installSource = join(
					packagePrefix,
					"node_modules",
					"pi-docker-sandboxes",
				);
			}
			await run("pi", ["install", installSource]);
			await run("git", ["init", "-b", "main"], repository);
			await run("git", ["config", "user.email", "e2e@example.com"], repository);
			await run("git", ["config", "user.name", "E2E"], repository);
			await writeFile(join(repository, "host.txt"), "host\n");
			await run("git", ["add", "."], repository);
			await run("git", ["commit", "-m", "initial"], repository);
			await run(
				"pi",
				[
					"--docker-sandbox",
					"--docker-sandbox-name",
					name,
					"--docker-sandbox-sync",
					"clean",
					"--docker-sandbox-keep",
					"--help",
				],
				repository,
			);
			assert.equal(await client.exists(name), true);
			assert.equal(
				await readFile(join(repository, "host.txt"), "utf8"),
				"host\n",
			);
		} finally {
			if (await client.exists(name)) await client.remove(name, true);
			await rm(root, { recursive: true, force: true });
		}
	},
);

sandboxTest(
	"Docker credential proxy keeps the value out of the VM environment",
	{
		skip: !enabled,
		timeout: 900_000,
	},
	async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-dsbx-proxy-"));
		const name = `pi-dsbx-proxy-${process.pid}`;
		const placeholder = `pi-placeholder-${Date.now()}`;
		const secret = `pi-secret-${Date.now()}`;
		const client = new SbxClient();
		await recordSandbox(name);
		try {
			await host("git", ["init", "-b", "main"], root);
			await host("git", ["config", "user.email", "e2e@example.com"], root);
			await host("git", ["config", "user.name", "E2E"], root);
			await writeFile(join(root, "host.txt"), "host\n");
			await host("git", ["add", "."], root);
			await host("git", ["commit", "-m", "initial"], root);
			await host("sbx", [
				"secret",
				"set-custom",
				"--sandbox",
				name,
				"--host",
				"httpbingo.org",
				"--env",
				"PI_PROXY_E2E_KEY",
				"--placeholder",
				placeholder,
				"--value",
				secret,
			]);
			const launched = await e2eLaunch({
				cwd: root,
				client,
				yes: true,
				projectTrusted: false,
				config: {
					syncProfile: "clean",
					sandbox: { name, keep: true },
					network: { allow: ["httpbingo.org"] },
				},
				piArgs: ["--help"],
			});
			assert.equal(launched.agentExitCode, 0);
			const environment = (
				await client.exec(name, ["sh", "-c", 'printf %s "$PI_PROXY_E2E_KEY"'])
			).stdout;
			assert.match(environment, new RegExp(placeholder));
			assert.doesNotMatch(environment, new RegExp(secret));
			const response = (
				await client.exec(name, [
					"sh",
					"-c",
					'curl -fsS -H "X-Test-Key: $PI_PROXY_E2E_KEY" https://httpbingo.org/headers',
				])
			).stdout;
			assert.doesNotMatch(response, new RegExp(placeholder));
			assert.match(response, new RegExp(secret));
		} finally {
			await host("sbx", [
				"secret",
				"rm",
				"--sandbox",
				name,
				"--placeholder",
				placeholder,
				"--force",
			]).catch(() => undefined);
			if (await client.exists(name)) await client.remove(name, true);
			await rm(root, { recursive: true, force: true });
		}
	},
);
