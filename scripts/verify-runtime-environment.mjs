#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export function verifyRuntimeEnvironment(environment, policies) {
	const reviewerRule = environment.protection_rules?.find(
		(rule) => rule.type === "required_reviewers",
	);
	if (!reviewerRule?.reviewers?.length)
		throw new Error("release-runtime requires at least one reviewer");
	if (!environment.deployment_branch_policy?.custom_branch_policies)
		throw new Error("release-runtime requires custom deployment policies");
	const names = new Set(
		(policies.branch_policies ?? []).map(({ name }) => name),
	);
	if (!names.has("main") || !names.has("v*"))
		throw new Error(
			"release-runtime deployment policies must include main and v*",
		);
	return true;
}

export async function main([environmentPath, policiesPath]) {
	if (!environmentPath || !policiesPath)
		throw new Error(
			"environment and deployment-policy JSON paths are required",
		);
	verifyRuntimeEnvironment(
		JSON.parse(await readFile(environmentPath, "utf8")),
		JSON.parse(await readFile(policiesPath, "utf8")),
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
	await main(process.argv.slice(2));
