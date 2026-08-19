import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

type Step = {
	id?: string;
	name?: string;
	uses?: string;
	run?: string;
	with?: Record<string, unknown>;
};
type Job = {
	if?: string;
	needs?: string | string[];
	environment?: { name?: string; url?: string };
	permissions?: Record<string, string>;
	steps?: Step[];
};
type RuntimeWorkflow = {
	on: Record<string, unknown>;
	permissions: Record<string, string>;
	jobs: Record<string, Job>;
};

const workflowPath = new URL(
	"../.github/workflows/runtime-image.yml",
	import.meta.url,
);
const checkout =
	"actions/checkout@11d5960a326750d5838078e36cf38b85af677262";
const sourceRef = "${{ needs.source.outputs.sha }}";
const needs = (job: Job) =>
	Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
const stepNamed = (job: Job, name: string) => {
	const step = job.steps?.find((candidate) => candidate.name === name);
	assert.ok(step, `${name} step is required`);
	return step;
};

function validateRuntimeWorkflow(workflow: RuntimeWorkflow) {
	assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
	assert.deepEqual(workflow.permissions, { contents: "read" });
	assert.deepEqual(Object.keys(workflow.jobs), [
		"source",
		"build",
		"security",
		"receipt",
		"publish",
	]);

	const { source, build, security, receipt, publish } = workflow.jobs;
	assert.ok(source && build && security && receipt && publish);
	assert.deepEqual(source.permissions, { contents: "read" });
	assert.deepEqual(build.permissions, { contents: "read" });
	assert.deepEqual(security.permissions, {
		contents: "read",
		"security-events": "write",
	});
	assert.deepEqual(receipt.permissions, { contents: "read" });
	assert.deepEqual(publish.permissions, {
		contents: "read",
		packages: "write",
		"id-token": "write",
		attestations: "write",
	});

	const sourceCheckout = source.steps?.[0];
	assert.equal(sourceCheckout?.uses, checkout);
	assert.equal(sourceCheckout.with?.["fetch-depth"], 0);
	const sourceRun = source.steps?.find((step) => step.id === "source")?.run;
	assert.ok(sourceRun, "source binding step is required");
	for (const check of [
		'git fetch --force origin "refs/heads/main:refs/remotes/origin/main"',
		'git merge-base --is-ancestor "$GITHUB_SHA" refs/remotes/origin/main',
		'test "$(git rev-parse HEAD)" = "$GITHUB_SHA"',
	])
		assert.ok(sourceRun.includes(check), `source binding must enforce: ${check}`);

	for (const job of [build, security, receipt, publish]) {
		const jobCheckout = job.steps?.find((step) => step.uses === checkout);
		assert.ok(jobCheckout, "downstream job must use the pinned checkout action");
		assert.equal(jobCheckout.with?.ref, sourceRef);
		assert.equal(jobCheckout.with?.["persist-credentials"], false);
	}

	for (const job of Object.values(workflow.jobs))
		for (const step of job.steps ?? [])
			if (step.uses)
				assert.match(
					step.uses,
					/^[^\s@]+@[0-9a-f]{40}$/,
					`${step.uses} must be immutable`,
				);

	const buildStep = stepNamed(
		build,
		"Build exact multi-platform archive without cache",
	);
	assert.equal(buildStep.with?.provenance, "mode=max");
	assert.equal(buildStep.with?.push, false);

	const scan = stepNamed(security, "Scan exact platform manifest");
	assert.equal(scan.with?.severity, "HIGH,CRITICAL");
	assert.equal(scan.with?.["ignore-unfixed"], false);
	assert.equal(scan.with?.["exit-code"], "1");
	for (const job of Object.values(workflow.jobs))
		for (const step of job.steps ?? []) {
			for (const key of Object.keys(step.with ?? {}))
				assert.doesNotMatch(key, /trivyignore/i);
			assert.doesNotMatch(step.run ?? "", /trivyignore|ignore-unfixed/i);
			assert.doesNotMatch(
				String(step.with?.["additional-args"] ?? ""),
				/ignore-unfixed|trivyignore/i,
			);
		}

	assert.equal(receipt.if, "inputs.variant == 'standard'");
	assert.deepEqual(needs(receipt), ["source", "build", "security"]);
	assert.equal(publish.if, "inputs.variant == 'standard'");
	assert.deepEqual(needs(publish), ["source", "receipt"]);
	assert.deepEqual(publish.environment, {
		name: "release-runtime",
		url: "https://github.com/${{ github.repository }}/pkgs",
	});
	const verifyIndex = publish.steps?.findIndex(
		(step) => step.name === "Verify release-runtime protection",
	);
	const pushIndex = publish.steps?.findIndex((step) => step.id === "push");
	assert.ok(
		verifyIndex !== undefined &&
			pushIndex !== undefined &&
			verifyIndex >= 0 &&
			verifyIndex < pushIndex,
		"environment verification must precede publication",
	);
	const environmentRun = publish.steps?.[verifyIndex]?.run ?? "";
	for (const check of [
		'gh api "$endpoint"',
		'gh api "$endpoint/deployment-branch-policies"',
		"scripts/verify-runtime-environment.mjs",
	])
		assert.ok(
			environmentRun.includes(check),
			`environment verification must enforce: ${check}`,
		);
}

test("runtime workflow policy rejects security and publication weakening", async (t) => {
	const source = await readFile(workflowPath, "utf8");
	const workflow = parse(source) as RuntimeWorkflow;
	assert.doesNotThrow(() => validateRuntimeWorkflow(workflow));

	const cases: Array<[string, (workflow: RuntimeWorkflow) => void]> = [
		[
			"disabled provenance",
			(value) => {
				stepNamed(
					value.jobs.build,
					"Build exact multi-platform archive without cache",
				).with!.provenance = false;
			},
		],
		[
			"omitted provenance",
			(value) => {
				delete stepNamed(
					value.jobs.build,
					"Build exact multi-platform archive without cache",
				).with!.provenance;
			},
		],
		[
			"Trivy ignore file",
			(value) => {
				stepNamed(
					value.jobs.security,
					"Scan exact platform manifest",
				).with!.trivyignores = ".trivyignore.yaml";
			},
		],
		[
			"ignored unfixed vulnerabilities",
			(value) => {
				stepNamed(
					value.jobs.security,
					"Scan exact platform manifest",
				).with!["ignore-unfixed"] = true;
			},
		],
		["nonmanual trigger", (value) => {
			value.on.push = {};
		}],
		["shallow source checkout", (value) => {
			value.jobs.source.steps![0]!.with!["fetch-depth"] = 1;
		}],
		[
			"missing environment protection check",
			(value) => {
				stepNamed(
					value.jobs.publish,
					"Verify release-runtime protection",
				).run = "echo skipped";
			},
		],
		["mutable action reference", (value) => {
			value.jobs.source.steps![0]!.uses = "actions/checkout@v4";
		}],
		["permission escalation", (value) => {
			value.jobs.build.permissions!.packages = "write";
		}],
		["standard publication bypass", (value) => {
			value.jobs.publish.needs = ["source"];
		}],
		["nonstandard publication", (value) => {
			delete value.jobs.publish.if;
		}],
	];

	for (const [name, mutate] of cases)
		await t.test(name, () => {
			const weakened = structuredClone(workflow);
			mutate(weakened);
			assert.throws(() => validateRuntimeWorkflow(weakened));
		});
});
