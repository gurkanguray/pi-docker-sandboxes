import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("runtime source is locked, controller-independent, and multi-platform", async () => {
	const [dockerfile, pkg, packageLock, runtimeLock] = await Promise.all([
		readFile(new URL("docker/runtime.Dockerfile", root), "utf8"),
		readFile(new URL("docker/runtime-package.json", root), "utf8").then(
			JSON.parse,
		),
		readFile(new URL("docker/runtime-package-lock.json", root), "utf8").then(
			JSON.parse,
		),
		readFile(new URL("docker/runtime-lock.json", root), "utf8").then(
			JSON.parse,
		),
	]);

	assert.equal(pkg.dependencies["@earendil-works/pi-coding-agent"], "0.84.1");
	assert.equal(
		packageLock.packages[""].dependencies["@earendil-works/pi-coding-agent"],
		"0.84.1",
	);
	assert.match(
		packageLock.packages["node_modules/@earendil-works/pi-coding-agent"]
			.integrity,
		/^sha512-/,
	);
	assert.match(runtimeLock.bases.standard, /@sha256:[0-9a-f]{64}$/);
	assert.match(runtimeLock.bases.docker, /@sha256:[0-9a-f]{64}$/);
	assert.match(runtimeLock.build.dockerfileFrontend, /@sha256:[0-9a-f]{64}$/);
	assert.match(runtimeLock.build.buildkitDriver, /@sha256:[0-9a-f]{64}$/);
	assert.deepEqual(runtimeLock.platforms, ["linux/amd64", "linux/arm64"]);
	assert.equal(runtimeLock.piVersion, "0.84.1");
	assert.match(runtimeLock.tools.fd.version, /^\d+\.\d+\.\d+$/);
	for (const arch of ["amd64", "arm64"])
		assert.match(runtimeLock.tools.fd.artifacts[arch].sha256, /^[0-9a-f]{64}$/);

	assert.ok(dockerfile.includes("FROM ${STANDARD_BASE} AS runtime"));
	assert.ok(dockerfile.includes("FROM ${STANDARD_BASE} AS standard"));
	assert.ok(dockerfile.includes("FROM ${DOCKER_BASE} AS docker"));
	assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
	assert.match(dockerfile, /runtime-package-lock\.json/);
	assert.match(dockerfile, /sha256sum --check/);
	const standardStage = dockerfile.slice(
		dockerfile.indexOf("FROM ${STANDARD_BASE} AS standard"),
		dockerfile.indexOf("FROM ${DOCKER_BASE} AS docker"),
	);
	const dockerStage = dockerfile.slice(
		dockerfile.indexOf("FROM ${DOCKER_BASE} AS docker"),
	);
	for (const binary of [
		"/usr/bin/docker",
		"/usr/libexec/docker/cli-plugins/docker-compose",
		"/usr/bin/pebble",
		"/usr/local/bin/clipboard-bridge",
		"/usr/libexec/docker/cli-plugins/docker-buildx",
	]) {
		assert.ok(standardStage.includes(binary), `${binary} must be stripped`);
		assert.match(standardStage, new RegExp(`test ! -e ${binary}`));
		assert.ok(!dockerStage.includes(binary), `${binary} removal is standard-only`);
	}
	assert.match(
		standardStage,
		/io\.pi-docker-sandboxes\.stripped-optional-binaries/,
	);
	assert.match(dockerfile, /USER agent\s*$/m);
	assert.match(dockerfile, /io\.pi-docker-sandboxes\.runtime-schema/);
	assert.match(dockerfile, /io\.pi-docker-sandboxes\.variant/);
	assert.doesNotMatch(
		dockerfile,
		/apt-get|pi-docker-sandboxes\.tgz|PACKAGE_VERSION/,
	);
});

test("runtime archive verifier binds both platform manifests and smoke tests", async () => {
	const verifier = await readFile(
		new URL("scripts/verify-runtime-image.mjs", root),
		"utf8",
	);
	assert.match(verifier, /loadRuntimeLock/);
	assert.match(verifier, /archiveIdentity/);
	assert.match(verifier, /name: "runtime\.oci\.tar"/);
	assert.match(verifier, /indexDigest/);
	assert.match(verifier, /platformDigests/);
	assert.match(verifier, /OCI blob size mismatch/);
	assert.match(verifier, /OCI blob digest mismatch/);
	assert.match(verifier, /unexpected OCI media type/);
	assert.match(verifier, /attestation-manifest/);
	assert.match(verifier, /org\.opencontainers\.image\.source/);
	assert.match(verifier, /org\.opencontainers\.image\.base\.name/);
	assert.match(verifier, /run\("docker"/);
	assert.match(verifier, /pi --version/);
	assert.match(verifier, /fd --version/);
	assert.match(verifier, /rg --version/);
	assert.match(verifier, /git --version/);
	for (const binary of [
		"/usr/bin/docker",
		"/usr/libexec/docker/cli-plugins/docker-compose",
		"/usr/bin/pebble",
		"/usr/local/bin/clipboard-bridge",
		"/usr/libexec/docker/cli-plugins/docker-buildx",
	]) {
		assert.ok(verifier.includes(binary), `${binary} must be verified absent`);
	}
	assert.match(verifier, /for \(const platform of lock\.platforms\)/);
	assert.match(verifier, /stripped-optional-binaries/);
	assert.match(verifier, /runtime-image-receipt\.json/);
});
