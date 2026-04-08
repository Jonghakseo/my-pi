export type BoundedTaskResult<TResult> =
	| { status: "fulfilled"; value: TResult }
	| { status: "rejected"; reason: unknown };

export async function runBoundedTasks<TItem, TResult>(args: {
	items: TItem[];
	maxConcurrency: number;
	worker: (item: TItem, index: number) => Promise<TResult>;
}): Promise<Array<BoundedTaskResult<TResult>>> {
	const { items, worker } = args;
	const maxConcurrency = Math.max(1, args.maxConcurrency);
	const results: Array<BoundedTaskResult<TResult>> = new Array(items.length);
	let nextIndex = 0;

	const runner = async (): Promise<void> => {
		while (true) {
			const currentIndex = nextIndex;
			nextIndex += 1;
			if (currentIndex >= items.length) return;

			try {
				results[currentIndex] = {
					status: "fulfilled",
					value: await worker(items[currentIndex] as TItem, currentIndex),
				};
			} catch (error) {
				results[currentIndex] = { status: "rejected", reason: error };
			}
		}
	};

	await Promise.all(Array.from({ length: Math.min(maxConcurrency, items.length) }, () => runner()));
	return results;
}
