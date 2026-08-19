import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error The release verifier is plain JavaScript without declarations.
import { verifyGithubAttestations } from "../scripts/verify-github-attestations.mjs";

const repository = "gurkanguray/pi-docker-sandboxes";
const sourceSha = "a".repeat(40);
const workflow = ".github/workflows/runtime-image.yml";

function document(overrides: Record<string, unknown> = {}) {
	return [{
		verificationResult: {
			statement: {
				_type: "https://in-toto.io/Statement/v1",
				predicateType: "https://slsa.dev/provenance/v1",
				subject: [{ name: "runtime-image-receipt.json", digest: {
					sha256: "b".repeat(64),
				} }],
				predicate: {
					buildDefinition: {
						externalParameters: {
							workflow: {
								repository: `https://github.com/${repository}`,
								path: workflow,
								ref: "refs/heads/main",
							},
						},
						resolvedDependencies: [{
							uri: `git+https://github.com/${repository}@refs/heads/main`,
							digest: { gitCommit: sourceSha },
						}],
					},
					runDetails: {
						builder: {
							id: `https://github.com/${repository}/${workflow}@refs/heads/main`,
						},
						metadata: {
							invocationId: `https://github.com/${repository}/actions/runs/123/attempts/2`,
						},
					},
				},
				...overrides,
			},
		},
	}];
}

const options = {
	documents: [document()],
	expectedRepository: repository,
	expectedSourceSha: sourceSha,
	expectedRunId: 123,
	expectedRunAttempt: 2,
	expectedWorkflow: workflow,
};

test("GitHub runtime attestations bind workflow, repository, source, and run", () => {
	assert.deepEqual(verifyGithubAttestations(options), {
		verified: true,
		repository,
		workflow,
		sourceSha,
		runId: 123,
		runAttempt: 2,
		subjects: [{ name: "runtime-image-receipt.json", sha256: "b".repeat(64) }],
	});
});

for (const [name, mutate] of [
	["source", (value: any) => {
		value[0].verificationResult.statement.predicate.buildDefinition
			.resolvedDependencies[0].digest.gitCommit = "c".repeat(40);
	}],
	["workflow", (value: any) => {
		value[0].verificationResult.statement.predicate.buildDefinition
			.externalParameters.workflow.path = ".github/workflows/other.yml";
	}],
	["run", (value: any) => {
		value[0].verificationResult.statement.predicate.runDetails.metadata
			.invocationId = "https://github.com/x/actions/runs/124/attempts/2";
	}],
] as const) {
	test(`GitHub runtime attestation rejects mismatched ${name}`, () => {
		const value = structuredClone(document());
		mutate(value);
		assert.throws(
			() => verifyGithubAttestations({ ...options, documents: [value] }),
			new RegExp(name, "i"),
		);
	});
}
