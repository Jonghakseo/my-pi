/**
 * Pixel art character definitions and half-block rendering engine.
 *
 * Each character is a 5px × 6px grid with 2+ animation frames.
 * Rendered using ▀▄█ half-block technique → 5 cols × 3 terminal rows.
 *
 * Characters can be referenced by name in agent .md frontmatter:
 *   character: fox
 *   character: blue-slime
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

// ─── 5×6 Mini Sprites ───────────────────────────────────────────────────────

const workerBase = [
	".YYY.",
	"SESES",
	".BBB.",
	"BBBBB",
	".K.K.",
	".....",
];

const catBase = [
	"L...L",
	"LELEL",
	".LIL.",
	"LLLLL",
	".L.L.",
	".....",
];

const bunnyBase = [
	".W.W.",
	"WEWEW",
	".WWW.",
	"WWWWW",
	".W.W.",
	".....",
];

const bearBase = [
	"N...N",
	"NENEN",
	".NnN.",
	"NNNNN",
	".N.N.",
	".....",
];

const penguinBase = [
	".KKK.",
	"KWKWK",
	".KOK.",
	"KWWWK",
	".O.O.",
	".....",
];

const foxBase = [
	"O...O",
	"OEOEO",
	".OWO.",
	"OWWWO",
	".O.O.",
	".....",
];

const slimeBase = [
	".....",
	".GGG.",
	"GWGWG",
	"GGGGG",
	"GGGGG",
	".....",
];

const chickBase = [
	".YYY.",
	"YEYEY",
	".YOY.",
	".YYY.",
	".o.o.",
	".....",
];

const mushroomBase = [
	".RRR.",
	"RRWRR",
	"RRRRR",
	".www.",
	".www.",
	".....",
];

const ghostBase = [
	".www.",
	"wEwEw",
	"wwwww",
	"wwwww",
	"w.w.w",
	".....",
];

const robotBase = [
	"..L..",
	"DCDCD",
	"DDDDD",
	"DLDLD",
	".D.D.",
	".....",
];

const dragonBase = [
	"R...R",
	"RERER",
	"RRRRR",
	".RRR.",
	".R.R.",
	".....",
];

const frogBase = [
	".W.W.",
	"GEGEG",
	"GGGGG",
	".GGG.",
	".G.G.",
	".....",
];

const alienBase = [
	".CCC.",
	"CECEC",
	"CCCCC",
	".CCC.",
	".C.C.",
	".....",
];

const princessBase = [
	".YYY.",
	"SESES",
	".III.",
	"IIIII",
	".I.I.",
	".....",
];

/** Apply color replacement for slime variants. */
function recolorSlime(base: string[], from: string, to: string): string[] {
	return base.map((row) => row.replaceAll(from, to));
}

const slimeBounce = [
	".....",
	".....",
	".GGG.",
	"GWGWG",
	"GGGGG",
	".....",
];

const ghostFloat = [
	".....",
	".www.",
	"wEwEw",
	"wwwww",
	"w.w.w",
	".....",
];

const mushroomSwell = [
	"RRRRR",
	"RWRWR",
	"RRRRR",
	".www.",
	".www.",
	".....",
];

export const CHARACTERS: PixelCharacterDef[] = [
	{
		name: "worker",
		aliases: ["노동자", "builder"],
		frames: [
			workerBase,
			walkFrame(workerBase, "K...K", "....."),
			workerBase,
			walkFrame(workerBase, "..KK.", "....."),
		],
	},
	{
		name: "cat",
		aliases: ["고양이", "kitty", "neko"],
		frames: [
			catBase,
			walkFrame(catBase, "L...L", "....."),
			catBase,
			walkFrame(catBase, "..LL.", "....."),
		],
	},
	{
		name: "bunny",
		aliases: ["토끼", "rabbit"],
		frames: [
			bunnyBase,
			walkFrame(bunnyBase, "W...W", "....."),
			bunnyBase,
			walkFrame(bunnyBase, "..WW.", "....."),
		],
	},
	{
		name: "bear",
		aliases: ["곰돌이", "곰", "teddy"],
		frames: [
			bearBase,
			walkFrame(bearBase, "N...N", "....."),
			bearBase,
			walkFrame(bearBase, "..NN.", "....."),
		],
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
		frames: [
			foxBase,
			walkFrame(foxBase, "O...O", "....."),
			foxBase,
			walkFrame(foxBase, "..OO.", "....."),
		],
	},
	{
		name: "slime",
		aliases: ["슬라임", "green-slime"],
		frames: [slimeBase, slimeBounce],
	},
	{
		name: "blue-slime",
		aliases: ["파란슬라임"],
		frames: [
			recolorSlime(slimeBase, "G", "C"),
			recolorSlime(slimeBounce, "G", "C"),
		],
	},
	{
		name: "pink-slime",
		aliases: ["핑크슬라임"],
		frames: [
			recolorSlime(slimeBase, "G", "I"),
			recolorSlime(slimeBounce, "G", "I"),
		],
	},
	{
		name: "purple-slime",
		aliases: ["보라슬라임"],
		frames: [
			recolorSlime(slimeBase, "G", "P"),
			recolorSlime(slimeBounce, "G", "P"),
		],
	},
	{
		name: "chick",
		aliases: ["병아리"],
		frames: [
			chickBase,
			walkFrame(chickBase, "o...o", "....."),
			chickBase,
			walkFrame(chickBase, "..oo.", "....."),
		],
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
		frames: [
			robotBase,
			walkFrame(robotBase, "D...D", "....."),
			robotBase,
			walkFrame(robotBase, "..DD.", "....."),
		],
	},
	{
		name: "dragon",
		aliases: ["용", "드래곤"],
		frames: [
			dragonBase,
			walkFrame(dragonBase, "R...R", "....."),
			dragonBase,
			walkFrame(dragonBase, "..RR.", "....."),
		],
	},
	{
		name: "frog",
		aliases: ["개구리"],
		frames: [
			frogBase,
			walkFrame(frogBase, "G...G", "....."),
			frogBase,
			walkFrame(frogBase, "..GG.", "....."),
		],
	},
	{
		name: "alien",
		aliases: ["외계인"],
		frames: [
			alienBase,
			walkFrame(alienBase, "C...C", "....."),
			alienBase,
			walkFrame(alienBase, "..CC.", "....."),
		],
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
 * @param characterField - value from agent .md frontmatter `character:` field
 * @param agentName - fallback: hash agent name to pick a character
 */
export function resolveCharacter(characterField: string | undefined, agentName: string): PixelCharacterDef {
	if (characterField) {
		const found = charByName.get(characterField.toLowerCase().trim());
		if (found) return found;
	}
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
