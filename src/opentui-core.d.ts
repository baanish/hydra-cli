declare module "@opentui/core" {
	export type StyledText = string & {
		readonly __styledTextBrand?: unique symbol;
	};

	export type StylableInput = string | number | StyledText;

	export interface Renderable {
		id: string;
	}

	export interface CliRendererConfig {
		exitOnCtrlC?: boolean;
		useAlternateScreen?: boolean;
	}

	export interface BoxRenderableOptions {
		border?: boolean;
		borderStyle?: "rounded" | "solid" | "double";
		flexDirection?: "row" | "column";
		gap?: number;
		padding?: number;
		width?: number | `${number}%` | "100%";
		height?: number | `${number}%` | "100%";
		flexGrow?: number;
	}

	export interface TextRenderableOptions {
		text?: StylableInput;
		content?: StylableInput;
	}

	export class CliRenderer {
		width: number;
		root: {
			add(child: Renderable): void;
		};
		requestLive(): void;
		dropLive(): void;
		destroy(): void;
	}

	export function createCliRenderer(
		config?: CliRendererConfig,
	): Promise<CliRenderer>;

	export class BoxRenderable implements Renderable {
		id: string;
		constructor(renderer: CliRenderer, options?: BoxRenderableOptions);
		add(child: Renderable): void;
		getChildren(): Renderable[];
		remove(id: string): void;
	}

	export class TextRenderable implements Renderable {
		id: string;
		text: StylableInput;
		content: StylableInput;
		constructor(renderer: CliRenderer, options?: TextRenderableOptions);
	}

	export function bold(input: StylableInput): StyledText;
	export function brightBlack(input: StylableInput): StyledText;
	export function green(input: StylableInput): StyledText;
	export function magenta(input: StylableInput): StyledText;
	export function yellow(input: StylableInput): StyledText;
	export function t(
		strings: TemplateStringsArray,
		...values: StylableInput[]
	): StyledText;
}
