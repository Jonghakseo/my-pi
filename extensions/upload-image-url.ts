import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const STORAGE_OWNER = process.env.PI_STORAGE_OWNER || "creatrip";
const STORAGE_REPO = process.env.PI_STORAGE_REPO || "agent-storage";
const STORAGE_BRANCH = "main";

const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"]);

const MIME_TO_EXT: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/svg+xml": ".svg",
	"image/bmp": ".bmp",
	"image/x-icon": ".ico",
};

/** Strip path separators and shell-unsafe characters to prevent traversal / injection. */
function sanitizeFilename(raw: string): string {
	return raw.replace(/[/\\:*?"<>|`$!&;#{}()'\s]/g, "_").replace(/\.{2,}/g, "_");
}

function getRepoContext(): { owner: string; repo: string } | null {
	try {
		const nameWithOwner = execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		const [owner, repo] = nameWithOwner.split("/");
		return owner && repo ? { owner, repo } : null;
	} catch {
		return null;
	}
}

function getPrNumber(): number | null {
	try {
		const pr = execFileSync("gh", ["pr", "view", "--json", "number", "--jq", ".number"], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		const num = Number(pr);
		return Number.isFinite(num) ? num : null;
	} catch {
		return null;
	}
}

function inferExtension(url: string, contentType?: string): string {
	try {
		const parts = path.extname(new URL(url).pathname).toLowerCase().split("?");
		const ext = parts[0] ?? "";
		if (ext && ALLOWED_EXTENSIONS.has(ext)) return ext;
	} catch {
		/* ignore */
	}

	if (contentType) {
		for (const [mime, ext] of Object.entries(MIME_TO_EXT)) {
			if (contentType.includes(mime)) return ext;
		}
	}

	return ".png";
}

export default function uploadImageUrl(pi: ExtensionAPI) {
	pi.registerTool({
		name: "upload_image_url",
		label: "Upload Image from URL",
		description:
			`Upload an image to GitHub storage (${STORAGE_OWNER}/${STORAGE_REPO}) and return a permanent raw URL. ` +
			"Accepts a URL or a local file path. " +
			"Useful for embedding Figma exports, screenshots, or any external image into GitHub content.",
		parameters: Type.Object({
			url: Type.String({ description: "Image URL or local file path to upload" }),
			filename: Type.Optional(
				Type.String({ description: "Optional custom filename without extension. Defaults to a UUID." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { url, filename } = params;
			const isLocal = !url.startsWith("http://") && !url.startsWith("https://");

			try {
				let buffer: Buffer;
				let ext: string;

				if (isLocal) {
					const resolved = path.resolve(url);
					if (!fs.existsSync(resolved)) {
						return {
							content: [{ type: "text", text: `File not found: ${resolved}` }],
							details: undefined,
							isError: true,
						};
					}
					ext = path.extname(resolved).toLowerCase();
					if (!ALLOWED_EXTENSIONS.has(ext)) {
						return {
							content: [{ type: "text", text: `Unsupported image type: ${ext}` }],
							details: undefined,
							isError: true,
						};
					}
					buffer = fs.readFileSync(resolved);
				} else {
					const res = await fetch(url);
					if (!res.ok) {
						return {
							content: [{ type: "text", text: `Download failed: HTTP ${res.status} from ${url}` }],
							details: undefined,
							isError: true,
						};
					}
					const contentType = res.headers.get("content-type") ?? "";
					ext = inferExtension(url, contentType);
					if (!ALLOWED_EXTENSIONS.has(ext)) {
						return {
							content: [{ type: "text", text: `Unsupported image type: ${ext}` }],
							details: undefined,
							isError: true,
						};
					}
					buffer = Buffer.from(await res.arrayBuffer());
				}

				// Build storage path: {owner}/{repo}/{prNumber}/{file} or general/{file}
				const name = sanitizeFilename(filename || randomUUID()) + ext;
				const repoCtx = getRepoContext();
				const prNumber = repoCtx ? getPrNumber() : null;
				const folder = repoCtx
					? prNumber
						? `${repoCtx.owner}/${repoCtx.repo}/${prNumber}`
						: `${repoCtx.owner}/${repoCtx.repo}/general`
					: "general";
				const storagePath = `${folder}/${name}`;

				// Upload via gh api — JSON body piped through stdin to avoid argv size limit (E2BIG)
				const payload = JSON.stringify({
					message: `upload: ${storagePath}`,
					content: buffer.toString("base64"),
					branch: STORAGE_BRANCH,
				});

				execFileSync(
					"gh",
					["api", "--method", "PUT", `repos/${STORAGE_OWNER}/${STORAGE_REPO}/contents/${storagePath}`, "--input", "-"],
					{ encoding: "utf-8", input: payload, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024 },
				);

				const rawUrl = `https://github.com/${STORAGE_OWNER}/${STORAGE_REPO}/blob/${STORAGE_BRANCH}/${storagePath}?raw=true`;
				const markdown = `![${name}](${rawUrl})`;

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ success: true, url: rawUrl, storagePath, markdown }, null, 2),
						},
					],
					details: undefined,
				};
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: JSON.stringify({ success: false, error: msg }) }],
					details: undefined,
					isError: true,
				};
			}
		},
	});
}
