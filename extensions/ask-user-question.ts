import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

interface AskUserQuestionDetails {
	question: string;
	context?: string;
	options: string[];
	allowCustomAnswer: boolean;
	allowMultiple: boolean;
	answer: string | null;
	answers: string[];
	selectedOption?: string;
	selectedOptions?: string[];
	selectedIndex?: number;
	selectedIndices?: number[];
	customInput?: string;
	cancelled: boolean;
}

const AskUserQuestionParams = Type.Object({
	question: Type.String({ description: "Question to ask the user" }),
	context: Type.Optional(Type.String({ description: "Optional extra context shown to the user" })),
	options: Type.Optional(Type.Array(Type.String(), { description: "Optional predefined options" })),
	allowCustomAnswer: Type.Optional(
		Type.Boolean({ description: "If true, allow typing a custom answer when options are provided", default: true }),
	),
	allowMultiple: Type.Optional(
		Type.Boolean({ description: "If true, allow selecting multiple options", default: false }),
	),
	placeholder: Type.Optional(Type.String({ description: "Optional input placeholder for typed answers" })),
});

const OTHER_OPTION_LABEL = "Other (type your own)";
const DONE_OPTION_LABEL = "Done selecting";

function normalizeOptions(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const dedup = new Set<string>();
	for (const item of raw) {
		if (typeof item !== "string") continue;
		const normalized = item.trim();
		if (!normalized) continue;
		dedup.add(normalized);
	}
	return Array.from(dedup);
}

function buildPrompt(question: string, context?: string): string {
	const ctx = typeof context === "string" ? context.trim() : "";
	if (!ctx) return question;
	return `${question}\n\n${ctx}`;
}

function clampLines(text: string, maxLines: number): string {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	const hidden = lines.length - maxLines;
	const visible = lines.slice(0, maxLines);
	const lastIndex = visible.length - 1;
	visible[lastIndex] = `${visible[lastIndex]} … (+${hidden} lines)`;
	return visible.join("\n");
}

function buildDetails(
	base: Omit<AskUserQuestionDetails, "answer" | "answers" | "cancelled"> & {
		answer?: string | null;
		answers?: string[];
		cancelled?: boolean;
	},
): AskUserQuestionDetails {
	return {
		...base,
		answer: base.answer ?? null,
		answers: base.answers ?? [],
		cancelled: base.cancelled ?? false,
	};
}

function buildCancelledResult(
	question: string,
	context: string | undefined,
	options: string[],
	allowCustomAnswer: boolean,
	allowMultiple: boolean,
) {
	return {
		content: [{ type: "text" as const, text: "User cancelled AskUserQuestion." }],
		details: buildDetails({
			question,
			context,
			options,
			allowCustomAnswer,
			allowMultiple,
			cancelled: true,
		}),
	};
}

type MultiSelectResult = {
	cancelled: boolean;
	answers: string[];
	selectedIndices: number[];
	customInput?: string;
};

async function promptForCustomInput(ctx: ExtensionContext, placeholder: string): Promise<string | undefined> {
	const answer = await ctx.ui.input("Your answer", placeholder);
	if (answer === undefined) return undefined;
	const normalized = answer.trim();
	if (!normalized) {
		ctx.ui.notify("Empty custom answer ignored.", "warning");
		return "";
	}
	return normalized;
}

async function askMultipleOptions(
	ctx: ExtensionContext,
	question: string,
	context: string | undefined,
	options: string[],
	allowCustomAnswer: boolean,
	placeholder: string,
): Promise<MultiSelectResult> {
	const selectedOptionIndices = new Set<number>();
	const customAnswers: string[] = [];

	while (true) {
		type Entry =
			| { kind: "option"; label: string; optionIndex: number }
			| { kind: "custom"; label: string; customIndex: number }
			| { kind: "other"; label: string }
			| { kind: "done"; label: string };

		const entries: Entry[] = [];
		for (let i = 0; i < options.length; i++) {
			const checked = selectedOptionIndices.has(i) ? "☑" : "☐";
			entries.push({ kind: "option", optionIndex: i, label: `${checked} ${i + 1}. ${options[i]}` });
		}

		if (allowCustomAnswer) {
			entries.push({ kind: "other", label: OTHER_OPTION_LABEL });
			for (let i = 0; i < customAnswers.length; i++) {
				entries.push({ kind: "custom", customIndex: i, label: `☑ custom ${i + 1}. ${customAnswers[i]}` });
			}
		}

		const selectedSummary = [
			...Array.from(selectedOptionIndices)
				.sort((a, b) => a - b)
				.map((index) => options[index]),
			...customAnswers,
		];
		entries.push({ kind: "done", label: `${DONE_OPTION_LABEL} (${selectedSummary.length} selected)` });

		const choice = await ctx.ui.select(
			`${buildPrompt(question, context)}\n\nSelected: ${selectedSummary.length > 0 ? selectedSummary.join(", ") : "(none)"}`,
			entries.map((entry) => entry.label),
		);

		if (choice === undefined) {
			return { cancelled: true, answers: [], selectedIndices: [] };
		}

		const selectedEntry = entries.find((entry) => entry.label === choice);
		if (!selectedEntry) continue;

		switch (selectedEntry.kind) {
			case "option": {
				if (selectedOptionIndices.has(selectedEntry.optionIndex)) {
					selectedOptionIndices.delete(selectedEntry.optionIndex);
				} else {
					selectedOptionIndices.add(selectedEntry.optionIndex);
				}
				break;
			}
			case "custom": {
				customAnswers.splice(selectedEntry.customIndex, 1);
				break;
			}
			case "other": {
				const customAnswer = await promptForCustomInput(ctx, placeholder);
				if (customAnswer === undefined) continue;
				if (!customAnswer) continue;
				if (!customAnswers.includes(customAnswer)) customAnswers.push(customAnswer);
				break;
			}
			case "done": {
				const answers = [
					...Array.from(selectedOptionIndices)
						.sort((a, b) => a - b)
						.map((index) => options[index]),
					...customAnswers,
				];
				if (answers.length === 0) {
					ctx.ui.notify("Select at least one option before finishing.", "warning");
					break;
				}
				return {
					cancelled: false,
					answers,
					selectedIndices: Array.from(selectedOptionIndices)
						.sort((a, b) => a - b)
						.map((index) => index + 1),
					customInput: customAnswers.length > 0 ? customAnswers.join(", ") : undefined,
				};
			}
		}
	}
}

export default function askUserQuestionExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "AskUserQuestion",
		label: "AskUserQuestion",
		description:
			"Ask the user a question and wait for their response. Use this when you need explicit user input before proceeding.",
		parameters: AskUserQuestionParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const question = typeof params.question === "string" ? params.question.trim() : "";
			const context = typeof params.context === "string" ? params.context.trim() : undefined;
			const options = normalizeOptions(params.options);
			const allowCustomAnswer = params.allowCustomAnswer ?? true;
			const allowMultiple = params.allowMultiple ?? false;
			const placeholder = typeof params.placeholder === "string" ? params.placeholder : "";

			if (!question) {
				return {
					content: [{ type: "text" as const, text: "AskUserQuestion requires a non-empty question." }],
					details: buildDetails({
						question,
						context,
						options,
						allowCustomAnswer,
						allowMultiple,
						cancelled: true,
					}),
					isError: true,
				};
			}

			if (!ctx.hasUI) {
				return {
					content: [{ type: "text" as const, text: "AskUserQuestion requires interactive mode (UI unavailable)." }],
					details: buildDetails({
						question,
						context,
						options,
						allowCustomAnswer,
						allowMultiple,
						cancelled: true,
					}),
					isError: true,
				};
			}

			ctx.ui.notify("Waiting for input", "info");

			if (allowMultiple && options.length > 0) {
				const multipleResult = await askMultipleOptions(
					ctx,
					question,
					context,
					options,
					allowCustomAnswer,
					placeholder,
				);

				if (multipleResult.cancelled) {
					return buildCancelledResult(question, context, options, allowCustomAnswer, allowMultiple);
				}

				const answerText = multipleResult.answers.join(", ");
				return {
					content: [{ type: "text" as const, text: answerText }],
					details: buildDetails({
						question,
						context,
						options,
						allowCustomAnswer,
						allowMultiple,
						answer: answerText,
						answers: multipleResult.answers,
						selectedOptions: multipleResult.answers,
						selectedIndices: multipleResult.selectedIndices,
						customInput: multipleResult.customInput,
					}),
				};
			}

			let answer: string | undefined;
			let selectedOption: string | undefined;
			let selectedIndex: number | undefined;
			let customInput: string | undefined;

			if (options.length > 0) {
				const selectable = allowCustomAnswer ? [...options, OTHER_OPTION_LABEL] : [...options];
				const selected = await ctx.ui.select(buildPrompt(question, context), selectable);

				if (selected === undefined) {
					return buildCancelledResult(question, context, options, allowCustomAnswer, allowMultiple);
				}

				if (selected === OTHER_OPTION_LABEL) {
					selectedOption = "custom";
					customInput = await promptForCustomInput(ctx, placeholder);
					if (customInput === undefined) {
						return buildCancelledResult(question, context, options, allowCustomAnswer, allowMultiple);
					}
					answer = customInput;
				} else {
					selectedOption = selected;
					selectedIndex = options.indexOf(selected) + 1;
					answer = selected;
				}
			} else {
				answer = await ctx.ui.input(buildPrompt(question, context), placeholder);
				if (answer === undefined) {
					return buildCancelledResult(question, context, options, allowCustomAnswer, allowMultiple);
				}
				customInput = answer.trim() || undefined;
			}

			const normalizedAnswer = answer.trim();
			return {
				content: [{ type: "text" as const, text: normalizedAnswer || "(empty answer)" }],
				details: buildDetails({
					question,
					context,
					options,
					allowCustomAnswer,
					allowMultiple,
					answer: normalizedAnswer,
					answers: [normalizedAnswer],
					selectedOption,
					selectedOptions:
						selectedOption && selectedOption !== "custom"
							? [selectedOption]
							: normalizedAnswer
								? [normalizedAnswer]
								: [],
					selectedIndex,
					selectedIndices: selectedIndex ? [selectedIndex] : undefined,
					customInput: selectedOption === "custom" ? normalizedAnswer : customInput,
				}),
			};
		},

		renderCall(args, theme) {
			const question = typeof args.question === "string" ? args.question : "(no question)";
			const context = typeof args.context === "string" && args.context.trim() ? args.context.trim() : "";
			const options = normalizeOptions(args.options);
			const allowCustomAnswer = args.allowCustomAnswer ?? true;
			const allowMultiple = args.allowMultiple ?? false;

			let text = theme.fg("toolTitle", theme.bold("AskUserQuestion")) + " " + theme.fg("accent", question);
			if (options.length > 0) {
				const renderedOptions = allowCustomAnswer ? [...options, "Other"] : options;
				text += `\n${theme.fg("dim", `options:${renderedOptions.length}${allowMultiple ? " · multi" : ""}`)}`;
				for (let i = 0; i < Math.min(renderedOptions.length, 4); i++) {
					text += `\n${theme.fg("muted", `- ${renderedOptions[i]}`)}`;
				}
				if (renderedOptions.length > 4) {
					text += `\n${theme.fg("muted", `… ${renderedOptions.length - 4} more`)}`;
				}
			} else if (context) {
				text += `\n${theme.fg("muted", context)}`;
			}
			return new Text(clampLines(text, 6), 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskUserQuestionDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			if (details.allowMultiple) {
				const answers = details.answers?.filter((answer) => answer && answer.trim()) ?? [];
				let text =
					theme.fg("success", "✓ ") +
					theme.fg("muted", `selected ${answers.length}: `) +
					theme.fg("accent", answers.length > 0 ? answers.join(", ") : "(none)");
				if (details.customInput) {
					text += `\n${theme.fg("dim", `custom: ${details.customInput}`)}`;
				}
				return new Text(clampLines(text, 3), 0, 0);
			}

			const answerText = details.answer ?? "";
			if (details.selectedOption && details.selectedOption !== "custom") {
				const indexPrefix = details.selectedIndex ? `${details.selectedIndex}. ` : "";
				return new Text(
					theme.fg("success", "✓ ") +
						theme.fg("muted", "selected ") +
						theme.fg("accent", `${indexPrefix}${answerText}`),
					0,
					0,
				);
			}

			return new Text(
				theme.fg("success", "✓ ") + theme.fg("muted", "answered ") + theme.fg("accent", answerText || "(empty answer)"),
				0,
				0,
			);
		},
	});
}
