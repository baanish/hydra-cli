/** run asynchronous work with bounded concurrency and optional progress callback. */
export async function runWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
	onProgress?: (completed: number, total: number) => void,
): Promise<R[]> {
	const total = items.length;
	if (total === 0) {
		return [];
	}

	const safeConcurrency = Math.max(1, Math.floor(concurrency));
	const results: R[] = new Array(total);
	let nextIndex = 0;
	let completed = 0;
	let hasFirstError = false;
	let firstError: unknown;

	const worker = async () => {
		while (true) {
			const currentIndex = nextIndex++;
			if (currentIndex >= total) {
				return;
			}

			try {
				const item = items[currentIndex];
				results[currentIndex] = await fn(item, currentIndex);
			} catch (error) {
				if (!hasFirstError) {
					hasFirstError = true;
					firstError = error;
				}
			} finally {
				completed += 1;
				onProgress?.(completed, total);
			}
		}
	};

	const workers = Array.from({ length: Math.min(total, safeConcurrency) }, () =>
		worker(),
	);
	await Promise.all(workers);
	if (hasFirstError) {
		throw firstError;
	}
	return results;
}
