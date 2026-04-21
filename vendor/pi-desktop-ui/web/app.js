// ─── Pi Desktop App ───────────────────────────────────────────
// Fully functional chat UI inside a Glimpse native webview.
// Bidirectional: send messages → pi processes → streams response back.

let data = {};
try {
	// Data is base64-encoded in the template to avoid Glimpse bridge corruption.
	var b64 = (document.getElementById("desktop-data").textContent || "").trim();
	if (b64) {
		var bytes = Uint8Array.from(atob(b64), function (c) {
			return c.charCodeAt(0);
		});
		var jsonStr = new TextDecoder().decode(bytes);
		data = JSON.parse(jsonStr);
	}
} catch (e) {
	console.error("[desktop] Failed to decode/parse desktop-data:", e);
	// Fallback: try direct parse (in case data is raw JSON, not base64)
	try {
		var raw = document.getElementById("desktop-data").textContent || "{}";
		data = JSON.parse(raw);
	} catch (e2) {
		console.error("[desktop] Fallback parse also failed:", e2);
	}
}

// ─── Mermaid (mermaid.js) ─────────────────────────────────

let _mermaidReady = false;
let _mermaidCounter = 0;

function initMermaid() {
	if (typeof mermaid === "undefined") return;
	mermaid.initialize({
		startOnLoad: false,
		theme: "neutral",
		securityLevel: "strict",
		fontFamily: "ui-sans-serif, system-ui, sans-serif",
	});
	_mermaidReady = true;
}

initMermaid();

function renderMermaidAsync(el) {
	if (!_mermaidReady || !el) return;
	var code = el.dataset.mermaidSrc;
	if (!code) return;
	var id = "mermaid-svg-" + ++_mermaidCounter;
	mermaid
		.render(id, code)
		.then(function (result) {
			el.innerHTML = result.svg;
			el.classList.remove("mermaid-pending");
			el.classList.add("mermaid-rendered");
		})
		.catch(function () {
			el.innerHTML =
				'<pre style="text-align:left;margin:0;background:var(--code-bg);border-radius:6px;"><code style="white-space:pre-wrap;word-break:break-word;">' +
				escapeHtml(code) +
				"</code></pre>";
			el.classList.remove("mermaid-pending");
			el.classList.add("mermaid-rendered");
		});
}

function renderAllPendingMermaid() {
	document.querySelectorAll(".mermaid-pending").forEach(renderMermaidAsync);
}

// ─── Render Cache ──────────────────────────────────────────
// Cache rendered HTML for messages to avoid expensive re-processing
var _renderCache = new Map(); // key: message content hash → rendered HTML

function getMsgCacheKey(msg) {
	// Simple cache key from role + content (fast string concat)
	return (
		msg.role +
		"||" +
		(msg.content || "") +
		"||" +
		(msg.toolName || "") +
		"||" +
		(msg.status || "") +
		"||" +
		(msg.isError ? "1" : "0")
	);
}

// ─── State ────────────────────────────────────────────────────

const state = {
	activeView: "threads",
	activeThreadIdx: -1, // -1 = current session
	messages: data.messages || [],
	theme: "dark",
	isStreaming: false,
	streamingText: "", // accumulated text during streaming
	thinkingText: "", // accumulated thinking text
	isThinking: false, // currently in thinking block
	activeTools: [], // deprecated, tools now tracked in messages
	commands: data.commands || [],
	viewingOldThread: false,
	// Workspace state
	expandedWorkspaces: { __current__: true }, // current workspace starts expanded
	workspaceSessions: {}, // { dirName: [...sessions] } - cached sessions per workspace
	activeWorkspace: null, // dirName of workspace being viewed (null = current)
	showWorkspaceModal: false,
	hiddenWorkspaces: data.hiddenWorkspaces || {}, // loaded from disk via backend
	planMode: false, // read-only plan mode
	viewingFile: null, // { path, name, content, ext, size } when viewing a file
	// Explorer tree state (sidebar)
	explorerTreeExpanded: {}, // { dirPath: true } - which dirs are expanded
	explorerTreeChildren: {}, // { dirPath: [...entries] } - cached children per dir
	explorerTreeRoot: null, // root path for tree
	searchResults: null, // null = no search, [] = search with results
};

// ─── DOM References ───────────────────────────────────────────

const projectTreeEl = document.getElementById("project-tree");
const explorerTreeEl = document.getElementById("explorer-tree");
const breadcrumbEl = document.getElementById("breadcrumb");
const threadHeaderEl = document.getElementById("thread-header");
const threadLabelEl = document.getElementById("thread-label");
const threadTitleEl = document.getElementById("thread-title");
const messagesEl = document.getElementById("messages");
const inputTextEl = document.getElementById("input-text");
const modelLabelEl = document.getElementById("model-label");
const thinkingLabelEl = document.getElementById("thinking-label");
const statsBarEl = document.getElementById("stats-bar");
const btnTheme = document.getElementById("btn-theme");
const iconMoon = document.getElementById("icon-moon");
const iconSun = document.getElementById("icon-sun");
const btnSend = document.getElementById("btn-send");
const btnNewThread = document.getElementById("btn-new-thread");
const navItems = document.querySelectorAll("[data-nav]");

// Auto-render mermaid diagrams when new content is added (disabled during streaming)
var _mermaidObserver = null;
var _mermaidDebounceTimer = null;
function startMermaidObserver() {
	if (_mermaidObserver || !messagesEl) return;
	_mermaidObserver = new MutationObserver(function () {
		if (_mermaidDebounceTimer) clearTimeout(_mermaidDebounceTimer);
		_mermaidDebounceTimer = setTimeout(renderAllPendingMermaid, 100);
	});
	_mermaidObserver.observe(messagesEl, { childList: true, subtree: true });
}
function stopMermaidObserver() {
	if (_mermaidObserver) {
		_mermaidObserver.disconnect();
		_mermaidObserver = null;
	}
}
// Start observer only when not streaming
if (!state.isStreaming) startMermaidObserver();

// ─── Markdown Setup ──────────────────────────────────────────

if (typeof marked !== "undefined") {
	marked.setOptions({
		breaks: true,
		gfm: true,
	});
}

// ─── Helpers ──────────────────────────────────────────────────

function escapeHtml(str) {
	return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmt(n) {
	if (n == null) return "0";
	if (n < 1000) return String(n);
	if (n < 1_000_000) return (n / 1000).toFixed(1) + "k";
	return (n / 1_000_000).toFixed(1) + "M";
}

function timeAgo(dateStr) {
	if (!dateStr) return "";
	const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
	if (s < 60) return "now";
	if (s < 3600) return Math.floor(s / 60) + "m";
	if (s < 86400) return Math.floor(s / 3600) + "h";
	return Math.floor(s / 86400) + "d";
}

function sanitizeHtml(html) {
	if (typeof DOMPurify !== "undefined") {
		return DOMPurify.sanitize(html, {
			ALLOWED_TAGS: [
				"h1",
				"h2",
				"h3",
				"h4",
				"h5",
				"h6",
				"p",
				"br",
				"hr",
				"blockquote",
				"ul",
				"ol",
				"li",
				"dl",
				"dt",
				"dd",
				"strong",
				"em",
				"b",
				"i",
				"u",
				"s",
				"del",
				"ins",
				"mark",
				"sub",
				"sup",
				"small",
				"a",
				"code",
				"pre",
				"kbd",
				"samp",
				"var",
				"table",
				"thead",
				"tbody",
				"tfoot",
				"tr",
				"th",
				"td",
				"caption",
				"img",
				"figure",
				"figcaption",
				"details",
				"summary",
				"div",
				"span",
			],
			ALLOWED_ATTR: [
				"href",
				"title",
				"alt",
				"src",
				"class",
				"id",
				"lang",
				"colspan",
				"rowspan",
				"headers",
				"scope",
				"open",
				"width",
				"height",
				"loading",
			],
			ADD_ATTR: ["target"],
			ALLOW_DATA_ATTR: false,
			FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "input", "textarea", "button", "select"],
			FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur", "style"],
		});
	}
	return html;
}

function renderMarkdown(text) {
	if (!text) return "";
	if (typeof marked !== "undefined") {
		try {
			// Trusted content that bypasses DOMPurify (mermaid SVG, KaTeX HTML)
			var trustedBlocks = [];

			// 1. Protect LaTeX formulas from markdown processing
			var processed = text;

			// Block math: $$...$$ (can span multiple lines)
			processed = processed.replace(/\$\$([\s\S]+?)\$\$/g, function (_, formula) {
				var idx = trustedBlocks.length;
				trustedBlocks.push({ type: "math", formula: formula.trim(), display: true });
				return "\n\nTRUSTED_BLOCK_" + idx + "\n\n";
			});

			// Inline math: $...$ (single line, not empty)
			processed = processed.replace(/(?:^|[^$])\$([^$\n]+?)\$(?:[^$]|$)/g, function (match, formula) {
				var idx = trustedBlocks.length;
				trustedBlocks.push({ type: "math", formula: formula.trim(), display: false });
				var leading = match[0] !== "$" ? match[0] : "";
				var trailing = match[match.length - 1] !== "$" ? match[match.length - 1] : "";
				return leading + "TRUSTED_BLOCK_" + idx + trailing;
			});

			// 2. Parse markdown
			var html = marked.parse(processed);

			// 3. Extract mermaid blocks and replace with placeholders
			html = html.replace(/<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g, function (_, code) {
				var decoded = code
					.replace(/&amp;/g, "&")
					.replace(/&lt;/g, "<")
					.replace(/&gt;/g, ">")
					.replace(/&quot;/g, '"');
				var idx = trustedBlocks.length;
				trustedBlocks.push({ type: "mermaid", code: decoded });
				return "TRUSTED_BLOCK_" + idx;
			});

			// 4. Syntax highlighting for code blocks (skip mermaid)
			if (typeof hljs !== "undefined") {
				html = html.replace(
					/<pre><code class="language-(\w+)">([\s\S]*?)<\/code><\/pre>/g,
					function (match, lang, code) {
						if (lang === "mermaid") return match; // already extracted above, but guard just in case
						if (!hljs.getLanguage(lang)) return match; // skip unknown languages
						try {
							var decoded = code
								.replace(/&amp;/g, "&")
								.replace(/&lt;/g, "<")
								.replace(/&gt;/g, ">")
								.replace(/&quot;/g, '"');
							var highlighted = hljs.highlight(decoded, { language: lang }).value;
							return '<pre><code class="language-' + lang + ' hljs">' + highlighted + "</code></pre>";
						} catch (e) {
							return match;
						}
					},
				);
			}

			// 5. Sanitize user-generated HTML (safe — trusted blocks are just text placeholders)
			html = sanitizeHtml(html);

			// 6. Replace placeholders with trusted content AFTER sanitization
			for (var i = 0; i < trustedBlocks.length; i++) {
				var block = trustedBlocks[i];
				var rendered;
				if (block.type === "math") {
					rendered = renderLatex(block.formula, block.display);
				} else if (block.type === "mermaid") {
					rendered = renderMermaidBlock(block.code);
				}
				html = html.replace(new RegExp("<p>TRUSTED_BLOCK_" + i + "</p>", "g"), function () {
					return rendered;
				});
				html = html.replace(new RegExp("TRUSTED_BLOCK_" + i, "g"), function () {
					return rendered;
				});
			}

			return html;
		} catch (e) {
			console.warn("[desktop] renderMarkdown error:", e);
		}
	}
	return "<p>" + escapeHtml(text).replace(/\n/g, "<br>") + "</p>";
}

function renderMermaidBlock(code) {
	// Always return a pending placeholder — mermaid.render() is async
	// and will fill in the SVG after DOM insertion.
	return (
		'<div class="mermaid-container mermaid-pending" data-mermaid-src="' +
		escapeHtml(code) +
		'">' +
		'<pre style="text-align:left;padding:16px;"><code>' +
		escapeHtml(code) +
		"</code></pre>" +
		"</div>"
	);
}

function renderLatex(formula, displayMode) {
	if (typeof katex !== "undefined") {
		try {
			const html = katex.renderToString(formula, {
				displayMode: displayMode,
				throwOnError: false,
				output: "htmlAndMathml",
				trust: false,
				strict: false,
			});
			return displayMode
				? '<div class="math-block">' + html + "</div>"
				: '<span class="math-inline">' + html + "</span>";
		} catch (err) {
			return displayMode
				? '<div class="math-block" style="color:#e55;">LaTeX error: ' + escapeHtml(err.message) + "</div>"
				: '<code style="color:#e55;">' + escapeHtml(formula) + "</code>";
		}
	}
	// Fallback: show raw formula
	return displayMode
		? '<div class="math-block"><code>' + escapeHtml(formula) + "</code></div>"
		: "<code>" + escapeHtml(formula) + "</code>";
}

function truncate(str, len) {
	if (!str) return "";
	return str.length > len ? str.slice(0, len) + "…" : str;
}

function scrollToBottom() {
	requestAnimationFrame(() => {
		messagesEl.scrollTop = messagesEl.scrollHeight;
	});
}

// ─── Theme ────────────────────────────────────────────────────

function setTheme(theme) {
	state.theme = theme;
	document.documentElement.setAttribute("data-theme", theme);
	iconMoon.classList.toggle("hidden", theme === "dark");
	iconSun.classList.toggle("hidden", theme === "light");
	const lightSheet = document.getElementById("hljs-light");
	const darkSheet = document.getElementById("hljs-dark");
	if (lightSheet) lightSheet.disabled = theme === "dark";
	if (darkSheet) darkSheet.disabled = theme === "light";
}

btnTheme.addEventListener("click", () => {
	setTheme(state.theme === "light" ? "dark" : "light");
});

// ─── Plan Mode ────────────────────────────────────────────────

const btnPlanMode = document.getElementById("btn-plan-mode");
const planModeBanner = document.getElementById("plan-mode-banner");

function setPlanMode(active) {
	state.planMode = active;
	btnPlanMode.classList.toggle("plan-active", active);
	planModeBanner.style.display = active ? "flex" : "none";
	inputTextEl.placeholder = active
		? "Plan mode — ask pi to read, analyze, or plan (no writes)..."
		: "Ask pi to inspect the repo, run a fix, or continue the current thread...";
	// Notify backend
	send({ type: "set-plan-mode", active });
}

btnPlanMode.addEventListener("click", () => {
	setPlanMode(!state.planMode);
});

// ─── Sidebar Toggle ───────────────────────────────────────────

const sidebarEl = document.getElementById("sidebar");
const btnToggleSidebar = document.getElementById("btn-toggle-sidebar");
let sidebarCollapsed = false;

function toggleSidebar() {
	sidebarCollapsed = !sidebarCollapsed;
	if (sidebarCollapsed) {
		sidebarEl.classList.remove("sidebar-expanded");
		sidebarEl.classList.add("sidebar-collapsed");
	} else {
		sidebarEl.classList.remove("sidebar-collapsed");
		sidebarEl.classList.add("sidebar-expanded");
	}
}

if (btnToggleSidebar) {
	btnToggleSidebar.addEventListener("click", toggleSidebar);
}

// ─── Navigation ───────────────────────────────────────────────

function setActiveNav(view) {
	state.activeView = view;
	navItems.forEach((item) => item.classList.toggle("active", item.dataset.nav === view));
	renderMainContent();
}

navItems.forEach((item) => {
	item.addEventListener("click", () => {
		if (item.dataset.nav === "workspace") {
			// Open workspace modal instead of navigating
			showWorkspaceModal();
			return;
		}
		// Toggle explorer: if already active, collapse back to threads
		if (item.dataset.nav === "explorer" && state.activeView === "explorer") {
			setActiveNav("threads");
			return;
		}
		setActiveNav(item.dataset.nav);
		send({ type: "nav", action: item.dataset.nav });
	});
});

// ─── Thread Search ──────────────────────────────────────────

let threadSearchQuery = "";
let _searchDebounceTimer = null;

const threadSearchInput = document.getElementById("thread-search");
const threadSearchClear = document.getElementById("thread-search-clear");

function clearThreadSearch() {
	threadSearchQuery = "";
	state.searchResults = null;
	if (threadSearchInput) threadSearchInput.value = "";
	if (threadSearchClear) threadSearchClear.classList.add("hidden");
	if (_searchDebounceTimer) clearTimeout(_searchDebounceTimer);
	renderProjectTree();
}

if (threadSearchClear) {
	threadSearchClear.addEventListener("click", clearThreadSearch);
}

if (threadSearchInput) {
	threadSearchInput.addEventListener("input", () => {
		const raw = threadSearchInput.value.trim();
		threadSearchQuery = raw.toLowerCase();

		if (_searchDebounceTimer) clearTimeout(_searchDebounceTimer);

		// Show/hide clear button
		if (threadSearchClear) threadSearchClear.classList.toggle("hidden", !raw);

		if (!raw) {
			// Cleared search — restore normal tree
			state.searchResults = null;
			renderProjectTree();
			return;
		}

		// Also do instant name-based filtering for responsiveness
		state.searchResults = null;
		renderProjectTree();

		// Debounce the backend full-content search
		_searchDebounceTimer = setTimeout(() => {
			send({ type: "search-threads", query: raw });
		}, 350);
	});
}

function matchesThreadSearch(name) {
	if (!threadSearchQuery) return true;
	return (name || "").toLowerCase().includes(threadSearchQuery);
}

function renderSearchResults() {
	const results = state.searchResults || [];
	if (results.length === 0) {
		return `<div class="px-3 py-4 text-center text-[13px] text-pi-text-dim">No threads found</div>`;
	}

	// Group results by workspace
	const groups = {};
	for (const r of results) {
		const ws = r.workspace || "__current__";
		if (!groups[ws]) groups[ws] = [];
		groups[ws].push(r);
	}

	let html = "";
	for (const [ws, items] of Object.entries(groups)) {
		// Workspace header
		const wsName =
			ws === "__current__"
				? data.projectName || "Current workspace"
				: ws.replace(/^--/, "").replace(/--$/, "").split("-").pop() || ws;
		html += `
      <div class="px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-pi-text-dim">${escapeHtml(wsName)}</div>
    `;

		for (const r of items) {
			html += `
        <button class="thread-item flex w-full flex-col rounded-md px-3 py-2 text-left text-[13px] gap-0.5"
                data-search-file="${escapeHtml(r.file)}" data-search-ws="${escapeHtml(r.workspace || "")}">
          <div class="flex items-center justify-between w-full">
            <span class="truncate font-medium" style="max-width: 170px;">${escapeHtml(truncate(r.name, 55))}</span>
            <span class="text-[11px] text-pi-text-dim flex-shrink-0">${timeAgo(r.date)}</span>
          </div>
          <div class="text-[11px] text-pi-text-dim truncate" style="max-width: 210px;">${escapeHtml(r.matchSnippet || "")}</div>
        </button>
      `;
		}
	}
	return html;
}

// ─── Project Tree (Sidebar Threads + Workspaces) ────────────

function renderProjectTree() {
	const projectTreeEl = document.getElementById("project-tree");
	if (!projectTreeEl) return;

	// If backend search results are available, render those instead
	if (state.searchResults !== null) {
		const html = renderSearchResults();
		projectTreeEl.innerHTML = html;
		// Attach click handlers for search results
		projectTreeEl.querySelectorAll("[data-search-file]").forEach((btn) => {
			btn.addEventListener("click", () => {
				const file = btn.dataset.searchFile;
				const ws = btn.dataset.searchWs;
				if (file) {
					state.activeView = "threads";
					state.viewingOldThread = true;
					if (ws && ws !== "__current__") {
						state.activeWorkspace = ws;
					} else {
						state.activeWorkspace = null;
					}
					send({ type: "open-thread", file });
				}
			});
		});
		renderHiddenWorkspacesBar([]);
		return;
	}

	const allThreads = data.threads || [];
	const threads = allThreads.filter((t) => matchesThreadSearch(t.name));
	const workspaces = data.workspaces || [];
	let html = "";

	// ─── Current workspace (collapsible) ─────────────────────
	const hasCurrentMatches = threadSearchQuery && threads.length > 0;
	const currentExpanded = hasCurrentMatches || state.expandedWorkspaces["__current__"] !== false;
	// When searching: hide current workspace if no threads match
	const showCurrentWs = !threadSearchQuery || hasCurrentMatches;
	const branch = data.gitBranch
		? ` <span style="color:var(--accent);">\u00b7 ${escapeHtml(data.gitBranch)}</span>`
		: "";

	if (showCurrentWs) {
		html += `
    <div class="flex items-center gap-2 px-3 py-2 text-[13px] cursor-pointer hover:bg-pi-sidebar-hover rounded-md" data-ws-toggle="__current__">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" class="text-pi-text-muted" style="flex-shrink:0;transition:transform 0.15s;transform:rotate(${currentExpanded ? 90 : 0}deg);">
        <path d="M8 5l8 7-8 7z"/>
      </svg>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-pi-text-muted" style="flex-shrink:0">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      </svg>
      <span class="font-medium" style="color:var(--text);">${escapeHtml(data.projectName || "")}</span>${branch}
    </div>
  `;

		// Current workspace sessions (shown when expanded)
		if (currentExpanded) {
			html += `<div id="ws-sessions-__current__">`;

			// Current session (hidden when searching)
			if (!threadSearchQuery) {
				html += `
        <button class="thread-item flex w-full items-center justify-between rounded-md px-7 py-1.5 text-left text-[13px] ${state.activeThreadIdx === -1 && state.activeView === "threads" && !state.activeWorkspace ? "active" : ""}"
              data-thread-idx="-1" data-ws="__current__">
        <span class="truncate font-medium" style="max-width: 170px; color: var(--accent);">\u25cf Current session</span>
        <span class="text-[11px] text-pi-text-dim flex-shrink-0">now</span>
      </button>
      `;
			}

			for (let i = 0; i < threads.length; i++) {
				const t = threads[i];
				const origIdx = allThreads.indexOf(t);
				const isActive = origIdx === state.activeThreadIdx && state.activeView === "threads" && !state.activeWorkspace;
				html += `
        <button class="thread-item flex w-full items-center justify-between rounded-md px-7 py-1.5 text-left text-[13px] ${isActive ? "active" : ""}"
                data-thread-idx="${origIdx}" data-ws="__current__">
          <span class="truncate" style="max-width: 170px;">${escapeHtml(truncate(t.name, 55))}</span>
          <span class="text-[11px] text-pi-text-dim flex-shrink-0">${timeAgo(t.date)}</span>
        </button>
      `;
			}
			html += `</div>`;
		}
	} // end showCurrentWs

	// ─── Other workspaces ─────────────────────────────────────
	const cwd = data.cwd || "";
	const visibleWs = workspaces.filter((ws) => ws.path !== cwd && !state.hiddenWorkspaces[ws.dirName]);
	const hiddenWs = workspaces.filter((ws) => ws.path !== cwd && state.hiddenWorkspaces[ws.dirName]);

	for (const ws of visibleWs) {
		const sessions = state.workspaceSessions[ws.dirName] || [];
		const filteredSessions = sessions.filter((s) => matchesThreadSearch(s.name));
		const hasWsMatches = threadSearchQuery && filteredSessions.length > 0;
		const sessionsLoading = threadSearchQuery && !state.workspaceSessions[ws.dirName];

		// Auto-fetch sessions when searching if not yet loaded
		if (sessionsLoading) {
			send({ type: "get-workspace-sessions", dirName: ws.dirName });
		}

		// When searching: hide workspaces with no matches (unless still loading)
		if (threadSearchQuery && !hasWsMatches && !sessionsLoading) continue;

		const isExpanded = hasWsMatches || sessionsLoading || !!state.expandedWorkspaces[ws.dirName];
		const arrowRotation = isExpanded ? "rotate(90deg)" : "rotate(0deg)";

		html += `
      <div class="flex items-center gap-2 px-3 py-2 text-[13px] cursor-pointer hover:bg-pi-sidebar-hover rounded-md" data-ws-toggle="${escapeHtml(ws.dirName)}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" class="text-pi-text-muted" style="flex-shrink:0;transition:transform 0.15s;transform:${arrowRotation};">
          <path d="M8 5l8 7-8 7z"/>
        </svg>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-pi-text-muted" style="flex-shrink:0">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        <span class="font-medium truncate" style="color:var(--text);max-width:140px;">${escapeHtml(ws.name)}</span>
        <span class="ml-auto text-[11px] text-pi-text-dim flex-shrink-0">${ws.sessionCount}</span>
      </div>
    `;

		if (isExpanded) {
			html += `<div id="ws-sessions-${escapeHtml(ws.dirName)}">`;
			if (sessions.length === 0) {
				html += `<div class="px-7 py-1.5 text-[12px] text-pi-text-dim">Loading...</div>`;
			} else {
				for (let i = 0; i < filteredSessions.length; i++) {
					const s = filteredSessions[i];
					const origIdx = sessions.indexOf(s);
					const isActive =
						state.activeWorkspace === ws.dirName && state.activeThreadIdx === origIdx && state.activeView === "threads";
					html += `
            <button class="thread-item flex w-full items-center justify-between rounded-md px-7 py-1.5 text-left text-[13px] ${isActive ? "active" : ""}"
                    data-thread-idx="${origIdx}" data-ws="${escapeHtml(ws.dirName)}" data-ws-file="${escapeHtml(s.file)}">
              <span class="truncate" style="max-width: 170px;">${escapeHtml(truncate(s.name, 55))}</span>
              <span class="text-[11px] text-pi-text-dim flex-shrink-0">${timeAgo(s.date)}</span>
            </button>
          `;
				}
			}
			html += `</div>`;
		}
	}

	// Show "no results" when searching and nothing matches
	if (threadSearchQuery && html.trim() === "") {
		html = `<div class="px-3 py-4 text-center text-[13px] text-pi-text-dim">No threads found</div>`;
	}

	projectTreeEl.innerHTML = html;

	// Render hidden workspaces bar (pinned at bottom of sidebar)
	renderHiddenWorkspacesBar(hiddenWs);

	// ─── Event listeners ──────────────────────────────────────

	// Workspace toggle (expand/collapse)
	projectTreeEl.querySelectorAll("[data-ws-toggle]").forEach((el) => {
		el.addEventListener("click", () => {
			const dirName = el.dataset.wsToggle;
			state.expandedWorkspaces[dirName] = !state.expandedWorkspaces[dirName];
			if (dirName !== "__current__" && state.expandedWorkspaces[dirName] && !state.workspaceSessions[dirName]) {
				// Fetch sessions for this workspace
				send({ type: "get-workspace-sessions", dirName });
			}
			renderProjectTree();
		});
	});

	// Thread click
	projectTreeEl.querySelectorAll("[data-thread-idx]").forEach((btn) => {
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			const idx = parseInt(btn.dataset.threadIdx);
			const ws = btn.dataset.ws;

			state.activeThreadIdx = idx;
			state.activeView = "threads";
			setActiveNav("threads");

			if (ws === "__current__") {
				state.activeWorkspace = null;
				// Reset explorer tree to current workspace
				state.explorerTreeExpanded = {};
				state.explorerTreeChildren = {};
				state.explorerTreeRoot = null;
				if (idx === -1) {
					state.viewingOldThread = false;
					send({ type: "get-stats" });
					renderMainContent();
				} else {
					state.viewingOldThread = true;
					send({ type: "open-thread", file: data.threads[idx]?.file, index: idx });
				}
			} else {
				// Viewing a session from another workspace
				state.activeWorkspace = ws;
				// Reset explorer tree for other workspace
				state.explorerTreeExpanded = {};
				state.explorerTreeChildren = {};
				state.explorerTreeRoot = null;
				state.viewingOldThread = true;
				const file = btn.dataset.wsFile;
				if (file) {
					send({ type: "open-thread", file, index: idx, workspace: ws });
				}
			}
		});
	});

	// Right-click on workspace headers → context menu to hide/show
	projectTreeEl.querySelectorAll("[data-ws-toggle]").forEach((el) => {
		const dirName = el.dataset.wsToggle;
		if (dirName === "__current__" || dirName === "__hidden__") return;
		el.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();
			showWsContextMenu(e.clientX, e.clientY, [
				{
					label: "Hide from sidebar",
					action: () => {
						state.hiddenWorkspaces[dirName] = true;
						send({ type: "set-hidden-workspaces", hiddenWorkspaces: state.hiddenWorkspaces });
						renderProjectTree();
					},
				},
			]);
		});
	});
}

// ─── Workspace Context Menu ─────────────────────────────────

function showWsContextMenu(x, y, items) {
	// Remove any existing context menu
	dismissWsContextMenu();

	const menu = document.createElement("div");
	menu.id = "ws-context-menu";
	menu.style.cssText = `position:fixed;z-index:200;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:4px;min-width:160px;box-shadow:0 8px 24px rgba(0,0,0,0.3);`;

	// Position: ensure menu stays in viewport
	menu.style.left = x + "px";
	menu.style.top = y + "px";

	for (const item of items) {
		const btn = document.createElement("button");
		btn.textContent = item.label;
		btn.style.cssText = `display:block;width:100%;text-align:left;padding:8px 12px;border:none;background:none;color:var(--text);font-size:13px;cursor:pointer;border-radius:6px;`;
		btn.addEventListener("mouseover", () => {
			btn.style.background = "var(--sidebar-hover)";
		});
		btn.addEventListener("mouseout", () => {
			btn.style.background = "none";
		});
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			dismissWsContextMenu();
			item.action();
		});
		menu.appendChild(btn);
	}

	document.body.appendChild(menu);

	// Adjust if overflows viewport
	requestAnimationFrame(() => {
		const rect = menu.getBoundingClientRect();
		if (rect.right > window.innerWidth) menu.style.left = window.innerWidth - rect.width - 8 + "px";
		if (rect.bottom > window.innerHeight) menu.style.top = y - rect.height + "px";
	});

	// Dismiss on click outside or escape
	function onDismiss(e) {
		if (!menu.contains(e.target)) dismissWsContextMenu();
	}
	function onKey(e) {
		if (e.key === "Escape") dismissWsContextMenu();
	}
	setTimeout(() => {
		document.addEventListener("click", onDismiss, { once: true });
		document.addEventListener("contextmenu", onDismiss, { once: true });
		document.addEventListener("keydown", onKey, { once: true });
	}, 0);

	menu._cleanup = () => {
		document.removeEventListener("click", onDismiss);
		document.removeEventListener("contextmenu", onDismiss);
		document.removeEventListener("keydown", onKey);
	};
}

function dismissWsContextMenu() {
	const existing = document.getElementById("ws-context-menu");
	if (existing) {
		if (existing._cleanup) existing._cleanup();
		existing.remove();
	}
}

// ─── Hidden Workspaces Bar (pinned bottom of sidebar) ───────

function renderHiddenWorkspacesBar(hiddenWs) {
	// Remove existing bar and popover
	const existingBar = document.getElementById("hidden-ws-bar");
	if (existingBar) existingBar.remove();
	const existingPopover = document.getElementById("hidden-ws-popover");
	if (existingPopover) existingPopover.remove();

	if (!hiddenWs || hiddenWs.length === 0) return;

	// Create the bar pinned at bottom of sidebar
	const sidebar = document.getElementById("sidebar");
	if (!sidebar) return;

	const bar = document.createElement("div");
	bar.id = "hidden-ws-bar";
	bar.style.cssText = "border-top:1px solid var(--border);padding:4px 8px;flex-shrink:0;";
	bar.innerHTML = `
    <div class="flex items-center gap-2 px-3 py-2 text-[12px] cursor-pointer hover:bg-pi-sidebar-hover rounded-md sidebar-expanded-only" style="color:var(--text-muted);">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="flex-shrink:0;">
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>
      </svg>
      <span>Hidden workspaces</span>
      <span class="ml-auto text-[11px]">${hiddenWs.length}</span>
    </div>
  `;
	sidebar.appendChild(bar);

	// Click handler: toggle popover growing upward
	bar.querySelector("div").addEventListener("click", () => {
		const existing = document.getElementById("hidden-ws-popover");
		if (existing) {
			existing.remove();
			return;
		}

		const barRect = bar.getBoundingClientRect();

		const popover = document.createElement("div");
		popover.id = "hidden-ws-popover";
		popover.style.cssText = `
      position: fixed;
      left: ${barRect.left}px;
      bottom: ${window.innerHeight - barRect.top + 4}px;
      width: ${barRect.width}px;
      max-height: 300px;
      overflow-y: auto;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 6px;
      box-shadow: 0 -8px 24px rgba(0,0,0,0.25);
      z-index: 150;
    `;

		let popHtml =
			'<div style="padding:4px 8px 6px;font-size:11px;font-weight:600;color:var(--text-dim);">Hidden workspaces</div>';
		for (const ws of hiddenWs) {
			popHtml += `
        <div class="flex items-center gap-2 px-3 py-2 text-[13px] cursor-pointer hover:bg-pi-sidebar-hover rounded-md" style="color:var(--text-muted);opacity:0.75;transition:opacity 0.15s;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.75'" data-unhide-ws="${escapeHtml(ws.dirName)}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="flex-shrink:0;">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
          <span class="truncate" style="max-width:130px;">${escapeHtml(ws.name)}</span>
          <span class="ml-auto text-[11px]" style="color:var(--text-dim);">${ws.sessionCount}</span>
        </div>
      `;
		}
		popover.innerHTML = popHtml;

		document.body.appendChild(popover);

		// Right-click on items to show in sidebar
		popover.querySelectorAll("[data-unhide-ws]").forEach((el) => {
			const dirName = el.dataset.unhideWs;
			el.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				e.stopPropagation();
				showWsContextMenu(e.clientX, e.clientY, [
					{
						label: "Show in sidebar",
						action: () => {
							delete state.hiddenWorkspaces[dirName];
							send({ type: "set-hidden-workspaces", hiddenWorkspaces: state.hiddenWorkspaces });
							popover.remove();
							renderProjectTree();
						},
					},
				]);
			});
			el.addEventListener("click", (e) => {
				e.stopPropagation();
				delete state.hiddenWorkspaces[dirName];
				send({ type: "set-hidden-workspaces", hiddenWorkspaces: state.hiddenWorkspaces });
				popover.remove();
				renderProjectTree();
			});
		});

		// Close popover on click outside (but not if context menu is open)
		function closePopover(e) {
			const ctxMenu = document.getElementById("ws-context-menu");
			if (ctxMenu && ctxMenu.contains(e.target)) return;
			if (!popover.contains(e.target) && !bar.contains(e.target)) {
				popover.remove();
				document.removeEventListener("click", closePopover);
				document.removeEventListener("keydown", closeOnEsc);
			}
		}
		function closeOnEsc(e) {
			if (e.key === "Escape") {
				popover.remove();
				document.removeEventListener("click", closePopover);
				document.removeEventListener("keydown", closeOnEsc);
			}
		}
		setTimeout(() => {
			document.addEventListener("click", closePopover);
			document.addEventListener("keydown", closeOnEsc);
		}, 0);
	});
}

// ─── Breadcrumb ───────────────────────────────────────────────

function renderBreadcrumb() {
	// Show active workspace name if viewing another workspace's thread
	let projectLabel = data.projectName;
	if (state.activeWorkspace && state.activeWorkspace !== "__current__") {
		const ws = (data.workspaces || []).find((w) => w.dirName === state.activeWorkspace);
		if (ws) projectLabel = ws.name;
	}
	const parts = [escapeHtml(projectLabel)];
	if (state.activeView === "threads") {
		if (data.gitBranch) {
			parts.push(
				`<span class="rounded px-2 py-0.5 text-[12px] font-medium" style="background:var(--breadcrumb-badge);">${escapeHtml(data.gitBranch)}</span>`,
			);
		}
		if (state.activeThreadIdx === -1) {
			parts.push(`<span style="color:var(--accent);">current session</span>`);
		} else {
			const thread = data.threads?.[state.activeThreadIdx];
			if (thread)
				parts.push(`<span class="truncate" style="max-width:400px;">${escapeHtml(truncate(thread.name, 80))}</span>`);
		}
	} else {
		const labels = {
			workspace: "Workspace",
			skills: "Skills & Extensions",
			settings: "Settings",
			explorer: "Explorer",
		};
		parts.push(labels[state.activeView] || state.activeView);
		if (state.activeView === "explorer" && state.viewingFile) {
			parts.push(`<span class="truncate" style="max-width:400px;">${escapeHtml(state.viewingFile.name)}</span>`);
		}
	}
	breadcrumbEl.innerHTML = parts.join(`<span class="text-pi-text-dim"> / </span>`);
}

// ─── Messages Rendering ──────────────────────────────────────

function renderMessageHtml(msg) {
	// Check cache first (skip for running tools since they update)
	var cacheKey = getMsgCacheKey(msg);
	if (msg.status !== "running" && _renderCache.has(cacheKey)) {
		return _renderCache.get(cacheKey);
	}

	var result;
	if (msg.role === "user") {
		result = `
      <div class="msg-animate mb-4 flex justify-end">
        <div class="max-w-[75%] rounded-2xl px-4 py-3 text-[14px]" style="background:var(--user-bubble);">
          ${escapeHtml(msg.content)}
        </div>
      </div>
    `;
	} else if (msg.role === "assistant") {
		result = `
      <div class="msg-animate mb-5">
        <div class="message-content text-[14.5px] leading-relaxed" style="color:var(--text);">
          ${renderMarkdown(msg.content)}
        </div>
      </div>
    `;
	} else if (msg.role === "thinking") {
		// Persisted thinking block — always collapsed
		result = `
      <div class="msg-animate mb-3">
        <details class="rounded-lg border" style="border-color: var(--border);">
          <summary class="cursor-pointer px-3 py-2 text-[12px] font-medium" style="color: var(--text-muted);">
            \uD83D\uDCAD Thinking <span class="text-[11px] font-normal" style="color: var(--text-dim);">(${msg.content.length} chars)</span>
          </summary>
          <div class="border-t px-3 py-2" style="border-color: var(--border); max-height: 300px; overflow-y: auto;">
            <pre class="text-[12px] whitespace-pre-wrap" style="color:var(--text-muted);">${escapeHtml(msg.content)}</pre>
          </div>
        </details>
      </div>
    `;
	} else if (msg.role === "tool") {
		const isRunning = msg.status === "running";
		const statusIcon = isRunning
			? '<span class="tool-spinner" style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin-right:4px;"></span>'
			: msg.isError
				? '<span style="color:#e55;">\u2717 Error</span>'
				: '<span style="color:#3b3;">\u2713</span>';
		const toolIcon = getToolIcon(msg.toolName);
		const hasEditDiffs = msg.editDiffs && msg.editDiffs.length > 0;
		const diffId = hasEditDiffs ? `diff-inline-${ensureMsgId(msg)}` : null;

		let detailsHtml = "";

		// For edit tools with diffs, show inline diff preview
		if (hasEditDiffs) {
			let diffPreview = "";
			msg.editDiffs.forEach((diff, i) => {
				const editLabel =
					msg.editDiffs.length > 1
						? `<div style="color:var(--text-dim);font-size:11px;font-weight:600;padding:4px 0;">Edit ${i + 1}</div>`
						: "";
				const oldLines = (diff.oldText || "").split("\n");
				const newLines = (diff.newText || "").split("\n");
				diffPreview += `${editLabel}<div style="display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--border);border-radius:6px;overflow:hidden;margin-bottom:6px;">
          <div style="padding:8px 10px;font-family:monospace;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-all;background:color-mix(in srgb, #e55 8%, var(--bg));border-right:1px solid var(--border);">${oldLines.map((l) => '<span style="display:block;background:color-mix(in srgb, #e55 15%, transparent);">' + escapeHtml(l) + "</span>").join("")}</div>
          <div style="padding:8px 10px;font-family:monospace;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-all;background:color-mix(in srgb, #3b3 8%, var(--bg));">${newLines.map((l) => '<span style="display:block;background:color-mix(in srgb, #3b3 15%, transparent);">' + escapeHtml(l) + "</span>").join("")}</div>
        </div>`;
			});

			detailsHtml += `
        <div class="border-t px-3 py-2" style="border-color: var(--border);cursor:pointer;" id="${diffId}" title="Click to expand full diff">
          <div class="text-[11px] font-semibold mb-1" style="color: var(--accent);">\u{1F50D} ${escapeHtml(msg.editPath || "")} \u2014 ${msg.editDiffs.length} edit(s) <span style="color:var(--text-dim);">(click to expand)</span></div>
          <div style="max-height:200px;overflow:hidden;">${diffPreview}</div>
        </div>
      `;
		} else if (msg.argsDisplay) {
			detailsHtml += `
        <div class="border-t px-3 py-2" style="border-color: var(--border);">
          <div class="text-[11px] font-semibold mb-1" style="color: var(--text-muted);">Input</div>
          <pre class="text-[12px] whitespace-pre-wrap overflow-x-auto" style="color:var(--text); max-height: 200px; overflow-y: auto;"><code>${escapeHtml(msg.argsDisplay)}</code></pre>
        </div>
      `;
		}
		if (msg.resultText && !isRunning) {
			detailsHtml += `
        <div class="border-t px-3 py-2" style="border-color: var(--border);">
          <div class="text-[11px] font-semibold mb-1" style="color: var(--text-muted);">Output</div>
          <pre class="text-[12px] whitespace-pre-wrap overflow-x-auto" style="color:var(--text-muted); max-height: 300px; overflow-y: auto;"><code>${escapeHtml(msg.resultText)}</code></pre>
        </div>
      `;
		}

		result = `
      <div class="msg-animate mb-3">
        <details class="rounded-lg border" style="border-color: var(--border);" ${isRunning || hasEditDiffs ? "open" : ""}>
          <summary class="cursor-pointer px-3 py-2 text-[12px] font-medium flex items-center gap-2" style="color: var(--text-muted);">
            <span>${toolIcon}</span>
            <span>${escapeHtml(msg.toolName || "Tool call")}</span>
            <span class="ml-auto">${statusIcon}</span>
          </summary>
          ${detailsHtml}
        </details>
      </div>
    `;
	}
	if (result && msg.status !== "running") {
		_renderCache.set(cacheKey, result);
	}
	return result || "";
}

function getToolIcon(toolName) {
	const icons = {
		bash: "\u2699\uFE0F",
		read: "\uD83D\uDCC4",
		edit: "\u270F\uFE0F",
		write: "\uD83D\uDCDD",
		grep: "\uD83D\uDD0D",
		find: "\uD83D\uDD0E",
		ls: "\uD83D\uDCC2",
		mcp: "\uD83D\uDD0C",
		parallel_search: "\uD83C\uDF10",
		parallel_research: "\uD83E\uDDEA",
		parallel_extract: "\uD83D\uDCE5",
		subagent: "\uD83E\uDD16",
		claude: "\uD83E\uDDE0",
		todo: "\u2611\uFE0F",
	};
	return icons[toolName] || "\uD83D\uDD27";
}

// ─── Diff Overlay ─────────────────────────────────────────────

// ─── Word-level diff engine ───────────────────────────────────

function computeWordDiff(oldStr, newStr) {
	const oldWords = oldStr.split(/(\s+)/);
	const newWords = newStr.split(/(\s+)/);

	// Simple LCS-based word diff
	const m = oldWords.length,
		n = newWords.length;
	const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i][j] = oldWords[i - 1] === newWords[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
		}
	}

	// Backtrack to get diff operations
	const result = [];
	let i = m,
		j = n;
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && oldWords[i - 1] === newWords[j - 1]) {
			result.unshift({ type: "same", text: oldWords[i - 1] });
			i--;
			j--;
		} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
			result.unshift({ type: "add", text: newWords[j - 1] });
			j--;
		} else {
			result.unshift({ type: "del", text: oldWords[i - 1] });
			i--;
		}
	}
	return result;
}

function renderUnifiedDiff(oldText, newText) {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");

	// Build line pairs using simple LCS for line-level alignment
	const pairs = [];
	let oi = 0,
		ni = 0;
	while (oi < oldLines.length || ni < newLines.length) {
		if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
			pairs.push({ type: "same", old: oldLines[oi], new: newLines[ni], oldNum: oi + 1, newNum: ni + 1 });
			oi++;
			ni++;
		} else if (oi < oldLines.length && ni < newLines.length) {
			pairs.push({ type: "changed", old: oldLines[oi], new: newLines[ni], oldNum: oi + 1, newNum: ni + 1 });
			oi++;
			ni++;
		} else if (oi < oldLines.length) {
			pairs.push({ type: "deleted", old: oldLines[oi], new: null, oldNum: oi + 1, newNum: null });
			oi++;
		} else {
			pairs.push({ type: "added", old: null, new: newLines[ni], oldNum: null, newNum: ni + 1 });
			ni++;
		}
	}

	// Group into chunks: changed/added/deleted lines, or runs of unchanged
	let leftHtml = "";
	let rightHtml = "";
	let i = 0;
	const CONTEXT = 2; // unchanged lines to show around changes

	while (i < pairs.length) {
		const p = pairs[i];

		if (p.type === "same") {
			// Find run of unchanged lines
			let runStart = i;
			while (i < pairs.length && pairs[i].type === "same") i++;
			const runLen = i - runStart;

			if (runLen > CONTEXT * 2 + 1) {
				// Show first CONTEXT, collapse middle, show last CONTEXT
				for (let j = runStart; j < runStart + CONTEXT; j++) {
					const ln = pairs[j];
					leftHtml += `<div class="diff-line diff-line-unchanged"><span class="diff-line-num">${ln.oldNum}</span><span class="diff-line-content">${escapeHtml(ln.old)}</span></div>`;
					rightHtml += `<div class="diff-line diff-line-unchanged"><span class="diff-line-num">${ln.newNum}</span><span class="diff-line-content">${escapeHtml(ln.new)}</span></div>`;
				}
				const hidden = runLen - CONTEXT * 2;
				leftHtml += `<div class="diff-collapsed">\u22EF ${hidden} unchanged lines \u22EF</div>`;
				rightHtml += `<div class="diff-collapsed">\u22EF ${hidden} unchanged lines \u22EF</div>`;
				for (let j = i - CONTEXT; j < i; j++) {
					const ln = pairs[j];
					leftHtml += `<div class="diff-line diff-line-unchanged"><span class="diff-line-num">${ln.oldNum}</span><span class="diff-line-content">${escapeHtml(ln.old)}</span></div>`;
					rightHtml += `<div class="diff-line diff-line-unchanged"><span class="diff-line-num">${ln.newNum}</span><span class="diff-line-content">${escapeHtml(ln.new)}</span></div>`;
				}
			} else {
				for (let j = runStart; j < i; j++) {
					const ln = pairs[j];
					leftHtml += `<div class="diff-line diff-line-unchanged"><span class="diff-line-num">${ln.oldNum}</span><span class="diff-line-content">${escapeHtml(ln.old)}</span></div>`;
					rightHtml += `<div class="diff-line diff-line-unchanged"><span class="diff-line-num">${ln.newNum}</span><span class="diff-line-content">${escapeHtml(ln.new)}</span></div>`;
				}
			}
		} else if (p.type === "changed") {
			const wordDiff = computeWordDiff(p.old, p.new);
			let oldWords = "",
				newWords = "";
			for (const op of wordDiff) {
				if (op.type === "same") {
					oldWords += escapeHtml(op.text);
					newWords += escapeHtml(op.text);
				} else if (op.type === "del") {
					oldWords += `<span class="diff-word-removed">${escapeHtml(op.text)}</span>`;
				} else {
					newWords += `<span class="diff-word-added">${escapeHtml(op.text)}</span>`;
				}
			}
			leftHtml += `<div class="diff-line diff-line-removed"><span class="diff-line-num">${p.oldNum}</span><span class="diff-line-content">${oldWords}</span></div>`;
			rightHtml += `<div class="diff-line diff-line-added"><span class="diff-line-num">${p.newNum}</span><span class="diff-line-content">${newWords}</span></div>`;
			i++;
		} else if (p.type === "deleted") {
			leftHtml += `<div class="diff-line diff-line-removed"><span class="diff-line-num">${p.oldNum}</span><span class="diff-line-content">${escapeHtml(p.old)}</span></div>`;
			rightHtml += `<div class="diff-line diff-empty-line"></div>`;
			i++;
		} else if (p.type === "added") {
			leftHtml += `<div class="diff-line diff-empty-line"></div>`;
			rightHtml += `<div class="diff-line diff-line-added"><span class="diff-line-num">${p.newNum}</span><span class="diff-line-content">${escapeHtml(p.new)}</span></div>`;
			i++;
		} else {
			i++;
		}
	}

	return `<div class="diff-columns">
    <div class="diff-col-header diff-col-header-old">\u2212 Original</div>
    <div class="diff-col-header diff-col-header-new">+ Modified</div>
  </div>
  <div class="diff-columns" style="flex:1;overflow:hidden;">
    <div class="diff-col diff-col-old scrollbar-thin diff-sync-scroll" style="overflow-y:auto;">${leftHtml}</div>
    <div class="diff-col diff-col-new scrollbar-thin diff-sync-scroll" style="overflow-y:auto;">${rightHtml}</div>
  </div>`;
}

function showDiffOverlay(editPath, editDiffs) {
	closeDiffOverlay();

	const overlay = document.createElement("div");
	overlay.id = "diff-overlay";
	overlay.className = "diff-overlay";
	overlay.addEventListener("click", (e) => {
		if (e.target === overlay) closeDiffOverlay();
	});

	const fileName = editPath.replace(/\\/g, "/").split("/").pop() || editPath;

	let editsHtml = "";
	editDiffs.forEach((diff, i) => {
		const label = editDiffs.length > 1 ? `Edit ${i + 1} of ${editDiffs.length}` : "";
		const labelHtml = label ? `<div class="diff-edit-label">${escapeHtml(label)}</div>` : "";

		editsHtml += `
      <div class="diff-edit-block" style="display:flex;flex-direction:column;">
        ${labelHtml}
        <div style="font-family:'SF Mono','Cascadia Code','Fira Code','Consolas',monospace;font-size:13px;line-height:1.6;display:flex;flex-direction:column;flex:1;">
          ${renderUnifiedDiff(diff.oldText || "", diff.newText || "")}
        </div>
      </div>
    `;
	});

	const stats = editDiffs.reduce(
		(acc, d) => {
			acc.removed += (d.oldText || "").split("\n").length;
			acc.added += (d.newText || "").split("\n").length;
			return acc;
		},
		{ removed: 0, added: 0 },
	);

	overlay.innerHTML = `
    <div class="diff-panel">
      <div class="diff-header">
        <div style="display:flex;align-items:center;gap:12px;">
          <span style="color:var(--accent);font-weight:600;font-size:14px;">\u270F\uFE0F ${escapeHtml(fileName)}</span>
          <span style="color:#e55;font-size:12px;font-weight:600;">\u2212${stats.removed}</span>
          <span style="color:#3b3;font-size:12px;font-weight:600;">+${stats.added}</span>
          <span style="color:var(--text-dim);font-size:12px;">${editDiffs.length} edit(s)</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="color:var(--text-dim);font-size:11px;">${escapeHtml(editPath)}</span>
          <button id="diff-close-btn" style="color:var(--text-muted);font-size:22px;cursor:pointer;padding:2px 10px;border:none;background:none;border-radius:6px;line-height:1;" onmouseover="this.style.background='var(--sidebar-hover)'" onmouseout="this.style.background='none'">&times;</button>
        </div>
      </div>
      <div class="diff-body scrollbar-thin">
        ${editsHtml}
      </div>
    </div>
  `;

	document.body.appendChild(overlay);
	document.getElementById("diff-close-btn")?.addEventListener("click", closeDiffOverlay);

	// Sync scroll between left and right diff columns
	const syncPairs = overlay.querySelectorAll(".diff-columns");
	syncPairs.forEach((pair) => {
		const cols = pair.querySelectorAll(".diff-sync-scroll");
		if (cols.length === 2) {
			let syncing = false;
			cols[0].addEventListener("scroll", () => {
				if (syncing) return;
				syncing = true;
				cols[1].scrollTop = cols[0].scrollTop;
				syncing = false;
			});
			cols[1].addEventListener("scroll", () => {
				if (syncing) return;
				syncing = true;
				cols[0].scrollTop = cols[1].scrollTop;
				syncing = false;
			});
		}
	});

	const escHandler = (e) => {
		if (e.key === "Escape") {
			closeDiffOverlay();
			document.removeEventListener("keydown", escHandler);
		}
	};
	document.addEventListener("keydown", escHandler);
}

function closeDiffOverlay() {
	const el = document.getElementById("diff-overlay");
	if (el) el.remove();
}

// Give each message a stable ID for DOM updates
let msgIdCounter = 0;
function ensureMsgId(msg) {
	if (!msg._id) msg._id = "msg-" + ++msgIdCounter;
	return msg._id;
}

function renderMessages() {
	const msgs = state.messages;
	if ((!msgs || msgs.length === 0) && !state.isStreaming) {
		messagesEl.innerHTML = `
      <div class="flex h-full items-center justify-center">
        <div class="text-center" style="color: var(--text-dim);">
          <div class="mb-2 text-3xl">&#x25C8;</div>
          <div class="text-sm">Start a conversation</div>
          <div class="mt-1 text-[12px]">Type a message below or use the terminal</div>
        </div>
      </div>
    `;
		return;
	}

	let html = "";
	for (const msg of msgs) {
		const id = ensureMsgId(msg);
		html += `<div id="${id}">${renderMessageHtml(msg)}</div>`;
	}

	// Show live thinking block
	if (state.isStreaming && state.isThinking && state.thinkingText) {
		html += `
      <div class="mb-3" id="thinking-msg">
        <details open class="rounded-lg border" style="border-color: var(--border);">
          <summary class="cursor-pointer px-3 py-2 text-[12px] font-medium" style="color: var(--text-muted);">
            &#x1F4AD; Thinking...
          </summary>
          <div class="border-t px-3 py-2" style="border-color: var(--border);">
            <div class="text-[12px] opacity-70 whitespace-pre-wrap" style="color:var(--text-muted); max-height: 200px; overflow-y: auto;">${escapeHtml(state.thinkingText.slice(-500))}</div>
          </div>
        </details>
      </div>
    `;
	}

	// Show streaming message
	if (state.isStreaming && state.streamingText) {
		html += `
      <div class="mb-5" id="streaming-msg">
        <div class="message-content text-[14.5px] leading-relaxed" style="color:var(--text);">
          ${renderMarkdown(state.streamingText)}
        </div>
        <div class="mt-1 flex items-center gap-1">
          <span class="tool-spinner" style="width:10px;height:10px;"></span>
          <span class="text-[11px]" style="color: var(--text-dim);">streaming...</span>
        </div>
      </div>
    `;
	}

	// Show waiting indicator
	if (state.isStreaming && !state.streamingText && !state.isThinking) {
		html += `
      <div class="mb-4 flex items-center gap-2 text-[13px]" id="waiting-indicator" style="color: var(--text-muted);">
        <span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span>
        <span>Working...</span>
      </div>
    `;
	}

	messagesEl.innerHTML = html;
	scrollToBottom();
}

// ---- Incremental DOM updates (avoid full re-render) ----

// Append a single message without rebuilding everything
function appendMessage(msg) {
	const id = ensureMsgId(msg);
	// Remove waiting/streaming indicators before appending
	removeEphemeralElements();
	const div = document.createElement("div");
	div.id = id;
	div.innerHTML = renderMessageHtml(msg);
	messagesEl.appendChild(div);
	scrollToBottom();
}

// Update a tool message in-place without touching other elements
function updateToolInPlace(toolCallId, updates) {
	const msg = state.messages.find((m) => m.role === "tool" && m.toolCallId === toolCallId);
	if (!msg) return;
	Object.assign(msg, updates);
	const el = document.getElementById(msg._id);
	if (el) {
		el.innerHTML = renderMessageHtml(msg);
	}
}

// Remove ephemeral elements (streaming msg, thinking msg, waiting indicator)
function removeEphemeralElements() {
	for (const id of ["streaming-msg", "thinking-msg", "waiting-indicator"]) {
		const el = document.getElementById(id);
		if (el) el.remove();
	}
}

// Add or update the streaming message without full re-render
function showStreamingBlock() {
	removeEphemeralElements();
	if (state.streamingText) {
		const div = document.createElement("div");
		div.id = "streaming-msg";
		div.className = "mb-5";
		div.innerHTML = `
      <div class="message-content text-[14.5px] leading-relaxed" style="color:var(--text);">
        ${renderMarkdown(state.streamingText)}
      </div>
      <div class="mt-1 flex items-center gap-1">
        <span class="tool-spinner" style="width:10px;height:10px;"></span>
        <span class="text-[11px]" style="color: var(--text-dim);">streaming...</span>
      </div>
    `;
		messagesEl.appendChild(div);
		scrollToBottom();
	}
}

function showWaitingIndicator() {
	if (document.getElementById("waiting-indicator")) return;
	removeEphemeralElements();
	const div = document.createElement("div");
	div.id = "waiting-indicator";
	div.className = "mb-4 flex items-center gap-2 text-[13px]";
	div.style.color = "var(--text-muted)";
	div.innerHTML =
		'<span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span><span>Working...</span>';
	messagesEl.appendChild(div);
	scrollToBottom();
}

// ─── Skills & Extensions View ─────────────────────────────────

function renderSkillsView() {
	const skills = data.skills || [];
	const extensions = data.extensions || [];
	let html = `<div class="space-y-2 p-2">`;
	html += `<div class="flex items-center justify-between px-2 pb-2">
    <h3 class="text-sm font-semibold">${skills.length} Skills Available</h3>
    <button id="btn-refresh-skills" class="text-[12px] px-2 py-1 rounded hover:bg-pi-sidebar-hover" style="color:var(--accent);">Refresh</button>
  </div>`;
	for (const s of skills) {
		html += `
      <div class="skill-card rounded-lg border p-3 cursor-pointer hover:bg-pi-sidebar-hover" style="border-color: var(--border); transition: background 0.1s;" data-skill="${escapeHtml(s.name)}">
        <div class="flex items-center gap-2">
          <span>\uD83E\uDDE9</span>
          <span class="font-semibold text-[14px]">${escapeHtml(s.name)}</span>
        </div>
        <div class="mt-1 text-[13px]" style="color: var(--text-muted);">${escapeHtml(s.desc || "No description")}</div>
      </div>
    `;
	}

	// Extensions section
	if (extensions.length > 0) {
		html += `<div class="px-2 pt-4 pb-2">
      <h3 class="text-sm font-semibold">${extensions.length} Extensions Loaded</h3>
    </div>`;
		for (const ext of extensions) {
			const typeLabel = ext.type === "builtin" ? "built-in" : ext.type === "package" ? "package" : "local";
			const typeColor =
				ext.type === "builtin" ? "var(--accent)" : ext.type === "package" ? "var(--text-muted)" : "var(--text-muted)";
			html += `
        <div class="rounded-lg border p-3" style="border-color: var(--border); transition: background 0.1s;">
          <div class="flex items-center gap-2">
            <span style="color: var(--accent);">\u2699</span>
            <span class="font-semibold text-[14px]">${escapeHtml(ext.name)}</span>
            <span class="text-[11px] px-1.5 py-0.5 rounded" style="background: color-mix(in srgb, ${typeColor} 15%, transparent); color: ${typeColor};">${typeLabel}</span>
          </div>
          <div class="mt-1 text-[13px]" style="color: var(--text-muted);">${escapeHtml(ext.source)}</div>
        </div>
      `;
		}
	}

	html += `</div>`;
	messagesEl.innerHTML = html;

	// Skill click handler: ask pi to load the skill
	messagesEl.querySelectorAll("[data-skill]").forEach((card) => {
		card.addEventListener("click", () => {
			const skillName = card.dataset.skill;
			send({ type: "send-message", text: `Load the ${skillName} skill and tell me what it does.` });
			setActiveNav("threads");
			state.activeThreadIdx = -1;
			state.viewingOldThread = false;
		});
	});

	const refreshBtn = document.getElementById("btn-refresh-skills");
	if (refreshBtn) refreshBtn.addEventListener("click", () => send({ type: "refresh-skills" }));
}

// ─── Settings View ────────────────────────────────────────────

function renderSettingsView() {
	const items = [
		["Model", data.model],
		["Thinking", data.thinkingLevel],
		["Directory", data.cwd],
		["Git Branch", data.gitBranch || "none"],
		["Provider", data.provider || "unknown"],
	];
	let html = `<div class="mx-auto max-w-xl space-y-4 p-4">
    <h2 class="text-lg font-semibold">Settings</h2>
    <div class="rounded-lg border overflow-hidden" style="border-color: var(--border);">`;
	for (const [label, value] of items) {
		html += `
      <div class="flex items-center justify-between border-b px-4 py-3" style="border-color: var(--border);">
        <span class="text-[13px]" style="color: var(--text-muted);">${escapeHtml(label)}</span>
        <span class="text-[13px] font-medium" style="color:var(--accent);">${escapeHtml(value || "—")}</span>
      </div>
    `;
	}
	html += `</div>`;

	// Available commands
	html += `<h3 class="text-sm font-semibold mt-6">Available Commands</h3>
    <div class="rounded-lg border overflow-hidden" style="border-color: var(--border);">`;
	const cmds = state.commands.length ? state.commands : data.commands || [];
	for (const cmd of cmds.slice(0, 30)) {
		html += `
      <div class="flex items-center justify-between border-b px-4 py-2 cursor-pointer hover:bg-pi-sidebar-hover" style="border-color: var(--border);" data-cmd="/${escapeHtml(cmd.name)}">
        <span class="text-[13px] font-mono" style="color:var(--accent);">/${escapeHtml(cmd.name)}</span>
        <span class="text-[12px]" style="color: var(--text-muted);">${escapeHtml(truncate(cmd.description, 50))}</span>
      </div>
    `;
	}
	html += `</div></div>`;
	messagesEl.innerHTML = html;

	// Click a command to type it
	messagesEl.querySelectorAll("[data-cmd]").forEach((el) => {
		el.addEventListener("click", () => {
			inputTextEl.value = el.dataset.cmd;
			inputTextEl.focus();
			setActiveNav("threads");
			state.activeThreadIdx = -1;
			state.viewingOldThread = false;
		});
	});
}

// ─── Workspace View ───────────────────────────────────────────

function renderWorkspaceView() {
	const s = data.stats || {};
	const html = `<div class="mx-auto max-w-2xl p-4">
    <h2 class="text-lg font-semibold mb-4">\u25C8 ${escapeHtml(data.projectName)}</h2>
    <div class="grid grid-cols-4 gap-3 mb-6">
      ${[
				[fmt(s.input || 0), "Input"],
				[fmt(s.output || 0), "Output"],
				[fmt(s.cache || 0), "Cache"],
				["$" + (s.cost || 0).toFixed(4), "Cost"],
			]
				.map(
					([val, label]) => `
        <div class="rounded-lg border p-4 text-center" style="border-color: var(--border);">
          <div class="text-xl font-bold" style="color:var(--accent);">${val}</div>
          <div class="text-[12px] mt-1" style="color: var(--text-dim);">${label}</div>
        </div>
      `,
				)
				.join("")}
    </div>
    <div class="rounded-lg border p-4" style="border-color: var(--border);">
      <div class="text-sm font-semibold mb-3">Session Info</div>
      <div class="grid grid-cols-2 gap-2 text-[13px]">
        <div style="color:var(--text-muted);">Directory</div><div>${escapeHtml(data.cwd)}</div>
        <div style="color:var(--text-muted);">Model</div><div style="color:var(--accent);">${escapeHtml(data.model)}</div>
        <div style="color:var(--text-muted);">Git Branch</div><div style="color:var(--accent);">${escapeHtml(data.gitBranch || "none")}</div>
        <div style="color:var(--text-muted);">Thinking</div><div>${escapeHtml(data.thinkingLevel)}</div>
        <div style="color:var(--text-muted);">Messages</div><div>${state.messages.length}</div>
        <div style="color:var(--text-muted);">Threads</div><div>${(data.threads || []).length}</div>
      </div>
    </div>
  </div>`;
	messagesEl.innerHTML = html;
}

// ─── Workspace Modal ──────────────────────────────────────────

function showWorkspaceModal() {
	// Request fresh workspace list
	send({ type: "get-workspaces" });
	state.showWorkspaceModal = true;
	renderWorkspaceModal();
}

function renderWorkspaceModal() {
	// Remove existing modal
	const existing = document.getElementById("workspace-modal");
	if (existing) existing.remove();

	if (!state.showWorkspaceModal) return;

	const workspaces = data.workspaces || [];

	let wsListHtml = "";
	for (const ws of workspaces) {
		const isCurrent = ws.path === data.cwd;
		wsListHtml += `
      <button class="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left hover:bg-pi-sidebar-hover" style="transition: background 0.1s;" data-ws-add="${escapeHtml(ws.dirName)}" data-ws-path="${escapeHtml(ws.path)}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;color:var(--accent);">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        <div class="min-w-0 flex-1">
          <div class="font-medium text-[14px]" style="color:var(--text);">${escapeHtml(ws.name)}${isCurrent ? ' <span style="color:var(--accent);font-size:12px;">(current)</span>' : ""}</div>
          <div class="text-[12px] truncate" style="color:var(--text-dim);">${escapeHtml(ws.path)}</div>
        </div>
        <div class="text-[12px] flex-shrink-0" style="color:var(--text-dim);">${ws.sessionCount} sessions</div>
      </button>
    `;
	}

	const modalHtml = `
    <div id="workspace-modal" style="position:fixed;inset:0;z-index:100;display:flex;align-items:flex-start;justify-content:center;padding-top:80px;background:rgba(0,0,0,0.5);">
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:12px;width:560px;max-height:70vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
        <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;">
          <div class="font-semibold text-[15px]" style="color:var(--text);">Open Workspace</div>
          <button id="ws-modal-close" style="color:var(--text-muted);font-size:20px;cursor:pointer;padding:2px 8px;border:none;background:none;border-radius:6px;line-height:1;" onmouseover="this.style.background='var(--sidebar-hover)'" onmouseout="this.style.background='none'">&times;</button>
        </div>
        <div style="padding:12px 20px;border-bottom:1px solid var(--border);">
          <div class="text-[12px] font-medium" style="color:var(--text-muted);margin-bottom:6px;">Open folder path</div>
          <div style="display:flex;gap:8px;">
            <input id="ws-path-input" type="text" placeholder="Enter or paste folder path..." style="flex:1;padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--input-bg, var(--sidebar-bg));color:var(--text);font-size:13px;outline:none;" />
            <button id="ws-path-open" style="padding:8px 16px;border-radius:8px;border:none;background:var(--accent);color:var(--bg);font-size:13px;font-weight:600;cursor:pointer;">Open</button>
          </div>
        </div>
        <div style="padding:8px 20px 4px;">
          <div class="text-[12px] font-medium" style="color:var(--text-muted);">Recent Workspaces</div>
        </div>
        <div style="overflow-y:auto;flex:1;padding:4px 12px 12px;">
          ${wsListHtml || '<div style="padding:20px;text-align:center;color:var(--text-dim);">No workspaces found</div>'}
        </div>
      </div>
    </div>
  `;

	document.body.insertAdjacentHTML("beforeend", modalHtml);

	// Close modal
	document.getElementById("ws-modal-close").addEventListener("click", closeWorkspaceModal);
	document.getElementById("workspace-modal").addEventListener("click", (e) => {
		if (e.target.id === "workspace-modal") closeWorkspaceModal();
	});

	// Workspace click — add to sidebar expanded
	document.querySelectorAll("[data-ws-add]").forEach((btn) => {
		btn.addEventListener("click", () => {
			const dirName = btn.dataset.wsAdd;
			state.expandedWorkspaces[dirName] = true;
			if (!state.workspaceSessions[dirName]) {
				send({ type: "get-workspace-sessions", dirName });
			}
			closeWorkspaceModal();
			renderProjectTree();
		});
	});

	// Open folder path input
	const pathInput = document.getElementById("ws-path-input");
	const pathOpenBtn = document.getElementById("ws-path-open");
	if (pathInput) pathInput.focus();

	function openFolderPath() {
		const path = (pathInput?.value || "").trim();
		if (!path) return;
		send({ type: "open-folder-path", path });
		closeWorkspaceModal();
	}

	if (pathOpenBtn) pathOpenBtn.addEventListener("click", openFolderPath);
	if (pathInput)
		pathInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") openFolderPath();
			if (e.key === "Escape") {
				e.stopPropagation();
				closeWorkspaceModal();
			}
		});
}

function closeWorkspaceModal() {
	state.showWorkspaceModal = false;
	const modal = document.getElementById("workspace-modal");
	if (modal) modal.remove();
}

// ─── Explorer Sidebar Tree ───────────────────────────────────

function renderExplorerTree() {
	if (!explorerTreeEl) return;
	const rootPath = state.explorerTreeRoot;
	// Back button to return to threads
	let html = `<div class="flex items-center gap-1.5 px-2 py-1.5 mb-1 cursor-pointer hover:bg-pi-sidebar-hover rounded text-[12px]" id="explorer-tree-back" style="color:var(--text-muted);">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
    <span>Threads</span>
  </div>`;
	if (!rootPath) {
		html += `<div class="py-4 text-center text-[12px]" style="color:var(--text-dim);">Loading…</div>`;
		explorerTreeEl.innerHTML = html;
		attachExplorerTreeBack();
		return;
	}
	const rootChildren = state.explorerTreeChildren[rootPath] || [];
	if (rootChildren.length === 0) {
		html += `<div class="py-4 text-center text-[12px]" style="color:var(--text-dim);">No files found.</div>`;
		explorerTreeEl.innerHTML = html;
		attachExplorerTreeBack();
		return;
	}
	html += renderTreeNodes(rootChildren, 0);
	explorerTreeEl.innerHTML = html;
	attachExplorerTreeBack();
	attachTreeListeners(explorerTreeEl);
}

function attachExplorerTreeBack() {
	document.getElementById("explorer-tree-back")?.addEventListener("click", () => {
		setActiveNav("threads");
	});
}

function renderTreeNodes(entries, depth) {
	let html = "";
	for (const f of entries) {
		const indent = depth * 16;
		const isExpanded = !!state.explorerTreeExpanded[f.path];
		if (f.isDir) {
			const chevron = isExpanded
				? `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" style="flex-shrink:0;"><path d="M7 10l5 5 5-5z"/></svg>`
				: `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" style="flex-shrink:0;"><path d="M10 7l5 5-5 5z"/></svg>`;
			html += `<div class="flex items-center gap-1 cursor-pointer hover:bg-pi-sidebar-hover rounded px-1 py-[2px] text-[12px]"
        style="padding-left:${indent + 4}px;" data-tree-dir="${escapeHtml(f.path)}">
        ${chevron}
        <span style="color:var(--accent);flex-shrink:0;">📁</span>
        <span class="truncate" style="color:var(--text);">${escapeHtml(f.name)}</span>
      </div>`;
			if (isExpanded) {
				const children = state.explorerTreeChildren[f.path] || [];
				if (children.length > 0) {
					html += renderTreeNodes(children, depth + 1);
				} else {
					html += `<div class="text-[11px]" style="padding-left:${indent + 24}px;color:var(--text-dim);">Loading…</div>`;
				}
			}
		} else {
			html += `<div class="flex items-center gap-1 cursor-pointer hover:bg-pi-sidebar-hover rounded px-1 py-[2px] text-[12px]"
        style="padding-left:${indent + 4}px;" data-tree-file="${escapeHtml(f.path)}">
        <span style="flex-shrink:0;width:10px;"></span>
        <span style="flex-shrink:0;">📄</span>
        <span class="truncate" style="color:var(--text-muted);">${escapeHtml(f.name)}</span>
      </div>`;
		}
	}
	return html;
}

function attachTreeListeners(container) {
	container.querySelectorAll("[data-tree-dir]").forEach((el) => {
		el.addEventListener("click", () => {
			const dirPath = el.dataset.treeDir;
			if (state.explorerTreeExpanded[dirPath]) {
				delete state.explorerTreeExpanded[dirPath];
				renderExplorerTree();
			} else {
				state.explorerTreeExpanded[dirPath] = true;
				if (!state.explorerTreeChildren[dirPath]) {
					send({ type: "explorer-tree-expand", path: dirPath });
				}
				renderExplorerTree();
			}
		});
	});
	container.querySelectorAll("[data-tree-file]").forEach((el) => {
		el.addEventListener("click", () => {
			send({ type: "explorer-open", path: el.dataset.treeFile });
		});
	});
}

// ─── Explorer View ────────────────────────────────────────────

function renderExplorerView() {
	// If viewing a file, show the file viewer instead
	if (state.viewingFile) {
		renderFileViewer();
		return;
	}
	const files = data.explorerFiles || [];
	let html = `<div class="p-2">`;
	if (files.length === 0) {
		html += `<div class="py-8 text-center text-sm" style="color: var(--text-dim);">No files loaded.</div>`;
	}
	for (const f of files) {
		const icon = f.isDir ? "\uD83D\uDCC1" : "\uD83D\uDCC4";
		html += `
      <button class="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-[13px] hover:bg-pi-sidebar-hover"
              data-explorer-path="${escapeHtml(f.path || "")}">
        <span>${icon}</span>
        <span class="${f.isDir ? "font-medium" : ""}">${escapeHtml(f.name)}</span>
        ${!f.isDir && f.size ? `<span class="ml-auto text-[11px]" style="color: var(--text-dim);">${f.size}</span>` : ""}
        ${f.isDir ? `<span class="ml-auto" style="color: var(--text-dim);">▸</span>` : ""}
      </button>
    `;
	}
	html += `</div>`;
	messagesEl.innerHTML = html;

	messagesEl.querySelectorAll("[data-explorer-path]").forEach((btn) => {
		btn.addEventListener("click", () => {
			send({ type: "explorer-open", path: btn.dataset.explorerPath });
		});
	});
}

// ─── File Viewer ──────────────────────────────────────────────

const EXT_TO_LANG = {
	js: "javascript",
	ts: "typescript",
	jsx: "javascript",
	tsx: "typescript",
	py: "python",
	rb: "ruby",
	rs: "rust",
	go: "go",
	java: "java",
	c: "c",
	cpp: "cpp",
	h: "c",
	hpp: "cpp",
	cs: "csharp",
	html: "xml",
	htm: "xml",
	xml: "xml",
	svg: "xml",
	css: "css",
	scss: "scss",
	less: "less",
	json: "json",
	yaml: "yaml",
	yml: "yaml",
	toml: "ini",
	md: "markdown",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	sql: "sql",
	php: "php",
	swift: "swift",
	kt: "kotlin",
	lua: "lua",
	r: "r",
	pl: "perl",
	dockerfile: "dockerfile",
	makefile: "makefile",
	cmake: "cmake",
};

function renderFileViewer() {
	const f = state.viewingFile;
	if (!f) return;

	const fileName = f.name || f.path.replace(/\\/g, "/").split("/").pop();
	const fileSize = f.size ? (f.size < 1024 ? f.size + " B" : (f.size / 1024).toFixed(1) + " KB") : "";

	let html = `<div style="display:flex;flex-direction:column;height:100%;">`;

	// Header bar with back button, file name, size
	html += `
    <div style="display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--border);flex-shrink:0;">
      <button id="file-viewer-back" style="background:none;border:1px solid var(--border);border-radius:6px;padding:4px 10px;cursor:pointer;color:var(--text-muted);font-size:13px;display:flex;align-items:center;gap:4px;" title="Back to file list">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
        Back
      </button>
      <span style="font-size:14px;font-weight:600;color:var(--text);">📄 ${escapeHtml(fileName)}</span>
      <span style="font-size:12px;color:var(--text-dim);margin-left:auto;">${escapeHtml(fileSize)}</span>
      <span style="font-size:11px;color:var(--text-dim);font-family:monospace;">${escapeHtml(f.path || "")}</span>
    </div>
  `;

	if (f.error) {
		html += `<div style="padding:32px;text-align:center;color:var(--text-muted);font-size:14px;">${escapeHtml(f.error)}</div>`;
	} else if (f.content != null) {
		// Detect language from extension
		const lang = EXT_TO_LANG[(f.ext || "").toLowerCase()] || "";
		let codeHtml = escapeHtml(f.content);

		// Syntax highlight if hljs supports the language
		if (typeof hljs !== "undefined" && lang && hljs.getLanguage(lang)) {
			try {
				codeHtml = hljs.highlight(f.content, { language: lang }).value;
			} catch (e) {
				/* fallback to escaped */
			}
		}

		// Line numbers + code
		const lines = f.content.split("\n");
		const lineCount = lines.length;
		const gutterWidth = String(lineCount).length * 9 + 16;

		html += `
      <div style="flex:1;overflow:auto;" class="scrollbar-thin">
        <div style="display:flex;font-family:'SF Mono','Cascadia Code','Fira Code','Consolas',monospace;font-size:13px;line-height:1.6;">
          <div style="flex-shrink:0;width:${gutterWidth}px;text-align:right;padding:12px 8px 12px 12px;color:var(--text-dim);user-select:none;border-right:1px solid var(--border);">
            ${Array.from({ length: lineCount }, (_, i) => `<div>${i + 1}</div>`).join("")}
          </div>
          <pre style="flex:1;margin:0;padding:12px 16px;overflow-x:auto;"><code class="${lang ? "language-" + lang + " hljs" : ""}" style="white-space:pre;">${codeHtml}</code></pre>
        </div>
      </div>
    `;
	} else {
		html += `<div style="padding:32px;text-align:center;color:var(--text-muted);font-size:14px;">Unable to load file content.</div>`;
	}

	html += `</div>`;
	messagesEl.innerHTML = html;

	// Back button handler
	document.getElementById("file-viewer-back")?.addEventListener("click", () => {
		state.viewingFile = null;
		renderExplorerView();
	});
}

// ─── Main Content Router ──────────────────────────────────────

function renderMainContent() {
	renderBreadcrumb();
	renderProjectTree();

	// Toggle explorer tree visibility in sidebar (inline after Explorer button)
	if (state.activeView === "explorer") {
		explorerTreeEl.style.display = "";
		renderExplorerTree();
	} else {
		explorerTreeEl.style.display = "none";
	}

	switch (state.activeView) {
		case "threads": {
			const thread = state.activeThreadIdx >= 0 ? data.threads?.[state.activeThreadIdx] : null;
			threadLabelEl.textContent = `${(data.projectName || "").toUpperCase()} \u00b7 ${(data.gitBranch || "LOCAL").toUpperCase()}`;
			threadTitleEl.textContent = thread ? truncate(thread.name, 100) : "Current session";
			threadHeaderEl.style.display = "";
			renderMessages();
			break;
		}
		case "skills":
			threadHeaderEl.style.display = "none";
			renderSkillsView();
			break;
		case "settings":
			threadHeaderEl.style.display = "none";
			renderSettingsView();
			break;
		case "workspace":
			threadHeaderEl.style.display = "none";
			renderWorkspaceView();
			break;
		case "explorer":
			threadHeaderEl.style.display = "none";
			renderExplorerView();
			break;
	}
}

// ─── Diff Click Delegation ────────────────────────────────────

messagesEl.addEventListener("click", (e) => {
	const diffArea = e.target.closest("[id^='diff-inline-']");
	if (!diffArea) return;
	const msgId = diffArea.id.replace("diff-inline-", "");
	const msg = state.messages.find((m) => m._id === msgId);
	if (msg && msg.editDiffs && msg.editDiffs.length > 0) {
		e.preventDefault();
		e.stopPropagation();
		showDiffOverlay(msg.editPath || msg.argsDisplay || "", msg.editDiffs);
	}
});

// ─── Stats Bar ────────────────────────────────────────────────

function renderStats() {
	const s = data.stats || {};
	statsBarEl.innerHTML = `
    <span>In ${fmt(s.input || 0)}</span>
    <span>Out ${fmt(s.output || 0)}</span>
    <span>Cache ${fmt(s.cache || 0)}</span>
    <span>Total ${fmt((s.input || 0) + (s.output || 0))}</span>
    <span>$${(s.cost || 0).toFixed(4)}</span>
  `;
	modelLabelEl.textContent = data.model || "unknown";
	thinkingLabelEl.textContent = data.thinkingLevel || "medium";
}

// ─── Input Handling ───────────────────────────────────────────

function autoResizeInput() {
	inputTextEl.style.height = "auto";
	inputTextEl.style.height = Math.min(inputTextEl.scrollHeight, 120) + "px";
}

inputTextEl.addEventListener("input", () => {
	autoResizeInput();
	updateCommandSuggestions();
});

inputTextEl.addEventListener("keydown", (e) => {
	// Handle command suggestion navigation — only when popup is actually visible
	const suggestionsEl = document.getElementById("cmd-suggestions");
	const suggestionsVisible =
		suggestionsEl && suggestionsEl.style.display !== "none" && suggestionsEl.children.length > 0;

	if (suggestionsVisible) {
		const items = suggestionsEl.querySelectorAll("[data-cmd-suggestion]");
		let activeIdx = -1;
		items.forEach((item, i) => {
			if (item.classList.contains("cmd-active")) activeIdx = i;
		});

		if (e.key === "ArrowDown") {
			e.preventDefault();
			const next = Math.min(activeIdx + 1, items.length - 1);
			items.forEach((item, i) => item.classList.toggle("cmd-active", i === next));
			return;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			const prev = Math.max(activeIdx - 1, 0);
			items.forEach((item, i) => item.classList.toggle("cmd-active", i === prev));
			return;
		}
		if (e.key === "Tab") {
			e.preventDefault();
			const selected = items[Math.max(activeIdx, 0)];
			if (selected) {
				inputTextEl.value = "/" + selected.dataset.cmdSuggestion + " ";
				hideCommandSuggestions();
				autoResizeInput();
			}
			return;
		}
		if (e.key === "Escape") {
			e.preventDefault();
			hideCommandSuggestions();
			return;
		}
		// Enter always sends — don't intercept it for selection
	}

	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		hideCommandSuggestions();
		sendMessage();
	}

	// Escape cancels streaming when not in suggestions
	if (e.key === "Escape" && !suggestionsVisible && state.isStreaming) {
		e.preventDefault();
		cancelStreaming();
	}
});

// Global Escape / Ctrl+C to cancel streaming
document.addEventListener("keydown", function (e) {
	if (e.key === "Escape" && state.isStreaming) {
		e.preventDefault();
		cancelStreaming();
	}
	if (e.key === "c" && e.ctrlKey && state.isStreaming) {
		e.preventDefault();
		cancelStreaming();
	}
});

btnSend.addEventListener("click", function () {
	if (state.isStreaming) {
		cancelStreaming();
	} else {
		sendMessage();
	}
});

// ─── Attach Button ─────────────────────────────────────────────

const btnAttach = document.getElementById("btn-attach");
const pendingAttachments = [];

function renderAttachmentPills() {
	let container = document.getElementById("attachment-pills");
	if (!container) {
		container = document.createElement("div");
		container.id = "attachment-pills";
		container.className = "flex flex-wrap gap-1.5 px-1 pb-2";
		const inputWrapper = inputTextEl.closest(".rounded-xl");
		if (inputWrapper) inputWrapper.parentNode.insertBefore(container, inputWrapper);
	}
	if (pendingAttachments.length === 0) {
		container.innerHTML = "";
		container.style.display = "none";
		return;
	}
	container.style.display = "flex";
	container.innerHTML = pendingAttachments
		.map((att, i) => {
			const isImage = att.mimeType.startsWith("image/");
			const icon = isImage ? "\uD83D\uDDBC\uFE0F" : "\uD83D\uDCCE";
			return `<span class="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12px]" style="border-color:var(--border);background:var(--card-bg);">
      <span>${icon}</span>
      <span class="max-w-[120px] truncate">${escapeHtml(att.name)}</span>
      <button class="ml-0.5 hover:opacity-70" data-remove-attach="${i}" title="Remove">&times;</button>
    </span>`;
		})
		.join("");
	container.querySelectorAll("[data-remove-attach]").forEach((btn) => {
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			pendingAttachments.splice(parseInt(btn.dataset.removeAttach), 1);
			renderAttachmentPills();
		});
	});
}

function handleAttachedFileAck(path, name, error) {
	if (error || !path) {
		// Show error notification
		return;
	}
	pendingAttachments.push({ path, name, mimeType: "" });
	renderAttachmentPills();
	inputTextEl.focus();
}

if (btnAttach) {
	btnAttach.addEventListener("click", () => {
		const fileInput = document.createElement("input");
		fileInput.type = "file";
		fileInput.multiple = true;
		fileInput.accept =
			"image/*,.txt,.md,.js,.ts,.py,.json,.yaml,.yml,.toml,.csv,.log,.xml,.html,.css,.sh,.bat,.ps1,.go,.rs,.c,.cpp,.h,.java,.rb,.php,.sql,.pdf,.docx,.xlsx";
		fileInput.addEventListener("change", () => {
			if (!fileInput.files || fileInput.files.length === 0) return;
			for (const file of fileInput.files) {
				const reader = new FileReader();
				reader.onload = () => {
					const base64 = reader.result.split(",")[1];
					send({
						type: "attach-file",
						name: file.name,
						mimeType: file.type || "application/octet-stream",
						base64,
					});
				};
				reader.readAsDataURL(file);
			}
		});
		fileInput.click();
	});
}

// ─── Image Paste (Ctrl+V / Cmd+V) ─────────────────────────────

document.addEventListener("paste", (e) => {
	const items = e.clipboardData?.items;
	if (!items) return;
	for (const item of items) {
		if (item.type.startsWith("image/")) {
			e.preventDefault();
			const blob = item.getAsFile();
			if (!blob) continue;
			const reader = new FileReader();
			reader.onload = () => {
				const base64 = reader.result.split(",")[1];
				send({
					type: "attach-file",
					name: `clipboard-image.${blob.type.split("/")[1] || "png"}`,
					mimeType: blob.type,
					base64,
				});
			};
			reader.readAsDataURL(blob);
			break;
		}
	}
});

function sendMessage() {
	const text = inputTextEl.value.trim();
	if (!text && pendingAttachments.length === 0) return;

	hideCommandSuggestions();

	// If viewing old thread, switch to current session first
	if (state.viewingOldThread) {
		state.viewingOldThread = false;
		state.activeThreadIdx = -1;
		// Restore current session messages (will be rebuilt from streaming)
		state.messages = data.messages || [];
		renderProjectTree();
	}

	// Build message text with attachment paths
	let fullText = text;
	if (pendingAttachments.length > 0) {
		const paths = pendingAttachments.map((a) => a.path).join(" ");
		fullText = fullText ? `${fullText} ${paths}` : paths;
	}

	// Add user message locally
	state.messages.push({ role: "user", content: fullText });
	renderMessages();

	// Send to pi
	send({ type: "send-message", text: fullText });

	// Clear input and attachments
	pendingAttachments.length = 0;
	renderAttachmentPills();
	inputTextEl.value = "";
	autoResizeInput();
	inputTextEl.focus();
}

btnNewThread.addEventListener("click", () => {
	send({ type: "send-message", text: "/new" });
});

// ─── Command Suggestions ──────────────────────────────────────

function updateCommandSuggestions() {
	const text = inputTextEl.value;
	// Only show suggestions when actively typing a command (starts with / and no spaces yet)
	if (!text.startsWith("/") || text.includes(" ")) {
		hideCommandSuggestions();
		return;
	}

	const query = text.slice(1).toLowerCase();
	const allCmds = state.commands.length ? state.commands : data.commands || [];
	const matches = allCmds.filter((c) => c.name.toLowerCase().startsWith(query)).slice(0, 8);

	if (matches.length === 0) {
		hideCommandSuggestions();
		return;
	}

	showCommandSuggestions(matches);
}

function showCommandSuggestions(commands) {
	let el = document.getElementById("cmd-suggestions");
	if (!el) {
		el = document.createElement("div");
		el.id = "cmd-suggestions";
		el.className = "cmd-suggestions";
		// Insert above the input area
		const inputArea = inputTextEl.closest(".input-area");
		if (inputArea) inputArea.style.position = "relative";
		inputArea?.insertBefore(el, inputArea.firstChild);
	}

	el.innerHTML = commands
		.map(
			(cmd, i) => `
    <div class="cmd-suggestion-item ${i === 0 ? "cmd-active" : ""}" data-cmd-suggestion="${escapeHtml(cmd.name)}">
      <span class="font-mono font-medium" style="color: var(--accent);">/​${escapeHtml(cmd.name)}</span>
      <span class="text-[12px]" style="color: var(--text-muted);">${escapeHtml(truncate(cmd.description || "", 50))}</span>
    </div>
  `,
		)
		.join("");

	el.style.display = "block";

	// Click handler for suggestions
	el.querySelectorAll("[data-cmd-suggestion]").forEach((item) => {
		item.addEventListener("click", () => {
			inputTextEl.value = "/" + item.dataset.cmdSuggestion + " ";
			hideCommandSuggestions();
			inputTextEl.focus();
			autoResizeInput();
		});
	});
}

function hideCommandSuggestions() {
	const el = document.getElementById("cmd-suggestions");
	if (el) {
		el.style.display = "none";
		el.innerHTML = "";
	}
}

// ─── Glimpse Communication ───────────────────────────────────

function send(payload) {
	if (window.glimpse?.send) {
		window.glimpse.send(payload);
	}
}

// ─── Receive Messages from Extension ─────────────────────────

window.__desktopReceive = function (message) {
	if (!message || typeof message !== "object") return;

	switch (message.type) {
		// ─── Streaming ─────────────────────────────
		case "agent-start":
			state.isStreaming = true;
			state.streamingText = "";
			state.activeTools = [];
			stopMermaidObserver();
			if (state.activeView === "threads" && !state.viewingOldThread) showWaitingIndicator();
			updateStreamingUI();
			break;

		case "agent-end":
			state.isStreaming = false;
			state.activeTools = [];
			removeEphemeralElements();
			startMermaidObserver();
			updateStreamingUI();
			inputTextEl.disabled = false;
			btnSend.disabled = false;
			break;

		case "message-start":
			if (message.role === "assistant") {
				state.streamingText = "";
				state.thinkingText = "";
				state.isThinking = false;
			}
			break;

		case "message-chunk-start":
			state.streamingText = "";
			break;

		case "message-chunk":
			state.streamingText += message.text;
			state.isThinking = false;
			updateStreamingMessage();
			break;

		case "message-chunk-end":
			// text_end with full content — could use for validation
			break;

		case "thinking-start":
			state.isThinking = true;
			state.thinkingText = "";
			if (state.activeView === "threads" && !state.viewingOldThread) renderMessages();
			break;

		case "thinking-chunk":
			state.thinkingText += message.text;
			updateThinkingMessage();
			break;

		case "thinking-end":
			// Persist thinking text as a collapsed message
			if (state.thinkingText.trim()) {
				const thinkMsg = { role: "thinking", content: state.thinkingText };
				state.messages.push(thinkMsg);
				if (state.activeView === "threads" && !state.viewingOldThread) {
					appendMessage(thinkMsg);
				}
			}
			state.isThinking = false;
			state.thinkingText = "";
			break;

		case "toolcall-stream-start":
			break;

		case "toolcall-stream-end":
			break;

		case "message-end":
			if (message.role === "assistant" && message.content) {
				const assistMsg = { role: "assistant", content: message.content };
				state.messages.push(assistMsg);
				state.streamingText = "";
				state.thinkingText = "";
				if (state.activeView === "threads" && !state.viewingOldThread) {
					removeEphemeralElements();
					appendMessage(assistMsg);
				}
			}
			break;

		case "tool-start": {
			// Decode base64-encoded diffs for edit tools
			let editDiffs = null;
			let editPath = message.editPath || "";
			if (message.editDiffsB64) {
				try {
					const binary = atob(message.editDiffsB64);
					const bytes = new Uint8Array(binary.length);
					for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
					const decoded = new TextDecoder().decode(bytes);
					editDiffs = JSON.parse(decoded);
				} catch (e) {
					console.log("[desktop] failed to decode diffs:", e);
				}
			}

			const toolMsg = {
				role: "tool",
				toolName: message.toolName,
				toolCallId: message.toolCallId,
				argsDisplay: message.argsDisplay || "",
				resultText: "",
				status: "running",
				isError: false,
				editDiffs: editDiffs,
				editPath: editPath,
			};
			state.messages.push(toolMsg);
			if (state.activeView === "threads" && !state.viewingOldThread) appendMessage(toolMsg);
			break;
		}

		case "tool-end": {
			const existing = state.messages.find(
				(m) => m.role === "tool" && m.toolCallId === message.toolCallId && m.status === "running",
			);
			if (existing) {
				// In-place update - preserves <details> open state of other elements
				updateToolInPlace(message.toolCallId, {
					status: "done",
					isError: message.isError,
					resultText: message.resultText || "",
				});
			} else {
				const toolMsg2 = {
					role: "tool",
					toolName: message.toolName,
					toolCallId: message.toolCallId,
					argsDisplay: "",
					resultText: message.resultText || "",
					status: "done",
					isError: message.isError,
				};
				state.messages.push(toolMsg2);
				if (state.activeView === "threads" && !state.viewingOldThread) appendMessage(toolMsg2);
			}
			break;
		}

		// ─── User input from terminal ──────────────
		// Removed - was causing duplicate messages

		// ─── Thread/data updates ───────────────────
		case "thread-messages":
			state.messages = message.messages || [];
			if (message.threadIdx !== undefined) state.activeThreadIdx = message.threadIdx;
			state.viewingOldThread = true;
			state.activeView = "threads";
			setActiveNav("threads");
			renderMainContent();
			break;

		case "stats-update":
			data.stats = message.stats;
			renderStats();
			break;

		case "explorer-data":
			data.explorerFiles = message.files || [];
			state.viewingFile = null; // back to file list
			if (state.activeView === "explorer") renderExplorerView();
			break;

		case "explorer-tree-children":
			if (message.parentPath) {
				state.explorerTreeChildren[message.parentPath] = message.children || [];
				if (!state.explorerTreeRoot) state.explorerTreeRoot = message.parentPath;
				if (state.activeView === "explorer") renderExplorerTree();
			}
			break;

		case "file-content":
			if (message.error) {
				state.viewingFile = {
					path: message.path,
					name: message.name,
					ext: message.ext,
					content: null,
					error: message.error,
					size: message.size,
				};
			} else {
				state.viewingFile = {
					path: message.path,
					name: message.name,
					ext: message.ext,
					content: message.content,
					size: message.size,
				};
			}
			if (state.activeView === "explorer") renderExplorerView();
			break;

		case "update-threads":
			data.threads = message.threads || [];
			renderProjectTree();
			break;

		case "update-skills":
			data.skills = message.skills || [];
			data.extensions = message.extensions || data.extensions || [];
			if (state.activeView === "skills") renderSkillsView();
			break;

		case "commands-list":
			state.commands = message.commands || [];
			if (state.activeView === "settings") renderSettingsView();
			break;

		case "workspaces-list":
			data.workspaces = message.workspaces || [];
			if (state.showWorkspaceModal) renderWorkspaceModal();
			renderProjectTree();
			break;

		case "workspace-sessions":
			if (message.dirName) {
				state.workspaceSessions[message.dirName] = message.sessions || [];
				renderProjectTree();
			}
			break;

		case "search-results":
			if (message.query && threadSearchQuery && message.query.toLowerCase() === threadSearchQuery) {
				state.searchResults = message.results || [];
				renderProjectTree();
			}
			break;

		case "workspace-opened":
			if (message.dirName) {
				// Reset explorer tree for new workspace
				state.explorerTreeExpanded = {};
				state.explorerTreeChildren = {};
				state.explorerTreeRoot = null;
				state.viewingFile = null;
				data.explorerFiles = [];
				// Re-request explorer data if explorer is active
				if (state.activeView === "explorer") {
					send({ type: "nav", action: "explorer" });
				}
				// Add to workspaces list if not already there
				const wsPath = message.path || "";
				const wsName = wsPath.split(/[\\/]/).pop() || wsPath;
				if (!data.workspaces) data.workspaces = [];
				if (!data.workspaces.find((w) => w.dirName === message.dirName)) {
					data.workspaces.push({
						name: wsName,
						path: wsPath,
						dirName: message.dirName,
						sessionCount: (message.sessions || []).length,
						lastActive: new Date().toISOString(),
					});
				}
				state.workspaceSessions[message.dirName] = message.sessions || [];
				state.expandedWorkspaces[message.dirName] = true;
				renderProjectTree();
			}
			break;

		case "file-attached-ack": {
			const att = {
				path: message.path || "",
				name: message.name || "file",
				mimeType: message.mimeType || "",
			};
			if (message.error || !att.path) break;
			pendingAttachments.push(att);
			renderAttachmentPills();
			inputTextEl.focus();
			break;
		}

		case "plan-mode-violation": {
			showPlanModeWarning(message.toolName, message.argsPreview);
			break;
		}
	}
};

// ─── Plan Mode Warning Toast ────────────────────────────────────

function showPlanModeWarning(toolName, argsPreview) {
	// Remove existing warning if any
	const existing = document.getElementById("plan-mode-warning");
	if (existing) existing.remove();

	const toast = document.createElement("div");
	toast.id = "plan-mode-warning";
	toast.style.cssText = `
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 200;
    background: color-mix(in srgb, #e55 12%, var(--bg));
    border: 1px solid color-mix(in srgb, #e55 40%, var(--border));
    border-radius: 10px;
    padding: 12px 16px;
    max-width: 400px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.25);
    animation: fadeIn 0.2s ease-out;
  `;
	toast.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
      <span style="font-size:16px;">\u26a0\ufe0f</span>
      <span style="font-weight:600;font-size:13px;color:#e55;">Plan Mode Violation</span>
      <button onclick="this.closest('#plan-mode-warning').remove()" style="margin-left:auto;color:var(--text-dim);border:none;background:none;cursor:pointer;font-size:16px;line-height:1;">&times;</button>
    </div>
    <div style="font-size:12px;color:var(--text-muted);">
      <strong>${escapeHtml(toolName)}</strong> attempted while Plan Mode is active.
      <div style="margin-top:4px;font-family:monospace;font-size:11px;color:var(--text-dim);max-height:60px;overflow:hidden;">${escapeHtml(argsPreview || "")}</div>
    </div>
  `;
	document.body.appendChild(toast);

	// Auto-dismiss after 6 seconds
	setTimeout(() => {
		toast.style.opacity = "0";
		toast.style.transition = "opacity 0.3s";
		setTimeout(() => toast.remove(), 300);
	}, 6000);
}

// ─── Streaming UI Updates ─────────────────────────────────────

function cancelStreaming() {
	if (!state.isStreaming) return;
	send({ type: "cancel-streaming" });
}

function updateStreamingUI() {
	// Update send button: show cancel (stop) button while streaming
	if (state.isStreaming) {
		btnSend.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
		btnSend.title = "Cancel (Escape)";
		btnSend.style.background = "#c0392b";
		btnSend.onclick = function (e) {
			e.preventDefault();
			cancelStreaming();
		};
	} else {
		btnSend.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`;
		btnSend.title = "Send";
		btnSend.style.background = "";
		btnSend.onclick = null;
	}

	if (state.activeView === "threads" && !state.viewingOldThread) {
		renderMessages();
	}
}

function updateStreamingMessage() {
	const streamDiv = document.getElementById("streaming-msg");
	if (streamDiv) {
		const contentDiv = streamDiv.querySelector(".message-content");
		if (contentDiv) {
			contentDiv.innerHTML = renderMarkdown(state.streamingText);
			scrollToBottom();
			return;
		}
	}
	// No streaming div yet - create one (append, don't rebuild)
	if (state.activeView === "threads" && !state.viewingOldThread) {
		showStreamingBlock();
	}
}

function updateThinkingMessage() {
	const thinkDiv = document.getElementById("thinking-msg");
	if (thinkDiv) {
		const contentDiv = thinkDiv.querySelector(".whitespace-pre-wrap");
		if (contentDiv) {
			contentDiv.textContent = state.thinkingText.slice(-500);
			scrollToBottom();
			return;
		}
	}
	// No thinking div yet - create one
	if (state.activeView === "threads" && !state.viewingOldThread) {
		removeEphemeralElements();
		const div = document.createElement("div");
		div.id = "thinking-msg";
		div.className = "mb-3";
		div.innerHTML = `
      <details open class="rounded-lg border" style="border-color: var(--border);">
        <summary class="cursor-pointer px-3 py-2 text-[12px] font-medium" style="color: var(--text-muted);">
          &#x1F4AD; Thinking...
        </summary>
        <div class="border-t px-3 py-2" style="border-color: var(--border);">
          <div class="text-[12px] opacity-70 whitespace-pre-wrap" style="color:var(--text-muted); max-height: 200px; overflow-y: auto;">${escapeHtml(state.thinkingText.slice(-500))}</div>
        </div>
      </details>
    `;
		messagesEl.appendChild(div);
		scrollToBottom();
	}
}

// ─── Keyboard Shortcuts ──────────────────────────────────────

document.addEventListener("keydown", (e) => {
	if (e.ctrlKey && e.key >= "1" && e.key <= "5") {
		e.preventDefault();
		const views = ["workspace", "threads", "skills", "settings", "explorer"];
		const view = views[parseInt(e.key) - 1];
		if (view === "workspace") {
			showWorkspaceModal();
		} else {
			setActiveNav(view);
		}
	}

	// Ctrl+B: toggle sidebar
	if (e.ctrlKey && e.key === "b") {
		e.preventDefault();
		toggleSidebar();
	}

	// Ctrl+P: toggle plan mode
	if (e.ctrlKey && !e.shiftKey && e.key === "p") {
		e.preventDefault();
		setPlanMode(!state.planMode);
	}

	if (e.key === "Escape") {
		// Close workspace modal first
		if (state.showWorkspaceModal) {
			closeWorkspaceModal();
			return;
		}
		// If viewing old thread, go back to current
		if (state.viewingOldThread) {
			state.viewingOldThread = false;
			state.activeThreadIdx = -1;
			state.activeWorkspace = null;
			state.messages = data.messages || [];
			renderMainContent();
		}
	}

	if (e.key === "/" && document.activeElement !== inputTextEl) {
		e.preventDefault();
		inputTextEl.focus();
	}

	// Ctrl+N: focus input
	if (e.ctrlKey && e.key === "n") {
		e.preventDefault();
		inputTextEl.focus();
		inputTextEl.value = "";
	}
});

// ─── Init ─────────────────────────────────────────────────────

renderStats();
renderMainContent();
setTheme("dark");
inputTextEl.focus();

// Request fresh data
send({ type: "get-commands" });
send({ type: "get-stats" });
