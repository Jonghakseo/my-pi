import { sanitizeNotificationText } from "./text.ts";

type Writer = (s: string) => void;

const FALLBACK_TITLE = "π";

function notifyOSC777(title: string, body: string, write: Writer): void {
	write(`\x1b]777;notify;${title};${body}\x07`);
}

function notifyOSC99(title: string, body: string, write: Writer): void {
	write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
	if (body) write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
}

export function notify(title: string, body: string, write: Writer = (s) => process.stdout.write(s)): void {
	const safeTitle = sanitizeNotificationText(title) || FALLBACK_TITLE;
	const safeBody = sanitizeNotificationText(body);
	if (process.env.KITTY_WINDOW_ID) {
		notifyOSC99(safeTitle, safeBody, write);
	} else {
		notifyOSC777(safeTitle, safeBody, write);
	}
}
