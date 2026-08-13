import { execFile } from "node:child_process";
import { access, cp, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { OperationError } from "./errors.ts";
import { type ImageLock, IMAGE_LOCK, loadImageLock } from "./image-lock.ts";
import {
	deriveLocalTemplateImage,
	parseSbxTemplateImages,
	requireLocalTemplate,
	splitLocalTemplateImage,
} from "./local-template.ts";

const execFileAsync = promisify(execFile);
export const LOCAL_IMAGE = IMAGE_LOCK.localImage;

interface CommandResult {
	stdout: string;
	stderr: string;
}

export async function runImageCommand(
	command: string,
	args: string[],
	options: { cwd?: string; maxBuffer?: number } = {},
): Promise<CommandResult> {
	try {
		return await execFileAsync(command, args, {
			cwd: options.cwd,
			encoding: "utf8",
			maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
		});
	} catch (cause) {
		const error = cause as { code?: number; stderr?: string };
		throw new OperationError({
			phase: "prepare",
			operation: `${command} ${args[0] ?? "command"}`,
			exitCode: typeof error.code === "number" ? error.code : undefined,
			detail: error.stderr,
			recovery: ["pi-dsbx image build"],
			cause,
		});
	}
}

export function packageRoot(): string {
	return dirname(dirname(fileURLToPath(import.meta.url)));
}

export type ImageCommand = typeof runImageCommand;

export async function packPackage(
	destination: string,
	root = packageRoot(),
	run: ImageCommand = runImageCommand,
): Promise<string> {
	try {
		await access(join(root, ".source-checkout"));
		await run("npm", ["run", "build:cli"], { cwd: root });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const { stdout } = await run("npm", [
		"pack",
		root,
		"--pack-destination",
		destination,
		"--json",
		"--ignore-scripts",
	]);
	let filename: string | undefined;
	try {
		const result = JSON.parse(stdout) as Array<{ filename?: string }>;
		filename = result[0]?.filename;
	} catch (cause) {
		throw new OperationError({
			phase: "prepare",
			operation: "parse npm pack output",
			detail: "npm pack returned malformed JSON",
			recovery: ["pi-dsbx image build"],
			cause,
		});
	}
	if (!filename || basename(filename) !== filename)
		throw new OperationError({
			phase: "prepare",
			operation: "validate npm pack output",
			detail: "npm pack returned an invalid filename",
			recovery: ["pi-dsbx image build"],
		});
	return join(destination, filename);
}

function smokeScript(lock: ImageLock): string {
	const exactPackage = (name: string, version: string) =>
		`test "$(dpkg-query -W -f='${"${Version}"}' ${name})" = "${version}"`;
	const output = (name: string, command: string) =>
		`printf 'PI_DSBX_VERIFY_${name}=%s\\n' "$(${command})"`;
	return [
		"set -eu",
		'test "$(id -u)" = 1000',
		`test "$(pi --version)" = "${lock.piVersion}"`,
		"pi-dsbx --help >/dev/null",
		exactPackage("fd-find", lock.tools.fdDebianVersion),
		exactPackage("ripgrep", lock.tools.rgDebianVersion),
		exactPackage("git", lock.tools.gitDebianVersion),
		"fd --version >/dev/null",
		"fdfind --version >/dev/null",
		"rg --version >/dev/null",
		"git --version >/dev/null",
		output("uid", "id -u"),
		output("pi", "pi --version"),
		output(
			"package",
			"node -p 'require(\"/usr/local/share/npm-global/lib/node_modules/pi-docker-sandboxes/package.json\").version'",
		),
		output("fd", `dpkg-query -W -f='${"${Version}"}' fd-find`),
		output("ripgrep", `dpkg-query -W -f='${"${Version}"}' ripgrep`),
		output("git", `dpkg-query -W -f='${"${Version}"}' git`),
		output("node", "node --version"),
		output("npm", "npm --version"),
	].join("; ");
}

export interface ImageVerificationReceipt {
	image: string;
	digest: string;
	imageId: string;
	registryDigest: string | null;
	platform: "linux/arm64";
	uid: number;
	user: string;
	entrypoint: string[];
	versions: {
		package: string;
		pi: string;
		fd: string;
		ripgrep: string;
		git: string;
		node: string;
		npm: string;
	};
}

export interface ImageParityResult {
	status: "matched";
	candidate: string;
}

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const DIGEST_REFERENCE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

function parseSmokeReceipt(output: string, lock: ImageLock) {
	const lines = output
		.split("\n")
		.filter((line) => line.startsWith("PI_DSBX_VERIFY_"));
	const entries = lines.map((line) => {
		const separator = line.indexOf("=");
		if (separator <= 15)
			throw new OperationError({
				phase: "prepare",
				operation: "parse image receipt",
				detail: "Malformed image receipt line",
				recovery: ["pi-dsbx image build"],
			});
		return [line.slice(15, separator), line.slice(separator + 1)] as const;
	});
	const values = new Map(entries);
	const fields = [
		"uid",
		"pi",
		"package",
		"fd",
		"ripgrep",
		"git",
		"node",
		"npm",
	];
	if (
		entries.length !== fields.length ||
		values.size !== fields.length ||
		[...values.keys()].some((name) => !fields.includes(name))
	)
		throw new OperationError({
			phase: "prepare",
			operation: "parse image receipt",
			detail: "Image receipt fields must appear exactly once",
			recovery: ["pi-dsbx image build"],
		});
	const expected = {
		uid: "1000",
		pi: lock.piVersion,
		package: lock.packageVersion,
		fd: lock.tools.fdDebianVersion,
		ripgrep: lock.tools.rgDebianVersion,
		git: lock.tools.gitDebianVersion,
	};
	for (const [name, value] of Object.entries(expected))
		if (values.get(name) !== value)
			throw new OperationError({
				phase: "prepare",
				operation: "verify image receipt",
				detail: `Expected ${name} ${value}`,
				recovery: ["pi-dsbx image build"],
			});
	for (const name of ["node", "npm"])
		if (!/^v?\d+\.\d+\.\d+$/.test(values.get(name) ?? ""))
			throw new OperationError({
				phase: "prepare",
				operation: "verify image receipt",
				detail: `Missing ${name} version`,
				recovery: ["pi-dsbx image build"],
			});
	return values;
}

export function imageSmokeArgs(
	image: string,
	lock: ImageLock,
	script: string,
): string[] {
	return [
		"run",
		"--rm",
		"--pull=never",
		"--network",
		"none",
		"--platform",
		lock.platform,
		"--entrypoint",
		"sh",
		image,
		"-lc",
		script,
	];
}

export async function verifyImageReceipt(
	image: string,
	lock: ImageLock,
	run: ImageCommand = runImageCommand,
	requireReceipt = true,
): Promise<ImageVerificationReceipt> {
	const remote = image.includes("@");
	if (
		image !== lock.localImage &&
		!IMAGE_ID.test(image) &&
		!DIGEST_REFERENCE.test(image)
	)
		throw new OperationError({
			phase: "prepare",
			operation: "verify image reference",
			detail:
				"Image reference must be the locked local tag, a local image ID, or a digest-pinned registry reference",
			recovery: ["pi-dsbx image build"],
		});
	const { stdout } = await run("docker", ["image", "inspect", image]);
	let metadata: Array<{
		Id?: string;
		Os?: string;
		Architecture?: string;
		RepoDigests?: string[];
		Config?: { User?: string; Entrypoint?: string[] | null };
	}>;
	try {
		metadata = JSON.parse(stdout) as typeof metadata;
	} catch (cause) {
		throw new OperationError({
			phase: "prepare",
			operation: "parse image metadata",
			detail: "docker image inspect returned malformed JSON",
			recovery: ["pi-dsbx image build"],
			cause,
		});
	}
	const inspected = metadata[0];
	const registryDigest = remote
		? (inspected?.RepoDigests?.find((digest) => digest === image) ?? null)
		: null;
	if (
		!IMAGE_ID.test(inspected?.Id ?? "") ||
		(IMAGE_ID.test(image) && inspected?.Id !== image) ||
		(remote && registryDigest !== image) ||
		`${inspected?.Os}/${inspected?.Architecture}` !== lock.platform ||
		inspected?.Config?.User !== "agent"
	)
		throw new OperationError({
			phase: "prepare",
			operation: "verify image metadata",
			detail: `Expected matching ${lock.platform} agent image metadata`,
			recovery: ["pi-dsbx image build"],
		});
	const immutableId = inspected.Id!;
	const result = await run(
		"docker",
		imageSmokeArgs(immutableId, lock, smokeScript(lock)),
	);
	if (/Downloading/i.test(`${result.stdout}\n${result.stderr}`))
		throw new OperationError({
			phase: "prepare",
			operation: "verify image has no runtime downloads",
			detail: "Smoke output contained Downloading",
			recovery: ["pi-dsbx image build"],
		});
	const values = requireReceipt
		? parseSmokeReceipt(result.stdout, lock)
		: new Map([
				["uid", "1000"],
				["package", lock.packageVersion],
				["pi", lock.piVersion],
				["fd", lock.tools.fdDebianVersion],
				["ripgrep", lock.tools.rgDebianVersion],
				["git", lock.tools.gitDebianVersion],
				["node", "verified"],
				["npm", "verified"],
			]);
	return {
		image,
		digest: remote ? image.slice(image.lastIndexOf("@") + 1) : immutableId,
		imageId: immutableId,
		registryDigest,
		platform: lock.platform,
		uid: Number(values.get("uid")),
		user: inspected.Config!.User!,
		entrypoint: inspected.Config?.Entrypoint ?? [],
		versions: {
			package: values.get("package")!,
			pi: values.get("pi")!,
			fd: values.get("fd")!,
			ripgrep: values.get("ripgrep")!,
			git: values.get("git")!,
			node: values.get("node")!,
			npm: values.get("npm")!,
		},
	};
}

export async function verifyImage(
	image: string,
	lock: ImageLock,
	run: ImageCommand = runImageCommand,
): Promise<string> {
	const receipt = await verifyImageReceipt(image, lock, run, false);
	return receipt.registryDigest ?? receipt.imageId;
}

export function compareImageReceipts(
	local: ImageVerificationReceipt,
	candidate: ImageVerificationReceipt,
): ImageParityResult {
	for (const field of [
		"platform",
		"uid",
		"user",
		"entrypoint",
		"versions",
	] as const)
		if (JSON.stringify(local[field]) !== JSON.stringify(candidate[field]))
			throw new OperationError({
				phase: "prepare",
				operation: "verify image parity",
				detail: `Image parity mismatch: ${field}`,
				recovery: [`npm run image:verify -- ${candidate.image}`],
			});
	return { status: "matched", candidate: candidate.image };
}

export async function buildLocalImage(
	options: { keepBuildDirectory?: boolean } = {},
	dependencies: {
		run?: ImageCommand;
		verify?: typeof verifyImage;
	} = {},
): Promise<{
	image: string;
	verifiedImage: string;
	templateStoreId?: string;
	archive: string;
	buildDirectory: string;
}> {
	const run = dependencies.run ?? runImageCommand;
	const verify = dependencies.verify ?? verifyImage;
	const directory = await mkdtemp(join(tmpdir(), "pi-docker-sandboxes-image-"));
	try {
		const lock = await loadImageLock();
		const archive = await packPackage(directory, packageRoot(), run);
		await cp(
			join(packageRoot(), "docker", "Dockerfile"),
			join(directory, "Dockerfile"),
		);
		await rename(archive, join(directory, "pi-docker-sandboxes.tgz"));
		await run(
			"docker",
			[
				"build",
				"--pull",
				"--load",
				"--platform",
				lock.platform,
				"--build-arg",
				`BASE_IMAGE=${lock.baseImage}`,
				"--build-arg",
				`PI_VERSION=${lock.piVersion}`,
				"--build-arg",
				`PACKAGE_VERSION=${lock.packageVersion}`,
				"--build-arg",
				`FD_DEBIAN_VERSION=${lock.tools.fdDebianVersion}`,
				"--build-arg",
				`RG_DEBIAN_VERSION=${lock.tools.rgDebianVersion}`,
				"--build-arg",
				`GIT_DEBIAN_VERSION=${lock.tools.gitDebianVersion}`,
				"--tag",
				lock.localImage,
				directory,
			],
			{ maxBuffer: 64 * 1024 * 1024 },
		);
		const verifiedImage = await verify(lock.localImage, lock, run);
		const image = deriveLocalTemplateImage(lock.localImage, verifiedImage);
		const expected = splitLocalTemplateImage(image);
		const imageArchive = join(directory, "pi-docker-sandboxes-image.tar");
		let temporaryTagCreated = false;
		try {
			await run("docker", ["tag", verifiedImage, image]);
			temporaryTagCreated = true;
			const existing = parseSbxTemplateImages(
				(await run("sbx", ["template", "ls", "--json"])).stdout,
			).filter(
				(candidate) =>
					candidate.repository === expected.repository &&
					candidate.tag === expected.tag,
			);
			if (existing.length > 1)
				throw new TypeError(
					"Expected at most one existing local template image",
				);
			await run("docker", ["save", "--output", imageArchive, image]);
			await run("sbx", ["template", "load", imageArchive], {
				maxBuffer: 64 * 1024 * 1024,
			});
			const template = requireLocalTemplate(
				(await run("sbx", ["template", "ls", "--json"])).stdout,
				image,
			);
			return {
				image,
				verifiedImage,
				templateStoreId: template.storeId,
				archive: imageArchive,
				buildDirectory: directory,
			};
		} finally {
			if (temporaryTagCreated) await run("docker", ["image", "rm", image]);
		}
	} catch (error) {
		if (!options.keepBuildDirectory)
			await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

export async function copyImageArtifacts(
	buildDirectory: string,
	destination: string,
): Promise<void> {
	for (const file of await readdir(buildDirectory)) {
		if (file.endsWith(".tar") || file === "Dockerfile" || file.endsWith(".tgz"))
			await cp(join(buildDirectory, file), join(destination, file));
	}
}
