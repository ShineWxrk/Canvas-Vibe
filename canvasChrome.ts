/** Per-canvas background + dots via Obsidian native CSS vars (no custom overlay). */

export interface CanvasChromeStyle {
	/** Hex background; empty = theme default */
	backgroundColor: string;
	/** Show native canvas dots */
	dots: boolean;
	/** Dot fill color (hex) */
	dotColor: string;
	/** Dot opacity 0–100 */
	dotOpacity: number;
	/** @deprecated kept for older saved settings */
	dotSize?: number;
	/** @deprecated kept for older saved settings */
	dotGap?: number;
}

export const DEFAULT_CANVAS_CHROME: CanvasChromeStyle = {
	backgroundColor: "",
	dots: true,
	dotColor: "#c8cdd3",
	dotOpacity: 28,
};

const LEGACY_OVERLAY = "intuition-dot-overlay";
const LEGACY_LAYER = "intuition-dot-layer";

export function normalizeCanvasChrome(
	partial?: Partial<CanvasChromeStyle> | null,
): CanvasChromeStyle {
	const p = partial ?? {};
	return {
		backgroundColor: normalizeHexOrEmpty(
			p.backgroundColor ?? DEFAULT_CANVAS_CHROME.backgroundColor,
		),
		dots: p.dots ?? DEFAULT_CANVAS_CHROME.dots,
		dotColor: normalizeHex(
			p.dotColor ?? DEFAULT_CANVAS_CHROME.dotColor,
			DEFAULT_CANVAS_CHROME.dotColor,
		),
		dotOpacity: clamp(p.dotOpacity ?? DEFAULT_CANVAS_CHROME.dotOpacity, 0, 100),
	};
}

export function hexToRgba(hex: string, opacityPct: number): string {
	const h = normalizeHex(hex, "#ffffff");
	const r = parseInt(h.slice(1, 3), 16);
	const g = parseInt(h.slice(3, 5), 16);
	const b = parseInt(h.slice(5, 7), 16);
	const a = Math.min(1, Math.max(0, opacityPct / 100));
	return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * Tint Obsidian’s native canvas background + SVG dots.
 * No overlays / no pan sync — zero lag on move.
 */
export function applyCanvasChrome(
	root: HTMLElement,
	style: CanvasChromeStyle,
	active: boolean,
) {
	const leaf =
		(root.closest(".workspace-leaf-content") as HTMLElement | null) ?? root;
	const wrapper =
		root.classList.contains("canvas-wrapper")
			? root
			: (root.querySelector(".canvas-wrapper") as HTMLElement | null) ?? root;

	stripLegacyOverlays(wrapper, leaf);

	if (!active) {
		clearCanvasChrome(leaf, wrapper);
		return;
	}

	const s = normalizeCanvasChrome(style);
	leaf.classList.add("intuition-canvas-chrome");
	wrapper.classList.add("intuition-canvas-chrome");
	leaf.dataset.intuitionDots = s.dots ? "1" : "0";
	wrapper.dataset.intuitionDots = s.dots ? "1" : "0";

	const bg = s.backgroundColor || "";
	const dot = hexToRgba(s.dotColor, s.dotOpacity);

	for (const el of [leaf, wrapper]) {
		if (bg) {
			el.style.setProperty("--intuition-canvas-bg", bg);
			// Obsidian native vars
			el.style.setProperty("--canvas-background", bg);
		} else {
			el.style.removeProperty("--intuition-canvas-bg");
			el.style.removeProperty("--canvas-background");
		}
		el.style.setProperty("--intuition-dot-color", dot);
		el.style.setProperty("--canvas-dot-pattern", dot);
	}

	const svg = wrapper.querySelector(
		"svg.canvas-background",
	) as unknown as HTMLElement | null;
	if (svg) {
		if (bg) {
			svg.style.setProperty("background-color", bg);
			svg.style.setProperty("--canvas-background", bg);
		} else {
			svg.style.removeProperty("background-color");
			svg.style.removeProperty("--canvas-background");
		}
		svg.style.setProperty("--canvas-dot-pattern", dot);
		svg.style.setProperty("--intuition-dot-color", dot);
	}
}

/** No-op kept so older main.ts call sites compile during edits. */
export function startChromeTransformSync(_wrapper: HTMLElement): () => void {
	return () => {};
}

export function clearCanvasChrome(...els: Array<HTMLElement | null | undefined>) {
	for (const el of els) {
		if (!el) continue;
		el.classList.remove("intuition-canvas-chrome");
		delete el.dataset.intuitionDots;
		el.style.removeProperty("--intuition-canvas-bg");
		el.style.removeProperty("--intuition-dot-color");
		el.style.removeProperty("--canvas-background");
		el.style.removeProperty("--canvas-dot-pattern");
		stripLegacyOverlays(el);
		el
			.querySelectorAll("svg.canvas-background")
			.forEach((svg) => {
				const s = svg as unknown as HTMLElement;
				s.style.removeProperty("background-color");
				s.style.removeProperty("--canvas-background");
				s.style.removeProperty("--canvas-dot-pattern");
				s.style.removeProperty("--intuition-dot-color");
			});
	}
}

function stripLegacyOverlays(...roots: Array<HTMLElement | null | undefined>) {
	for (const root of roots) {
		if (!root) continue;
		root.querySelectorAll(`.${LEGACY_OVERLAY}, .${LEGACY_LAYER}`).forEach((el) =>
			el.remove(),
		);
	}
}

/** Sample current canvas/theme background as #rrggbb for the color picker. */
export function sampleCanvasBackground(root: HTMLElement): string {
	const svg = root.querySelector(
		"svg.canvas-background",
	) as SVGElement | null;
	const target = (svg as unknown as HTMLElement) ?? root;
	const bg =
		getComputedStyle(target).backgroundColor ||
		getComputedStyle(document.body).getPropertyValue("--canvas-background") ||
		getComputedStyle(document.body).getPropertyValue("--background-primary");
	return rgbStringToHex(bg.trim()) || "#1e1f24";
}

function clamp(n: number, min: number, max: number) {
	if (!Number.isFinite(n)) return min;
	return Math.min(max, Math.max(min, n));
}

function normalizeHex(value: string, fallback: string): string {
	if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
	if (/^#[0-9a-fA-F]{3}$/.test(value)) {
		const r = value[1];
		const g = value[2];
		const b = value[3];
		return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
	}
	return fallback;
}

function normalizeHexOrEmpty(value: string): string {
	if (!value) return "";
	return normalizeHex(value, "");
}

function rgbStringToHex(input: string): string {
	if (/^#[0-9a-fA-F]{6}$/.test(input)) return input.toLowerCase();
	const m = input.match(
		/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i,
	);
	if (!m) return "";
	const r = Math.round(Number(m[1]));
	const g = Math.round(Number(m[2]));
	const b = Math.round(Number(m[3]));
	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function toHex(n: number) {
	return Math.min(255, Math.max(0, n)).toString(16).padStart(2, "0");
}
