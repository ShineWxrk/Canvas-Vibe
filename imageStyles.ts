import {
	extractPalette,
	paintAuraLayer,
	removeAuraLayer,
	waitForImage,
} from "./imageAura";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;

export type ImageBorderStyle = "solid" | "dashed" | "dotted";

export interface IntuitionImageStyle {
	opacity: number;
	borderWidth: number;
	borderColor: string;
	borderStyle: ImageBorderStyle;
	/** Corner roundness in px */
	borderRadius: number;
	aura: boolean;
	auraStrength: number;
	/** Aura footprint as % of the node box. */
	auraSize: number;
	/** Cached dominant color from the image (hex). */
	auraColor: string;
	/** Extra palette colors for shimmer (hex). */
	auraPalette: string[];
	/** v2 drifting multi-color blobs */
	auraShimmer: boolean;
	/** When false, vibe tilt/glare skip this image */
	vibeTilt: boolean;
	/** Per-image tilt strength 0–100% (multiplies canvas vibe strength) */
	vibeTiltStrength: number;
}

export const DEFAULT_IMAGE_STYLE: IntuitionImageStyle = {
	opacity: 100,
	borderWidth: 0,
	borderColor: "#d6d9db",
	borderStyle: "solid",
	borderRadius: 12,
		aura: true,
	auraStrength: 50,
	auraSize: 100,
	auraColor: "",
	auraPalette: [],
	auraShimmer: true,
	vibeTilt: true,
	vibeTiltStrength: 100,
};

export const BORDER_STYLE_OPTIONS: {
	label: string;
	value: ImageBorderStyle;
}[] = [
	{ label: "Сплошная", value: "solid" },
	{ label: "Пунктир", value: "dashed" },
	{ label: "Точки", value: "dotted" },
];

export interface ImageNodeData {
	type?: string;
	file?: string;
	intuitionImage?: Partial<IntuitionImageStyle>;
	[key: string]: unknown;
}

export interface ImageNodeLike {
	id: string;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	nodeEl?: HTMLElement | null;
	file?: { path?: string } | null;
	filePath?: string;
	render?: () => void;
	getData?: () => ImageNodeData;
	setData?: (data: ImageNodeData, addHistory?: boolean) => void;
	canvas?: { requestSave?: () => void };
}

const PAINT_ATTR = "data-intuition-image-painted";
const BORDER_ATTR = "data-intuition-image-border";
const PAINT_KEY_ATTR = "intuitionPaintKey";

/** Debounced canvas.save after palette extraction (avoid N saves on bulk paint). */
const pendingAuraSaves = new WeakMap<object, number>();
const auraExtractInflight = new Map<string, Promise<void>>();

const CSS_VARS = [
	"--intuition-image-opacity",
	"--intuition-image-border-width",
	"--intuition-image-border-color",
	"--intuition-image-border-style",
	"--intuition-image-border-radius",
] as const;

export function isImageNode(node: ImageNodeLike): boolean {
	const data = node.getData?.();
	if (data?.type && data.type !== "file") return false;

	const path =
		node.file?.path ??
		node.filePath ??
		(typeof data?.file === "string" ? data.file : undefined);

	if (path) return IMAGE_EXT.test(path);
	/* .media-embed also wraps audio/video — only treat real images as photos. */
	return !!node.nodeEl?.querySelector("img, .image-embed");
}

export function readImageStyle(node: ImageNodeLike): IntuitionImageStyle {
	const stored = node.getData?.()?.intuitionImage ?? {};
	return {
		opacity: clampOpacity(stored.opacity ?? DEFAULT_IMAGE_STYLE.opacity),
		borderWidth: clampBorderWidth(
			stored.borderWidth ?? DEFAULT_IMAGE_STYLE.borderWidth,
		),
		borderColor: normalizeColor(
			stored.borderColor ?? DEFAULT_IMAGE_STYLE.borderColor,
		),
		borderStyle: normalizeBorderStyle(
			stored.borderStyle ?? DEFAULT_IMAGE_STYLE.borderStyle,
		),
		borderRadius: clampBorderRadius(
			stored.borderRadius ?? DEFAULT_IMAGE_STYLE.borderRadius,
		),
		aura: stored.aura ?? DEFAULT_IMAGE_STYLE.aura,
		auraStrength: clampAuraStrength(
			stored.auraStrength ?? DEFAULT_IMAGE_STYLE.auraStrength,
		),
		auraSize: clampAuraSize(stored.auraSize ?? DEFAULT_IMAGE_STYLE.auraSize),
		auraColor:
			typeof stored.auraColor === "string" && /^#[0-9a-fA-F]{6}$/.test(stored.auraColor)
				? stored.auraColor
				: DEFAULT_IMAGE_STYLE.auraColor,
		auraPalette: Array.isArray(stored.auraPalette)
			? stored.auraPalette.filter(
					(c): c is string => typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c),
				)
			: DEFAULT_IMAGE_STYLE.auraPalette,
		auraShimmer: stored.auraShimmer ?? DEFAULT_IMAGE_STYLE.auraShimmer,
		vibeTilt: stored.vibeTilt ?? DEFAULT_IMAGE_STYLE.vibeTilt,
		vibeTiltStrength: clampVibeTiltStrength(
			stored.vibeTiltStrength ?? DEFAULT_IMAGE_STYLE.vibeTiltStrength,
		),
	};
}

export function writeImageStyle(node: ImageNodeLike, style: IntuitionImageStyle) {
	const data = { ...(node.getData?.() ?? {}) };
	data.intuitionImage = {
		opacity: clampOpacity(style.opacity),
		borderWidth: clampBorderWidth(style.borderWidth),
		borderColor: normalizeColor(style.borderColor),
		borderStyle: normalizeBorderStyle(style.borderStyle),
		borderRadius: clampBorderRadius(style.borderRadius),
		aura: !!style.aura,
		auraStrength: clampAuraStrength(style.auraStrength),
		auraSize: clampAuraSize(style.auraSize),
		auraColor: style.auraColor || undefined,
		auraPalette: style.auraPalette?.length ? style.auraPalette : undefined,
		auraShimmer: !!style.auraShimmer,
		vibeTilt: style.vibeTilt !== false,
		vibeTiltStrength: clampVibeTiltStrength(style.vibeTiltStrength),
	};
	node.setData?.(data);
	applyImageStyleToDom(node, style);
	node.canvas?.requestSave?.();
}

export function clearImageStyle(node: ImageNodeLike) {
	const data = { ...(node.getData?.() ?? {}) };
	delete data.intuitionImage;
	node.setData?.(data);

	const el = node.nodeEl;
	if (el) {
		for (const prop of CSS_VARS) el.style.removeProperty(prop);
		delete el.dataset.intuitionImage;
		delete el.dataset.intuitionNoTilt;
		delete el.dataset.intuitionTiltStrength;
		delete el.dataset[PAINT_KEY_ATTR];
		clearPaintedStyles(el);
	}

	// Back to defaults (aura on @ 100%)
	applyImageStyleToDom(node, { ...DEFAULT_IMAGE_STYLE });
	node.canvas?.requestSave?.();
}

export function applyImageStyleToDom(
	node: ImageNodeLike,
	style?: IntuitionImageStyle,
) {
	const el = node.nodeEl;
	if (!el) return;

	const s = style ?? readImageStyle(node);
	const opacity = clampOpacity(s.opacity) / 100;
	const borderWidth = clampBorderWidth(s.borderWidth);
	const borderColor = normalizeColor(s.borderColor);
	const borderStyle = normalizeBorderStyle(s.borderStyle);
	const borderRadius = clampBorderRadius(s.borderRadius);
	const paintKey = [
		opacity.toFixed(4),
		borderWidth,
		borderColor,
		borderStyle,
		borderRadius,
		s.vibeTilt === false ? 0 : 1,
		clampVibeTiltStrength(s.vibeTiltStrength),
		s.aura ? 1 : 0,
		clampAuraStrength(s.auraStrength),
		clampAuraSize(s.auraSize),
		s.auraShimmer ? 1 : 0,
		s.auraColor || "",
		(s.auraPalette ?? []).join(","),
	].join("|");

	const hasPaintedMedia = !!el.querySelector(
		`img[${PAINT_ATTR}], .media-embed[${PAINT_ATTR}], .image-embed[${PAINT_ATTR}]`,
	);
	const hasAura = el.dataset.intuitionAura === "1";
	const auraLive = !!el.querySelector(".intuition-image-aura");
	/* After plugin reload dataset may linger while the DOM layer is gone. */
	const auraStateOk = !!s.aura === hasAura && (!s.aura || auraLive);
	if (el.dataset[PAINT_KEY_ATTR] === paintKey && hasPaintedMedia && auraStateOk) {
		return;
	}

	el.dataset.intuitionImage = "1";
	el.dataset[PAINT_KEY_ATTR] = paintKey;
	if (s.vibeTilt === false) {
		el.dataset.intuitionNoTilt = "1";
		delete el.dataset.intuitionTiltStrength;
	} else {
		delete el.dataset.intuitionNoTilt;
		el.dataset.intuitionTiltStrength = String(
			clampVibeTiltStrength(s.vibeTiltStrength),
		);
	}
	el.style.setProperty("--intuition-image-opacity", String(opacity));
	el.style.setProperty("--intuition-image-border-width", `${borderWidth}px`);
	el.style.setProperty("--intuition-image-border-color", borderColor);
	el.style.setProperty("--intuition-image-border-style", borderStyle);
	el.style.setProperty("--intuition-image-border-radius", `${borderRadius}px`);

	paintImageStyles(el, opacity, borderWidth, borderColor, borderStyle, borderRadius);
	void applyAura(node, s);

	// Retry once if Canvas hasn't mounted media/container yet.
	const needsRetry =
		!el.querySelector(".canvas-node-container") ||
		!el.querySelector("img, .media-embed, .image-embed");
	if (!needsRetry) return;

	window.requestAnimationFrame(() => {
		if (!node.nodeEl || node.nodeEl !== el) return;
		paintImageStyles(el, opacity, borderWidth, borderColor, borderStyle, borderRadius);
		void applyAura(node, s);
	});
}

async function applyAura(node: ImageNodeLike, style: IntuitionImageStyle) {
	const el = node.nodeEl;
	if (!el) return;

	if (!style.aura) {
		removeAuraLayer(el);
		return;
	}

	let color = style.auraColor;
	let palette = [...style.auraPalette];

	if (!color) {
		const img = el.querySelector("img") as HTMLImageElement | null;
		if (!img) {
			paintAuraLayer(el, {
				color: "#7a6bb5",
				strength: style.auraStrength * (clampOpacity(style.opacity) / 100),
				size: style.auraSize,
				seed: node.id,
				shimmer: style.auraShimmer,
			});
			return;
		}

		const inflightKey = node.id;
		let pending = auraExtractInflight.get(inflightKey);
		if (!pending) {
			pending = (async () => {
				try {
					const ready = await waitForImage(img);
					if (!ready || node.nodeEl !== el) return;
					const extracted = extractPalette(ready);
					const extractedColor = extracted?.[0] || "#7a6bb5";
					const extractedPalette = extracted ?? [extractedColor];

					const data = { ...(node.getData?.() ?? {}) };
					const prev = data.intuitionImage ?? {};
					if (
						prev.auraColor !== extractedColor ||
						!arraysEqual(prev.auraPalette, extractedPalette)
					) {
						data.intuitionImage = {
							...prev,
							auraColor: extractedColor,
							auraPalette: extractedPalette,
						};
						node.setData?.(data, false);
						queueAuraPaletteSave(node.canvas);
					}

					if (node.nodeEl !== el) return;
					const current = readImageStyle(node);
					if (!current.aura) {
						removeAuraLayer(el);
						return;
					}
					paintAuraLayer(el, {
						color: current.auraColor || extractedColor,
						palette:
							current.auraPalette.length >= 2
								? current.auraPalette
								: extractedPalette,
						strength:
							current.auraStrength * (clampOpacity(current.opacity) / 100),
						size: current.auraSize,
						seed: node.id,
						shimmer: current.auraShimmer,
					});
				} finally {
					auraExtractInflight.delete(inflightKey);
				}
			})();
			auraExtractInflight.set(inflightKey, pending);
		}
		await pending;
		return;
	} else if (palette.length < 2) {
		palette = [color];
	}

	paintAuraLayer(el, {
		color: color || "#7a6bb5",
		palette,
		// Fade aura with the photo so transparent images don't keep solid glow
		strength: style.auraStrength * (clampOpacity(style.opacity) / 100),
		size: style.auraSize,
		seed: node.id,
		shimmer: style.auraShimmer,
	});
}

function queueAuraPaletteSave(canvas?: { requestSave?: () => void } | null) {
	if (!canvas?.requestSave) return;
	const prev = pendingAuraSaves.get(canvas);
	if (prev) window.clearTimeout(prev);
	const id = window.setTimeout(() => {
		pendingAuraSaves.delete(canvas);
		canvas.requestSave?.();
	}, 600);
	pendingAuraSaves.set(canvas, id);
}

function arraysEqual(a: unknown, b: string[]): boolean {
	if (!Array.isArray(a) || a.length !== b.length) return false;
	return a.every((v, i) => v === b[i]);
}

function paintImageStyles(
	nodeEl: HTMLElement,
	opacity: number,
	borderWidth: number,
	borderColor: string,
	borderStyle: ImageBorderStyle,
	borderRadius: number,
) {
	const opacityValue = String(opacity);
	const fullyGone = opacity <= 0.005;
	const radiusPx = `${clampBorderRadius(borderRadius)}px`;
	nodeEl.dataset.intuitionInvisible = fullyGone ? "1" : "0";

	nodeEl
		.querySelectorAll<HTMLElement>("img, .media-embed, .image-embed")
		.forEach((el) => {
			el.style.setProperty("opacity", opacityValue, "important");
			el.style.setProperty("border-radius", radiusPx, "important");
			el.setAttribute(PAINT_ATTR, "1");
			if (fullyGone) {
				el.style.setProperty("border", "none", "important");
				el.style.setProperty("box-shadow", "none", "important");
				el.style.setProperty("outline", "none", "important");
				el.style.setProperty("background", "transparent", "important");
			}
		});

	const container = nodeEl.querySelector(
		".canvas-node-container",
	) as HTMLElement | null;
	const content = nodeEl.querySelector(
		".canvas-node-content",
	) as HTMLElement | null;
	if (!container) return;

	const applyRadius = (el: HTMLElement) => {
		el.style.setProperty("border-radius", radiusPx, "important");
		el.style.setProperty("overflow", "hidden", "important");
		el.setAttribute(BORDER_ATTR, "1");
	};

	const stripChrome = (el: HTMLElement) => {
		el.style.setProperty("border", "none", "important");
		el.style.setProperty("border-width", "0", "important");
		el.style.setProperty("box-shadow", "none", "important");
		el.style.setProperty("outline", "none", "important");
		el.style.setProperty("background", "transparent", "important");
		el.style.setProperty("background-color", "transparent", "important");
		applyRadius(el);
	};

	// Fully transparent photo: kill Obsidian/theme card chrome too
	if (fullyGone || borderWidth <= 0) {
		stripChrome(container);
		if (content) stripChrome(content);
		if (!fullyGone && borderWidth <= 0) {
			container.style.removeProperty("background");
			container.style.removeProperty("background-color");
			if (content) {
				content.style.removeProperty("background");
				content.style.removeProperty("background-color");
			}
			applyRadius(container);
			if (content) applyRadius(content);
		}
	} else {
		const stroke =
			borderWidth <= 1
				? softStrokeColor(borderColor, 0.45)
				: softStrokeColor(borderColor, Math.min(1, 0.35 + borderWidth * 0.12));
		container.style.setProperty("box-shadow", "none", "important");
		container.style.setProperty("outline", "none", "important");
		container.style.setProperty("border-width", `${borderWidth}px`, "important");
		container.style.setProperty("border-style", borderStyle, "important");
		container.style.setProperty("border-color", stroke, "important");
		container.style.setProperty("box-sizing", "border-box", "important");
		applyRadius(container);
		if (content) applyRadius(content);
	}
}

function softStrokeColor(color: string, alpha: number): string {
	const hex = normalizeColor(color).slice(1);
	const r = parseInt(hex.slice(0, 2), 16);
	const g = parseInt(hex.slice(2, 4), 16);
	const b = parseInt(hex.slice(4, 6), 16);
	const a = Math.min(1, Math.max(0, alpha));
	return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function clearPaintedStyles(nodeEl: HTMLElement) {
	delete nodeEl.dataset.intuitionInvisible;
	const chromeProps = [
		"opacity",
		"border",
		"border-width",
		"border-style",
		"border-color",
		"border-radius",
		"outline",
		"box-shadow",
		"box-sizing",
		"background",
		"background-color",
		"overflow",
	];
	nodeEl.querySelectorAll<HTMLElement>(`[${PAINT_ATTR}]`).forEach((el) => {
		for (const prop of chromeProps) el.style.removeProperty(prop);
		el.removeAttribute(PAINT_ATTR);
	});
	nodeEl.querySelectorAll<HTMLElement>(`[${BORDER_ATTR}]`).forEach((el) => {
		for (const prop of chromeProps) el.style.removeProperty(prop);
		el.removeAttribute(BORDER_ATTR);
	});
}

function clampOpacity(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_IMAGE_STYLE.opacity;
	return Math.min(100, Math.max(0, Math.round(value)));
}

function clampBorderWidth(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_IMAGE_STYLE.borderWidth;
	return Math.min(32, Math.max(0, Math.round(value)));
}

function clampBorderRadius(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_IMAGE_STYLE.borderRadius;
	return Math.min(64, Math.max(0, Math.round(value)));
}

function clampAuraStrength(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_IMAGE_STYLE.auraStrength;
	return Math.min(100, Math.max(0, Math.round(value)));
}

function clampVibeTiltStrength(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_IMAGE_STYLE.vibeTiltStrength;
	return Math.min(100, Math.max(0, Math.round(value)));
}

function clampAuraSize(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_IMAGE_STYLE.auraSize;
	return Math.min(200, Math.max(0, Math.round(value)));
}

function normalizeColor(color: string): string {
	if (/^#[0-9a-fA-F]{6}$/.test(color)) return color;
	if (/^#[0-9a-fA-F]{3}$/.test(color)) {
		const r = color[1];
		const g = color[2];
		const b = color[3];
		return `#${r}${r}${g}${g}${b}${b}`;
	}
	return DEFAULT_IMAGE_STYLE.borderColor;
}

function normalizeBorderStyle(style: string): ImageBorderStyle {
	if (style === "dashed" || style === "dotted" || style === "solid") return style;
	return DEFAULT_IMAGE_STYLE.borderStyle;
}

export function applyImageStylesToCanvas(nodes: Iterable<ImageNodeLike>) {
	for (const node of nodes) {
		if (!isImageNode(node)) continue;
		applyImageStyleToDom(node);
	}
}
