/**
 * Pixel art character definitions and half-block rendering engine.
 *
 * Two character groups:
 *   1. Role-based icons — matched to agent roles via AGENT_DEFAULTS
 *   2. Legacy creatures — available for custom `character:` field assignment
 *
 * Each character is a 7px × 7px grid with 2+ animation frames.
 * Rendered using ▀▄█ half-block technique → 7 cols × 4 terminal rows.
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
	frames: string[][];
}

function walkFrame(base: string[], footA: string, footB: string): string[] {
	const f = [...base];
	f[f.length - 2] = footA;
	f[f.length - 1] = footB;
	return f;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROLE-BASED ICON CHARACTERS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── 1. Construction Worker (worker) — subtle walk ───────────────────────────
const hardhatStand = [".YYYYY.", "..YYY..", "..SES..", "..oOo..", ".OOOOO.", "..N.N..", "......."];
const hardhatWalkL = [".YYYYY.", "..YYY..", "..SES..", "..oOo..", ".OOOOO.", ".N..N..", "......."];
const hardhatWalkR = [".YYYYY.", "..YYY..", "..SES..", "..oOo..", ".OOOOO.", "..N..N.", "......."];

// ─── 2. Rotating Globe (browser) — band rotation ────────────────────────────
const globeF0 = ["..BBB..", ".GGBBB.", "BGGBBBB", "BGGBBBB", ".GGBBB.", "..BBB..", "......."];
const globeF1 = ["..BBB..", ".BGGBB.", "BBGGBBB", "BBGGBBB", ".BGGBB.", "..BBB..", "......."];
const globeF2 = ["..BBB..", ".BBGGB.", "BBBGGBB", "BBBGGBB", ".BBGGB.", "..BBB..", "......."];
const globeF3 = ["..BBB..", ".BBBGG.", "BBBBGGB", "BBBBGGB", ".BBBGG.", "..BBB..", "......."];

// ─── 3. Boxing Glove (challenger) — horizontal punch ─────────────────────────
const glovePull = [".......", "RRR....", "RRRRR..", "RRRRr..", ".N.....", ".......", "......."];
const glovePunch = [".......", "....RRR", "..RRRRR", "..RRRRr", ".....N.", ".......", "......."];
const gloveHit = ["......Y", "....RRR", "..RRRRR", "..RRRRr", ".....N.", ".......", "......."];

// ─── 4. Folder Icon (finder) — open/close ────────────────────────────────────
const folderClosed = [".OOO...", "OOOOOOO", "OwwwwwO", "OwKKKwO", "OwwwwwO", "OOOOOOO", "......."];
const folderOpen = [".OOO.W.", "OOOOOOO", "OwWKWwO", "OwWKWwO", "OwwwwwO", "OOOOOOO", "......."];

// ─── 5. Wizard Hat (planner) — orbiting star ─────────────────────────────────
const wizardF0 = ["...P...", "..PPP..", "..PPP..", ".PPPPP.", ".PPYPP.", "PPPPPPP", "......."];
const wizardF1 = ["...P...", "..PPP..", "..PPP.Y", ".PPPPP.", ".PPWPP.", "PPPPPPP", "......."];
const wizardF2 = ["...PY..", "..PPP..", "..PPP..", ".PPPPP.", ".PPWPP.", "PPPPPPP", "......."];
const wizardF3 = ["...P...", "..PPP..", "Y.PPP..", ".PPPPP.", ".PPWPP.", "PPPPPPP", "......."];

// ─── 6. Computer Monitor (reviewer) — scrolling diff ─────────────────────────
const monitorF0 = ["DDDDDDD", "DGGKRRD", "DRRKKGD", "DKKGGRD", "DDDDDDD", "...D...", "..DDD.."];
const monitorF1 = ["DDDDDDD", "DRRKKGD", "DKKGGRD", "DGGKRRD", "DDDDDDD", "...D...", "..DDD.."];

// ─── 7. Magnifying Glass (searcher) — handle separated from lens ─────────────
const magF0 = ["..LLL..", ".LwwwL.", ".LwwwL.", ".LwwwL.", "..LLL..", ".....N.", "......N"];
const magF1 = ["..LLL..", ".LWwwL.", ".LwwwL.", ".LwwwL.", "..LLL..", ".....N.", "......N"];
const magF2 = ["..LLL..", ".LwWwL.", ".LwwwL.", ".LwwwL.", "..LLL..", ".....N.", "......N"];
const magF3 = ["..LLL..", ".LwwWL.", ".LwwwL.", ".LwwwL.", "..LLL..", ".....N.", "......N"];

// ─── 8. Checkbox (verifier) — empty ↔ checked ───────────────────────────────
const checkEmpty = ["LLLLLLL", "L.....L", "L.....L", "L.....L", "L.....L", "L.....L", "LLLLLLL"];
const checkDone = ["LLLLLLL", "LG...GL", "L.G.G.L", "L..G..L", "L.....L", "L.....L", "LLLLLLL"];

// ─── 9. Judge's Gavel (decider) — bright slam ───────────────────────────────
const gavelF0 = [".YYYYY.", "..YyY..", "...O...", "...O...", ".......", ".......", ".nnnnn."];
const gavelF1 = [".......", ".YYYYY.", "..YyY..", "...O...", "...O...", ".......", ".nnnnn."];
const gavelF2 = [".......", ".......", ".......", ".YYYYY.", "..YyO..", ".nnnnn.", "..Y.Y.."];

// ═══════════════════════════════════════════════════════════════════════════════
// LEGACY CREATURE CHARACTERS
// ═══════════════════════════════════════════════════════════════════════════════

const catBase = [".L...L.", ".LL.LL.", ".LLLLL.", ".LELEL.", "..LIL..", ".LLLLL.", "..L.L.."];
const bunnyBase = ["..W.W..", "..W.W..", ".WWWWW.", ".WEWEW.", "..WWW..", ".WWWWW.", "..W.W.."];
const bearBase = ["NN...NN", ".NNNNN.", ".NENEN.", "..NNN..", "..NnN..", ".NNNNN.", "..N.N.."];
const penguinBase = ["..KKK..", ".KKKKK.", ".KWKWK.", "..KOK..", ".KWWWK.", "..KKK..", "..O.O.."];
const foxBase = [".O...O.", ".OO.OO.", ".OOOOO.", ".OEOEO.", "..OWO..", ".OWWWO.", "..O.O.."];
const chickBase = ["..YYY..", ".YYYYY.", ".YEYEY.", "..YOY..", "..YYY..", ".YYYYY.", "..o.o.."];
const ghostBase = ["..www..", ".wwwww.", ".wEwEw.", ".wwwww.", ".wwwww.", ".wwwww.", ".w.w.w."];
const ghostFloat = [".......", "..www..", ".wwwww.", ".wEwEw.", ".wwwww.", ".wwwww.", ".w.w.w."];
const robotBase = ["...L...", ".DDDDD.", ".DCDCD.", ".DDDDD.", ".DLDLD.", "..DDD..", "..D.D.."];
const dragonBase = [".R...R.", ".RRRRR.", ".RERER.", "..RRR..", "R.RRR.R", "..RRR..", "..R.R.."];
const frogBase = ["..W.W..", ".GGGGG.", ".GEGEG.", "GGGGGGG", ".GGGGG.", "..GGG..", "..G.G.."];
const alienBase = ["..CCC..", ".CCCCC.", "CCCCCCC", ".CECEC.", ".CCCCC.", "..CCC..", "..C.C.."];
const princessBase = [".Y.Y.Y.", "..YYY..", ".SSSSS.", ".SESES.", "..SSS..", ".IIIII.", "..I.I.."];

const slimeBase = [".......", "..GGG..", ".GGGGG.", ".GWGWG.", ".GGGGG.", "GGGGGGG", ".GG.GG."];
const slimeBounce = [".......", ".......", "..GGG..", ".GWGWG.", ".GGGGG.", "GGGGGGG", ".GG.GG."];
const mushroomBase = ["..RRR..", ".RRRRR.", "RRWRWRR", ".RRRRR.", "..www..", "..www..", ".wwwww."];
const mushroomSwell = [".RRRRR.", "RRRRRRR", "RWRRWRR", "RRRRRRR", "..www..", "..www..", ".wwwww."];

function recolorSlime(base: string[], from: string, to: string): string[] {
	return base.map((row) => row.replaceAll(from, to));
}

// ─── Character Registry ─────────────────────────────────────────────────────

export const CHARACTERS: PixelCharacterDef[] = [
	// ── Role-based icons ──
	{
		name: "hardhat",
		aliases: ["건설공", "worker-icon", "construction"],
		frames: [hardhatStand, hardhatWalkL, hardhatStand, hardhatWalkR],
	},
	{
		name: "globe",
		aliases: ["지구본", "earth", "browser-icon"],
		frames: [globeF0, globeF1, globeF2, globeF3],
	},
	{
		name: "glove",
		aliases: ["글러브", "boxing-glove", "challenger-icon", "권투글러브"],
		frames: [glovePull, glovePunch, gloveHit, glovePunch],
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
			walkFrame(chickBase, ".o...o.", "......."),
			chickBase,
			walkFrame(chickBase, "...oo..", "......."),
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
			walkFrame(alienBase, ".C...C.", "......."),
			alienBase,
			walkFrame(alienBase, "...CC..", "......."),
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
		const found = charByName.get(defaultChar);
		if (found) return found;
	}
	const idx = agentHash(agentName) % CHARACTERS.length;
	return CHARACTERS[idx];
}

// ─── Rendering ───────────────────────────────────────────────────────────────

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

/** Width in terminal columns of a single character (always 7). */
export const CHAR_WIDTH = 7;
/** Height in terminal rows of a single rendered character (always 4 for 7px with padding). */
export const CHAR_HEIGHT = 4;
