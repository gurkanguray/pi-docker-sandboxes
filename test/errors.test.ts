import assert from "node:assert/strict";
import test from "node:test";
import {
	OperationError,
	formatError,
	sanitizeDetail,
	scanSecretCategories,
} from "../src/errors.ts";

test("operation errors name phase, operation, recovery, and redact secrets", () => {
	const error = new OperationError({
		phase: "preflight",
		operation: "git rev-parse HEAD",
		exitCode: 128,
		detail: "fatal: token=sk-test-1234567890abcdef",
		recovery: ['git commit --allow-empty -m "Initial commit"'],
	});
	const rendered = formatError(error);
	assert.match(rendered, /preflight: git rev-parse HEAD failed \(exit 128\)/);
	assert.match(rendered, /git commit --allow-empty/);
	assert.equal(rendered.includes("sk-test-1234567890abcdef"), false);
});

test("sanitizes common opaque credential representations", () => {
	const cases = [
		["token=opaqueCredential", "opaqueCredential"],
		["token : anotherOpaqueCredential", "anotherOpaqueCredential"],
		["password: hunter2", "hunter2"],
		['{"password":"quotedHunter2"}', "quotedHunter2"],
		["{'apiKey': 'quotedApiKey'}", "quotedApiKey"],
		['token = "quotedToken"', "quotedToken"],
		["Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
		["https://url-user:url-password@host/path", "url-user"],
		["https://url-user:url-password@host/path", "url-password"],
	] as const;

	for (const [value, secret] of cases) {
		const sanitized = sanitizeDetail(`failure: ${value}`);
		assert.equal(sanitized.includes(secret), false);
		assert.equal(sanitized.includes("[redacted]"), true);
	}
	assert.equal(
		sanitizeDetail('failure: {"password":"quotedHunter2"}'),
		'failure: {"password":"[redacted]"}',
	);
});

test("secret scanner returns categories without values and is repeatable", () => {
	const secret = "sk-test-1234567890abcdef";
	for (let iteration = 0; iteration < 2; iteration++) {
		const categories = scanSecretCategories(`token=${secret}`);
		assert.deepEqual(categories, ["secret assignment", "secret token"]);
		assert.equal(categories.join(" ").includes(secret), false);
	}
	assert.deepEqual(scanSecretCategories("ordinary markdown"), []);
});

test("preserves ordinary prose containing basic", () => {
	assert.equal(
		sanitizeDetail("  basic   requirement failed  "),
		"basic requirement failed",
	);
	assert.deepEqual(
		scanSecretCategories(
			"The password policy and token budget are documented.",
		),
		[],
	);
});

test("sanitized detail is bounded and single-line", () => {
	const detail = sanitizeDetail(
		`https://url-user:url-password@host/path\n${"x".repeat(600)}`,
		120,
	);
	assert.equal(detail.includes("\n"), false);
	assert.equal(detail.includes("url-user"), false);
	assert.equal(detail.includes("url-password"), false);
	assert.ok(detail.length <= 121);
});
