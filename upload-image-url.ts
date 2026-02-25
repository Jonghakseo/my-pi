import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "crypto";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { execSync } from "child_process";

const STORAGE_OWNER = "creatrip";
const STORAGE_REPO = "agent-storage";
const STORAGE_BRANCH = "main";

const ALLOWED_EXTENSIONS = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico",
]);

const MIME_TO_EXT: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/svg+xml": ".svg",
	"image/bmp": ".bmp",
	"image/x-icon": ".ico",
};

function getRepoContext(): { owner: string; repo: string } | null {
	try {
		const nameWithOwner = execSync("gh repo view --json nameWithOwner --jq .nameWithOwner", {
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
		const pr = execSync("gh pr view --json number --jq .number", {
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
		const ext = path.extname(new URL(url).pathname).toLowerCase().split("?")[0]!;
		if (ext && ALLOWED_EXTENSIONS.has(ext)) return ext;
	} catch { /* ignore */ }

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
			"Upload an image to GitHub storage (creatrip/agent-storage) and return a permanent raw URL. " +
			"Accepts a URL or a local file path. " +
			"Useful for embedding Figma exports, screenshots, or any external image into GitHub content.",
		parameters: Type.Object({
			url: Type.String({ description: "Image URL or local file path to upload" }),
			filename: Type.Optional(
				Type.String({ description: "Optional custom filename without extension. Defaults to a UUID." }),
			),
		}),
		async execute(_toolCallId, params) {
			const { url, filename } = params as { url: string; filename?: string };
			const isLocal = !url.startsWith("http://") && !url.startsWith("https://");

			try {
				let buffer: Buffer;
				let ext: string;

				if (isLocal) {
					const resolved = path.resolve(url);
					if (!fs.existsSync(resolved)) {
						return {
							content: [{ type: "text", text: `File not found: ${resolved}` }],
							isError: true,
						};
					}
					ext = path.extname(resolved).toLowerCase();
					if (!ALLOWED_EXTENSIONS.has(ext)) {
						return {
							content: [{ type: "text", text: `Unsupported image type: ${ext}` }],
							isError: true,
						};
					}
					buffer = fs.readFileSync(resolved);
				} else {
					const res = await fetch(url);
					if (!res.ok) {
						return {
							content: [{ type: "text", text: `Download failed: HTTP ${res.status} from ${url}` }],
							isError: true,
						};
					}
					const contentType = res.headers.get("content-type") ?? "";
					ext = inferExtension(url, contentType);
					if (!ALLOWED_EXTENSIONS.has(ext)) {
						return {
							content: [{ type: "text", text: `Unsupported image type: ${ext}` }],
							isError: true,
						};
					}
					buffer = Buffer.from(await res.arrayBuffer());
				}

				// 2. Build storage path: {owner}/{repo}/{prNumber}/{file} or {owner}/{repo}/general/{file}
				const name = (filename || randomUUID()) + ext;
				const repoCtx = getRepoContext();
				const prNumber = repoCtx ? getPrNumber() : null;
				const folder = repoCtx
					? prNumber
						? `${repoCtx.owner}/${repoCtx.repo}/${prNumber}`
						: `${repoCtx.owner}/${repoCtx.repo}/general`
					: "general";
				const storagePath = `${folder}/${name}`;

				const tmpFile = path.join(os.tmpdir(), `upload-${name}`);
				fs.writeFileSync(tmpFile, buffer);
				const base64Content = buffer.toString("base64");

				// 3. Upload via gh api
				try {
					execSync(
						`gh api --method PUT "repos/${STORAGE_OWNER}/${STORAGE_REPO}/contents/${storagePath}" ` +
						`-f message="upload: ${storagePath}" ` +
						`-f content="${base64Content}" ` +
						`-f branch="${STORAGE_BRANCH}"`,
						{ encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024 },
					);
				} finally {
					try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
				}

				const rawUrl = `https://github.com/${STORAGE_OWNER}/${STORAGE_REPO}/blob/${STORAGE_BRANCH}/${storagePath}?raw=true`;
				const markdown = `![${name}](${rawUrl})`;

				return {
					content: [{
						type: "text",
						text: JSON.stringify({ success: true, url: rawUrl, storagePath, markdown }, null, 2),
					}],
				};
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: JSON.stringify({ success: false, error: msg }) }],
					isError: true,
				};
			}
		},
	});
}
