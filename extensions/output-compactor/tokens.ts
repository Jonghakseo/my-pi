/** 대략적 토큰 추정: 코드/로그 기준 ~4 chars/token. 양쪽(원본·주입본)에 동일 적용하므로 절감량 비교에는 충분히 일관적. */
export function estimateTokens(text: string): number {
	return Math.max(0, Math.ceil(text.length / 4));
}

/** 푸터용 토큰 수 포맷: 부호 포함, 1000 이상은 k 단위. */
export function formatSignedTokens(n: number): string {
	const sign = n > 0 ? "+" : n < 0 ? "-" : "";
	const abs = Math.abs(n);
	const body = abs >= 1000 ? `${(abs / 1000).toFixed(1)}k` : `${abs}`;
	return `${sign}${body}`;
}
