type RepoStatusInvalidationListener = () => void;

const repoStatusInvalidationListeners = new Set<RepoStatusInvalidationListener>();

export function subscribeRepoStatusInvalidation(listener: RepoStatusInvalidationListener): () => void {
	repoStatusInvalidationListeners.add(listener);
	return () => {
		repoStatusInvalidationListeners.delete(listener);
	};
}

export function invalidateRepoStatus(): void {
	for (const listener of repoStatusInvalidationListeners) {
		listener();
	}
}
