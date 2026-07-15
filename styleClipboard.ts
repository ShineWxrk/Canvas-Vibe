import type { IntuitionImageStyle } from "./imageStyles";
import type { IntuitionTextStyle } from "./textStyles";

export type StyleClipboard =
	| { kind: "text"; style: IntuitionTextStyle }
	| { kind: "image"; style: IntuitionImageStyle };

let clipboard: StyleClipboard | null = null;

export function copyTextFormat(style: IntuitionTextStyle) {
	clipboard = { kind: "text", style: { ...style } };
}

export function copyImageFormat(style: IntuitionImageStyle) {
	clipboard = {
		kind: "image",
		style: {
			...style,
			auraPalette: [...(style.auraPalette ?? [])],
		},
	};
}

export function peekStyleClipboard(): StyleClipboard | null {
	return clipboard;
}

export function getCopiedTextFormat(): IntuitionTextStyle | null {
	if (clipboard?.kind !== "text") return null;
	return { ...clipboard.style };
}

export function getCopiedImageFormat(): IntuitionImageStyle | null {
	if (clipboard?.kind !== "image") return null;
	return {
		...clipboard.style,
		auraPalette: [...(clipboard.style.auraPalette ?? [])],
	};
}

export function hasTextFormat(): boolean {
	return clipboard?.kind === "text";
}

export function hasImageFormat(): boolean {
	return clipboard?.kind === "image";
}
