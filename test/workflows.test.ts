import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const workflows = new URL("../.github/workflows/", import.meta.url);

type Step = {
	id?: string;
	name?: string;
	uses?: string;
	run?: string;
	with?: Record<string, unknown>;
};
type Job = {
	environment?: { name?: string; url?: string };
	if?: string;
	needs?: string[];
	permissions?: Record<string, string>;
	steps?: Step[];
	uses?: string;
	with?: Record<string, unknown>;
};
type Workflow = {
	on?: Record<string, unknown>;
	permissions?: Record<string, string>;
	jobs: Record<string, Job>;
};

test("release workflows are valid npm-only gates", async () => {
	const names = (await readdir(workflows)).filter((name) =>
		name.endsWith(".yml"),
	);
	const parsed = new Map<string, Workflow>();
	for (const name of names) {
		const workflow = parse(
			await readFile(new URL(name, workflows), "utf8"),
		) as Workflow;
		assert.ok(workflow.jobs, name);
		parsed.set(name, workflow);
	}

	const docs = parsed.get("docs.yml")!;
	assert.ok(docs, "docs.yml");
	assert.deepEqual(docs.jobs.build.permissions, { contents: "read" });
	assert.deepEqual(docs.jobs.deploy.permissions, {
		pages: "write",
		"id-token": "write",
	});
	assert.deepEqual(docs.jobs.deploy.needs, ["build"]);
	assert.equal(docs.jobs.deploy.environment?.name, "github-pages");

	const docsText = await readFile(new URL("docs.yml", workflows), "utf8");
	assert.match(docsText, /node-version:\s*24\.12\.0/);
	assert.match(docsText, /npm ci --ignore-scripts/);
	assert.match(docsText, /npm run docs:build/);
	const docsSteps = docs.jobs.build.steps ?? [];
	const archive = docsSteps.find(
		(step) => step.name === "Archive documentation",
	)?.run;
	assert.match(archive ?? "", /--dereference --hard-dereference/);
	assert.match(archive ?? "", /--directory docs\/\.vitepress\/dist/);
	assert.match(archive ?? "", /\$RUNNER_TEMP\/artifact\.tar/);
	const upload = docsSteps.find(
		(step) => step.name === "Upload Pages artifact",
	);
	assert.equal(
		upload?.uses,
		"actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
	);
	assert.deepEqual(upload?.with, {
		name: "github-pages",
		path: "${{ runner.temp }}/artifact.tar",
		"retention-days": 1,
		"if-no-files-found": "error",
	});
	assert.equal(
		docsSteps.some((step) =>
			step.uses?.startsWith("actions/upload-pages-artifact@"),
		),
		false,
	);
	assert.doesNotMatch(
		docsText,
		/npm publish|docker\/build-push-action|packages:\s*write/,
	);
	for (const action of docsText.matchAll(/uses:\s*([^\s]+)@([^\s]+)/g))
		assert.match(
			action[2]!,
			/^[0-9a-f]{40}$/,
			`${action[1]} must be SHA-pinned`,
		);

	const releaseText = await readFile(
		new URL("release-candidate.yml", workflows),
		"utf8",
	);
	const release = parsed.get("release-candidate.yml")!;
	assert.equal(release.jobs.security.permissions?.["security-events"], "write");
	assert.deepEqual(release.jobs["publish-npm"].needs, ["metadata", "receipt"]);
	assert.equal(release.jobs["publish-npm"].permissions?.["id-token"], "write");
	assert.equal(
		release.jobs["publish-npm"].with?.package_artifact,
		"npm-package-${{ needs.metadata.outputs.sha }}",
	);
	assert.match(releaseText, /fresh-install-receipt\.json/);
	assert.match(releaseText, /freshInstallReceipt/);
	assert.match(releaseText, /RUNNER_TEMP\/npm-package/);
	const sourceRun = release.jobs.metadata.steps?.find(
		(step) => step.id === "source",
	)?.run;
	assert.ok(sourceRun, "metadata source step must be executable");
	const sourceChecks = [
		'sha="$(git rev-list -n 1 "$TAG")"',
		'git fetch --force origin "refs/heads/main:refs/remotes/origin/main"',
		'git merge-base --is-ancestor "$sha" refs/remotes/origin/main',
		'test "$GITHUB_REF" = "refs/tags/$TAG"',
		'test "$GITHUB_SHA" = "$sha"',
	];
	const sourceOutput = sourceRun.indexOf('echo "sha=$sha" >> "$GITHUB_OUTPUT"');
	assert.ok(sourceOutput >= 0, "source step must emit its verified SHA");
	assert.match(sourceRun, /release versions must not be prereleases/);
	let previousCheck = -1;
	for (const check of sourceChecks) {
		const index = sourceRun.indexOf(check);
		assert.ok(index > previousCheck, `${check} must be ordered in source step`);
		assert.ok(index < sourceOutput, `${check} must precede source outputs`);
		previousCheck = index;
	}
	assert.doesNotMatch(releaseText, /packages: write|ghcr\.io|publish-image/);
	await assert.rejects(access(new URL("publish-image.yml", workflows)));

	const e2e = await readFile(new URL("e2e.yml", workflows), "utf8");
	assert.match(e2e, /expected_artifact="oci-candidate-\$SOURCE_SHA"/);
	assert.match(e2e, /image-verification\.json/);
	assert.match(e2e, /PI_DOCKER_SANDBOX_E2E_TEMPLATE_STORE_ID/);
	const imageRun = parsed
		.get("e2e.yml")!
		.jobs["macos-arm64"]!.steps?.find(
			(step) => step.name === "Load and bind the exact OCI candidate",
		)?.run;
	assert.ok(imageRun, "E2E image binding step must be executable");
	assert.match(
		imageRun,
		/const matches = \(templates\.images \?\? \[\]\)\.filter\(/,
	);
	assert.match(imageRun, /if \(matches\.length !== 1\) process\.exit\(1\);/);
	assert.match(imageRun, /console\.log\(matches\[0\]\.id\);/);
	assert.doesNotMatch(imageRun, /templates\.images\?\.find\(/);
	const security = await readFile(new URL("security.yml", workflows), "utf8");
	assert.match(security, /expected_artifact="oci-candidate-\$SOURCE_SHA"/);
	const trivySteps = Object.values(parsed.get("security.yml")!.jobs).flatMap(
		(job) =>
			(job.steps ?? []).filter((step) =>
				step.uses?.startsWith("aquasecurity/trivy-action@"),
			),
	);
	assert.equal(trivySteps.length, 5);
	for (const step of trivySteps) {
		assert.equal(
			step.uses,
			"aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25",
		);
		assert.equal(step.with?.version, "v0.74.0");
	}
	const repositoryScan = trivySteps.find(
		(step) => step.name === "Scan repository",
	)!;
	assert.equal(repositoryScan.with?.trivyignores, undefined);
	assert.equal(repositoryScan.with?.["limit-severities-for-sarif"], true);
	const imageScans = trivySteps.filter((step) =>
		["Scan candidate image", "Scan exact candidate image"].includes(
			step.name ?? "",
		),
	);
	assert.equal(imageScans.length, 2);
	for (const step of imageScans) {
		assert.equal(step.with?.trivyignores, ".trivyignore.yaml");
		assert.equal(step.with?.["limit-severities-for-sarif"], true);
	}

	const policy = JSON.parse(
		await readFile(new URL("../.trivyignore.yaml", import.meta.url), "utf8"),
	) as {
		vulnerabilities: Array<{
			id: string;
			paths: string[];
			statement: string;
		}>;
	};
	assert.deepEqual(policy.vulnerabilities.map(({ id }) => id).sort(), [
		"CVE-2026-33818",
		"CVE-2026-34040",
		"CVE-2026-39821",
		"CVE-2026-39822",
		"CVE-2026-41567",
		"CVE-2026-42306",
		"CVE-2026-46600",
		"CVE-2026-56853",
		"CVE-2026-56858",
		"CVE-2026-56859",
		"CVE-2026-56860",
		"CVE-2026-56862",
	]);
	assert.equal(
		policy.vulnerabilities.reduce(
			(total, exception) => total + exception.paths.length,
			0,
		),
		64,
	);
	for (const exception of policy.vulnerabilities) {
		assert.match(exception.statement, /upstream Docker-owned/);
		assert.match(exception.statement, /@sha256:[0-9a-f]{64}/);
		assert.match(exception.statement, /reviewed 2026-08-17/);
	}
	for (const jobName of ["image", "candidate-image"]) {
		const validation = parsed
			.get("security.yml")!
			.jobs[jobName]!.steps?.find(
				(step) => step.name === "Validate image exception policy",
			)?.run;
		assert.match(validation ?? "", /scripts\/check-release\.mjs/);
		assert.match(
			validation ?? "",
			/--tag "v\$\(node -p 'require\("\.\/package\.json"\)\.version'\)"/,
		);
	}
	const candidateSteps =
		parsed.get("security.yml")!.jobs["candidate-image"]!.steps!;
	const candidateCheckout = candidateSteps.findIndex(
		(step) =>
			step.uses === "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
	);
	const candidateScan = candidateSteps.findIndex(
		(step) => step.name === "Scan exact candidate image",
	);
	assert.ok(candidateCheckout >= 0 && candidateCheckout < candidateScan);
	assert.equal(
		candidateSteps[candidateCheckout]!.with?.ref,
		"${{ inputs.source_sha }}",
	);
	const publish = await readFile(new URL("publish-npm.yml", workflows), "utf8");
	assert.match(publish, /freshInstallReceipt\?\.sourceSha/);
	const publishSteps = parsed.get("publish-npm.yml")!.jobs.publish.steps ?? [];
	const verifyIndex = publishSteps.findIndex(
		(step) =>
			step.name === "Verify protected candidate receipt and npm configuration",
	);
	const npmPublishIndex = publishSteps.findIndex((step) =>
		step.run?.startsWith('npm publish "$tarball"'),
	);
	assert.ok(verifyIndex >= 0, "publish workflow must have a verification step");
	assert.ok(npmPublishIndex > verifyIndex, "verification must precede publish");
	assert.equal(
		publishSteps[npmPublishIndex]!.run,
		'npm publish "$tarball" --provenance --access public --tag latest',
	);
	const verifyRun = publishSteps[verifyIndex]!.run;
	assert.ok(verifyRun, "publish verification step must be executable");
	for (const check of [
		'test "$GITHUB_REF" = "refs/tags/$TAG"',
		'test "$GITHUB_SHA" = "$SOURCE_SHA"',
		"verification.binVersion !== pkg.version",
		"receipt.version !== pkg.version",
		"receipt.tag !== `v${pkg.version}`",
		"receipt.freshInstallReceipt?.version !== pkg.version",
		"receipt.e2eReceipt?.packageVersion !== pkg.version",
	])
		assert.ok(
			verifyRun.includes(check),
			`${check} must be enforced by publish verification`,
		);

	const receiptRun = release.jobs.receipt.steps?.find(
		(step) => step.name === "Join and verify candidate evidence",
	)?.run;
	assert.ok(receiptRun, "candidate receipt join must be executable");
	for (const check of [
		"packageReceipt.binVersion !== expected.VERSION",
		"freshInstallReceipt.version !== expected.VERSION",
		"e2eReceipt.packageVersion !== expected.VERSION",
	])
		assert.ok(
			receiptRun.includes(check),
			`${check} must bind candidate version evidence`,
		);

	const publication = release.jobs["verify-publication"];
	assert.deepEqual(publication.needs, ["metadata", "publish-npm"]);
	const publicationRun = publication.steps?.find(
		(step) => step.name === "Verify npm and Pi package gallery availability",
	)?.run;
	assert.ok(publicationRun, "publication verification must be executable");
	assert.match(publicationRun, /npm view "pi-docker-sandboxes" version/);
	assert.match(publicationRun, /npm install[^\n]*"pi-docker-sandboxes"/);
	assert.match(
		publicationRun,
		/https:\/\/pi\.dev\/packages\/pi-docker-sandboxes/,
	);
	assert.match(publicationRun, /grep -F "\$VERSION"/);

	for (const [name, workflow] of parsed)
		for (const job of Object.values(workflow.jobs))
			for (const step of job.steps ?? [])
				if (step.uses?.startsWith("docker/build-push-action@"))
					assert.equal(step.with?.push, false, `${name} must not push images`);

	const runtimeText = await readFile(
		new URL("runtime-image.yml", workflows),
		"utf8",
	);
	const runtime = parsed.get("runtime-image.yml")!;
	assert.ok(runtime, "runtime-image.yml");
	assert.deepEqual(Object.keys(runtime.on ?? {}), ["workflow_dispatch"]);
	assert.deepEqual(runtime.permissions, { contents: "read" });
	assert.match(runtimeText, /platforms: linux\/amd64,linux\/arm64/);
	assert.match(runtimeText, /no-cache: true/);
	assert.match(runtimeText, /target: \$\{\{ inputs\.variant \}\}/);
	assert.match(runtimeText, /options: \[standard, docker\]/);
	assert.doesNotMatch(runtimeText, /matrix\.variant/);
	assert.match(runtimeText, /verify-runtime-image\.mjs/);
	assert.match(runtimeText, /--lock/);
	assert.match(runtimeText, /runtime-build-args\.mjs/);
	assert.match(runtimeText, /runtime-image-receipt\.json/);
	assert.match(runtimeText, /format: cyclonedx/);
	assert.match(runtimeText, /severity: HIGH,CRITICAL/);
	assert.match(
		runtimeText,
		/candidate-\$SOURCE_SHA-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT/,
	);
	assert.match(runtimeText, /subject-digest:/);
	assert.match(runtimeText, /subject-path:/);
	assert.match(runtimeText, /verify-runtime-environment\.mjs/);
	assert.match(runtimeText, /finalize-runtime-receipt\.mjs/);
	assert.match(runtimeText, /driver-opts: image=\$\{\{/);
	assert.doesNotMatch(
		runtimeText,
		/candidate already exists|inspect "docker:\/\/\$candidate"/,
	);
	assert.doesNotMatch(
		runtimeText,
		/pull_request:|pi-docker-sandboxes\.tgz|PACKAGE_VERSION|flag:\s*["']wx["']/,
	);
	const runtimeSecuritySteps = runtime.jobs.security.steps ?? [];
	for (const step of runtimeSecuritySteps.filter((candidate) =>
		candidate.uses?.startsWith("aquasecurity/trivy-action@"),
	))
		assert.equal(step.with?.input, "runtime/oci");
	const publishRuntime = runtime.jobs.publish;
	assert.equal(runtime.jobs.receipt.if, "inputs.variant == 'standard'");
	assert.equal(publishRuntime.if, "inputs.variant == 'standard'");
	assert.equal(publishRuntime.environment?.name, "release-runtime");
	assert.deepEqual(publishRuntime.permissions, {
		contents: "read",
		packages: "write",
		"id-token": "write",
		attestations: "write",
	});
	for (const [name, job] of Object.entries(runtime.jobs)) {
		assert.ok(job.permissions, `${name} must declare permissions`);
		for (const step of job.steps ?? [])
			if (step.uses) {
				const [action, revision] = step.uses.split("@");
				assert.match(
					revision ?? "",
					/^[0-9a-f]{40}$/,
					`${action} must be SHA-pinned`,
				);
			}
	}
	for (const [name, workflow] of parsed)
		if (name !== "runtime-image.yml")
			assert.notEqual(
				workflow.jobs.publish?.permissions?.packages,
				"write",
				`${name} cannot publish GHCR`,
			);

	const ci = await readFile(new URL("ci.yml", workflows), "utf8");
	assert.match(
		ci,
		/go run github\.com\/rhysd\/actionlint\/cmd\/actionlint@v1\.7\.7/,
	);

	const pkg = JSON.parse(
		await readFile(new URL("../package.json", import.meta.url), "utf8"),
	);
	assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
	assert.ok(pkg.keywords.includes("pi-package"));
	assert.deepEqual(pkg.pi.extensions, [
		"./extensions/docker-sandboxes/index.ts",
	]);
	assert.equal(pkg.engines.node, ">=24.12.0 <25");
});
