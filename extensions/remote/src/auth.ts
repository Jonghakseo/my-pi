import { randomBytes, randomInt } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { jwtVerify, SignJWT } from "jose";

export type ServerMode = "lan" | "tailscale" | "funnel";

interface FailedAttemptState {
	count: number;
	lockedUntil: number;
}

interface AuthInitOptions {
	mode: ServerMode;
	onAuthRevoke?: (reason: string) => void;
	onPinChange?: (pin: string, reason: string) => void;
}

interface JwtPayload {
	generation: number;
}

interface AuthFailure {
	ok: false;
	reason: string;
	statusCode?: number;
}

interface AuthSuccess {
	ok: true;
	token?: string;
}

export type AuthResult = AuthFailure | AuthSuccess;

const LOCALHOSTS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const PIN_TTL_MS = 10 * 60 * 1000;
const LOCKOUT_MS = 60 * 1000;
const PER_IP_FAILURE_LIMIT = 5;
const GLOBAL_FAILURE_ROTATE_LIMIT = 50;
const GLOBAL_FAILURE_REVOKE_LIMIT = 200;
const FUNNEL_ATTEMPT_WINDOW_MS = 60 * 1000;
const FUNNEL_ATTEMPT_LIMIT = 10;

let currentMode: ServerMode = "lan";
let lanToken = randomBytes(16).toString("hex");
let currentPin: string | null = null;
let pinExpiresAt = 0;
let pinRotationTimer: NodeJS.Timeout | null = null;
let jwtSecret = randomBytes(32);
let authGeneration = 0;
let globalFailureCount = 0;
let onAuthRevokeCb: ((reason: string) => void) | undefined;
let onPinChangeCb: ((pin: string, reason: string) => void) | undefined;
let failedAttemptsByIp = new Map<string, FailedAttemptState>();
let funnelAttempts: number[] = [];

export function initializeAuth(options: AuthInitOptions): void {
	clearPinRotationTimer();

	currentMode = options.mode;
	onAuthRevokeCb = options.onAuthRevoke;
	onPinChangeCb = options.onPinChange;
	lanToken = randomBytes(16).toString("hex");
	jwtSecret = randomBytes(32);
	authGeneration = 0;
	globalFailureCount = 0;
	failedAttemptsByIp = new Map();
	funnelAttempts = [];
	currentPin = null;
	pinExpiresAt = 0;

	if (currentMode !== "lan") {
		rotatePin("initial_pin");
	}
}

export function registerAuthRevokeHandler(cb: (reason: string) => void): void {
	onAuthRevokeCb = cb;
}

export function getLanToken(): string {
	return lanToken;
}

export function getCurrentPin(): string | undefined {
	ensurePinFresh();
	return currentPin ?? undefined;
}

export function getPinLength(): number {
	return currentMode === "funnel" ? 8 : 6;
}

export function generatePin(mode: "tailscale" | "funnel"): string {
	if (mode === "funnel") {
		return String(randomInt(10_000_000, 100_000_000)).padStart(8, "0");
	}
	return String(randomInt(100_000, 1_000_000)).padStart(6, "0");
}

export async function createJwt(): Promise<string> {
	const secret = new Uint8Array(jwtSecret);
	return new SignJWT({ generation: authGeneration })
		.setProtectedHeader({ alg: "HS256" })
		.setIssuedAt()
		.setExpirationTime("24h")
		.sign(secret);
}

export async function verifyJwt(token: string): Promise<boolean> {
	try {
		const secret = new Uint8Array(jwtSecret);
		const result = await jwtVerify<JwtPayload>(token, secret, { algorithms: ["HS256"] });
		return result.payload.generation === authGeneration;
	} catch {
		return false;
	}
}

export function verifyPin(pin: string, remoteIp: string): AuthResult {
	ensurePinFresh();

	if (currentMode === "lan") {
		return { ok: false, reason: "PIN auth is unavailable in LAN mode", statusCode: 400 };
	}

	const identity = getRemoteIdentity(remoteIp);
	const now = Date.now();

	if (currentMode === "funnel") {
		funnelAttempts = funnelAttempts.filter((timestamp) => now - timestamp < FUNNEL_ATTEMPT_WINDOW_MS);
		if (funnelAttempts.length >= FUNNEL_ATTEMPT_LIMIT) {
			return { ok: false, reason: "Too many attempts. Please wait a minute and try again.", statusCode: 429 };
		}
		funnelAttempts.push(now);
	} else {
		const state = failedAttemptsByIp.get(identity);
		if (state && state.lockedUntil > now) {
			const seconds = Math.ceil((state.lockedUntil - now) / 1000);
			return {
				ok: false,
				reason: `Too many failed attempts. Try again in ${seconds}s.`,
				statusCode: 429,
			};
		}
	}

	if (pin === currentPin) {
		if (currentMode === "tailscale") {
			failedAttemptsByIp.delete(identity);
		}
		return { ok: true };
	}

	recordFailure(identity);
	return { ok: false, reason: "Invalid PIN", statusCode: 403 };
}

export async function wsAuthCheck(req: IncomingMessage): Promise<AuthResult> {
	ensurePinFresh();

	if (currentMode === "lan") {
		if (isLocalRequest(req)) {
			return { ok: true };
		}

		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
		const token = url.searchParams.get("token");
		if (token === lanToken) {
			return { ok: true };
		}

		return { ok: false, reason: "Forbidden: invalid LAN token", statusCode: 403 };
	}

	return { ok: true };
}

export async function httpAuthMiddleware(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
	ensurePinFresh();

	if (currentMode === "lan") {
		if (isLocalRequest(req)) {
			return true;
		}

		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
		const token = url.searchParams.get("token");
		if (token === lanToken) {
			return true;
		}

		res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ error: "Forbidden: invalid LAN token" }));
		return false;
	}

	const authHeader = req.headers.authorization;
	const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
	if (!token || !(await verifyJwt(token))) {
		res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ error: "Unauthorized" }));
		return false;
	}

	return true;
}

export async function handleAuthRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (currentMode === "lan") {
		res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ error: "LAN mode does not use PIN auth" }));
		return;
	}

	const body = (await readJsonBody(req)) as Record<string, unknown> | null;
	const pin = typeof body?.pin === "string" ? body.pin.trim() : "";
	const verification = verifyPin(pin, getRequestIp(req));

	if (!verification.ok) {
		res.writeHead(verification.statusCode ?? 403, { "Content-Type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ error: verification.reason }));
		return;
	}

	const token = await createJwt();
	res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify({ token }));
}

export function resetPinAndSessions(reason: string): { newPin: string; revoked: true } | null {
	if (currentMode === "lan") {
		lanToken = randomBytes(16).toString("hex");
		return null;
	}

	const newPin = rotatePin(reason);
	jwtSecret = randomBytes(32);
	authGeneration += 1;
	onAuthRevokeCb?.(reason);
	return { newPin, revoked: true };
}

function ensurePinFresh(): void {
	if (currentMode === "lan") return;
	if (Date.now() >= pinExpiresAt) {
		rotatePin("pin_expired");
	}
}

function rotatePin(reason: string): string {
	currentPin = generatePin(currentMode as "tailscale" | "funnel");
	pinExpiresAt = Date.now() + PIN_TTL_MS;
	globalFailureCount = 0;
	failedAttemptsByIp = new Map();
	funnelAttempts = [];
	schedulePinRotation();
	onPinChangeCb?.(currentPin, reason);
	return currentPin;
}

function schedulePinRotation(): void {
	clearPinRotationTimer();
	if (currentMode === "lan") return;

	const delay = Math.max(pinExpiresAt - Date.now(), 0);
	pinRotationTimer = setTimeout(() => {
		pinRotationTimer = null;
		if (currentMode === "lan") return;
		rotatePin("pin_expired");
	}, delay);
}

function clearPinRotationTimer(): void {
	if (pinRotationTimer) {
		clearTimeout(pinRotationTimer);
		pinRotationTimer = null;
	}
}

function recordFailure(identity: string): void {
	globalFailureCount += 1;
	const now = Date.now();

	if (currentMode === "tailscale") {
		const state = failedAttemptsByIp.get(identity) ?? { count: 0, lockedUntil: 0 };
		state.count += 1;
		if (state.count >= PER_IP_FAILURE_LIMIT) {
			state.lockedUntil = now + LOCKOUT_MS;
			state.count = 0;
		}
		failedAttemptsByIp.set(identity, state);
	}

	if (globalFailureCount >= GLOBAL_FAILURE_REVOKE_LIMIT) {
		resetPinAndSessions("too_many_failures_revoke");
		return;
	}

	if (globalFailureCount >= GLOBAL_FAILURE_ROTATE_LIMIT) {
		rotatePin("too_many_failures");
	}
}

function getRemoteIdentity(remoteIp: string): string {
	return remoteIp || "unknown";
}

function isLocalRequest(req: IncomingMessage): boolean {
	return LOCALHOSTS.has(getRequestIp(req));
}

function getRequestIp(req: IncomingMessage): string {
	return req.socket.remoteAddress ?? "";
}

async function readJsonBody(req: IncomingMessage, maxSize = 4096): Promise<unknown> {
	const chunks: Buffer[] = [];
	let totalSize = 0;

	for await (const chunk of req) {
		const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		totalSize += bufferChunk.length;
		if (totalSize > maxSize) {
			return null;
		}
		chunks.push(bufferChunk);
	}

	if (chunks.length === 0) return null;
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
	} catch {
		return null;
	}
}
