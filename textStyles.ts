export interface IntuitionTextStyle {
	plain: boolean;
	color: string;
	fontSize: number;
	fontFamily: string;
	fontWeight: string;
	textAlign: "left" | "center" | "right";
	verticalAlign: "top" | "middle" | "bottom";
	lineHeight: number;
	/** Card chrome (used when plain === false) */
	cardBgColor: string;
	cardBgOpacity: number;
	cardBorderColor: string;
	cardBorderWidth: number;
}

export const DEFAULT_TEXT_STYLE: IntuitionTextStyle = {
	plain: true,
	color: "#e8eaed",
	fontSize: 28,
	fontFamily: "PT Sans",
	fontWeight: "600",
	textAlign: "center",
	verticalAlign: "middle",
	lineHeight: 1.35,
	cardBgColor: "#1e1f24",
	cardBgOpacity: 85,
	cardBorderColor: "#d6d9db",
	cardBorderWidth: 1,
};

export const FONT_OPTIONS: { label: string; value: string }[] = [
	{ label: "PT Sans", value: "PT Sans" },
	{ label: "Georgia", value: "Georgia, serif" },
	{ label: "Palatino", value: "Palatino Linotype, Palatino, serif" },
	{ label: "Segoe UI", value: "Segoe UI, sans-serif" },
	{ label: "Consolas", value: "Consolas, monospace" },
	{ label: "Comic Sans", value: "Comic Sans MS, cursive" },
];

export interface TextNodeData {
	type?: string;
	text?: string;
	styleAttributes?: Record<string, string | null | undefined>;
	intuitionText?: Partial<IntuitionTextStyle>;
	[key: string]: unknown;
}

export interface TextNodeLike {
	id: string;
	nodeEl?: HTMLElement | null;
	getData?: () => TextNodeData;
	setData?: (data: TextNodeData, addHistory?: boolean) => void;
	render?: () => void;
	canvas?: { requestSave?: () => void };
}

const PAINT_ATTR = "data-intuition-painted";
const CARD_ATTR = "data-intuition-card-painted";
const WATCH_ATTR = "data-intuition-typo-watch";

const CSS_VARS = [
	"--intuition-text-color",
	"--intuition-font-size",
	"--intuition-font-family",
	"--intuition-font-weight",
	"--intuition-line-height",
	"--intuition-text-align",
	"--intuition-vertical-align",
	"--intuition-card-bg",
	"--intuition-card-border-color",
	"--intuition-card-border-width",
] as const;

const TYPO_TARGETS =
	".markdown-preview-view, .markdown-preview-sizer, .markdown-source-view, .cm-editor, .cm-scroller, .cm-contentContainer, .cm-content, .cm-line, .markdown-preview-view p, .markdown-preview-view div, .markdown-preview-view li, .markdown-preview-view span, .markdown-preview-view h1, .markdown-preview-view h2, .markdown-preview-view h3, .markdown-preview-view h4";

const OVERFLOW_TARGETS =
	".canvas-node-container, .canvas-node-content, .markdown-preview-view, .markdown-preview-sizer, .markdown-source-view, .cm-editor, .cm-scroller, .cm-contentContainer, .cm-content, .cm-line";

function setImp(el: HTMLElement, prop: string, value: string) {
	el.style.setProperty(prop, value, "important");
}

function clearImp(el: HTMLElement, props: string[]) {
	for (const prop of props) el.style.removeProperty(prop);
}

export function isTextNode(node: TextNodeLike): boolean {
	const data = node.getData?.();
	if (data?.type === "text") return true;
	return !!node.nodeEl?.classList.contains("is-text");
}

export function readTextStyle(node: TextNodeLike): IntuitionTextStyle {
	const data = node.getData?.() ?? {};
	const stored = data.intuitionText ?? {};
	const borderInvisible = data.styleAttributes?.border === "invisible";

	return {
		...DEFAULT_TEXT_STYLE,
		plain: stored.plain ?? borderInvisible ?? DEFAULT_TEXT_STYLE.plain,
		color: stored.color ?? DEFAULT_TEXT_STYLE.color,
		fontSize: stored.fontSize ?? DEFAULT_TEXT_STYLE.fontSize,
		fontFamily: stored.fontFamily ?? DEFAULT_TEXT_STYLE.fontFamily,
		fontWeight: stored.fontWeight ?? DEFAULT_TEXT_STYLE.fontWeight,
		textAlign: stored.textAlign ?? DEFAULT_TEXT_STYLE.textAlign,
		verticalAlign: stored.verticalAlign ?? DEFAULT_TEXT_STYLE.verticalAlign,
		lineHeight: stored.lineHeight ?? DEFAULT_TEXT_STYLE.lineHeight,
		cardBgColor: normalizeHex(
			stored.cardBgColor ?? DEFAULT_TEXT_STYLE.cardBgColor,
			DEFAULT_TEXT_STYLE.cardBgColor,
		),
		cardBgOpacity: clampPct(
			stored.cardBgOpacity ?? DEFAULT_TEXT_STYLE.cardBgOpacity,
		),
		cardBorderColor: normalizeHex(
			stored.cardBorderColor ?? DEFAULT_TEXT_STYLE.cardBorderColor,
			DEFAULT_TEXT_STYLE.cardBorderColor,
		),
		cardBorderWidth: clampBorderWidth(
			stored.cardBorderWidth ?? DEFAULT_TEXT_STYLE.cardBorderWidth,
		),
	};
}

export function writeTextStyle(node: TextNodeLike, style: IntuitionTextStyle) {
	const data = { ...(node.getData?.() ?? {}) };
	data.intuitionText = { ...style };
	data.styleAttributes = {
		...(data.styleAttributes ?? {}),
		border: style.plain ? "invisible" : null,
		textAlign: style.textAlign,
	};
	node.setData?.(data);
	applyTextStyleToDom(node, style);
	node.canvas?.requestSave?.();
}

/** Remove plugin typography overrides; keep optional frameless border. */
export function clearTextStyle(node: TextNodeLike, keepPlain = true) {
	const data = { ...(node.getData?.() ?? {}) };
	delete data.intuitionText;
	if (keepPlain) {
		data.styleAttributes = {
			...(data.styleAttributes ?? {}),
			border: "invisible",
		};
	}
	node.setData?.(data);

	const el = node.nodeEl;
	if (el) {
		el.classList.remove(
			"intuition-v-top",
			"intuition-v-middle",
			"intuition-v-bottom",
		);
		for (const prop of CSS_VARS) el.style.removeProperty(prop);
		delete el.dataset.intuitionTextAlign;
		delete el.dataset.intuitionVerticalAlign;
		clearPaintedTypography(el);
		clearCardChrome(el);

		if (keepPlain) {
			el.classList.add("intuition-plain-text");
			el.dataset.intuitionPlain = "1";
		} else {
			el.classList.remove("intuition-plain-text");
			delete el.dataset.intuitionPlain;
		}

		const body =
			(el.querySelector(".markdown-preview-view") as HTMLElement | null) ??
			(el.querySelector(".markdown-preview-sizer") as HTMLElement | null);
		if (body) body.style.marginTop = "";
	}

	node.canvas?.requestSave?.();
}

export function applyTextStyleToDom(node: TextNodeLike, style?: IntuitionTextStyle) {
	const el = node.nodeEl;
	if (!el) return;

	const data = node.getData?.() ?? {};
	const hasStored = !!data.intuitionText;

	if (!style && !hasStored) {
		if (data.styleAttributes?.border === "invisible") {
			el.classList.add("intuition-plain-text");
			el.dataset.intuitionPlain = "1";
		}
		return;
	}

	const s = style ?? readTextStyle(node);

	el.classList.toggle("intuition-plain-text", s.plain);
	el.dataset.intuitionPlain = s.plain ? "1" : "0";
	el.dataset.intuitionTextAlign = s.textAlign;
	el.dataset.intuitionVerticalAlign = s.verticalAlign;
	el.classList.remove("intuition-v-top", "intuition-v-middle", "intuition-v-bottom");
	el.classList.add(`intuition-v-${s.verticalAlign}`);

	el.style.setProperty("--intuition-text-color", s.color);
	el.style.setProperty("--intuition-font-size", `${s.fontSize}px`);
	el.style.setProperty("--intuition-font-family", s.fontFamily);
	el.style.setProperty("--intuition-font-weight", s.fontWeight);
	el.style.setProperty("--intuition-line-height", String(s.lineHeight));
	el.style.setProperty("--intuition-text-align", s.textAlign);
	el.style.setProperty("--intuition-vertical-align", s.verticalAlign);
	el.style.setProperty(
		"--intuition-card-bg",
		hexToRgba(s.cardBgColor, s.cardBgOpacity / 100),
	);
	el.style.setProperty("--intuition-card-border-color", s.cardBorderColor);
	el.style.setProperty(
		"--intuition-card-border-width",
		`${s.cardBorderWidth}px`,
	);

	// Themes/core often beat plugin CSS — paint inline !important so glyphs aren't clipped
	paintTypography(el, s);
	paintCardChrome(el, s);
	watchTypography(el, () => readTextStyle(node));

	window.requestAnimationFrame(() => {
		paintTypography(el, s);
		paintCardChrome(el, s);
		applyVerticalAlignPadding(el, s.verticalAlign);
		window.requestAnimationFrame(() => {
			paintTypography(el, s);
			paintCardChrome(el, s);
			applyVerticalAlignPadding(el, s.verticalAlign);
		});
	});
	watchVerticalAlign(el, () => readTextStyle(node).verticalAlign);
}

/**
 * Force size/line-height/overflow onto the real text nodes.
 * Themes set line-height in rem/px which clips large fonts — CSS vars alone lose.
 */
function paintTypography(nodeEl: HTMLElement, s: IntuitionTextStyle) {
	const linePx = Math.max(1, Math.round(s.fontSize * s.lineHeight * 100) / 100);
	const sizePx = `${s.fontSize}px`;
	const lhPx = `${linePx}px`;

	setImp(nodeEl, "overflow", "visible");

	nodeEl.querySelectorAll<HTMLElement>(OVERFLOW_TARGETS).forEach((el) => {
		setImp(el, "overflow", "visible");
		setImp(el, "overflow-x", "visible");
		setImp(el, "overflow-y", "visible");
		el.setAttribute(PAINT_ATTR, "1");
	});

	nodeEl.querySelectorAll<HTMLElement>(TYPO_TARGETS).forEach((el) => {
		setImp(el, "font-size", sizePx);
		setImp(el, "line-height", lhPx);
		setImp(el, "font-family", s.fontFamily);
		setImp(el, "font-weight", s.fontWeight);
		setImp(el, "color", s.color);
		setImp(el, "text-align", s.textAlign);
		setImp(el, "height", "auto");
		setImp(el, "max-height", "none");
		setImp(el, "min-height", "0");
		setImp(el, "overflow", "visible");
		// Extra room so descenders aren't clipped by tight line boxes
		if (el.classList.contains("cm-line") || el.tagName === "P") {
			setImp(el, "padding-top", "0.12em");
			setImp(el, "padding-bottom", "0.12em");
			setImp(el, "box-sizing", "content-box");
		}
		el.setAttribute(PAINT_ATTR, "1");
	});
}

function clearPaintedTypography(nodeEl: HTMLElement) {
	const props = [
		"font-size",
		"line-height",
		"font-family",
		"font-weight",
		"color",
		"text-align",
		"height",
		"max-height",
		"min-height",
		"overflow",
		"overflow-x",
		"overflow-y",
		"padding-top",
		"padding-bottom",
		"box-sizing",
		"margin-top",
	];
	clearImp(nodeEl, ["overflow"]);
	nodeEl.querySelectorAll<HTMLElement>(`[${PAINT_ATTR}]`).forEach((el) => {
		clearImp(el, props);
		el.removeAttribute(PAINT_ATTR);
	});
}

function paintCardChrome(nodeEl: HTMLElement, s: IntuitionTextStyle) {
	const container = nodeEl.querySelector(
		".canvas-node-container",
	) as HTMLElement | null;
	const content = nodeEl.querySelector(
		".canvas-node-content",
	) as HTMLElement | null;

	if (s.plain) {
		clearCardChrome(nodeEl);
		delete nodeEl.dataset.intuitionCard;
		return;
	}

	if (!container) return;
	nodeEl.dataset.intuitionCard = "1";

	const bg = hexToRgba(s.cardBgColor, clampPct(s.cardBgOpacity) / 100);
	const borderW = clampBorderWidth(s.cardBorderWidth);

	setImp(container, "background", bg);
	setImp(container, "background-color", bg);
	setImp(container, "box-shadow", "none");
	setImp(container, "outline", "none");
	setImp(container, "box-sizing", "border-box");
	if (borderW <= 0) {
		setImp(container, "border", "none");
	} else {
		setImp(container, "border-width", `${borderW}px`);
		setImp(container, "border-style", "solid");
		setImp(container, "border-color", s.cardBorderColor);
	}
	container.setAttribute(CARD_ATTR, "1");

	if (content) {
		setImp(content, "background", "transparent");
		setImp(content, "background-color", "transparent");
		setImp(content, "box-shadow", "none");
		content.setAttribute(CARD_ATTR, "1");
	}
}

function clearCardChrome(nodeEl: HTMLElement) {
	delete nodeEl.dataset.intuitionCard;
	const props = [
		"background",
		"background-color",
		"border",
		"border-width",
		"border-style",
		"border-color",
		"box-shadow",
		"outline",
		"box-sizing",
	];
	nodeEl.querySelectorAll<HTMLElement>(`[${CARD_ATTR}]`).forEach((el) => {
		clearImp(el, props);
		el.removeAttribute(CARD_ATTR);
	});
}

function clampPct(value: number): number {
	if (!Number.isFinite(value)) return 85;
	return Math.min(100, Math.max(0, Math.round(value)));
}

function clampBorderWidth(value: number): number {
	if (!Number.isFinite(value)) return 1;
	return Math.min(16, Math.max(0, Math.round(value)));
}

function normalizeHex(color: string, fallback: string): string {
	if (/^#[0-9a-fA-F]{6}$/.test(color)) return color;
	if (/^#[0-9a-fA-F]{3}$/.test(color)) {
		const r = color[1];
		const g = color[2];
		const b = color[3];
		return `#${r}${r}${g}${g}${b}${b}`;
	}
	return fallback;
}

function hexToRgba(color: string, alpha: number): string {
	const hex = normalizeHex(color, "#1e1f24").slice(1);
	const r = parseInt(hex.slice(0, 2), 16);
	const g = parseInt(hex.slice(2, 4), 16);
	const b = parseInt(hex.slice(4, 6), 16);
	const a = Math.min(1, Math.max(0, alpha));
	return `rgba(${r}, ${g}, ${b}, ${a})`;
}

const typoObservers = new WeakMap<HTMLElement, MutationObserver>();

function watchTypography(
	nodeEl: HTMLElement,
	getStyle: () => IntuitionTextStyle,
) {
	if (typoObservers.has(nodeEl)) return;
	if (nodeEl.getAttribute(WATCH_ATTR) === "1") return;
	nodeEl.setAttribute(WATCH_ATTR, "1");

	let scheduled = false;
	const observer = new MutationObserver(() => {
		if (scheduled) return;
		scheduled = true;
		window.requestAnimationFrame(() => {
			scheduled = false;
			const style = getStyle();
			paintTypography(nodeEl, style);
			paintCardChrome(nodeEl, style);
		});
	});
	observer.observe(nodeEl, { childList: true, subtree: true });
	typoObservers.set(nodeEl, observer);
}

/** Push text inside full-height content via margin on the text body. */
export function applyVerticalAlignPadding(
	nodeEl: HTMLElement,
	verticalAlign: IntuitionTextStyle["verticalAlign"],
) {
	if (nodeEl.classList.contains("is-editing")) return;

	const container = nodeEl.querySelector(
		".canvas-node-container",
	) as HTMLElement | null;
	const content = nodeEl.querySelector(
		".canvas-node-content",
	) as HTMLElement | null;
	if (!content) return;

	const body =
		(nodeEl.querySelector(".markdown-preview-view") as HTMLElement | null) ??
		(nodeEl.querySelector(".markdown-preview-sizer") as HTMLElement | null) ??
		(nodeEl.querySelector(".cm-content") as HTMLElement | null) ??
		content;

	if (container) {
		container.style.height = "100%";
		container.style.boxSizing = "border-box";
		setImp(container, "overflow", "visible");
	}
	content.style.height = "100%";
	content.style.boxSizing = "border-box";
	setImp(content, "overflow", "visible");

	// Reset previous offset (don't fight padding !important from plugin CSS)
	body.style.marginTop = "0px";
	body.style.height = "auto";
	body.style.minHeight = "0";

	const frameH = (container ?? nodeEl).clientHeight;
	const bodyH = Math.max(body.scrollHeight, body.offsetHeight);
	const spare = Math.max(0, frameH - bodyH);

	if (verticalAlign === "middle") {
		body.style.marginTop = `${Math.floor(spare / 2)}px`;
	} else if (verticalAlign === "bottom") {
		body.style.marginTop = `${spare}px`;
	} else {
		body.style.marginTop = "0px";
	}
}

const vAlignObservers = new WeakMap<HTMLElement, ResizeObserver>();

function watchVerticalAlign(
	nodeEl: HTMLElement,
	getAlign: () => IntuitionTextStyle["verticalAlign"],
) {
	if (vAlignObservers.has(nodeEl)) return;
	const ro = new ResizeObserver(() => {
		applyVerticalAlignPadding(nodeEl, getAlign());
	});
	ro.observe(nodeEl);
	vAlignObservers.set(nodeEl, ro);
}

export function applyTextStylesToCanvas(nodes: Iterable<TextNodeLike>) {
	for (const node of nodes) {
		if (!isTextNode(node)) continue;
		applyTextStyleToDom(node);
	}
}
