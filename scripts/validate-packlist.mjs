import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
	const trackedFiles = new Set(
		execFileSync("git", ["ls-files"], {
			cwd: repositoryRoot,
			encoding: "utf8",
		}).trim().split("\n").filter(Boolean),
	);
	const packOutput = execFileSync(
		"npm",
		["pack", "--dry-run", "--json", "--ignore-scripts"],
		{
			cwd: repositoryRoot,
			encoding: "utf8",
		},
	);
	const packResult = JSON.parse(packOutput);

	if (!Array.isArray(packResult) || !Array.isArray(packResult[0]?.files)) {
		throw new Error("npm pack returned an unexpected result");
	}

	const untrackedFiles = packResult[0].files
		.map(({ path }) => path)
		.filter((path) => !trackedFiles.has(path));

	if (untrackedFiles.length > 0) {
		console.error("npm pack includes untracked files:");
		for (const path of untrackedFiles) {
			console.error(`- ${path}`);
		}
		process.exitCode = 1;
	}
} catch (error) {
	console.error("Failed to validate npm packlist:");
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
