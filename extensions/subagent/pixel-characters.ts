/**
 * Pixel art character definitions and half-block rendering engine.
 *
 * Two character groups:
 *   1. Role-based icons — matched to agent roles via AGENT_DEFAULTS
 *   2. Legacy creatures — available for custom `character:` field assignment
 *
 * Each character is a 7px × 6px grid with 2+ animation frames.
 * Rendered using ▀▄█ half-block technique → 7 cols × 3 terminal rows.
 */

// ─── Color Palette ───────────────────────────────────────────────────────────

type RGB = [number, number, number];
type PaletteKey =
	| "."
	| "K"
	| "W"
	| "w"
	| "S"
	| "s"
	| "Y"
	| "y"
	| "B"
	| "b"
	| "R"
	| "r"
	| "G"
	| "g"
	| "P"
	| "O"
	| "o"
	| "N"
	| "n"
	| "L"
	| "l"
	| "D"
	| "I"
	| "C"
	| "E";

const PALETTE: Record<PaletteKey, RGB | null> = {
	".": null,
	K: [35, 35, 45], // Dark Grey (Backgrounds)
	W: [255, 255, 255], // Pure White
	w: [225, 230, 240], // Off White
	S: [255, 205, 155], // Skin/Peach
	s: [235, 180, 130], // Dark Skin
	Y: [255, 215, 50], // Yellow
	y: [225, 185, 35], // Dark Yellow
	B: [65, 130, 255], // Blue
	b: [45, 95, 200], // Dark Blue
	R: [235, 60, 60], // Red
	r: [190, 40, 40], // Dark Red
	G: [80, 210, 90], // Green
	g: [55, 165, 60], // Dark Green
	P: [170, 95, 235], // Purple
	O: [255, 155, 45], // Orange
	o: [215, 120, 30], // Dark Orange
	N: [165, 105, 65], // Brown
	n: [120, 75, 45], // Dark Brown
	L: [195, 205, 220], // Light Grey
	l: [155, 165, 180], // Medium Grey
	D: [90, 95, 115], // Slate/Dark Grey
	I: [255, 170, 200], // Pink
	C: [80, 210, 240], // Cyan
	E: [25, 25, 35], // Deep Black/Grey
};

// Pre-compute ANSI sequences for performance
const PAL_ANSI = new Map<string, { fg: string; bg: string }>();
const RST = "\x1b[0m";

function fgAnsi(r: number, g: number, b: number): string {
	return `\x1b[38;2;${r};${g};${b}m`;
}
function bgAnsi(r: number, g: number, b: number): string {
	return `\x1b[48;2;${r};${g};${b}m`;
}

for (const [key, rgb] of Object.entries(PALETTE)) {
	if (rgb) {
		PAL_ANSI.set(key, {
			fg: fgAnsi(rgb[0], rgb[1], rgb[2]),
			bg: bgAnsi(rgb[0], rgb[1], rgb[2]),
		});
	}
}

// ─── Character Definitions ───────────────────────────────────────────────────

export interface PixelCharacterDef {
	readonly name: string;
	readonly aliases: ReadonlyArray<string>;
	readonly frames: ReadonlyArray<ReadonlyArray<string>>;
}

function walkFrame(base: ReadonlyArray<string>, footA: string, footB: string): string[] {
	if (base.length < 2) return [...base];
	const f = [...base];
	f[f.length - 2] = footA;
	f[f.length - 1] = footB;
	return f;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROLE-BASED ICON CHARACTERS (REMASTERED V2)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── 1. Construction Worker (worker) ─────────────────────────────────────────
// Yellow hardhat, orange vest, simple face.
const hardhatBase = [
	".YYYYY.", // Helmet Dome
	".YYYYY.", // Helmet Brim
	"..SES..", // Face
	".OOOOO.", // Vest
	".OOOOO.", // Vest
	"..N.N.."  // Boots
];

// ─── 2. Rotating Globe (browser) ─────────────────────────────────────────────
// Blue ocean, Green continents.
const globeF0 = ["..BBB..", ".BGBBB.", "BBGBBGB", "BGBBGBB", ".BBGBB.", "..BBB.."];
const globeF1 = ["..BBB..", ".BBGBB.", "BBBGBBB", "GBBGBBG", ".BGBBB.", "..BBB.."];
const globeF2 = ["..BBB..", ".BBBGB.", "GBBBGBB", "BGBBGBB", ".BBGBB.", "..BBB.."];
const globeF3 = ["..BBB..", ".BGBBB.", "BGBBBGB", "BBGBBGB", ".BBBGB.", "..BBB.."];

// ─── 3. Boxing Glove (challenger) ────────────────────────────────────────────
// Red glove punching Left (<--)
const gloveRetract = [".......", "..RRRR.", ".RRRRRW", ".RRRRRW", "..RRR..", "......."];
const gloveExtend =  [".......", "RRRR...", "RRRRRW.", "RRRRRW.", "RRR....", "......."];
const gloveHit =     ["Y......", "RRRR...", "RRRRRW.", "RRRRRW.", "RRR....", "Y......"];

// ─── 4. Folder Icon (finder) ─────────────────────────────────────────────────
// Manila folder style.
const folderClosed = [".OOO...", "OOOOOOO", "OwwwwwO", "OwwwwwO", "OwwwwwO", "OOOOOOO"];
const folderOpen =   [".OOO.W.", "OOOOOOO", "OwWKWwO", "OwWKWwO", "OwwwwwO", "OOOOOOO"];

// ─── 5. Wizard Hat (planner) ─────────────────────────────────────────────────
// Purple hat with yellow star/belt.
const wizardF0 = ["...P...", "..PPP..", ".PPPPP.", ".PPPPP.", ".PPYPP.", "PPPPPPP"];
const wizardF1 = ["...P...", "..PPP..", ".PPPPP.", ".PPPPP.", ".PYPPP.", "PPPPPPP"]; // Sparkle L
const wizardF2 = ["...P...", "..PPP..", ".PPPPP.", ".PPPPP.", ".PPPYP.", "PPPPPPP"]; // Sparkle R
const wizardF3 = ["...P...", "..PPP..", ".PPPPP.", ".PPPPP.", ".PPYPP.", "PPPPPPP"];

// ─── 6. Computer Monitor (reviewer) ──────────────────────────────────────────
// Dark screen, green code lines.
const monitorF0 = ["DDDDDDD", "DKKKKKD", "DKG.GKD", "DK.G.KD", "DDDDDDD", "..DDD.."];
const monitorF1 = ["DDDDDDD", "DKKKKKD", "DK.G.KD", "DKG.GKD", "DDDDDDD", "..DDD.."];

// ─── 7. Magnifying Glass (searcher) ──────────────────────────────────────────
// Glass lens with reflection.
const magF0 = ["..LLL..", ".LWWWL.", ".LWWWL.", "..LLL..", "...N...", "....N.."];
const magF1 = ["..LLL..", ".LwWWL.", ".LWWWL.", "..LLL..", "...N...", "....N.."];
const magF2 = ["..LLL..", ".LwwWL.", ".LWWWL.", "..LLL..", "...N...", "....N.."];
const magF3 = ["..LLL..", ".LwwwL.", ".LWWWL.", "..LLL..", "...N...", "....N.."];

// ─── 8. Checkbox (verifier) ─────────────────────────────────────────────────
// Box with Green V checkmark.
const checkEmpty = ["LLLLLLL", "LWWWWWL", "LWWWWWL", "LWWWWWL", "LWWWWWL", "LLLLLLL"];
const checkDone =  ["LLLLLLL", "LWWWWWL", "LWWWGWL", "LWGWGWL", "LGWGWWL", "LLLLLLL"];

// ─── 9. Judge's Gavel (decider) ─────────────────────────────────────────────
// Brown hammer.
const gavelF0 = [".......", "...NN..", "..NNNN.", "..NNNN.", "...NN..", "....N.."];
const gavelF1 = [".......", ".......", "..NN...", ".NNNN..", ".NNNN..", "..NN.N."]; // Swing
const gavelF2 = [".......", ".......", ".......", "N......", "NNNN...", "NNNN.N."]; // Hit

// ═══════════════════════════════════════════════════════════════════════════════
// LEGACY CREATURE CHARACTERS (REMASTERED V2)
// ═══════════════════════════════════════════════════════════════════════════════

// Cat: Grey, pink ears/nose.
const catBase =      [
	".L...L.",
	"LLLLLLL",
	"L.W.W.L",
	"L..I..L",
	".LLLLL.",
	"..L.L.."
];

// Bunny: White, pink ears.
const bunnyBase =    [
	".W...W.",
	".W...W.",
	".WWWWW.",
	".W.I.W.",
	".WWWWW.",
	"..W.W.."
];

// Bear: Brown, round ears.
const bearBase =     [
	".N...N.",
	".NNNNN.",
	".NW.WN.",
	".N.K.N.",
	".NNNNN.",
	"..N.N.."
];

// Penguin: Black & White.
const penguinBase =  [
	"..KKK..",
	".KKKKK.",
	".K.O.K.",
	".WWWWW.",
	".WWWWW.",
	".O...O."
];

// Fox: Orange, white chin.
const foxBase =      [
	".O...O.",
	".OOOOO.",
	".OW.WO.",
	".WWKWW.",
	".OOOOO.",
	"..O.O.."
];

// Chick: Yellow, orange beak.
const chickBase =    [
	"..Y.Y..", // Comb
	".YYYYY.",
	".YW.WY.",
	".Y.O.Y.",
	".YYYYY.",
	"..O.O.."
];

// Ghost: White, floaty.
const ghostBase =    [
	"..WWW..",
	".WWWWW.",
	".WE.EW.",
	".WWWWW.",
	".WWWWW.",
	".W.W.W."
];
const ghostFloat =   [
	".......",
	"..WWW..",
	".WWWWW.",
	".WE.EW.",
	".WWWWW.",
	".W.W.W."
];

// Robot: Grey/Blue, red eye.
const robotBase =    [
	"...L...", // Antenna
	".DDDDD.",
	".D.R.D.", // Red eye
	".DDDDD.",
	".LLLLL.",
	".D...D."
];

// Dragon: Green, red wings.
const dragonBase =   [
	".R...R.", // Wings
	".GGGGG.",
	"G.W.W.G",
	"G..K..G", // Nostrils
	".GGGGG.",
	"..G.G.."
];

// Frog: Green, big eyes.
const frogBase =     [
	".G...G.",
	"GGGGGGG",
	"G.W.W.G", // Eyes
	"G..g..G", // Mouth
	".GGGGG.",
	"..G.G.."
];

// Alien: Green, classic invader.
const alienBase =    [
	"..G.G..",
	...frogBase.slice(1, 3), // Reuse head/eyes
	".GGGGG.",
	".G.G.G.",
	"G.....G"
];

// Princess: Pink dress, crown.
const princessBase = [
	".Y.Y.Y.", // Crown
	"..YYY..",
	".SSSSS.", // Face
	".IIIII.", // Dress
	".IIIII.",
	"..I.I.."
];

// Slime: Green jelly.
const slimeBase =    [
	".......",
	"..GGG..",
	".GWGWG.", // Highlights
	".GGGGG.",
	"GGGGGGG",
	".GG.GG."
];
const slimeBounce =  [
	".......",
	".......",
	"..GGG..",
	".GWGWG.",
	"GGGGGGG",
	"GGGGGGG"
];

// Mushroom: Red cap, white spots.
const mushroomBase =  [
	"..RRR..",
	".RWRWR.",
	"RRRRRRR",
	"..SSS..", // Stem
	"..SSS..",
	"..S.S.."
];
const mushroomSwell = [
	".RRRRR.",
	"RWRWRWR",
	"RRRRRRR",
	"..SSS..",
	"..SSS..",
	"..S.S.."
];

function recolorSlime(base: ReadonlyArray<string>, from: string, to: string): string[] {
	return base.map((row) => row.replaceAll(from, to));
}

// ─── Character Registry ─────────────────────────────────────────────────────

/** Returns a list of all available character names (canonical names only). */
export function getAllCharacterNames(): string[] {
	return CHARACTERS.map((c) => c.name).sort();
}

export const CHARACTERS: ReadonlyArray<PixelCharacterDef> = [
	// ── Role-based icons ──
	{
		name: "hardhat",
		aliases: ["건설공", "worker-icon", "construction"],
		frames: [
			hardhatBase,
			walkFrame(hardhatBase, ".N...N.", "......."),
			hardhatBase,
			walkFrame(hardhatBase, "...NN..", "......."),
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
		frames: [gloveRetract, gloveExtend, gloveHit, gloveExtend],
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
		frames: [checkEmpty, checkDone],
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
		frames: [catBase, walkFrame(catBase, ".L...L.", "......."), catBase, walkFrame(catBase, "...LL..", ".......")],
	},
	{
		name: "bunny",
		aliases: ["토끼", "rabbit"],
		frames: [
			bunnyBase,
			walkFrame(bunnyBase, ".W...W.", "......."),
			bunnyBase,
			walkFrame(bunnyBase, "...WW..", "......."),
		],
	},
	{
		name: "bear",
		aliases: ["곰돌이", "곰", "teddy"],
		frames: [bearBase, walkFrame(bearBase, ".N...N.", "......."), bearBase, walkFrame(bearBase, "...NN..", ".......")],
	},
	{
		name: "penguin",
		aliases: ["펭귄"],
		frames: [
			penguinBase,
			walkFrame(penguinBase, ".O...O.", "......."),
			penguinBase,
			walkFrame(penguinBase, "...OO..", "......."),
		],
	},
	{
		name: "fox",
		aliases: ["여우"],
		frames: [foxBase, walkFrame(foxBase, ".O...O.", "......."), foxBase, walkFrame(foxBase, "...OO..", ".......")],
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
		frames: [
			chickBase,
			walkFrame(chickBase, ".O...O.", "......."),
			chickBase,
			walkFrame(chickBase, "...OO..", "......."),
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
			walkFrame(robotBase, ".D...D.", "......."),
			robotBase,
			walkFrame(robotBase, "...DD..", "......."),
		],
	},
	{
		name: "dragon",
		aliases: ["용", "드래곤"],
		frames: [
			dragonBase,
			walkFrame(dragonBase, ".R...R.", "......."),
			dragonBase,
			walkFrame(dragonBase, "...RR..", "......."),
		],
	},
	{
		name: "frog",
		aliases: ["개구리"],
		frames: [frogBase, walkFrame(frogBase, ".G...G.", "......."), frogBase, walkFrame(frogBase, "...GG..", ".......")],
	},
	{
		name: "alien",
		aliases: ["외계인"],
		frames: [
			alienBase,
			walkFrame(alienBase, ".G...G.", "......."),
			alienBase,
			walkFrame(alienBase, "...GG..", "......."),
		],
	},
	{
		name: "princess",
		aliases: ["공주"],
		frames: [
			princessBase,
			walkFrame(princessBase, ".I...I.", "......."),
			princessBase,
			walkFrame(princessBase, "...II..", "......."),
		],
	},
];

// ─── Default agent → character mapping ───────────────────────────────────────

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

// Validation: Ensure all AGENT_DEFAULTS exist
for (const [agent, charName] of Object.entries(AGENT_DEFAULTS)) {
	if (!charByName.has(charName.toLowerCase())) {
		console.warn(`[pixel-characters] Config Error: Agent "${agent}" defaults to missing character "${charName}"`);
	}
}

function agentHash(name: string): number {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
	return Math.abs(h);
}

export function resolveCharacter(characterField: string | undefined, agentName: string): PixelCharacterDef {
	if (characterField) {
		const found = charByName.get(characterField.toLowerCase().trim());
		if (found) return found;
	}
	const defaultChar = AGENT_DEFAULTS[agentName.toLowerCase()];
	if (defaultChar) {
		const found = charByName.get(defaultChar.toLowerCase());
		if (found) return found;
	}
	const idx = agentHash(agentName) % CHARACTERS.length;
	return CHARACTERS[idx];
}

// ─── Rendering ───────────────────────────────────────────────────────────────

const renderCache = new WeakMap<ReadonlyArray<string>, string[]>();

export function renderFrame(frame: ReadonlyArray<string>): string[] {
	if (renderCache.has(frame)) {
		return renderCache.get(frame)!;
	}

	const rows = [...frame];
	if (rows.length % 2 !== 0) rows.push(".".repeat(rows[0].length));

	const lines: string[] = [];
	for (let y = 0; y < rows.length; y += 2) {
		let line = "";
		const topRow = rows[y];
		const botRow = rows[y + 1];
		for (let x = 0; x < topRow.length; x++) {
			const tKey = topRow[x] as PaletteKey;
			const bKey = botRow[x] as PaletteKey;
			const tc = PAL_ANSI.get(tKey);
			const bc = PAL_ANSI.get(bKey);

			if (!tc && !bc) {
				line += " ";
			} else if (!tc && bc) {
				line += bc.fg + "▄" + RST;
			} else if (tc && !bc) {
				line += tc.fg + "▀" + RST;
			} else if (tc && bc && tKey === bKey) {
				line += tc.fg + "█" + RST;
			} else if (tc && bc) {
				line += tc.bg + bc.fg + "▄" + RST;
			}
		}
		lines.push(line);
	}

	renderCache.set(frame, lines);
	return lines;
}

/** Width in terminal columns of a single character (always 7). */
export const CHAR_WIDTH = 7;
/** Height in terminal rows of a single rendered character (always 3 for 6px). */
export const CHAR_HEIGHT = 3;
