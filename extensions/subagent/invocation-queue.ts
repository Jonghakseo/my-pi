import { SUBAGENT_QUEUE_INTERVAL_MS } from "./constants.js";

let queueTail: Promise<void> = Promise.resolve();

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serialize subagent invocations through a single queue.
 *
 * Every invocation waits in the queue and starts after a fixed delay,
 * ensuring calls are made sequentially at 500ms intervals.
 */
export function enqueueSubagentInvocation<T>(job: () => Promise<T>): Promise<T> {
	const queuedJob = async () => {
		await sleep(SUBAGENT_QUEUE_INTERVAL_MS);
		return await job();
	};

	const result = queueTail.then(queuedJob, queuedJob);
	queueTail = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}
