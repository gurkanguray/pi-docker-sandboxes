import assert from "node:assert/strict";
import test from "node:test";
import {
	decideDisposition,
	type ChangeState,
	type DispositionInput,
} from "../src/disposition.ts";

const booleans = [false, true] as const;
const changes = [
	"clean",
	"changed",
	"unknown",
] as const satisfies readonly ChangeState[];

function expected(input: DispositionInput): "preserve" | "remove" {
	if (input.keep) return "preserve";
	if (input.exportRequested && !input.exportSucceeded) return "preserve";
	if (input.changes === "clean") return "remove";
	if (input.exportRequested && input.exportSucceeded) return "remove";
	return input.discardAuthorized ? "remove" : "preserve";
}

test("all 48 disposition combinations follow the data-loss policy", () => {
	let count = 0;
	for (const keep of booleans)
		for (const changeState of changes)
			for (const exportRequested of booleans)
				for (const exportSucceeded of booleans)
					for (const discardAuthorized of booleans) {
						const input = {
							keep,
							changes: changeState,
							exportRequested,
							exportSucceeded,
							discardAuthorized,
						};
						assert.equal(
							decideDisposition(input),
							expected(input),
							JSON.stringify(input),
						);
						count++;
					}
	assert.equal(count, 48);
});

test("priority mutations cannot turn keep or failed export into removal", () => {
	const removable: DispositionInput = {
		keep: false,
		changes: "changed",
		exportRequested: false,
		exportSucceeded: false,
		discardAuthorized: true,
	};
	assert.equal(decideDisposition(removable), "remove");
	assert.equal(decideDisposition({ ...removable, keep: true }), "preserve");
	assert.equal(
		decideDisposition({
			...removable,
			exportRequested: true,
			exportSucceeded: false,
		}),
		"preserve",
	);
});
