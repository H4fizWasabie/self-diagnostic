// Run: node --experimental-strip-types --test
import assert from "node:assert/strict";
import { test } from "node:test";
import { findRepeatedBashFailures } from "./self-diagnostic.ts";

type Step = ["bash", string, boolean] | ["edit"];

/** One assistant message per step, each followed by its tool result. `true` = the bash call failed. */
function transcript(steps: Step[]): Record<string, unknown>[] {
	return steps.flatMap((step, i): Record<string, unknown>[] => {
		const id = `call-${i}`;
		if (step[0] === "edit") {
			return [
				{ role: "assistant", content: [{ type: "toolCall", id, name: "edit", arguments: { path: "/tmp/x.py" } }] },
				{ role: "toolResult", toolCallId: id, isError: false, content: [{ type: "text", text: "ok" }] },
			];
		}
		const [, command, failed] = step;
		return [
			{ role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command } }] },
			{ role: "toolResult", toolCallId: id, isError: failed, content: [{ type: "text", text: `output of run ${i}` }] },
		];
	});
}

const verify = "python3 -m unittest test_image_border.py -v";

test("a fix-and-rerun loop is not reported (issue #407)", () => {
	const messages = transcript([
		["bash", verify, true],
		["edit"],
		["bash", verify, true],
		["edit"],
		["bash", verify, true],
		["edit"],
		["bash", verify, false],
	]);
	assert.deepEqual(findRepeatedBashFailures(messages), []);
});

test("rerunning a failing command unchanged is reported, with the last error", () => {
	const findings = findRepeatedBashFailures(
		transcript([
			["bash", verify, true],
			["bash", "ls", false],
			["bash", `  ${verify}  `, true],
			["bash", verify, true],
		]),
	);
	assert.equal(findings.length, 1);
	assert.match(findings[0]!.summary, /failed 3 times in a row/);
	assert.match(findings[0]!.detail, /output of run 3/);
});

test("a success of the same command resets its streak", () => {
	const messages = transcript([
		["bash", verify, true],
		["bash", verify, true],
		["bash", verify, false],
		["bash", verify, true],
		["bash", verify, true],
	]);
	assert.deepEqual(findRepeatedBashFailures(messages), []);
});
