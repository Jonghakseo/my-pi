// ── Stopwords ────────────────────────────────────────────────────────────────

const EN_STOPWORDS = new Set([
	"a",
	"an",
	"the",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"shall",
	"should",
	"may",
	"might",
	"must",
	"can",
	"could",
	"to",
	"of",
	"in",
	"for",
	"on",
	"with",
	"at",
	"by",
	"from",
	"as",
	"into",
	"through",
	"during",
	"before",
	"after",
	"above",
	"below",
	"between",
	"out",
	"off",
	"over",
	"under",
	"again",
	"further",
	"then",
	"once",
	"and",
	"but",
	"or",
	"nor",
	"not",
	"so",
	"yet",
	"both",
	"either",
	"neither",
	"each",
	"every",
	"all",
	"any",
	"few",
	"more",
	"most",
	"other",
	"some",
	"such",
	"no",
	"only",
	"own",
	"same",
	"than",
	"too",
	"very",
	"just",
	"because",
	"if",
	"when",
	"while",
	"how",
	"what",
	"which",
	"who",
	"whom",
	"this",
	"that",
	"these",
	"those",
	"it",
	"its",
	"my",
	"your",
	"his",
	"her",
	"our",
	"their",
	"i",
	"me",
	"we",
	"you",
	"he",
	"she",
	"they",
	"them",
	"about",
	"up",
	"down",
	"here",
	"there",
	"where",
	"also",
	"like",
	"use",
	"used",
	"using",
	"get",
	"set",
	"new",
	"make",
	"need",
	"want",
	"know",
	"try",
	"let",
	"put",
	"take",
	"come",
	"go",
	"see",
	"look",
]);

const KO_STOPWORDS = new Set([
	"이",
	"그",
	"저",
	"것",
	"수",
	"등",
	"때",
	"중",
	"위",
	"내",
	"및",
	"는",
	"은",
	"을",
	"를",
	"에",
	"의",
	"가",
	"와",
	"과",
	"도",
	"로",
	"으로",
	"에서",
	"부터",
	"까지",
	"이다",
	"하다",
	"되다",
	"있다",
	"없다",
	"않다",
	"해야",
	"한다",
	"합니다",
	"입니다",
	"하는",
	"하고",
	"해서",
	"그리고",
	"하지만",
	"그러나",
	"또는",
	"혹은",
	"그래서",
	"따라서",
	"때문에",
]);

// ── Korean Suffix Stripping ───────────────────────────────────────────────────

/** Korean particles (조사) and endings (어미), sorted longest-first for greedy matching. */
const KO_SUFFIXES = [
	// 4-char 조사
	"에서부터",
	"으로부터",
	// 3-char 조사
	"에서는",
	"으로써",
	"에서의",
	"으로서",
	"이라는",
	"에게서",
	"으로는",
	"에서도",
	"이라고",
	// 2-char 조사
	"라는",
	"에서",
	"으로",
	"에게",
	"한테",
	"께서",
	"부터",
	"까지",
	"만큼",
	"처럼",
	"보다",
	"에는",
	"에도",
	"과는",
	"와는",
	"이란",
	"이라",
	"라고",
	"로서",
	"로써",
	// 2-char 어미
	"해야",
	"하다",
	"한다",
	"했다",
	"하는",
	"하고",
	"하면",
	"하여",
	"해서",
	"이다",
	"이며",
	"된다",
	"되는",
	"되어",
	// 1-char 조사
	"는",
	"은",
	"이",
	"가",
	"을",
	"를",
	"에",
	"의",
	"로",
	"와",
	"과",
	"도",
	"만",
	"서",
	"란",
	// 1-char 어미
	"된",
	"인",
	"적",
];

/**
 * Strip Korean suffix (조사/어미) from a token.
 * Returns the original token if the remainder would be 1 char or less.
 */
function stripKoreanSuffix(token: string): string {
	for (const suffix of KO_SUFFIXES) {
		if (token.endsWith(suffix)) {
			const stem = token.slice(0, -suffix.length);
			if (stem.length > 1) return stem;
			// remainder ≤ 1 char — try next (shorter) suffix
		}
	}
	return token;
}

// ── Tokenizer ────────────────────────────────────────────────────────────────

/**
 * Split text into word tokens.
 * Handles mixed Korean/English text, preserves version numbers and compound terms.
 */
function tokenize(text: string): string[] {
	// Normalize whitespace and split on non-word boundaries
	// Keep: alphanumeric, Korean syllables, dots in version numbers, hyphens, underscores, @
	return text
		.toLowerCase()
		.replace(/[^\w\uAC00-\uD7AF\u3131-\u3163@.-]/g, " ")
		.split(/\s+/)
		.filter(Boolean);
}

/**
 * Check if a token looks like a meaningful keyword.
 * - At least 2 characters (or 1 Korean character)
 * - Not a stopword
 * - Not purely numeric (unless version-like)
 */
function isKeywordCandidate(token: string): boolean {
	// 1. Stopword check FIRST (catches 1-char Korean stopwords like 이/그/수/저)
	if (EN_STOPWORDS.has(token) || KO_STOPWORDS.has(token)) return false;

	// 2. Single Korean characters are valid (only non-stopword ones reach here)
	if (/^[\uAC00-\uD7AF]$/.test(token)) return true;

	// 3. Too short
	if (token.length < 2) return false;

	// 4. Pure number (but allow version-like: v4, 3.x, etc.)
	if (/^\d+$/.test(token)) return false;

	return true;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract keywords from text using heuristic tokenization.
 * No LLM call — fast and deterministic.
 *
 * @returns Deduplicated array of keywords, max 10.
 */
export function extractKeywords(text: string): string[] {
	const tokens = tokenize(text);
	const seen = new Set<string>();
	const keywords: string[] = [];

	for (const raw of tokens) {
		const token = stripKoreanSuffix(raw);
		if (!isKeywordCandidate(token)) continue;
		if (seen.has(token)) continue;
		seen.add(token);
		keywords.push(token);
		if (keywords.length >= 10) break;
	}

	return keywords;
}
