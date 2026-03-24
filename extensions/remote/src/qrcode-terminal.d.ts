declare module "qrcode-terminal" {
	export function generate(text: string, options?: { small?: boolean }, callback?: (qrcode: string) => void): void;
}
