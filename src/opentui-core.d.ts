declare module "@opentui/core" {
	export type StyledText = unknown;

	export class CliRenderer {
		width: number;
		root: {
			add(child: unknown): void;
		};
		requestLive(): void;
		dropLive(): void;
		destroy(): void;
	}

	export function createCliRenderer(
		config?: Record<string, unknown>,
	): Promise<CliRenderer>;

	export class BoxRenderable {
		id: string;
		constructor(renderer: CliRenderer, options?: Record<string, unknown>);
		add(child: unknown): void;
		getChildren(): Array<{ id: string }>;
		remove(id: string): void;
	}

	export class TextRenderable {
		id: string;
		text: StyledText;
		content: StyledText;
		constructor(
			renderer: CliRenderer,
			options?: Record<string, unknown> & { text?: StyledText },
		);
	}

	export function bold(input: unknown): StyledText;
	export function brightBlack(input: unknown): StyledText;
	export function green(input: unknown): StyledText;
	export function magenta(input: unknown): StyledText;
	export function yellow(input: unknown): StyledText;
	export function t(
		strings: TemplateStringsArray,
		...values: unknown[]
	): StyledText;
}
