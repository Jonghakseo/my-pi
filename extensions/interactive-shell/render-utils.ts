import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

export function fitOverlayRowContent(content: string, width: number): string {
	const safeWidth = Math.max(0, width);
	const truncated = truncateToWidth(content, safeWidth, "");
	return `${truncated}${" ".repeat(Math.max(0, safeWidth - visibleWidth(truncated)))}`;
}

export function centerOverlayText(content: string, width: number): string {
	const safeWidth = Math.max(0, width);
	const truncated = truncateToWidth(content, safeWidth, "");
	const contentWidth = visibleWidth(truncated);
	const leftPad = Math.max(0, Math.floor((safeWidth - contentWidth) / 2));
	const rightPad = Math.max(0, safeWidth - leftPad - contentWidth);
	return `${" ".repeat(leftPad)}${truncated}${" ".repeat(rightPad)}`;
}
