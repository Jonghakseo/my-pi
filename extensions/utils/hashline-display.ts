const HASH_GLYPH_PATTERN = "[ZPMQVRWSNKTXJBYH]{2}";

const HASHLINE_WITH_LINE_RE = new RegExp(
	`^(?<prefix>\\s*(?:>>>|>>)?\\s*)(?<lineNum>\\d+)\\s*#\\s*(?:${HASH_GLYPH_PATTERN}):(?<content>.*)$`,
);
const HASHLINE_WITHOUT_LINE_RE = new RegExp(
	`^(?<prefix>\\s*(?:>>>|>>)?\\s*)#\\s*(?:${HASH_GLYPH_PATTERN}):(?<content>.*)$`,
);
const DISPLAYABLE_DIFF_LINE_RE = new RegExp(
	`^(?<prefix>[+\\- ])(?<lineNum>\\s*\\d+)(?:(?:\\s*#\\s*(?:${HASH_GLYPH_PATTERN}):)|(?:\\s{4})|(?:\\s*:\\s?)|(?:\\s))(?<content>.*)$`,
);

function formatLineNumber(lineNum: string, content: string): string {
	return content.length > 0 ? `${lineNum}: ${content}` : `${lineNum}:`;
}

export function formatHashlineLineForDisplay(line: string): string {
	const diffMatch = DISPLAYABLE_DIFF_LINE_RE.exec(line);
	if (diffMatch?.groups) {
		const { prefix, lineNum, content } = diffMatch.groups;
		return `${prefix}${formatLineNumber(lineNum, content)}`;
	}

	const lineMatch = HASHLINE_WITH_LINE_RE.exec(line);
	if (lineMatch?.groups) {
		const { prefix, lineNum, content } = lineMatch.groups;
		return `${prefix}${formatLineNumber(lineNum, content)}`;
	}

	const noLineMatch = HASHLINE_WITHOUT_LINE_RE.exec(line);
	if (noLineMatch?.groups) {
		const { prefix, content } = noLineMatch.groups;
		return `${prefix}${content}`;
	}

	return line;
}

export function formatHashlineTextForDisplay(text: string): string {
	return text.split("\n").map(formatHashlineLineForDisplay).join("\n");
}

export function parseDisplayableEditDiffLine(
	line: string,
): { prefix: "+" | "-" | " "; lineNum: string; content: string } | null {
	const match = DISPLAYABLE_DIFF_LINE_RE.exec(line);
	if (!match?.groups) {
		return null;
	}

	const prefix = match.groups.prefix;
	if (prefix !== "+" && prefix !== "-" && prefix !== " ") {
		return null;
	}

	return {
		prefix,
		lineNum: match.groups.lineNum.trim(),
		content: match.groups.content,
	};
}
