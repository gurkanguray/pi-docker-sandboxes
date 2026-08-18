#!/usr/bin/env node

function failure(error) {
	const detail = String(error instanceof Error ? error.message : error)
		.replace(
			/((?:token|password|secret|api[-_]?key)\s*[:=]\s*)\S+/gi,
			"$1[redacted]",
		)
		.replace(/\s+/g, " ")
		.slice(0, 500);
	return {
		status: "failed",
		phase: "prepare",
		operation: "verify image",
		detail,
	};
}

const [image] = process.argv.slice(2);
if (!image || image === "--help" || image === "-h") {
	console.log("Usage: npm run image:verify -- <image@sha256:digest>");
	process.exitCode = image ? 0 : 2;
} else {
	const error = new Error(
		"production runtime image verification is unavailable until Task 8",
	);
	const result = failure(error);
	console.error(`Image verification failed: ${result.detail}`);
	console.log(JSON.stringify(result));
	process.exitCode = 1;
}
