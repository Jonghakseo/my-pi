/**
 * Pixel art character definitions and half-block rendering engine.
 *
 * Two character groups:
 *   1. Role-based icons — matched to agent roles via AGENT_DEFAULTS
 *   2. Legacy creatures — available for custom `character:` field assignment
 *
 * Each character is a 5px × 6px grid with 2+ animation frames.
 * Rendered using ▀▄█ half-block technique → 5 cols × 3 terminal rows.
 *
 * Characters can be referenced by name in agent .md frontmatter:
 *   character: globe
 *   character: fox
 */

// ─── Color Palette ───────────────────────────────────────────────────────────

const PAL: Record<string, [number, number, number] | null> = {
	".": null,
	K: [35, 35, 45],
	W: [255, 255, 255],
	w: [225, 230, 240],
	S: [255, 205, 155],
	s: [235, 180, 130],
	Y: [255, 215, 50],
	y: [225, 185, 35],
	B: [65, 130, 255],
	b: [45, 95, 200],
	R: [235, 60, 60],
	r: [190, 40, 40],
	G: [80, 210, 90],
	g: [55, 165, 60],
	P: [170, 95, 235],
	O: [255, 155, 45],
	o: [215, 120, 30],
	N: [165, 105, 65],
	n: [120, 75, 45],
	L: [195, 205, 220],
	l: [155, 165, 180],
	D: [90, 95, 115],
	I: [255, 170, 200],
	C: [80, 210, 240],
	E: [25, 25, 35],
};

function fgAnsi(r: number, g: number, b: number): string {
	return `\x1b[38;2;${r};${g};${b}m`;
}
function bgAnsi(r: number, g: number, b: number): string {
	return `\x1b[48;2;${r};${g};${b}m`;
}
const RST = "\x1b[0m";

// ─── Character Definitions ───────────────────────────────────────────────────

export interface PixelCharacterDef {
	name: string;
	aliases: string[];
	/** Array of frames. Each frame is an array of 6 pixel rows (strings of 5 palette keys). */
	frames: string[][];
}

function walkFrame(base: string[], footA: string, footB: string): string[] {
	const f = [...base];
	f[f.length - 2] = footA;
	f[f.length - 1] = footB;
	return f;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROLE-BASED ICON CHARACTERS — matched to agents via AGENT_DEFAULTS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── 1. Construction Worker (worker) ─────────────────────────────────────────
// Yellow hard hat + skin face + orange hi-vis vest + black boots
const hardhatBase = ["YYYYY", ".SES.", ".oOo.", ".OOO.", ".K.K.", "....."];

// ─── 2. Rotating Globe (browser) ─────────────────────────────────────────────
// Blue sphere with green land mass that scrolls right (rotation)
const globeF0 = [".bBb.", "BGBBB", "BGGBB", "BGBBB", ".bBb.", "....."];
const globeF1 = [".bBb.", "BBGBB", "BBGGB", "BBGBB", ".bBb.", "....."];
const globeF2 = [".bBb.", "BBBGB", "BBBGG", "BBBGB", ".bBb.", "....."];
const globeF3 = [".bBb.", "GBBBG", "GBBBB", "GBBBG", ".bBb.", "....."];

// ─── 3. Boxing Glove (challenger) ────────────────────────────────────────────
// Red glove: bounces up (uppercut punch animation)
const gloveDown = [".....", ".RRR.", "RRRRR", "RRRRr", "..r..", "..N.."];
const gloveUp = [".RRR.", "RRRRR", "RRRRr", ".RRR.", "..r..", "..N.."];

// ─── 4. Folder Icon (finder) ─────────────────────────────────────────────────
// Yellow folder with tab; paper peeks out when searching
const folderClosed = [".YY..", "YYYYY", "YyyyY", "YyyyY", "YYYYY", "....."];
const folderOpen = [".YYW.", "YYYYY", "YWyyY", "YyyyY", "YYYYY", "....."];

// ─── 5. Wizard Hat (planner) ─────────────────────────────────────────────────
// Tall purple cone with orbiting yellow star (✦)
const wizardF0 = ["..P..", "..P..", ".PPP.", ".PYP.", "PPPPP", "....."];
const wizardF1 = ["..P..", "..P.Y", ".PPP.", ".PWP.", "PPPPP", "....."];
const wizardF2 = ["..P..", "Y.P..", ".PPP.", ".PYP.", "PPPPP", "....."];
const wizardF3 = ["..P..", "..P..", ".PPP.", ".PWP.", "PPPPP", "Y...."];

// ─── 6. Computer Monitor (reviewer) ──────────────────────────────────────────
// Screen shows scrolling code diff (G=additions, R=deletions, K=background)
const monitorF0 = ["DDDDD", "DGKRD", "DRKGD", "DDDDD", "..D..", ".DDD."];
const monitorF1 = ["DDDDD", "DRKGD", "DGKRD", "DDDDD", "..D..", ".DDD."];

// ─── 7. Magnifying Glass (searcher) ──────────────────────────────────────────
// Metal rim (l) + glass lens (w) + gleam (W) sweeps across + wooden handle (N)
const magF0 = [".lll.", "lwwwl", "lwwwl", ".lll.", "...lN", "....N"];
const magF1 = [".lll.", "lWwwl", "lwwwl", ".lll.", "...lN", "....N"];
const magF2 = [".lll.", "lwWwl", "lwwwl", ".lll.", "...lN", "....N"];
const magF3 = [".lll.", "lwwWl", "lwwwl", ".lll.", "...lN", "....N"];

// ─── 8. Checkbox (verifier) ──────────────────────────────────────────────────
// Frame 0 = CHECKED (shown when done). Running cycles: check→empty→build→build
const checkF0 = ["DDDDD", "D..GD", "D.GGD", "DGG.D", "DDDDD", "....."];
const checkF1 = ["DDDDD", "D...D", "D...D", "D...D", "DDDDD", "....."];
const checkF2 = ["DDDDD", "D...D", "D...D", "DG..D", "DDDDD", "....."];
const checkF3 = ["DDDDD", "D...D", "D.G.D", "DGG.D", "DDDDD", "....."];

// ─── 9. Judge's Gavel (decider) ──────────────────────────────────────────────
// Swing animation: raised → mid → SLAM (impact reverb on base) → recoil
const gavelF0 = [".NNN.", ".NnN.", "..N..", "..N..", ".....", ".nnn."];
const gavelF1 = [".....", ".NNN.", ".NnN.", "..N..", "..N..", ".nnn."];
const gavelF2 = [".....", ".....", ".NNN.", ".NnN.", "..Nn.", "NnNnN"];
// F3 = F1 (recoil = mid-swing)

// ═══════════════════════════════════════════════════════════════════════════════
// LEGACY CREATURE CHARACTERS — available for custom character: field
// ═══════════════════════════════════════════════════════════════════════════════

const catBase = ["L...L", "LELEL", ".LIL.", "LLLLL", ".L.L.", "....."];
const bunnyBase = [".W.W.", "WEWEW", ".WWW.", "WWWWW", ".W.W.", "....."];
const bearBase = ["N...N", "NENEN", ".NnN.", "NNNNN", ".N.N.", "....."];
const penguinBase = [".KKK.", "KWKWK", ".KOK.", "KWWWK", ".O.O.", "....."];
const foxBase = ["O...O", "OEOEO", ".OWO.", "OWWWO", ".O.O.", "....."];
const chickBase = [".YYY.", "YEYEY", ".YOY.", ".YYY.", ".o.o.", "....."];
const ghostBase = [".www.", "wEwEw", "wwwww", "wwwww", "w.w.w", "....."];
const robotBase = ["..L..", "DCDCD", "DDDDD", "DLDLD", ".D.D.", "....."];
const dragonBase = ["R...R", "RERER", "RRRRR", ".RRR.", ".R.R.", "....."];
const frogBase = [".W.W.", "GEGEG", "GGGGG", ".GGG.", ".G.G.", "....."];
const alienBase = [".CCC.", "CECEC", "CCCCC", ".CCC.", ".C.C.", "....."];
const princessBase = [".YYY.", "SESES", ".III.", "IIIII", ".I.I.", "....."];

const slimeBase = [".....", ".GGG.", "GWGWG", "GGGGG", "GGGGG", "....."];
const slimeBounce = [".....", ".....", ".GGG.", "GWGWG", "GGGGG", "....."];
const mushroomBase = [".RRR.", "RRWRR", "RRRRR", ".www.", ".www.", "....."];
const mushroomSwell = ["RRRRR", "RWRWR", "RRRRR", ".www.", ".www.", "....."];
const ghostFloat = [".....", ".www.", "wEwEw", "wwwww", "w.w.w", "....."];

/** Apply color replacement for slime variants. */
function recolorSlime(base: string[], from: string, to: string): string[] {
	return base.map((row) => row.replaceAll(from, to));
}

// ─── Character Registry ─────────────────────────────────────────────────────

export const CHARACTERS: PixelCharacterDef[] = [
	// ── Role-based icons ──
	{
		name: "hardhat",
		aliases: ["건설공", "worker-icon", "construction"],
		frames: [
			hardhatBase,
			walkFrame(hardhatBase, "K...K", "....."),
			hardhatBase,
			walkFrame(hardhatBase, "..KK.", "....."),
		],
	},
	{
		name: "globe",
		aliases: ["지구본", "earth", "browser-icon"],
		frames: [globeF0, globeF1, globeF2, globeF3],
	},
	{
		name: "glove",
		aliases: ["글러브", "boxing-glove", "challenger-icon", "권투글러브"],
		frames: [gloveDown, gloveUp],
	},
	{
		name: "folder",
		aliases: ["폴더", "finder-icon"],
		frames: [folderClosed, folderOpen],
	},
	{
		name: "wizard",
		aliases: ["마법사", "wizard-hat", "마법사모자", "planner-icon"],
		frames: [wizardF0, wizardF1, wizardF2, wizardF3],
	},
	{
		name: "monitor",
		aliases: ["모니터", "computer", "컴퓨터", "reviewer-icon"],
		frames: [monitorF0, monitorF1],
	},
	{
		name: "magnifier",
		aliases: ["돋보기", "magnifying-glass", "searcher-icon"],
		frames: [magF0, magF1, magF2, magF3],
	},
	{
		name: "checkbox",
		aliases: ["체크박스", "check", "verifier-icon"],
		frames: [checkF0, checkF1, checkF2, checkF3],
	},
	{
		name: "gavel",
		aliases: ["법봉", "판사봉", "judge", "decider-icon"],
		frames: [gavelF0, gavelF1, gavelF2, gavelF1],
	},

	// ── Legacy creature characters ──
	{
		name: "cat",
		aliases: ["고양이", "kitty", "neko"],
		frames: [catBase, walkFrame(catBase, "L...L", "....."), catBase, walkFrame(catBase, "..LL.", ".....")],
	},
	{
		name: "bunny",
		aliases: ["토끼", "rabbit"],
		frames: [bunnyBase, walkFrame(bunnyBase, "W...W", "....."), bunnyBase, walkFrame(bunnyBase, "..WW.", ".....")],
	},
	{
		name: "bear",
		aliases: ["곰돌이", "곰", "teddy"],
		frames: [bearBase, walkFrame(bearBase, "N...N", "....."), bearBase, walkFrame(bearBase, "..NN.", ".....")],
	},
	{
		name: "penguin",
		aliases: ["펭귄"],
		frames: [
			penguinBase,
			walkFrame(penguinBase, "O...O", "....."),
			penguinBase,
			walkFrame(penguinBase, "..OO.", "....."),
		],
	},
	{
		name: "fox",
		aliases: ["여우"],
		frames: [foxBase, walkFrame(foxBase, "O...O", "....."), foxBase, walkFrame(foxBase, "..OO.", ".....")],
	},
	{
		name: "slime",
		aliases: ["슬라임", "green-slime"],
		frames: [slimeBase, slimeBounce],
	},
	{
		name: "blue-slime",
		aliases: ["파란슬라임"],
		frames: [recolorSlime(slimeBase, "G", "C"), recolorSlime(slimeBounce, "G", "C")],
	},
	{
		name: "pink-slime",
		aliases: ["핑크슬라임"],
		frames: [recolorSlime(slimeBase, "G", "I"), recolorSlime(slimeBounce, "G", "I")],
	},
	{
		name: "purple-slime",
		aliases: ["보라슬라임"],
		frames: [recolorSlime(slimeBase, "G", "P"), recolorSlime(slimeBounce, "G", "P")],
	},
	{
		name: "chick",
		aliases: ["병아리"],
		frames: [chickBase, walkFrame(chickBase, "o...o", "....."), chickBase, walkFrame(chickBase, "..oo.", ".....")],
	},
	{
		name: "mushroom",
		aliases: ["버섯"],
		frames: [mushroomBase, mushroomSwell],
	},
	{
		name: "ghost",
		aliases: ["유령"],
		frames: [ghostBase, ghostFloat],
	},
	{
		name: "robot",
		aliases: ["로봇"],
		frames: [robotBase, walkFrame(robotBase, "D...D", "....."), robotBase, walkFrame(robotBase, "..DD.", ".....")],
	},
	{
		name: "dragon",
		aliases: ["용", "드래곤"],
		frames: [dragonBase, walkFrame(dragonBase, "R...R", "....."), dragonBase, walkFrame(dragonBase, "..RR.", ".....")],
	},
	{
		name: "frog",
		aliases: ["개구리"],
		frames: [frogBase, walkFrame(frogBase, "G...G", "....."), frogBase, walkFrame(frogBase, "..GG.", ".....")],
	},
	{
		name: "alien",
		aliases: ["외계인"],
		frames: [alienBase, walkFrame(alienBase, "C...C", "....."), alienBase, walkFrame(alienBase, "..CC.", ".....")],
	},
	{
		name: "princess",
		aliases: ["공주"],
		frames: [
			princessBase,
			walkFrame(princessBase, "I...I", "....."),
			princessBase,
			walkFrame(princessBase, "..II.", "....."),
		],
	},
];

// ─── Default agent → character mapping ───────────────────────────────────────

/**
 * Maps agent names to their default role-based character.
 * Used when no `character:` field is set in the agent's .md frontmatter.
 */
const AGENT_DEFAULTS: Record<string, string> = {
	worker: "hardhat",
	browser: "globe",
	challenger: "glove",
	finder: "folder",
	planner: "wizard",
	reviewer: "monitor",
	searcher: "magnifier",
	verifier: "checkbox",
	decider: "gavel",
};

// ─── Lookup ──────────────────────────────────────────────────────────────────

const charByName = new Map<string, PixelCharacterDef>();
for (const ch of CHARACTERS) {
	charByName.set(ch.name.toLowerCase(), ch);
	for (const alias of ch.aliases) charByName.set(alias.toLowerCase(), ch);
}

function agentHash(name: string): number {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
	return Math.abs(h);
}

/**
 * Resolve a pixel character for an agent.
 *
 * Priority:
 *   1. Explicit `character:` field from agent .md frontmatter
 *   2. AGENT_DEFAULTS mapping (role-based default)
 *   3. Hash-based fallback from all available characters
 *
 * @param characterField - value from agent .md frontmatter `character:` field
 * @param agentName - agent name used for default/hash lookup
 */
export function resolveCharacter(characterField: string | undefined, agentName: string): PixelCharacterDef {
	// 1. Explicit character field
	if (characterField) {
		const found = charByName.get(characterField.toLowerCase().trim());
		if (found) return found;
	}

	// 2. Role-based default
	const defaultChar = AGENT_DEFAULTS[agentName.toLowerCase()];
	if (defaultChar) {
		const found = charByName.get(defaultChar);
		if (found) return found;
	}

	// 3. Hash fallback
	const idx = agentHash(agentName) % CHARACTERS.length;
	return CHARACTERS[idx];
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/**
 * Render a single frame to an array of terminal lines (3 lines for a 6-row grid).
 * Uses half-block technique: each line encodes 2 pixel rows.
 */
export function renderFrame(frame: string[]): string[] {
	const rows = [...frame];
	if (rows.length % 2 !== 0) rows.push(".".repeat(rows[0].length));

	const lines: string[] = [];
	for (let y = 0; y < rows.length; y += 2) {
		let line = "";
		const topRow = rows[y];
		const botRow = rows[y + 1];
		for (let x = 0; x < topRow.length; x++) {
			const tKey = topRow[x];
			const bKey = botRow[x];
			const tc = PAL[tKey] ?? null;
			const bc = PAL[bKey] ?? null;

			if (tc === null && bc === null) {
				line += " ";
			} else if (tc === null && bc !== null) {
				line += fgAnsi(bc[0], bc[1], bc[2]) + "▄" + RST;
			} else if (tc !== null && bc === null) {
				line += fgAnsi(tc[0], tc[1], tc[2]) + "▀" + RST;
			} else if (tc !== null && bc !== null && tc[0] === bc[0] && tc[1] === bc[1] && tc[2] === bc[2]) {
				line += fgAnsi(tc[0], tc[1], tc[2]) + "█" + RST;
			} else if (tc !== null && bc !== null) {
				line += bgAnsi(tc[0], tc[1], tc[2]) + fgAnsi(bc[0], bc[1], bc[2]) + "▄" + RST;
			}
		}
		lines.push(line);
	}
	return lines;
}

/** Width in terminal columns of a single character (always 5). */
export const CHAR_WIDTH = 5;
/** Height in terminal rows of a single rendered character (always 3 for 6px). */
export const CHAR_HEIGHT = 3;
