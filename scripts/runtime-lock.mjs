import { readFile } from "node:fs/promises";

const digestReference = /^[^\s@]+(?::[^\s@]+)?@sha256:[0-9a-f]{64}$/;

export async function loadRuntimeLock(path) {
	const lock = JSON.parse(await readFile(path, "utf8"));
	if (lock.version !== 1 || lock.runtimeSchema !== 1)
		throw new Error("unsupported runtime lock");
	for (const key of ["runtimeVersion", "piVersion"])
		if (typeof lock[key] !== "string" || !lock[key])
			throw new Error(`runtime lock ${key} is required`);
	if (JSON.stringify(lock.platforms) !== '["linux/amd64","linux/arm64"]')
		throw new Error("runtime lock platforms are invalid");
	for (const [name, reference] of Object.entries({
		...lock.bases,
		dockerfileFrontend: lock.build?.dockerfileFrontend,
		buildkitDriver: lock.build?.buildkitDriver,
		qemu: lock.build?.qemu,
		skopeo: lock.build?.skopeo,
	}))
		if (!digestReference.test(reference))
			throw new Error(`runtime lock ${name} must be digest-pinned`);
	if (!/^v\d+\.\d+\.\d+$/.test(lock.build?.buildxVersion))
		throw new Error("runtime lock buildxVersion is invalid");
	if (
		!/^tonistiigi\/binfmt:qemu-v\d+\.\d+\.\d+(?:-\d+)?@sha256:[0-9a-f]{64}$/.test(
			lock.build?.qemu,
		)
	)
		throw new Error(
			"runtime lock qemu image must use a stable digest-pinned tag",
		);
	for (const arch of ["amd64", "arm64"]) {
		const artifact = lock.tools?.fd?.artifacts?.[arch];
		if (!artifact?.name || !/^[0-9a-f]{64}$/.test(artifact.sha256))
			throw new Error(`runtime lock fd ${arch} artifact is invalid`);
	}
	return lock;
}

export function runtimeBuildArgs(lock) {
	return {
		STANDARD_BASE: lock.bases.standard,
		DOCKER_BASE: lock.bases.docker,
		PI_VERSION: lock.piVersion,
		RUNTIME_VERSION: lock.runtimeVersion,
		FD_VERSION: lock.tools.fd.version,
		FD_AMD64_NAME: lock.tools.fd.artifacts.amd64.name,
		FD_AMD64_SHA256: lock.tools.fd.artifacts.amd64.sha256,
		FD_ARM64_NAME: lock.tools.fd.artifacts.arm64.name,
		FD_ARM64_SHA256: lock.tools.fd.artifacts.arm64.sha256,
	};
}
