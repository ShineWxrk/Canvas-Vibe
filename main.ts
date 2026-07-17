import {
	Notice,
	Plugin,
	WorkspaceLeaf,
	setIcon,
	setTooltip,
	TFile,
	type View,
} from "obsidian";
import { ImageStylePanel } from "./ImageStylePanel";
import { TextStylePanel } from "./TextStylePanel";
import { CanvasStylePanel } from "./CanvasStylePanel";
import {
	applyCanvasChrome,
	clearCanvasChrome,
	normalizeCanvasChrome,
	type CanvasChromeStyle,
	DEFAULT_CANVAS_CHROME,
} from "./canvasChrome";
import {
	applyImageStylesToCanvas,
	isImageNode,
	readImageStyle,
	writeImageStyle,
	type ImageNodeLike,
} from "./imageStyles";
import {
	DEFAULT_TEXT_STYLE,
	applyTextStylesToCanvas,
	isTextNode,
	writeTextStyle,
	type TextNodeData,
	type TextNodeLike,
} from "./textStyles";
import { VibeTiltController, type VibeCard } from "./vibeTilt";
import {
	DEFAULT_SPARKLE_CONFIG,
	SPARKLE_LIMITS,
	VibeSparkleController,
	migrateLegacySparkleConfig,
	normalizeSparkleConfig,
	type VibeSparkleConfig,
} from "./vibeSparkles";
import { FpsOverlay } from "./fpsOverlay";
import { StickyAudioPlayer } from "./stickyAudioPlayer";
import { PhotoPresentation, type PresentationSlide } from "./photoPresentation";
import {
	DEFAULT_PRESENTATION_SETTINGS,
	normalizePresentationSettings,
	type PresentationSettings,
} from "./presentationSettings";
import {
	aspectFromImageNode,
	boundingBox,
	clampCollageCount,
	clampCollageGap,
	COLLAGE_COUNT_DEFAULT,
	COLLAGE_COUNT_MAX,
	COLLAGE_COUNT_MIN,
	COLLAGE_GAP_MAX,
	COLLAGE_GAP_SLIDER_MAX,
	layoutExactRows,
	layoutMasonry,
	normalizeCollagePackAxis,
	sortNodesReadingOrder,
	type CollagePackAxis,
} from "./collageLayout";

const CANVAS_VIEW_TYPE = "canvas";
const BUTTON_ATTR = "data-intuition-canvas-labels-toggle";
const AURA_BTN_ATTR = "data-intuition-canvas-aura-toggle";
const VIBE_BTN_ATTR = "data-intuition-canvas-vibe-toggle";
const CHROME_BTN_ATTR = "data-intuition-canvas-chrome-toggle";
const TEXT_BTN_ATTR = "data-intuition-canvas-add-text";
const COLLAGE_BTN_ATTR = "data-intuition-canvas-collage";
const HIDE_CLASS = "intuition-canvas-hide-image-labels";
const HIDE_AURAS_CLASS = "intuition-canvas-hide-auras";
/** When canvas zoom is below this, use lite auras (no shimmer/sparkles). */
const FAR_ZOOM_CLASS = "intuition-canvas-far-zoom";
/**
 * Overview / sharp zoom-out: full blur+blob auras thrash the compositor
 * (photos blank, UI flicker). Lite FX only on deep overview; normal / close zoom stays full.
 */
const FAR_ZOOM_THRESHOLD = 0.18;
const ZOOM_HOOK_ATTR = "data-intuition-zoom-fx";
/** While panning/scrolling the board — pause auras/sparkles + clear tilt. */
const PANNING_CLASS = "intuition-canvas-panning";
/**
 * While zoom is still settling after a wheel/gesture — clear + suspend 3D tilt.
 * Sharp zoom + live perspective drops compositor paint; pan "heals" via clearAllEffects —
 * apply the same during zoom itself.
 */
const ZOOM_SETTLING_CLASS = "intuition-canvas-zoom-settling";
/** Relative |Δzoom|/prev — restart aura CSS animations (never hide). */
const SHARP_ZOOM_REL = 0.1;
const DOM_HOOK_ATTR = "data-intuition-canvas-resize-hook";
const TEXT_HOOK_ATTR = "data-intuition-canvas-text-hook";

interface GlobalAuraSettings {
	enabled: boolean;
	shimmer: boolean;
	strength: number;
	size: number;
}

const DEFAULT_GLOBAL_AURA: GlobalAuraSettings = {
	enabled: true,
	shimmer: true,
	strength: 50,
	size: 100,
};

function normalizeGlobalAura(
	partial?: Partial<GlobalAuraSettings> | null,
): GlobalAuraSettings {
	const p = partial ?? {};
	return {
		enabled: p.enabled ?? DEFAULT_GLOBAL_AURA.enabled,
		shimmer: p.shimmer ?? DEFAULT_GLOBAL_AURA.shimmer,
		strength: Math.min(100, Math.max(0, Math.round(p.strength ?? DEFAULT_GLOBAL_AURA.strength))),
		size: Math.min(200, Math.max(0, Math.round(p.size ?? DEFAULT_GLOBAL_AURA.size))),
	};
}

interface IntuitionCanvasSettings {
	hideImageLabels: boolean;
	hideAuras: boolean;
	vibeMode: boolean;
	/** 0–100, tilt/glare strength (50% ≈ former 100% / ±8°) */
	vibeStrength: number;
	/** 0–100, text glow strength (independent from tilt) */
	vibeTextStrength: number;
	/** Bumped when strength scale doubles so we can remap saved % once */
	vibeStrengthScale?: number;
	/** @deprecated use vibeSparkles.amount */
	vibeSparkle?: number;
	vibeSparkleScale?: number;
	/** Full sparkle / glitter settings */
	vibeSparkles: VibeSparkleConfig;
	/** Global aura defaults applied to all images */
	globalAura: GlobalAuraSettings;
	/** Accordion open state in vibe panel */
	vibePanelSections?: Record<string, boolean>;
	/** Per-canvas background/dot chrome, keyed by vault path */
	canvasChrome: Record<string, CanvasChromeStyle>;
	/** Gap between photos in collage grid (px) */
	collageGap: number;
	/** Tile by column count (masonry) or row count (justified rows). */
	collagePackAxis: CollagePackAxis;
	/** Number of columns or rows (1–20). */
	collageCount: number;
	/** Slideshow / presentation preferences (interval, fade, Ken Burns, FX, transition). */
	presentation: PresentationSettings;
	/** Sticky mini-player volume 0–100 */
	stickyAudioVolume: number;
	/** Sticky mini-player loop one track */
	stickyAudioLoop: boolean;
}

const DEFAULT_SETTINGS: IntuitionCanvasSettings = {
	hideImageLabels: true,
	hideAuras: false,
	vibeMode: false,
	vibeStrength: 40,
	vibeTextStrength: 28,
	vibeStrengthScale: 2,
	vibeSparkleScale: 3,
	vibeSparkles: { ...DEFAULT_SPARKLE_CONFIG },
	globalAura: { ...DEFAULT_GLOBAL_AURA },
	vibePanelSections: {
		tilt: true,
		sparkles: false,
		auras: false,
	},
	canvasChrome: {},
	collageGap: 16,
	collagePackAxis: "cols",
	collageCount: COLLAGE_COUNT_DEFAULT,
	presentation: { ...DEFAULT_PRESENTATION_SETTINGS },
	stickyAudioVolume: 80,
	stickyAudioLoop: false,
};

const VIBE_STRENGTH_SCALE = 2;
/** Bumped to 3 when sparkle amount/size/freq became absolute units. */
const VIBE_SPARKLE_SCALE = 3;

interface CanvasNodeLike {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	labelEl?: HTMLElement | null;
	nodeEl?: HTMLElement | null;
	file?: TFile;
	filePath?: string;
	render?: () => void;
	getData?: () => TextNodeData & { file?: string };
	setData?: (data: TextNodeData, addHistory?: boolean) => void;
	canvas?: { requestSave?: () => void };
}

interface CanvasLike {
	canvasControlsEl?: HTMLElement;
	wrapperEl?: HTMLElement;
	canvasEl?: HTMLElement;
	cardMenuEl?: HTMLElement;
	nodes?: Map<string, CanvasNodeLike>;
	selection?: Set<CanvasNodeLike>;
	requestSave?: () => void;
	/** Current / target viewport zoom (internal Canvas API). */
	zoom?: number;
	tZoom?: number;
	tx?: number;
	ty?: number;
	x?: number;
	y?: number;
	isDragging?: boolean;
	setDragging?: (dragging: boolean) => void;
	markViewportChanged?: () => void;
	setViewport?: (tx: number, ty: number, tZoom: number) => void;
	posCenter?: () => { x: number; y: number };
	createTextNode?: (options: {
		pos?: { x: number; y: number };
		size?: { width: number; height: number };
		text?: string;
		focus?: boolean;
	}) => CanvasNodeLike & TextNodeLike;
	deselectAll?: () => void;
	selectOnly?: (node: CanvasNodeLike) => void;
	select?: (node: CanvasNodeLike) => void;
}

interface CanvasViewLike extends View {
	file?: TFile | null;
	canvas?: CanvasLike;
}

export default class IntuitionCanvasPlugin extends Plugin {
	settings: IntuitionCanvasSettings = { ...DEFAULT_SETTINGS };
	private observers: MutationObserver[] = [];
	private aspectResizeActive = false;
	private textPanels = new Map<string, TextStylePanel>();
	private imagePanels = new Map<string, ImageStylePanel>();
	private vibeControllers = new Map<string, VibeTiltController>();
	private vibeSparkles = new Map<string, VibeSparkleController>();
	private vibePanels = new Map<string, HTMLElement>();
	private collagePanels = new Map<string, HTMLElement>();
	private canvasPanels = new Map<string, CanvasStylePanel>();
	private fpsOverlays = new Map<string, FpsOverlay>();
	private stickyAudioPlayers = new Map<string, StickyAudioPlayer>();
	private photoPresentations = new Map<string, PhotoPresentation>();
	private vibeStrengthSaveTimer = 0;
	private chromeSaveTimer = 0;
	private collageGapSaveTimer = 0;
	private presentationSaveTimer = 0;
	private workspaceRefreshTimer = 0;
	private zoomFarByLeaf = new Map<string, boolean>();
	private patchedCanvasViewport = new WeakSet<object>();
	private lastViewportByLeaf = new Map<
		string,
		{ x: number; y: number; zoom: number }
	>();
	private panIdleTimers = new Map<string, number>();
	private zoomIdleTimers = new Map<string, number>();
	private auraRestartTimers = new Map<string, number>();
	/** Last sane zoom per canvas — rejects float epsilons (~1e-16) that flicker HUD to 0%. */
	private lastGoodZoomByCanvas = new WeakMap<object, number>();

	async onload() {
		await this.loadSettings();
		this.injectFallbackStyle();
		this.applyLabelVisibility();
		this.applyAuraVisibility();

		this.registerEvent(
			this.app.workspace.on("layout-change", () => this.queueWorkspaceRefresh()),
		);
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () =>
				this.queueWorkspaceRefresh(),
			),
		);

		this.app.workspace.onLayoutReady(() => {
			this.queueWorkspaceRefresh();
			window.setTimeout(() => this.queueWorkspaceRefresh(), 100);
			window.setTimeout(() => this.queueWorkspaceRefresh(), 500);
		});

		this.addCommand({
			id: "toggle-image-labels",
			name: "Toggle Canvas labels",
			checkCallback: (checking) => {
				const canvasOpen =
					this.app.workspace.getLeavesOfType(CANVAS_VIEW_TYPE).length > 0;
				if (checking) return canvasOpen;
				void this.toggleHideImageLabels();
				return true;
			},
		});

		this.addCommand({
			id: "toggle-image-auras",
			name: "Toggle Canvas image auras",
			checkCallback: (checking) => {
				const canvasOpen =
					this.app.workspace.getLeavesOfType(CANVAS_VIEW_TYPE).length > 0;
				if (checking) return canvasOpen;
				void this.toggleHideAuras();
				return true;
			},
		});

		this.addCommand({
			id: "toggle-vibe-mode",
			name: "Toggle Canvas vibe tilt mode",
			checkCallback: (checking) => {
				const canvasOpen =
					this.app.workspace.getLeavesOfType(CANVAS_VIEW_TYPE).length > 0;
				if (checking) return canvasOpen;
				void this.toggleVibeMode();
				return true;
			},
		});

		this.addCommand({
			id: "add-plain-text",
			name: "Add plain text to Canvas",
			checkCallback: (checking) => {
				const leaf = this.getActiveCanvasLeaf();
				if (checking) return !!leaf;
				if (leaf) this.addPlainTextNode(leaf.view as CanvasViewLike);
				return true;
			},
		});

		this.addCommand({
			id: "arrange-images-collage",
			name: "Arrange selected images in collage grid",
			checkCallback: (checking) => {
				const leaf = this.getActiveCanvasLeaf();
				if (!leaf) return false;
				const images = this.getSelectedImageNodes(
					leaf.view as CanvasViewLike,
				);
				if (checking) return images.length >= 2;
				this.arrangeSelectedImagesCollage(leaf.view as CanvasViewLike);
				return true;
			},
		});

		this.addCommand({
			id: "present-selected-images",
			name: "Present selected images (slideshow)",
			checkCallback: (checking) => {
				const leaf = this.getActiveCanvasLeaf();
				if (!leaf) return false;
				const images = this.getSelectedImageNodes(
					leaf.view as CanvasViewLike,
				);
				if (checking) return images.length >= 1;
				this.startPhotoPresentation(leaf);
				return true;
			},
		});

		this.addCommand({
			id: "stop-photo-presentation",
			name: "Stop photo presentation",
			checkCallback: (checking) => {
				const leaf = this.getActiveCanvasLeaf();
				if (!leaf) return false;
				const id =
					(leaf as WorkspaceLeaf & { id?: string }).id ?? String(leaf);
				const active = this.photoPresentations.get(id)?.isActive();
				if (checking) return !!active;
				this.photoPresentations.get(id)?.stop();
				return true;
			},
		});
	}

	onunload() {
		this.clearObservers();
		for (const panel of this.textPanels.values()) panel.el.remove();
		this.textPanels.clear();
		for (const panel of this.imagePanels.values()) panel.el.remove();
		this.imagePanels.clear();
		for (const vibe of this.vibeControllers.values()) vibe.destroy();
		this.vibeControllers.clear();
		for (const sparkles of this.vibeSparkles.values()) sparkles.destroy();
		this.vibeSparkles.clear();
		for (const panel of this.vibePanels.values()) panel.remove();
		this.vibePanels.clear();
		for (const panel of this.collagePanels.values()) panel.remove();
		this.collagePanels.clear();
		for (const panel of this.canvasPanels.values()) panel.el.remove();
		this.canvasPanels.clear();
		for (const fps of this.fpsOverlays.values()) fps.destroy();
		this.fpsOverlays.clear();
		for (const player of this.stickyAudioPlayers.values()) player.destroy();
		this.stickyAudioPlayers.clear();
		for (const present of this.photoPresentations.values()) present.destroy();
		this.photoPresentations.clear();
		if (this.vibeStrengthSaveTimer) window.clearTimeout(this.vibeStrengthSaveTimer);
		if (this.chromeSaveTimer) window.clearTimeout(this.chromeSaveTimer);
		if (this.collageGapSaveTimer) window.clearTimeout(this.collageGapSaveTimer);
		if (this.presentationSaveTimer) window.clearTimeout(this.presentationSaveTimer);
		if (this.workspaceRefreshTimer) window.clearTimeout(this.workspaceRefreshTimer);
		for (const t of this.panIdleTimers.values()) window.clearTimeout(t);
		this.panIdleTimers.clear();
		for (const t of this.zoomIdleTimers.values()) window.clearTimeout(t);
		this.zoomIdleTimers.clear();
		for (const t of this.auraRestartTimers.values()) window.clearTimeout(t);
		this.auraRestartTimers.clear();
		document.querySelectorAll(".intuition-vibe-sparkle").forEach((el) => el.remove());
		document
			.querySelectorAll("[data-intuition-vibe-sparkles-canvas]")
			.forEach((el) => el.remove());
		document.querySelectorAll(".intuition-image-aura").forEach((el) => el.remove());
		document
			.querySelectorAll("[data-intuition-vibe-sparkle-hook]")
			.forEach((el) => el.removeAttribute("data-intuition-vibe-sparkle-hook"));
		document
			.querySelectorAll("[data-intuition-vibe-aura-hook]")
			.forEach((el) => el.removeAttribute("data-intuition-vibe-aura-hook"));
		document
			.querySelectorAll("[data-intuition-vibe-auras-canvas]")
			.forEach((el) => el.remove());
		document
			.querySelectorAll(".intuition-canvas-chrome")
			.forEach((el) => clearCanvasChrome(el as HTMLElement));
		document.querySelectorAll(`[${CHROME_BTN_ATTR}]`).forEach((el) => el.remove());
		document
			.querySelectorAll("[data-intuition-canvas-panel]")
			.forEach((el) => el.remove());
		document
			.querySelectorAll("[data-intuition-photo-presentation]")
			.forEach((el) => el.remove());
		document
			.querySelectorAll("[data-intuition-sticky-audio]")
			.forEach((el) => el.remove());
		document.getElementById("intuition-canvas-label-style")?.remove();
		document.body.classList.remove(HIDE_CLASS);
		document.body.classList.remove(HIDE_AURAS_CLASS);
		document.body.classList.remove("intuition-canvas-vibe");
		document.body.classList.remove(FAR_ZOOM_CLASS);
		document.body.classList.remove(PANNING_CLASS);
		document.body.classList.remove(ZOOM_SETTLING_CLASS);
		document
			.querySelectorAll(
				`.${HIDE_CLASS}, .${HIDE_AURAS_CLASS}, .intuition-canvas-vibe, .${FAR_ZOOM_CLASS}, .${PANNING_CLASS}, .${ZOOM_SETTLING_CLASS}`,
			)
			.forEach((el) => {
				el.classList.remove(HIDE_CLASS);
				el.classList.remove(HIDE_AURAS_CLASS);
				el.classList.remove("intuition-canvas-vibe");
				el.classList.remove(FAR_ZOOM_CLASS);
				el.classList.remove(PANNING_CLASS);
				el.classList.remove(ZOOM_SETTLING_CLASS);
			});
		document.querySelectorAll(".canvas-node-label").forEach((el) => {
			(el as HTMLElement).style.removeProperty("display");
		});
		document.querySelectorAll(`[${BUTTON_ATTR}]`).forEach((el) => el.remove());
		document.querySelectorAll(`[${AURA_BTN_ATTR}]`).forEach((el) => el.remove());
		document.querySelectorAll(`[${VIBE_BTN_ATTR}]`).forEach((el) => el.remove());
		document.querySelectorAll(`[${TEXT_BTN_ATTR}]`).forEach((el) => el.remove());
		document.querySelectorAll(`[${COLLAGE_BTN_ATTR}]`).forEach((el) => el.remove());
		document.querySelectorAll(".intuition-vibe-glare").forEach((el) => el.remove());
		document
			.querySelectorAll("[data-intuition-vibe-tilting]")
			.forEach((el) => {
				(el as HTMLElement).style.removeProperty("transform");
				(el as HTMLElement).style.removeProperty("transition");
				el.removeAttribute("data-intuition-vibe-tilting");
			});
		document
			.querySelectorAll("[data-intuition-vibe-text]")
			.forEach((el) => {
				el.removeAttribute("data-intuition-vibe-text");
			});
		document
			.querySelectorAll("[data-intuition-vibe-filter]")
			.forEach((el) => {
				(el as HTMLElement).style.removeProperty("filter");
				(el as HTMLElement).style.removeProperty("transition");
				el.removeAttribute("data-intuition-vibe-filter");
			});
		document
			.querySelectorAll(".intuition-vibe-shine-layer, .intuition-vibe-text-shine")
			.forEach((el) => el.remove());
		document
			.querySelectorAll("[data-intuition-vibe-shine]")
			.forEach((el) => el.removeAttribute("data-intuition-vibe-shine"));
		document
			.querySelectorAll(`[${DOM_HOOK_ATTR}]`)
			.forEach((el) => el.removeAttribute(DOM_HOOK_ATTR));
		document
			.querySelectorAll(`[${TEXT_HOOK_ATTR}]`)
			.forEach((el) => el.removeAttribute(TEXT_HOOK_ATTR));
		document
			.querySelectorAll("[data-intuition-vibe-hook]")
			.forEach((el) => el.removeAttribute("data-intuition-vibe-hook"));
		document
			.querySelectorAll(".intuition-plain-text")
			.forEach((el) => el.classList.remove("intuition-plain-text"));
	}

	private injectFallbackStyle() {
		if (document.getElementById("intuition-canvas-label-style")) return;
		const style = document.createElement("style");
		style.id = "intuition-canvas-label-style";
		style.textContent = `
			body.${HIDE_CLASS} .canvas-node-label,
			.${HIDE_CLASS} .canvas-node-label {
				display: none !important;
				visibility: hidden !important;
				opacity: 0 !important;
				pointer-events: none !important;
			}
		`;
		document.head.appendChild(style);
	}

	private clearObservers() {
		for (const observer of this.observers) observer.disconnect();
		this.observers = [];
	}

	private watchCanvasDom(root: HTMLElement) {
		if (root.dataset.intuitionCanvasWatching === "1") return;
		root.dataset.intuitionCanvasWatching = "1";

		const observer = new MutationObserver(() => {
			if (this.settings.hideImageLabels) {
				this.hideLabelsIn(root);
			}
		});
		observer.observe(root, { childList: true, subtree: true });
		this.observers.push(observer);
	}

	private hideLabelsIn(root: HTMLElement) {
		root.querySelectorAll<HTMLElement>(".canvas-node-label").forEach((label) => {
			label.style.setProperty("display", "none", "important");
		});
	}

	async loadSettings() {
		const raw = (await this.loadData()) as Partial<IntuitionCanvasSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);
		if (!this.settings.canvasChrome) this.settings.canvasChrome = {};

		// Migrate legacy single sparkle % → full config
		const legacyAmount =
			typeof raw?.vibeSparkle === "number"
				? raw.vibeSparkle
				: raw?.vibeSparkles?.amount;
		const prevSparkleScale = raw?.vibeSparkleScale ?? 1;
		const mergedSparkles = {
			...DEFAULT_SPARKLE_CONFIG,
			...(raw?.vibeSparkles ?? {}),
			...(legacyAmount != null ? { amount: legacyAmount } : {}),
		};
		this.settings.vibeSparkles =
			prevSparkleScale < VIBE_SPARKLE_SCALE
				? migrateLegacySparkleConfig(mergedSparkles)
				: normalizeSparkleConfig(mergedSparkles);
		this.settings.globalAura = normalizeGlobalAura(raw?.globalAura);
		this.settings.presentation = normalizePresentationSettings(raw?.presentation);
		this.settings.stickyAudioVolume = Math.min(
			100,
			Math.max(
				0,
				Math.round(
					Number(
						raw?.stickyAudioVolume ?? DEFAULT_SETTINGS.stickyAudioVolume,
					),
				),
			),
		);
		this.settings.stickyAudioLoop = !!(
			raw?.stickyAudioLoop ?? DEFAULT_SETTINGS.stickyAudioLoop
		);
		this.settings.vibeTextStrength = this.clampVibeTextStrength(
			raw?.vibeTextStrength ?? DEFAULT_SETTINGS.vibeTextStrength,
		);
		this.settings.vibePanelSections = {
			...DEFAULT_SETTINGS.vibePanelSections,
			...(raw?.vibePanelSections ?? {}),
		};

		let migrated = false;
		const prevTiltScale = this.settings.vibeStrengthScale ?? 1;
		if (prevTiltScale < VIBE_STRENGTH_SCALE) {
			const factor = prevTiltScale / VIBE_STRENGTH_SCALE;
			this.settings.vibeStrength = this.clampVibeStrength(
				this.settings.vibeStrength * factor,
			);
			this.settings.vibeStrengthScale = VIBE_STRENGTH_SCALE;
			migrated = true;
		}
		if (prevSparkleScale < VIBE_SPARKLE_SCALE) {
			this.settings.vibeSparkleScale = VIBE_SPARKLE_SCALE;
			migrated = true;
		}
		// Keep legacy field in sync for older backups
		this.settings.vibeSparkle = this.settings.vibeSparkles.amount;
		this.settings.collageGap = clampCollageGap(
			this.settings.collageGap ?? DEFAULT_SETTINGS.collageGap,
		);
		const rawAny = (raw ?? {}) as Record<string, unknown>;
		const hadLegacyCollage =
			"collageArrange" in rawAny ||
			"collageCenterSize" in rawAny ||
			"collageSizeMode" in rawAny ||
			"collageFixedAxis" in rawAny ||
			"collageFixedSize" in rawAny ||
			(!("collagePackAxis" in rawAny) && !("collageCount" in rawAny));
		this.settings.collagePackAxis = normalizeCollagePackAxis(
			rawAny.collagePackAxis ?? DEFAULT_SETTINGS.collagePackAxis,
		);
		const packAxis = this.settings.collagePackAxis;
		const legacyCount =
			typeof rawAny.collageCount === "number"
				? rawAny.collageCount
				: packAxis === "rows" && typeof rawAny.collageRows === "number"
					? rawAny.collageRows
					: typeof rawAny.collageCols === "number"
						? rawAny.collageCols
						: DEFAULT_SETTINGS.collageCount;
		this.settings.collageCount = clampCollageCount(legacyCount);
		if (hadLegacyCollage) migrated = true;
		const settingsBag = this.settings as unknown as Record<string, unknown>;
		delete settingsBag.collageArrange;
		delete settingsBag.collageCenterSize;
		delete settingsBag.collageSizeMode;
		delete settingsBag.collageFixedAxis;
		delete settingsBag.collageFixedSize;
		delete settingsBag.collageCols;
		delete settingsBag.collageRows;
		if (migrated) await this.saveSettings();
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private queueWorkspaceRefresh() {
		if (this.workspaceRefreshTimer) window.clearTimeout(this.workspaceRefreshTimer);
		this.workspaceRefreshTimer = window.setTimeout(() => {
			this.workspaceRefreshTimer = 0;
			this.onWorkspaceRefresh();
		}, 120);
	}

	private onWorkspaceRefresh() {
		this.enhanceAllCanvases();
		this.applyLabelVisibility();
		this.applyAuraVisibility();
		this.refreshTextStyles();
		this.refreshImageStyles();
		this.applyAllCanvasChrome();
	}

	private getActiveCanvasLeaf(): WorkspaceLeaf | null {
		const activeLeaf = this.app.workspace.activeLeaf;
		if (activeLeaf?.view?.getViewType?.() === CANVAS_VIEW_TYPE) return activeLeaf;
		return this.app.workspace.getLeavesOfType(CANVAS_VIEW_TYPE)[0] ?? null;
	}

	private refreshTextStyles() {
		for (const leaf of this.app.workspace.getLeavesOfType(CANVAS_VIEW_TYPE)) {
			const nodes = (leaf.view as CanvasViewLike).canvas?.nodes;
			if (nodes) applyTextStylesToCanvas(nodes.values());
		}
	}

	private refreshImageStyles() {
		for (const leaf of this.app.workspace.getLeavesOfType(CANVAS_VIEW_TYPE)) {
			const nodes = (leaf.view as CanvasViewLike).canvas?.nodes;
			if (!nodes) continue;
			applyImageStylesToCanvas(nodes.values());
		}
	}

	private applyLabelVisibility() {
		const hide = this.settings.hideImageLabels;
		document.body.classList.toggle(HIDE_CLASS, hide);

		for (const leaf of this.app.workspace.getLeavesOfType(CANVAS_VIEW_TYPE)) {
			const view = leaf.view as CanvasViewLike;
			const root = view.containerEl;

			root.classList.toggle(HIDE_CLASS, hide);
			view.canvas?.wrapperEl?.classList.toggle(HIDE_CLASS, hide);
			view.canvas?.canvasEl?.classList.toggle(HIDE_CLASS, hide);
			root.querySelector(".canvas")?.classList.toggle(HIDE_CLASS, hide);
			this.watchCanvasDom(root);

			root.querySelectorAll<HTMLElement>(".canvas-node-label").forEach((label) => {
				if (hide) label.style.setProperty("display", "none", "important");
				else label.style.removeProperty("display");
			});

			const nodes = view.canvas?.nodes;
			if (!nodes) continue;
			for (const node of nodes.values()) {
				const label = node.labelEl;
				if (!label) continue;
				if (hide) label.style.setProperty("display", "none", "important");
				else label.style.removeProperty("display");
			}
		}
	}

	private async toggleHideImageLabels() {
		this.settings.hideImageLabels = !this.settings.hideImageLabels;
		await this.saveSettings();
		this.applyLabelVisibility();
		this.syncAllToggleButtons();
	}

	private applyAuraVisibility() {
		const hide = this.settings.hideAuras;
		document.body.classList.toggle(HIDE_AURAS_CLASS, hide);

		for (const leaf of this.app.workspace.getLeavesOfType(CANVAS_VIEW_TYPE)) {
			const view = leaf.view as CanvasViewLike;
			const root = view.containerEl;

			root.classList.toggle(HIDE_AURAS_CLASS, hide);
			view.canvas?.wrapperEl?.classList.toggle(HIDE_AURAS_CLASS, hide);
			view.canvas?.canvasEl?.classList.toggle(HIDE_AURAS_CLASS, hide);
			root.querySelector(".canvas")?.classList.toggle(HIDE_AURAS_CLASS, hide);
		}
	}

	private async toggleHideAuras() {
		this.settings.hideAuras = !this.settings.hideAuras;
		await this.saveSettings();
		this.applyAuraVisibility();
		this.syncAllAuraToggleButtons();
	}

	private applyVibeMode() {
		const on = this.settings.vibeMode;
		const strength = this.clampVibeStrength(this.settings.vibeStrength);
		const textStrength = this.clampVibeTextStrength(this.settings.vibeTextStrength);
		this.settings.vibeTextStrength = textStrength;
		const sparkleCfg = normalizeSparkleConfig(this.settings.vibeSparkles);
		this.settings.vibeSparkles = sparkleCfg;
		for (const leaf of this.app.workspace.getLeavesOfType(CANVAS_VIEW_TYPE)) {
			const id = (leaf as WorkspaceLeaf & { id?: string }).id ?? String(leaf);
			const vibe = this.vibeControllers.get(id);
			vibe?.setStrength(strength);
			vibe?.setTextStrength(textStrength);
			vibe?.setEnabled(on);
			const sparkles = this.vibeSparkles.get(id);
			sparkles?.setConfig(sparkleCfg);
			sparkles?.setEnabled(on);
			this.syncVibeStrengthPanel(leaf, on);
		}
		this.syncAllVibeToggleButtons();
	}

	private clampVibeStrength(value: number) {
		if (!Number.isFinite(value)) return DEFAULT_SETTINGS.vibeStrength;
		return Math.min(100, Math.max(0, Math.round(value)));
	}

	private clampVibeTextStrength(value: number) {
		if (!Number.isFinite(value)) return DEFAULT_SETTINGS.vibeTextStrength;
		return Math.min(100, Math.max(0, Math.round(value)));
	}

	private setVibeStrength(value: number, persist = true) {
		const strength = this.clampVibeStrength(value);
		this.settings.vibeStrength = strength;
		for (const vibe of this.vibeControllers.values()) {
			vibe.setStrength(strength);
		}
		this.syncAllVibeStrengthSliders();
		if (!persist) return;
		this.queueVibeSettingsSave();
	}

	private setVibeTextStrength(value: number, persist = true) {
		const textStrength = this.clampVibeTextStrength(value);
		this.settings.vibeTextStrength = textStrength;
		for (const vibe of this.vibeControllers.values()) {
			vibe.setTextStrength(textStrength);
		}
		this.syncAllVibeTextStrengthSliders();
		if (!persist) return;
		this.queueVibeSettingsSave();
	}

	private patchVibeSparkles(partial: Partial<VibeSparkleConfig>, persist = true) {
		this.settings.vibeSparkles = normalizeSparkleConfig({
			...this.settings.vibeSparkles,
			...partial,
		});
		this.settings.vibeSparkle = this.settings.vibeSparkles.amount;
		for (const ctrl of this.vibeSparkles.values()) {
			ctrl.setConfig(this.settings.vibeSparkles);
		}
		this.syncVibeSparkleControls();
		if (!persist) return;
		this.queueVibeSettingsSave();
	}

	private resetVibeSparkles() {
		this.settings.vibeSparkles = normalizeSparkleConfig({
			...DEFAULT_SPARKLE_CONFIG,
		});
		this.settings.vibeSparkle = this.settings.vibeSparkles.amount;
		for (const ctrl of this.vibeSparkles.values()) {
			ctrl.setConfig(this.settings.vibeSparkles);
		}
		this.syncVibeSparkleControls();
		this.queueVibeSettingsSave();
		new Notice("Блестки сброшены", 1200);
	}

	private patchGlobalAura(partial: Partial<GlobalAuraSettings>, persist = true) {
		this.settings.globalAura = normalizeGlobalAura({
			...this.settings.globalAura,
			...partial,
		});
		// Panel "Вкл." must not fight the toolbar hide-auras CSS gate.
		if (partial.enabled === true) this.clearHideAurasGate();
		this.syncGlobalAuraControls();
		// Live-apply to all images when tweaking global aura
		this.applyGlobalAuraToAllImages(false);
		if (!persist) return;
		this.queueVibeSettingsSave();
	}

	private resetGlobalAura() {
		this.settings.globalAura = normalizeGlobalAura({ ...DEFAULT_GLOBAL_AURA });
		this.clearHideAurasGate();
		this.syncGlobalAuraControls();
		this.applyGlobalAuraToAllImages(false);
		this.queueVibeSettingsSave();
		new Notice("Ауры сброшены", 1200);
	}

	/** Clear the global CSS hide so painted DOM auras can actually show. */
	private clearHideAurasGate() {
		if (!this.settings.hideAuras) return;
		this.settings.hideAuras = false;
		this.applyAuraVisibility();
		this.syncAllAuraToggleButtons();
		this.queueVibeSettingsSave();
	}

	/** Push global aura fields onto every image node on open canvases. */
	private applyGlobalAuraToAllImages(showNotice = true) {
		const g = normalizeGlobalAura(this.settings.globalAura);
		if (g.enabled) this.clearHideAurasGate();
		let count = 0;
		for (const leaf of this.app.workspace.getLeavesOfType(CANVAS_VIEW_TYPE)) {
			const nodes = (leaf.view as CanvasViewLike).canvas?.nodes;
			if (!nodes) continue;
			for (const node of nodes.values()) {
				if (!isImageNode(node as ImageNodeLike)) continue;
				const img = node as ImageNodeLike;
				const base = readImageStyle(img);
				writeImageStyle(img, {
					...base,
					aura: g.enabled,
					auraShimmer: g.shimmer,
					auraStrength: g.strength,
					auraSize: g.size,
					// keep per-image color / palette
				});
				count += 1;
			}
		}
		this.refreshImageStyles();
		if (showNotice) {
			new Notice(
				count > 0 ? `Ауры применены (${count})` : "Нет картинок на канвасе",
				1400,
			);
		}
	}

	private queueVibeSettingsSave() {
		if (this.vibeStrengthSaveTimer) window.clearTimeout(this.vibeStrengthSaveTimer);
		this.vibeStrengthSaveTimer = window.setTimeout(() => {
			this.vibeStrengthSaveTimer = 0;
			void this.saveSettings();
		}, 200);
	}

	private async toggleVibeMode() {
		this.settings.vibeMode = !this.settings.vibeMode;
		await this.saveSettings();
		this.applyVibeMode();
		new Notice(
			this.settings.vibeMode ? "Вайб-режим: наклон карточек" : "Вайб-режим выключен",
			1400,
		);
	}

	private enhanceAllCanvases() {
		for (const leaf of this.app.workspace.getLeavesOfType(CANVAS_VIEW_TYPE)) {
			this.injectToggle(leaf);
			this.injectAuraToggle(leaf);
			this.injectVibeToggle(leaf);
			this.injectChromeToggle(leaf);
			this.injectAddTextButton(leaf);
			this.injectCollageButton(leaf);
			this.ensureCollagePanel(leaf);
			this.installDomResizeHook(leaf);
			this.ensureTextPanel(leaf);
			this.ensureImagePanel(leaf);
			this.ensureCanvasPanel(leaf);
			this.installTextSelectionHook(leaf);
			this.ensureVibeStrengthPanel(leaf);
			this.ensureVibeController(leaf);
			this.ensureFpsOverlay(leaf);
			this.ensureStickyAudioPlayer(leaf);
			this.installZoomFxHook(leaf);
		}
		this.applyVibeMode();
		this.applyAllCanvasChrome();
	}

	/** Freeze heavy FX when zoomed far out (all photos in view → GPU thrash). */
	private installZoomFxHook(leaf: WorkspaceLeaf) {
		const view = leaf.view as CanvasViewLike;
		const root =
			view.canvas?.wrapperEl ??
			view.containerEl.querySelector<HTMLElement>(".canvas-wrapper") ??
			view.containerEl;
		this.patchCanvasViewportHook(leaf);
		if (root.getAttribute(ZOOM_HOOK_ATTR) === "1") {
			this.syncZoomFx(leaf);
			return;
		}
		root.setAttribute(ZOOM_HOOK_ATTR, "1");

		let raf = 0;
		const schedule = () => {
			if (raf) return;
			raf = window.requestAnimationFrame(() => {
				raf = 0;
				this.syncZoomFx(leaf);
			});
		};

		const endPan = () => this.setCanvasPanning(leaf, false);

		this.registerDomEvent(root, "wheel", schedule, { passive: true });
		this.registerDomEvent(root, "pointerup", () => {
			schedule();
			endPan();
		}, { passive: true });
		this.registerDomEvent(window, "pointerup", endPan);
		this.registerDomEvent(window, "pointercancel", endPan);
		this.syncZoomFx(leaf);
	}

	/** Obsidian fires markViewportChanged on every zoom/pan — most reliable hook. */
	private patchCanvasViewportHook(leaf: WorkspaceLeaf) {
		const canvas = (leaf.view as CanvasViewLike).canvas;
		if (!canvas || this.patchedCanvasViewport.has(canvas)) return;
		this.patchedCanvasViewport.add(canvas);

		const c = canvas as CanvasLike;
		const schedule = () => {
			window.requestAnimationFrame(() => this.syncZoomFx(leaf));
		};

		if (typeof c.markViewportChanged === "function") {
			const orig = c.markViewportChanged.bind(c);
			c.markViewportChanged = () => {
				orig();
				schedule();
			};
		}
		if (typeof c.setViewport === "function") {
			const orig = c.setViewport.bind(c);
			c.setViewport = (tx, ty, tZoom) => {
				orig(tx, ty, tZoom);
				schedule();
			};
		}
		if (typeof c.setDragging === "function") {
			const orig = c.setDragging.bind(c);
			c.setDragging = (dragging: boolean) => {
				orig(dragging);
				this.setCanvasPanning(leaf, !!dragging);
			};
		}
	}

	private setCanvasPanning(leaf: WorkspaceLeaf, on: boolean) {
		const id = (leaf as WorkspaceLeaf & { id?: string }).id ?? String(leaf);
		const view = leaf.view as CanvasViewLike;
		const root =
			view.canvas?.wrapperEl ??
			view.containerEl.querySelector<HTMLElement>(".canvas-wrapper") ??
			view.containerEl;

		const idle = this.panIdleTimers.get(id);
		if (idle) {
			window.clearTimeout(idle);
			this.panIdleTimers.delete(id);
		}

		const apply = (active: boolean) => {
			const was = root.classList.contains(PANNING_CLASS);
			root.classList.toggle(PANNING_CLASS, active);
			view.containerEl.classList.toggle(PANNING_CLASS, active);
			view.canvas?.canvasEl?.classList.toggle(PANNING_CLASS, active);
			this.vibeSparkles.get(id)?.setPanning(active);
			if (active && !was) {
				this.vibeControllers.get(id)?.clearAllEffects();
			}
		};

		if (on) {
			apply(true);
			return;
		}

		const t = window.setTimeout(() => {
			this.panIdleTimers.delete(id);
			if (view.canvas?.isDragging) return;
			apply(false);
		}, 80);
		this.panIdleTimers.set(id, t);
	}

	private syncZoomFx(leaf: WorkspaceLeaf) {
		const view = leaf.view as CanvasViewLike;
		const root =
			view.canvas?.wrapperEl ??
			view.containerEl.querySelector<HTMLElement>(".canvas-wrapper") ??
			view.containerEl;
		const id = (leaf as WorkspaceLeaf & { id?: string }).id ?? String(leaf);
		const zoom = this.readCanvasZoom(view);
		const far = zoom > 0 && zoom < FAR_ZOOM_THRESHOLD;
		const wasFar = this.zoomFarByLeaf.get(id) ?? false;

		root.classList.toggle(FAR_ZOOM_CLASS, far);
		view.containerEl.classList.toggle(FAR_ZOOM_CLASS, far);
		view.canvas?.canvasEl?.classList.toggle(FAR_ZOOM_CLASS, far);
		this.zoomFarByLeaf.set(id, far);

		this.vibeSparkles.get(id)?.setZoom(zoom);
		this.vibeControllers.get(id)?.setZoom(zoom);

		/* Leaving overview — kick breathe/drift back on (far CSS had animation:none). */
		if (wasFar && !far) {
			this.queueAuraRestart(leaf);
		}

		const canvas = view.canvas;
		const x = canvas?.tx ?? canvas?.x ?? 0;
		const y = canvas?.ty ?? canvas?.y ?? 0;
		const prev = this.lastViewportByLeaf.get(id);
		this.lastViewportByLeaf.set(id, { x, y, zoom });
		if (prev) {
			const moved =
				Math.abs(prev.x - x) > 0.5 || Math.abs(prev.y - y) > 0.5;
			const zoomed = Math.abs(prev.zoom - zoom) > 0.001;
			if (zoomed) {
				this.setCanvasZoomSettling(leaf, true);
				this.setCanvasZoomSettling(leaf, false);
				const rel =
					Math.abs(zoom - prev.zoom) / Math.max(prev.zoom, 0.001);
				/* Only restart while already in full-FX zoom — never while far CSS wins. */
				if (rel >= SHARP_ZOOM_REL && !far) {
					this.queueAuraRestart(leaf);
				}
			}
			if (moved && !zoomed) {
				this.setCanvasPanning(leaf, true);
				this.setCanvasPanning(leaf, false);
			}
		}

		if (canvas?.isDragging) this.setCanvasPanning(leaf, true);
	}

	/**
	 * Debounced CSS animation restart (auras stay visible).
	 * Skips while far-zoom lite CSS is active.
	 */
	private queueAuraRestart(leaf: WorkspaceLeaf) {
		const id = (leaf as WorkspaceLeaf & { id?: string }).id ?? String(leaf);
		const view = leaf.view as CanvasViewLike;
		const prev = this.auraRestartTimers.get(id);
		if (prev) window.clearTimeout(prev);
		const t = window.setTimeout(() => {
			this.auraRestartTimers.delete(id);
			if (this.zoomFarByLeaf.get(id)) return;
			this.restartAuraAnimations(view);
		}, 80);
		this.auraRestartTimers.set(id, t);
	}

	/** Re-enable breathe/drift after far-zoom or a sharp near-zoom jump. */
	private restartAuraAnimations(view: CanvasViewLike) {
		const root =
			view.canvas?.wrapperEl ??
			view.containerEl.querySelector<HTMLElement>(".canvas-wrapper") ??
			view.containerEl;
		if (
			root.classList.contains(FAR_ZOOM_CLASS) ||
			view.containerEl.classList.contains(FAR_ZOOM_CLASS)
		) {
			return;
		}

		const auras = view.containerEl.querySelectorAll<HTMLElement>(
			".intuition-image-aura, .intuition-image-aura__blob",
		);
		if (!auras.length) return;

		auras.forEach((el) => {
			el.style.setProperty("animation", "none");
		});
		void view.containerEl.offsetWidth;
		requestAnimationFrame(() => {
			auras.forEach((el) => {
				el.style.removeProperty("animation");
			});
		});
	}

	/** Suspend media tilt + hide auras briefly while zoom is still settling. */
	private setCanvasZoomSettling(leaf: WorkspaceLeaf, on: boolean) {
		const id = (leaf as WorkspaceLeaf & { id?: string }).id ?? String(leaf);
		const view = leaf.view as CanvasViewLike;
		const root =
			view.canvas?.wrapperEl ??
			view.containerEl.querySelector<HTMLElement>(".canvas-wrapper") ??
			view.containerEl;

		const idle = this.zoomIdleTimers.get(id);
		if (idle) {
			window.clearTimeout(idle);
			this.zoomIdleTimers.delete(id);
		}

		const apply = (active: boolean) => {
			const was = root.classList.contains(ZOOM_SETTLING_CLASS);
			root.classList.toggle(ZOOM_SETTLING_CLASS, active);
			view.containerEl.classList.toggle(ZOOM_SETTLING_CLASS, active);
			view.canvas?.canvasEl?.classList.toggle(ZOOM_SETTLING_CLASS, active);
			if (active && !was) {
				this.vibeControllers.get(id)?.clearAllEffects();
			}
		};

		if (on) {
			apply(true);
			return;
		}

		const t = window.setTimeout(() => {
			this.zoomIdleTimers.delete(id);
			apply(false);
		}, 120);
		this.zoomIdleTimers.set(id, t);
	}

	private readCanvasZoom(view: CanvasViewLike): number {
		const canvas = view.canvas as CanvasLike & {
			zoom?: number;
			tZoom?: number;
		};
		const fromZoom = canvas?.zoom;
		const fromTarget = canvas?.tZoom;
		const lastGood =
			(canvas ? this.lastGoodZoomByCanvas.get(canvas) : undefined) ?? 1;

		/**
		 * Obsidian briefly exposes canvas.zoom / tZoom as float noise (~1e-16)
		 * at zoom extremes — `> 0` accepts it and the HUD jumps 78%→0%→33%.
		 * Real canvas zoom in practice stays >= ~6%; reject anything under 1%.
		 */
		const MIN_ZOOM = 0.01;
		const isSane = (z: unknown): z is number =>
			typeof z === "number" && Number.isFinite(z) && z >= MIN_ZOOM;

		let usedFallback = true;
		let result = lastGood;

		if (isSane(fromZoom)) {
			result = fromZoom;
			usedFallback = false;
		} else if (isSane(fromTarget)) {
			result = fromTarget;
			usedFallback = false;
		} else {
			const canvasEl =
				canvas?.canvasEl ??
				view.containerEl.querySelector<HTMLElement>(".canvas");
			if (canvasEl) {
				const scale = readElementScale(canvasEl);
				if (isSane(scale)) {
					result = scale;
					usedFallback = false;
				}
			}

			if (usedFallback) {
				const hosts = [
					canvas?.wrapperEl,
					view.containerEl.querySelector<HTMLElement>(".canvas-wrapper"),
				].filter(Boolean) as HTMLElement[];

				for (const el of hosts) {
					const scale = readElementScale(el);
					if (isSane(scale)) {
						result = scale;
						usedFallback = false;
						break;
					}
				}
			}
		}

		if (canvas && isSane(result)) {
			this.lastGoodZoomByCanvas.set(canvas, result);
		}

		return result;
	}

	private ensureFpsOverlay(leaf: WorkspaceLeaf) {
		const id = (leaf as WorkspaceLeaf & { id?: string }).id ?? String(leaf);
		const view = leaf.view as CanvasViewLike;
		const host =
			view.containerEl.querySelector<HTMLElement>(".view-content") ??
			view.containerEl;
		let fps = this.fpsOverlays.get(id);
		if (!fps) {
			fps = new FpsOverlay();
			this.fpsOverlays.set(id, fps);
		}
		fps.setSparkleCountProvider(
			() => this.vibeSparkles.get(id)?.getActiveCount() ?? 0,
		);
		fps.setZoomProvider(() => this.readCanvasZoom(view));
		fps.attach(host);
	}

	/** Sticky mini-player: keeps audio alive when the Canvas node leaves the viewport. */
	private ensureStickyAudioPlayer(leaf: WorkspaceLeaf) {
		const id = (leaf as WorkspaceLeaf & { id?: string }).id ?? String(leaf);
		const view = leaf.view as CanvasViewLike;
		const host =
			view.containerEl.querySelector<HTMLElement>(".view-content") ??
			view.containerEl;
		const canvasRoot =
			view.canvas?.wrapperEl ??
			view.containerEl.querySelector<HTMLElement>(".canvas-wrapper") ??
			view.containerEl;
		let player = this.stickyAudioPlayers.get(id);
		if (!player) {
			player = new StickyAudioPlayer();
			this.stickyAudioPlayers.set(id, player);
		}
		player.setVolume(this.settings.stickyAudioVolume);
		player.setLoop(this.settings.stickyAudioLoop);
		player.setOnVolumeChange((pct) => {
			this.settings.stickyAudioVolume = pct;
			void this.saveSettings();
		});
		player.setOnLoopChange((loop) => {
			this.settings.stickyAudioLoop = loop;
			void this.saveSettings();
		});
		player.attach(host, canvasRoot);
	}

	private ensureVibeController(leaf: WorkspaceLeaf) {
		const id = (leaf as WorkspaceLeaf & { id?: string }).id ?? String(leaf);
		const view = leaf.view as CanvasViewLike;
		const root =
			view.canvas?.wrapperEl ??
			view.containerEl.querySelector<HTMLElement>(".canvas-wrapper") ??
			view.containerEl;

		const suspendOpts = {
			getSuspended: () => this.aspectResizeActive,
			getSelectionCount: () => {
				const sel = view.canvas?.selection;
				if (sel) return sel.size;
				return view.containerEl.querySelectorAll(".canvas-node.is-selected")
					.length;
			},
			getZoom: () => this.readCanvasZoom(view),
			getCards: (): VibeCard[] => {
				const nodes = view.canvas?.nodes;
				const out: VibeCard[] = [];
				const seen = new Set<HTMLElement>();
				if (nodes) {
					for (const node of nodes.values()) {
						const el = (node as { nodeEl?: HTMLElement | null }).nodeEl;
						if (!el || seen.has(el) || el.classList.contains("is-group")) {
							continue;
						}
						const data = (
							node as { getData?: () => { type?: string } }
						).getData?.();
						const type = data?.type;
						if (type === "text" || el.classList.contains("is-text")) {
							seen.add(el);
							out.push({ el, kind: "text" });
							continue;
						}
						if (
							type === "file" ||
							type === "link" ||
							el.querySelector("img, .media-embed, .image-embed")
						) {
							seen.add(el);
							out.push({ el, kind: "media" });
						}
					}
				}
				return out;
			},
		};

		let vibe = this.vibeControllers.get(id);
		if (!vibe) {
			vibe = new VibeTiltController();
			this.vibeControllers.set(id, vibe);
		}
		vibe.attach(root, suspendOpts);
		vibe.setStrength(this.clampVibeStrength(this.settings.vibeStrength));
		vibe.setTextStrength(
			this.clampVibeTextStrength(this.settings.vibeTextStrength),
		);

		let sparkles = this.vibeSparkles.get(id);
		if (!sparkles) {
			sparkles = new VibeSparkleController();
			this.vibeSparkles.set(id, sparkles);
		}
		sparkles.attach(root, suspendOpts);
		sparkles.setConfig(normalizeSparkleConfig(this.settings.vibeSparkles));
	}

	private ensureVibeStrengthPanel(leaf: WorkspaceLeaf) {
		const id = (leaf as WorkspaceLeaf & { id?: string }).id ?? String(leaf);
		const view = leaf.view as CanvasViewLike;
		const host =
			view.containerEl.querySelector<HTMLElement>(".view-content") ??
			view.containerEl;

		const existing = this.vibePanels.get(id);
		if (existing) {
			if (!existing.isConnected) host.appendChild(existing);
			existing.hidden = !this.settings.vibeMode;
			return;
		}

		const panel = document.createElement("div");
		panel.className = "intuition-vibe-panel";
		panel.setAttribute("data-intuition-vibe-panel", "1");
		panel.hidden = !this.settings.vibeMode;

		const sections = this.settings.vibePanelSections ?? {};
		const cfg = normalizeSparkleConfig(this.settings.vibeSparkles);
		const aura = normalizeGlobalAura(this.settings.globalAura);

		// ── Tilt ──
		const tiltSec = this.createVibeAccordion(
			panel,
			"tilt",
			"Реакция",
			!!sections.tilt,
		);
		tiltSec.body.appendChild(
			this.createVibeSliderRow({
				label: "Наклон",
				sliderClass: "intuition-vibe-panel__slider--tilt",
				valueClass: "intuition-vibe-panel__value--tilt",
				aria: "Сила наклона картинок",
				initial: this.clampVibeStrength(this.settings.vibeStrength),
				onInput: (n) => this.setVibeStrength(n, true),
			}),
		);
		tiltSec.body.appendChild(
			this.createVibeSliderRow({
				label: "Текст",
				sliderClass: "intuition-vibe-panel__slider--text",
				valueClass: "intuition-vibe-panel__value--text",
				aria: "Сила свечения текста при наведении",
				initial: this.clampVibeTextStrength(this.settings.vibeTextStrength),
				onInput: (n) => this.setVibeTextStrength(n, true),
			}),
		);

		// ── Sparkles ──
		const sparkSec = this.createVibeAccordion(
			panel,
			"sparkles",
			"Блестки",
			!!sections.sparkles,
		);
		sparkSec.body.appendChild(
			this.createVibeSliderRow({
				label: "Кол-во",
				sliderClass: "intuition-vibe-panel__slider--amount",
				valueClass: "intuition-vibe-panel__value--amount",
				aria: "Максимальное количество блесток",
				min: SPARKLE_LIMITS.amount.min,
				max: SPARKLE_LIMITS.amount.max,
				initial: cfg.amount,
				format: (n) => String(n),
				onInput: (n) => this.patchVibeSparkles({ amount: n }, true),
			}),
		);
		sparkSec.body.appendChild(
			this.createVibeSliderRow({
				label: "Частота",
				sliderClass: "intuition-vibe-panel__slider--freq",
				valueClass: "intuition-vibe-panel__value--freq",
				aria: "Частота спавна блесток",
				min: SPARKLE_LIMITS.frequency.min,
				max: SPARKLE_LIMITS.frequency.max,
				initial: cfg.frequency,
				format: (n) => String(n),
				onInput: (n) => this.patchVibeSparkles({ frequency: n }, true),
			}),
		);
		sparkSec.body.appendChild(
			this.createVibeSliderRow({
				label: "Размер",
				sliderClass: "intuition-vibe-panel__slider--size",
				valueClass: "intuition-vibe-panel__value--size",
				aria: "Размер блесток",
				min: SPARKLE_LIMITS.size.min,
				max: SPARKLE_LIMITS.size.max,
				initial: cfg.size,
				format: (n) => `${n}px`,
				onInput: (n) => this.patchVibeSparkles({ size: n }, true),
			}),
		);
		sparkSec.body.appendChild(
			this.createVibeSliderRow({
				label: "Жизнь",
				sliderClass: "intuition-vibe-panel__slider--life",
				valueClass: "intuition-vibe-panel__value--life",
				aria: "Время жизни блесток",
				min: SPARKLE_LIMITS.lifetime.min,
				max: SPARKLE_LIMITS.lifetime.max,
				step: 100,
				initial: cfg.lifetime,
				format: (n) => `${(n / 1000).toFixed(1)}с`,
				onInput: (n) => this.patchVibeSparkles({ lifetime: n }, true),
			}),
		);
		sparkSec.body.appendChild(
			this.createVibeSliderRow({
				label: "Яркость",
				sliderClass: "intuition-vibe-panel__slider--opacity",
				valueClass: "intuition-vibe-panel__value--opacity",
				aria: "Яркость блесток",
				min: SPARKLE_LIMITS.opacity.min,
				max: SPARKLE_LIMITS.opacity.max,
				initial: cfg.opacity,
				onInput: (n) => this.patchVibeSparkles({ opacity: n }, true),
			}),
		);
		sparkSec.body.appendChild(
			this.createVibeSliderRow({
				label: "Подъём",
				sliderClass: "intuition-vibe-panel__slider--drift",
				valueClass: "intuition-vibe-panel__value--drift",
				aria: "Скорость подъёма блесток",
				min: SPARKLE_LIMITS.drift.min,
				max: SPARKLE_LIMITS.drift.max,
				initial: cfg.drift,
				format: (n) => String(n),
				onInput: (n) => this.patchVibeSparkles({ drift: n }, true),
			}),
		);

		const colorRow = document.createElement("div");
		colorRow.className = "intuition-vibe-panel__row";
		const colorLabel = document.createElement("span");
		colorLabel.className = "intuition-vibe-panel__label";
		colorLabel.textContent = "Цвет";
		const colorInput = document.createElement("input");
		colorInput.type = "color";
		colorInput.className =
			"intuition-vibe-panel__color intuition-vibe-panel__slider--color";
		colorInput.value = cfg.color;
		colorInput.setAttribute("aria-label", "Цвет блесток");
		colorInput.addEventListener("pointerdown", (e) => e.stopPropagation());
		colorInput.addEventListener("click", (e) => e.stopPropagation());
		colorInput.addEventListener("input", () =>
			this.patchVibeSparkles({ color: colorInput.value }, true),
		);
		colorRow.appendChild(colorLabel);
		colorRow.appendChild(colorInput);
		sparkSec.body.appendChild(colorRow);

		const resetSparkle = document.createElement("div");
		resetSparkle.className =
			"intuition-vibe-panel__row intuition-vibe-panel__row--full";
		const resetSparkleBtn = document.createElement("button");
		resetSparkleBtn.type = "button";
		resetSparkleBtn.className = "mod-muted intuition-vibe-panel__reset";
		resetSparkleBtn.textContent = "Сбросить блестки";
		resetSparkleBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
		resetSparkleBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.resetVibeSparkles();
		});
		resetSparkle.appendChild(resetSparkleBtn);
		sparkSec.body.appendChild(resetSparkle);

		// ── Global auras ──
		const auraSec = this.createVibeAccordion(
			panel,
			"auras",
			"Ауры",
			!!sections.auras,
		);

		auraSec.body.appendChild(
			this.createVibeToggleRow({
				label: "Вкл.",
				inputClass: "intuition-vibe-panel__aura-enabled",
				checked: aura.enabled,
				aria: "Ауры на всех картинках",
				onChange: (on) => this.patchGlobalAura({ enabled: on }, true),
			}),
		);
		auraSec.body.appendChild(
			this.createVibeToggleRow({
				label: "Перелив",
				inputClass: "intuition-vibe-panel__aura-shimmer",
				checked: aura.shimmer,
				aria: "Перелив ауры",
				onChange: (on) => this.patchGlobalAura({ shimmer: on }, true),
			}),
		);
		auraSec.body.appendChild(
			this.createVibeSliderRow({
				label: "Сила",
				sliderClass: "intuition-vibe-panel__slider--aura-str",
				valueClass: "intuition-vibe-panel__value--aura-str",
				aria: "Сила ауры",
				initial: aura.strength,
				onInput: (n) => this.patchGlobalAura({ strength: n }, true),
			}),
		);
		auraSec.body.appendChild(
			this.createVibeSliderRow({
				label: "Площадь",
				sliderClass: "intuition-vibe-panel__slider--aura-size",
				valueClass: "intuition-vibe-panel__value--aura-size",
				aria: "Размер ауры",
				min: 0,
				max: 200,
				step: 5,
				initial: aura.size,
				format: (n) => `${n}%`,
				onInput: (n) => this.patchGlobalAura({ size: n }, true),
			}),
		);

		const applyAuraRow = document.createElement("div");
		applyAuraRow.className =
			"intuition-vibe-panel__row intuition-vibe-panel__row--full";
		const applyAuraBtn = document.createElement("button");
		applyAuraBtn.type = "button";
		applyAuraBtn.className = "mod-cta intuition-vibe-panel__reset";
		applyAuraBtn.textContent = "Применить ко всем";
		applyAuraBtn.title = "Записать эти настройки ауры на все картинки канваса";
		applyAuraBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
		applyAuraBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.applyGlobalAuraToAllImages();
		});
		applyAuraRow.appendChild(applyAuraBtn);
		auraSec.body.appendChild(applyAuraRow);

		const resetAuraRow = document.createElement("div");
		resetAuraRow.className =
			"intuition-vibe-panel__row intuition-vibe-panel__row--full";
		const resetAuraBtn = document.createElement("button");
		resetAuraBtn.type = "button";
		resetAuraBtn.className = "mod-muted intuition-vibe-panel__reset";
		resetAuraBtn.textContent = "Сбросить ауры";
		resetAuraBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
		resetAuraBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.resetGlobalAura();
		});
		resetAuraRow.appendChild(resetAuraBtn);
		auraSec.body.appendChild(resetAuraRow);

		host.appendChild(panel);
		this.vibePanels.set(id, panel);
	}

	private createVibeAccordion(
		panel: HTMLElement,
		key: string,
		title: string,
		open: boolean,
	) {
		const section = document.createElement("div");
		section.className = "intuition-vibe-panel__accordion";
		section.dataset.section = key;
		if (open) section.classList.add("is-open");

		const head = document.createElement("div");
		head.className = "intuition-vibe-panel__accordion-head";
		head.setAttribute("role", "button");
		head.tabIndex = 0;
		head.setAttribute("aria-expanded", open ? "true" : "false");

		const chevron = document.createElement("span");
		chevron.className = "intuition-vibe-panel__accordion-chevron";
		setIcon(chevron, "chevron-right");

		const label = document.createElement("span");
		label.className = "intuition-vibe-panel__accordion-title";
		label.textContent = title;

		head.appendChild(chevron);
		head.appendChild(label);

		const body = document.createElement("div");
		body.className = "intuition-vibe-panel__accordion-body";

		const toggle = () => {
			const next = !section.classList.contains("is-open");
			section.classList.toggle("is-open", next);
			head.setAttribute("aria-expanded", next ? "true" : "false");
			this.settings.vibePanelSections = {
				...(this.settings.vibePanelSections ?? {}),
				[key]: next,
			};
			this.queueVibeSettingsSave();
		};

		head.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			toggle();
		});
		head.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				toggle();
			}
		});

		section.appendChild(head);
		section.appendChild(body);
		panel.appendChild(section);
		return { section, body, head };
	}

	private createVibeToggleRow(opts: {
		label: string;
		inputClass: string;
		checked: boolean;
		aria: string;
		onChange: (on: boolean) => void;
	}) {
		const row = document.createElement("div");
		row.className = "intuition-vibe-panel__row";

		const label = document.createElement("span");
		label.className = "intuition-vibe-panel__label";
		label.textContent = opts.label;

		const wrap = document.createElement("label");
		wrap.className = "intuition-text-panel__toggle";
		const input = document.createElement("input");
		input.type = "checkbox";
		input.className = opts.inputClass;
		input.checked = opts.checked;
		input.setAttribute("aria-label", opts.aria);
		wrap.appendChild(input);
		wrap.appendChild(
			Object.assign(document.createElement("span"), {
				className: "intuition-text-panel__toggle-ui",
			}),
		);
		input.addEventListener("change", () => opts.onChange(input.checked));

		row.appendChild(label);
		row.appendChild(wrap);
		return row;
	}

	private createVibeSliderRow(opts: {
		label: string;
		sliderClass: string;
		valueClass: string;
		aria: string;
		initial: number;
		min?: number;
		max?: number;
		step?: number;
		format?: (n: number) => string;
		onInput: (n: number) => void;
	}) {
		const row = document.createElement("div");
		row.className = "intuition-vibe-panel__row";

		const label = document.createElement("span");
		label.className = "intuition-vibe-panel__label";
		label.textContent = opts.label;

		const wrap = document.createElement("div");
		wrap.className = "intuition-vibe-panel__size";

		const slider = document.createElement("input");
		slider.type = "range";
		slider.min = String(opts.min ?? 0);
		slider.max = String(opts.max ?? 100);
		slider.step = String(opts.step ?? 1);
		slider.className = `intuition-vibe-panel__slider ${opts.sliderClass}`;
		slider.value = String(opts.initial);
		slider.setAttribute("aria-label", opts.aria);

		const value = document.createElement("span");
		value.className = `intuition-vibe-panel__value ${opts.valueClass}`;
		const fmt = opts.format ?? ((n: number) => `${n}%`);
		value.textContent = fmt(Number(slider.value));

		slider.addEventListener("pointerdown", (e) => e.stopPropagation());
		slider.addEventListener("click", (e) => e.stopPropagation());
		slider.addEventListener("input", () => {
			const n = Number(slider.value);
			value.textContent = fmt(n);
			opts.onInput(n);
		});

		wrap.appendChild(slider);
		wrap.appendChild(value);
		row.appendChild(label);
		row.appendChild(wrap);
		return row;
	}

	private syncVibeStrengthPanel(leaf: WorkspaceLeaf, visible: boolean) {
		const id = (leaf as WorkspaceLeaf & { id?: string }).id ?? String(leaf);
		let panel = this.vibePanels.get(id);
		if (!panel || !panel.isConnected) {
			this.ensureVibeStrengthPanel(leaf);
			panel = this.vibePanels.get(id);
		}
		if (!panel) return;
		panel.hidden = !visible;
		this.syncPanelSlider(
			panel,
			".intuition-vibe-panel__slider--tilt",
			".intuition-vibe-panel__value--tilt",
			this.clampVibeStrength(this.settings.vibeStrength),
			(n) => `${n}%`,
		);
		this.syncPanelSlider(
			panel,
			".intuition-vibe-panel__slider--text",
			".intuition-vibe-panel__value--text",
			this.clampVibeTextStrength(this.settings.vibeTextStrength),
			(n) => `${n}%`,
		);
		this.syncVibeSparkleControlsOn(panel);
		this.syncGlobalAuraControlsOn(panel);
	}

	private syncPanelSlider(
		panel: HTMLElement,
		sliderSel: string,
		valueSel: string,
		pct: number,
		format: (n: number) => string = (n) => `${n}%`,
	) {
		const slider = panel.querySelector<HTMLInputElement>(sliderSel);
		const value = panel.querySelector<HTMLElement>(valueSel);
		if (slider) slider.value = String(pct);
		if (value) value.textContent = format(pct);
	}

	private syncAllVibeStrengthSliders() {
		const strength = this.clampVibeStrength(this.settings.vibeStrength);
		for (const panel of this.vibePanels.values()) {
			this.syncPanelSlider(
				panel,
				".intuition-vibe-panel__slider--tilt",
				".intuition-vibe-panel__value--tilt",
				strength,
			);
		}
	}

	private syncAllVibeTextStrengthSliders() {
		const textStrength = this.clampVibeTextStrength(this.settings.vibeTextStrength);
		for (const panel of this.vibePanels.values()) {
			this.syncPanelSlider(
				panel,
				".intuition-vibe-panel__slider--text",
				".intuition-vibe-panel__value--text",
				textStrength,
			);
		}
	}

	private syncVibeSparkleControls() {
		for (const panel of this.vibePanels.values()) {
			this.syncVibeSparkleControlsOn(panel);
		}
	}

	private syncGlobalAuraControls() {
		for (const panel of this.vibePanels.values()) {
			this.syncGlobalAuraControlsOn(panel);
		}
	}

	private syncGlobalAuraControlsOn(panel: HTMLElement) {
		const g = normalizeGlobalAura(this.settings.globalAura);
		const enabled = panel.querySelector<HTMLInputElement>(
			".intuition-vibe-panel__aura-enabled",
		);
		const shimmer = panel.querySelector<HTMLInputElement>(
			".intuition-vibe-panel__aura-shimmer",
		);
		if (enabled) enabled.checked = g.enabled;
		if (shimmer) shimmer.checked = g.shimmer;
		this.syncPanelSlider(
			panel,
			".intuition-vibe-panel__slider--aura-str",
			".intuition-vibe-panel__value--aura-str",
			g.strength,
		);
		this.syncPanelSlider(
			panel,
			".intuition-vibe-panel__slider--aura-size",
			".intuition-vibe-panel__value--aura-size",
			g.size,
			(n) => `${n}%`,
		);
		if (shimmer) shimmer.disabled = !g.enabled;
		const str = panel.querySelector<HTMLInputElement>(
			".intuition-vibe-panel__slider--aura-str",
		);
		const size = panel.querySelector<HTMLInputElement>(
			".intuition-vibe-panel__slider--aura-size",
		);
		if (str) str.disabled = !g.enabled;
		if (size) size.disabled = !g.enabled;
	}

	private syncVibeSparkleControlsOn(panel: HTMLElement) {
		const cfg = normalizeSparkleConfig(this.settings.vibeSparkles);
		this.syncPanelSlider(
			panel,
			".intuition-vibe-panel__slider--amount",
			".intuition-vibe-panel__value--amount",
			cfg.amount,
			(n) => String(n),
		);
		this.syncPanelSlider(
			panel,
			".intuition-vibe-panel__slider--freq",
			".intuition-vibe-panel__value--freq",
			cfg.frequency,
			(n) => String(n),
		);
		this.syncPanelSlider(
			panel,
			".intuition-vibe-panel__slider--size",
			".intuition-vibe-panel__value--size",
			cfg.size,
			(n) => `${n}px`,
		);
		this.syncPanelSlider(
			panel,
			".intuition-vibe-panel__slider--life",
			".intuition-vibe-panel__value--life",
			cfg.lifetime,
			(n) => `${(n / 1000).toFixed(1)}с`,
		);
		this.syncPanelSlider(
			panel,
			".intuition-vibe-panel__slider--opacity",
			".intuition-vibe-panel__value--opacity",
			cfg.opacity,
		);
		this.syncPanelSlider(
			panel,
			".intuition-vibe-panel__slider--drift",
			".intuition-vibe-panel__value--drift",
			cfg.drift,
			(n) => String(n),
		);
		const color = panel.querySelector<HTMLInputElement>(
			".intuition-vibe-panel__slider--color",
		);
		if (color) color.value = cfg.color;
	}

	private ensureTextPanel(leaf: WorkspaceLeaf) {
		const id = (leaf as WorkspaceLeaf & { id?: string }).id ?? String(leaf);
		if (this.textPanels.has(id)) return;

		const view = leaf.view as CanvasViewLike;
		const host =
			view.containerEl.querySelector<HTMLElement>(".view-content") ??
			view.containerEl;
		const panel = new TextStylePanel(host);
		this.textPanels.set(id, panel);
	}

	private ensureImagePanel(leaf: WorkspaceLeaf) {
		const id = (leaf as WorkspaceLeaf & { id?: string }).id ?? String(leaf);
		if (this.imagePanels.has(id)) return;

		const view = leaf.view as CanvasViewLike;
		const host =
			view.containerEl.querySelector<HTMLElement>(".view-content") ??
			view.containerEl;
		const panel = new ImageStylePanel(host);
		panel.setCollageHooks({
			getGap: () => clampCollageGap(this.settings.collageGap),
			onGapChange: (gap) => {
				this.settings.collageGap = clampCollageGap(gap);
				this.queueCollageSettingsSave();
				this.syncAllCollageButtons();
			},
			getPackAxis: () =>
				normalizeCollagePackAxis(this.settings.collagePackAxis),
			onPackAxisChange: (axis) => {
				this.settings.collagePackAxis = normalizeCollagePackAxis(axis);
				this.queueCollageSettingsSave();
				this.syncAllCollageButtons();
			},
			getCount: () => clampCollageCount(this.settings.collageCount),
			onCountChange: (count) => {
				this.settings.collageCount = clampCollageCount(count);
				this.queueCollageSettingsSave();
				this.syncAllCollageButtons();
			},
			onArrange: () => this.arrangeSelectedImagesCollage(view),
			onPresent: () => this.startPhotoPresentation(leaf),
			getPresentation: () => this.settings.presentation,
			onPresentationChange: (partial) =>
				this.patchPresentationSettings(partial),
		});
		this.imagePanels.set(id, panel);
	}

	private ensureCanvasPanel(leaf: WorkspaceLeaf) {
		const id = (leaf as WorkspaceLeaf & { id?: string }).id ?? String(leaf);
		if (this.canvasPanels.has(id)) return;

		const view = leaf.view as CanvasViewLike;
		const host =
			view.containerEl.querySelector<HTMLElement>(".view-content") ??
			view.containerEl;
		const panel = new CanvasStylePanel(host);
		this.canvasPanels.set(id, panel);
	}

	private toggleCanvasPanel(leaf: WorkspaceLeaf) {
		const id = (leaf as WorkspaceLeaf & { id?: string }).id ?? String(leaf);
		this.ensureCanvasPanel(leaf);
		const panel = this.canvasPanels.get(id);
		if (!panel) return;

		const view = leaf.view as CanvasViewLike;
		const root =
			view.canvas?.wrapperEl ??
			view.containerEl.querySelector<HTMLElement>(".canvas-wrapper") ??
			view.containerEl;
		const path = view.file?.path ?? "";
		const style = this.getCanvasChrome(path, view);

		panel.toggle(root, style, (next) => {
			this.setCanvasChrome(path, view, next);
		});
	}

	private getCanvasChrome(path: string, view?: CanvasViewLike): CanvasChromeStyle {
		const fromMeta = this.readChromeFromCanvas(view);
		if (fromMeta) return normalizeCanvasChrome(fromMeta);
		if (path && this.settings.canvasChrome[path]) {
			return normalizeCanvasChrome(this.settings.canvasChrome[path]);
		}
		return normalizeCanvasChrome(DEFAULT_CANVAS_CHROME);
	}

	private readChromeFromCanvas(
		view?: CanvasViewLike,
	): Partial<CanvasChromeStyle> | null {
		if (!view?.canvas) return null;
		const canvas = view.canvas as CanvasLike & {
			metadata?: { intuitionCanvas?: Partial<CanvasChromeStyle> };
			data?: { metadata?: { intuitionCanvas?: Partial<CanvasChromeStyle> } };
		};
		const meta =
			canvas.metadata?.intuitionCanvas ??
			canvas.data?.metadata?.intuitionCanvas;
		return meta ?? null;
	}

	private setCanvasChrome(
		path: string,
		view: CanvasViewLike,
		style: CanvasChromeStyle,
	) {
		const normalized = normalizeCanvasChrome(style);
		if (path) {
			this.settings.canvasChrome[path] = normalized;
		}
		this.writeChromeToCanvas(view, normalized);
		this.applyCanvasChromeForLeaf(view, normalized);

		if (this.chromeSaveTimer) window.clearTimeout(this.chromeSaveTimer);
		this.chromeSaveTimer = window.setTimeout(() => {
			this.chromeSaveTimer = 0;
			void this.saveSettings();
		}, 200);
	}

	private writeChromeToCanvas(view: CanvasViewLike, style: CanvasChromeStyle) {
		const canvas = view.canvas as CanvasLike & {
			metadata?: Record<string, unknown>;
			requestSave?: () => void;
		};
		if (!canvas) return;
		if (!canvas.metadata) canvas.metadata = {};
		canvas.metadata.intuitionCanvas = style;
		canvas.requestSave?.();
	}

	private applyAllCanvasChrome() {
		for (const leaf of this.app.workspace.getLeavesOfType(CANVAS_VIEW_TYPE)) {
			const view = leaf.view as CanvasViewLike;
			const path = view.file?.path ?? "";
			const style = this.getCanvasChrome(path, view);
			this.applyCanvasChromeForLeaf(view, style);
		}
	}

	private applyCanvasChromeForLeaf(
		view: CanvasViewLike,
		style: CanvasChromeStyle,
	) {
		const root =
			view.canvas?.wrapperEl ??
			view.containerEl.querySelector<HTMLElement>(".canvas-wrapper") ??
			view.containerEl;
		const path = view.file?.path ?? "";
		const stored =
			!!this.readChromeFromCanvas(view) ||
			!!(path && this.settings.canvasChrome[path]);
		applyCanvasChrome(root, style, stored);
	}

	private installTextSelectionHook(leaf: WorkspaceLeaf) {
		const view = leaf.view as CanvasViewLike;
		const root =
			view.canvas?.wrapperEl ??
			view.containerEl.querySelector<HTMLElement>(".canvas-wrapper") ??
			view.containerEl;

		if (root.getAttribute(TEXT_HOOK_ATTR) === "1") return;
		root.setAttribute(TEXT_HOOK_ATTR, "1");

		const sync = () => this.syncStylePanelsForLeaf(leaf);
		this.registerDomEvent(root, "pointerup", () => {
			window.setTimeout(sync, 30);
		});
		this.registerDomEvent(root, "keyup", () => {
			window.setTimeout(sync, 30);
		});
		window.setTimeout(sync, 50);
	}

	private syncStylePanelsForLeaf(leaf: WorkspaceLeaf) {
		const id = (leaf as WorkspaceLeaf & { id?: string }).id ?? String(leaf);
		const textPanel = this.textPanels.get(id);
		const imagePanel = this.imagePanels.get(id);
		if (!textPanel && !imagePanel) return;

		const view = leaf.view as CanvasViewLike;
		const textNode = this.getSelectedTextNode(view);
		const imageNodes = this.getSelectedImageNodes(view);

		/* Prefer image panel whenever any photo is selected — audio/other
		 * nodes in the same selection are ignored (e.g. MP3 + photos). */
		if (imageNodes.length > 0) {
			textPanel?.hide();
			imagePanel?.showFor(imageNodes);
			return;
		}

		if (textNode) {
			imagePanel?.hide();
			textPanel?.showFor(textNode);
			applyTextStylesToCanvas([textNode]);
			return;
		}

		textPanel?.hide();
		imagePanel?.hide();
	}

	private getSelectedTextNode(view: CanvasViewLike): TextNodeLike | null {
		const canvas = view.canvas;
		if (!canvas?.nodes) return null;

		if (canvas.selection) {
			for (const item of canvas.selection) {
				if (isTextNode(item)) return item;
			}
		}

		for (const node of canvas.nodes.values()) {
			if (node.nodeEl?.classList.contains("is-selected") && isTextNode(node)) {
				return node;
			}
		}
		return null;
	}

	private injectAddTextButton(leaf: WorkspaceLeaf) {
		const view = leaf.view as CanvasViewLike;
		const menu =
			view.canvas?.cardMenuEl ??
			view.containerEl.querySelector<HTMLElement>(".canvas-card-menu");

		if (!menu) return;
		if (menu.querySelector(`[${TEXT_BTN_ATTR}]`)) return;

		const btn = document.createElement("div");
		btn.className = "canvas-card-menu-button";
		btn.setAttribute(TEXT_BTN_ATTR, "1");
		btn.setAttribute("aria-label", "Текст без карточки");
		setIcon(btn, "type");
		setTooltip(btn, "Текст без карточки", { placement: "top" });
		btn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.addPlainTextNode(view);
		});
		menu.appendChild(btn);
	}

	private injectCollageButton(leaf: WorkspaceLeaf) {
		const view = leaf.view as CanvasViewLike;
		const controls =
			view.canvas?.canvasControlsEl ??
			view.containerEl.querySelector<HTMLElement>(".canvas-controls");

		if (!controls) return;
		const existing = controls.querySelector(`[${COLLAGE_BTN_ATTR}] button`);
		if (existing instanceof HTMLButtonElement) {
			this.syncCollageButton(leaf, existing);
			return;
		}

		const group = document.createElement("div");
		group.className = "canvas-control-group";
		group.setAttribute(COLLAGE_BTN_ATTR, "1");

		const button = document.createElement("button");
		button.className = "clickable-icon intuition-canvas-toggle";
		button.type = "button";
		this.syncCollageButton(leaf, button);
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.toggleCollagePanel(leaf);
		});

		group.appendChild(button);
		controls.appendChild(group);
	}

	private ensureCollagePanel(leaf: WorkspaceLeaf) {
		const id = (leaf as WorkspaceLeaf & { id?: string }).id ?? String(leaf);
		if (this.collagePanels.has(id)) return;

		const view = leaf.view as CanvasViewLike;
		const host =
			view.containerEl.querySelector<HTMLElement>(".view-content") ??
			view.containerEl;

		const panel = document.createElement("div");
		panel.className = "intuition-collage-panel";
		panel.setAttribute("data-intuition-collage-panel", "1");
		panel.hidden = true;

		const title = document.createElement("div");
		title.className = "intuition-collage-panel__title";
		title.textContent = "Коллаж";

		const gapRow = document.createElement("div");
		gapRow.className = "intuition-collage-panel__row";

		const gapLabel = document.createElement("span");
		gapLabel.className = "intuition-collage-panel__label";
		gapLabel.textContent = "Отступы";

		const slider = document.createElement("input");
		slider.type = "range";
		slider.min = "0";
		slider.max = String(COLLAGE_GAP_SLIDER_MAX);
		slider.step = "1";
		slider.className = "intuition-collage-panel__slider";
		slider.value = String(
			Math.min(COLLAGE_GAP_SLIDER_MAX, clampCollageGap(this.settings.collageGap)),
		);
		slider.setAttribute("aria-label", "Отступы между фото");
		slider.setAttribute("data-collage-gap", "1");

		const gapInput = document.createElement("input");
		gapInput.type = "number";
		gapInput.min = "0";
		gapInput.max = String(COLLAGE_GAP_MAX);
		gapInput.step = "1";
		gapInput.className = "intuition-collage-panel__number";
		gapInput.value = String(clampCollageGap(this.settings.collageGap));
		gapInput.setAttribute("aria-label", "Отступы в пикселях");
		gapInput.setAttribute("data-collage-gap-px", "1");

		const applyGap = (raw: number) => {
			const gap = clampCollageGap(raw);
			slider.value = String(Math.min(COLLAGE_GAP_SLIDER_MAX, gap));
			gapInput.value = String(gap);
			this.settings.collageGap = gap;
			this.queueCollageSettingsSave();
			this.syncAllCollageButtons();
		};

		slider.addEventListener("pointerdown", (e) => e.stopPropagation());
		slider.addEventListener("click", (e) => e.stopPropagation());
		slider.addEventListener("input", () => applyGap(Number(slider.value)));

		gapInput.addEventListener("pointerdown", (e) => e.stopPropagation());
		gapInput.addEventListener("click", (e) => e.stopPropagation());
		const commitGapPx = () => applyGap(Number(gapInput.value));
		gapInput.addEventListener("change", commitGapPx);
		gapInput.addEventListener("blur", commitGapPx);
		gapInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				commitGapPx();
				gapInput.blur();
			}
		});

		gapRow.appendChild(gapLabel);
		gapRow.appendChild(slider);
		gapRow.appendChild(gapInput);

		const gridRow = document.createElement("div");
		gridRow.className = "intuition-collage-panel__row";

		const gridLabel = document.createElement("span");
		gridLabel.className = "intuition-collage-panel__label";
		gridLabel.textContent = "Сетка";

		const axisSelect = document.createElement("select");
		axisSelect.className = "dropdown intuition-collage-panel__select";
		axisSelect.setAttribute("data-collage-axis", "1");
		axisSelect.setAttribute("aria-label", "Столбцы или строки");
		for (const opt of [
			{ value: "cols", label: "Столбцы" },
			{ value: "rows", label: "Строки" },
		] as const) {
			const option = document.createElement("option");
			option.value = opt.value;
			option.textContent = opt.label;
			axisSelect.appendChild(option);
		}
		axisSelect.value = normalizeCollagePackAxis(this.settings.collagePackAxis);
		axisSelect.addEventListener("pointerdown", (e) => e.stopPropagation());
		axisSelect.addEventListener("click", (e) => e.stopPropagation());

		const countLabel = document.createElement("span");
		countLabel.className = "intuition-collage-panel__label";
		countLabel.setAttribute("data-collage-count-label", "1");
		countLabel.textContent =
			normalizeCollagePackAxis(this.settings.collagePackAxis) === "rows"
				? "Строки"
				: "Столбцы";

		const countSlider = document.createElement("input");
		countSlider.type = "range";
		countSlider.min = String(COLLAGE_COUNT_MIN);
		countSlider.max = String(COLLAGE_COUNT_MAX);
		countSlider.step = "1";
		countSlider.className = "intuition-collage-panel__slider";
		countSlider.setAttribute("data-collage-count-slider", "1");
		countSlider.value = String(clampCollageCount(this.settings.collageCount));

		const countInput = document.createElement("input");
		countInput.type = "number";
		countInput.min = String(COLLAGE_COUNT_MIN);
		countInput.max = String(COLLAGE_COUNT_MAX);
		countInput.step = "1";
		countInput.className = "intuition-collage-panel__number";
		countInput.setAttribute("data-collage-count", "1");
		countInput.value = String(clampCollageCount(this.settings.collageCount));

		const applyCount = (raw: number) => {
			const count = clampCollageCount(raw);
			countSlider.value = String(count);
			countInput.value = String(count);
			this.settings.collageCount = count;
			this.queueCollageSettingsSave();
			this.syncAllCollageButtons();
		};

		axisSelect.addEventListener("change", () => {
			this.settings.collagePackAxis = normalizeCollagePackAxis(axisSelect.value);
			countLabel.textContent =
				normalizeCollagePackAxis(axisSelect.value) === "rows"
					? "Строки"
					: "Столбцы";
			this.queueCollageSettingsSave();
			this.syncAllCollageButtons();
		});

		countSlider.addEventListener("pointerdown", (e) => e.stopPropagation());
		countSlider.addEventListener("click", (e) => e.stopPropagation());
		countSlider.addEventListener("input", () =>
			applyCount(Number(countSlider.value)),
		);
		countInput.addEventListener("pointerdown", (e) => e.stopPropagation());
		countInput.addEventListener("click", (e) => e.stopPropagation());
		const commitCount = () => applyCount(Number(countInput.value));
		countInput.addEventListener("change", commitCount);
		countInput.addEventListener("blur", commitCount);

		gridRow.appendChild(gridLabel);
		gridRow.appendChild(axisSelect);

		const countRow = document.createElement("div");
		countRow.className = "intuition-collage-panel__row";
		countRow.appendChild(countLabel);
		countRow.appendChild(countSlider);
		countRow.appendChild(countInput);

		const apply = document.createElement("button");
		apply.type = "button";
		apply.className = "mod-cta intuition-collage-panel__apply";
		apply.textContent = "В сетку";
		apply.addEventListener("pointerdown", (e) => e.stopPropagation());
		apply.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.arrangeSelectedImagesCollage(view);
		});

		panel.appendChild(title);
		panel.appendChild(gapRow);
		panel.appendChild(gridRow);
		panel.appendChild(countRow);
		panel.appendChild(apply);
		host.appendChild(panel);
		this.collagePanels.set(id, panel);
		this.syncCollagePanelControls(panel);
	}

	private toggleCollagePanel(leaf: WorkspaceLeaf) {
		const id = (leaf as WorkspaceLeaf & { id?: string }).id ?? String(leaf);
		this.ensureCollagePanel(leaf);
		const panel = this.collagePanels.get(id);
		if (!panel) return;
		panel.hidden = !panel.hidden;
		this.syncCollageButton(
			leaf,
			leaf.view.containerEl.querySelector(`[${COLLAGE_BTN_ATTR}] button`),
		);
		if (!panel.hidden) this.syncCollagePanelControls(panel);
	}

	private syncCollagePanelControls(panel: HTMLElement) {
		const gap = clampCollageGap(this.settings.collageGap);
		const axis = normalizeCollagePackAxis(this.settings.collagePackAxis);
		const count = clampCollageCount(this.settings.collageCount);

		const slider = panel.querySelector<HTMLInputElement>("[data-collage-gap]");
		const gapPx = panel.querySelector<HTMLInputElement>("[data-collage-gap-px]");
		if (slider) slider.value = String(Math.min(COLLAGE_GAP_SLIDER_MAX, gap));
		if (gapPx) gapPx.value = String(gap);

		const axisSelect = panel.querySelector<HTMLSelectElement>("[data-collage-axis]");
		if (axisSelect) axisSelect.value = axis;

		const countLabel = panel.querySelector<HTMLElement>(
			"[data-collage-count-label]",
		);
		if (countLabel) {
			countLabel.textContent = axis === "rows" ? "Строки" : "Столбцы";
		}

		const countSlider = panel.querySelector<HTMLInputElement>(
			"[data-collage-count-slider]",
		);
		const countInput = panel.querySelector<HTMLInputElement>(
			"[data-collage-count]",
		);
		if (countSlider) countSlider.value = String(count);
		if (countInput) countInput.value = String(count);
	}

	private syncCollageButton(
		leaf: WorkspaceLeaf,
		button: HTMLButtonElement | null,
	) {
		if (!button) return;
		const id = (leaf as WorkspaceLeaf & { id?: string }).id ?? String(leaf);
		const open = !(this.collagePanels.get(id)?.hidden ?? true);
		const gap = clampCollageGap(this.settings.collageGap);
		button.classList.toggle("is-active", open);
		setIcon(button, "layout-grid");
		setTooltip(button, open ? "Скрыть настройки коллажа" : "Коллаж", {
			placement: "left",
		});
		button.setAttribute(
			"aria-label",
			open ? "Скрыть настройки коллажа" : `Коллаж, отступы ${gap}px`,
		);
	}

	syncAllCollageButtons() {
		for (const leaf of this.app.workspace.getLeavesOfType(CANVAS_VIEW_TYPE)) {
			const btn = leaf.view.containerEl.querySelector(
				`[${COLLAGE_BTN_ATTR}] button`,
			);
			this.syncCollageButton(
				leaf,
				btn instanceof HTMLButtonElement ? btn : null,
			);
			const id = (leaf as WorkspaceLeaf & { id?: string }).id ?? String(leaf);
			const panel = this.collagePanels.get(id);
			if (panel && !panel.hidden) this.syncCollagePanelControls(panel);
			this.imagePanels.get(id)?.syncCollageFromHooks();
		}
	}

	clampCollageGap(value: number) {
		return clampCollageGap(value);
	}

	private queueCollageSettingsSave() {
		if (this.collageGapSaveTimer) window.clearTimeout(this.collageGapSaveTimer);
		this.collageGapSaveTimer = window.setTimeout(() => {
			this.collageGapSaveTimer = 0;
			void this.saveSettings();
		}, 200);
	}

	private queuePresentationSettingsSave() {
		if (this.presentationSaveTimer) window.clearTimeout(this.presentationSaveTimer);
		this.presentationSaveTimer = window.setTimeout(() => {
			this.presentationSaveTimer = 0;
			void this.saveSettings();
		}, 200);
	}

	private patchPresentationSettings(partial: Partial<PresentationSettings>) {
		this.settings.presentation = normalizePresentationSettings({
			...this.settings.presentation,
			...partial,
		});
		this.queuePresentationSettingsSave();
	}

	/** Full-viewport slideshow for selected images (crossfade + Ken Burns). */
	private startPhotoPresentation(leaf: WorkspaceLeaf) {
		const id = (leaf as WorkspaceLeaf & { id?: string }).id ?? String(leaf);
		const view = leaf.view as CanvasViewLike;
		const selected = this.getSelectedImageNodes(view);
		if (selected.length < 1) {
			new Notice("Выдели хотя бы одну картинку", 1600);
			return;
		}

		const ordered = sortNodesReadingOrder(
			selected as unknown as CanvasNodeLike[],
		) as unknown as ImageNodeLike[];
		const slides: PresentationSlide[] = [];
		for (const node of ordered) {
			const src = this.resolveImageSlideSrc(node);
			if (!src) continue;
			const path =
				node.file?.path ??
				node.filePath ??
				node.getData?.()?.file ??
				"";
			const label = path.includes("/")
				? path.slice(path.lastIndexOf("/") + 1)
				: path || undefined;
			const nx = node.x;
			const ny = node.y;
			const nw = node.width;
			const nh = node.height;
			const hasLayout =
				Number.isFinite(nx) &&
				Number.isFinite(ny) &&
				Number.isFinite(nw) &&
				Number.isFinite(nh) &&
				(nw as number) > 0 &&
				(nh as number) > 0;
			slides.push({
				src,
				label,
				...(hasLayout ? { x: nx, y: ny, width: nw, height: nh } : {}),
			});
		}

		if (slides.length === 0) {
			new Notice("Не удалось прочитать изображения", 2000);
			return;
		}

		const host =
			view.containerEl.querySelector<HTMLElement>(".view-content") ??
			view.containerEl;

		let present = this.photoPresentations.get(id);
		if (!present) {
			present = new PhotoPresentation();
			this.photoPresentations.set(id, present);
		}

		const ok = present.start(host, slides, {
			settings: this.settings.presentation,
			/* Half of canvas vibe tilt; no cursor glare in slideshow. */
			tiltStrength: Math.round(
				this.clampVibeStrength(this.settings.vibeStrength) * 0.5,
			),
		});
		if (!ok) {
			new Notice("Не удалось запустить презентацию", 1600);
			return;
		}
		new Notice(`Презентация: ${slides.length} фото · Esc — выход`, 2200);
	}

	private resolveImageSlideSrc(node: ImageNodeLike): string | null {
		const img = node.nodeEl?.querySelector("img") as HTMLImageElement | null;
		const fromDom = (img?.currentSrc || img?.src || "").trim();
		if (fromDom && !fromDom.startsWith("data:")) return fromDom;

		const path =
			node.file?.path ??
			node.filePath ??
			(typeof node.getData?.()?.file === "string"
				? node.getData()?.file
				: undefined);
		if (!path) return fromDom || null;

		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			return this.app.vault.getResourcePath(file);
		}
		return fromDom || null;
	}

	/** One-shot collage: tile masonry by columns, or justified rows. */
	private arrangeSelectedImagesCollage(view: CanvasViewLike) {
		const selected = this.getSelectedImageNodes(view) as unknown as CanvasNodeLike[];
		if (selected.length < 2) {
			new Notice("Выдели хотя бы 2 картинки", 1600);
			return;
		}

		const gap = clampCollageGap(this.settings.collageGap);
		const axis = normalizeCollagePackAxis(this.settings.collagePackAxis);
		const count = clampCollageCount(this.settings.collageCount);
		const ordered = sortNodesReadingOrder(selected);
		const box = boundingBox(ordered);
		const items = ordered.map((node) => ({
			id: node.id,
			aspect: aspectFromImageNode(node),
		}));

		const totalWidth = Math.max(
			box.width,
			120 * Math.min(count, ordered.length) +
				gap * Math.max(0, Math.min(count, ordered.length) - 1),
		);

		let packed: Map<string, { x: number; y: number; width: number; height: number }>;

		if (axis === "rows") {
			const rows = Math.min(count, items.length);
			packed = layoutExactRows(items, {
				originX: box.x,
				originY: box.y,
				rowWidth: totalWidth,
				rows,
				gap,
			});
		} else {
			const columns = Math.min(count, items.length);
			packed = layoutMasonry(items, {
				originX: box.x,
				originY: box.y,
				totalWidth,
				columns,
				gap,
			});
		}

		for (const node of ordered) {
			const rect = packed.get(node.id);
			if (!rect) continue;
			node.x = Math.round(rect.x);
			node.y = Math.round(rect.y);
			node.width = Math.max(1, Math.round(rect.width));
			node.height = Math.max(1, Math.round(rect.height));
			node.render?.();
		}

		view.canvas?.requestSave?.();
		const axisNote =
			axis === "rows" ? ` · ${count} стр.` : ` · ${count} стлб.`;
		new Notice(
			`Коллаж: ${ordered.length} фото · отступы ${gap}px${axisNote}`,
			1400,
		);
	}

	private addPlainTextNode(view: CanvasViewLike) {
		const canvas = view.canvas;
		if (!canvas?.createTextNode) {
			new Notice("Canvas API: createTextNode недоступен");
			return;
		}

		const center = canvas.posCenter?.() ?? { x: 0, y: 0 };
		const width = 320;
		const height = 120;
		const node = canvas.createTextNode({
			pos: { x: center.x - width / 2, y: center.y - height / 2 },
			size: { width, height },
			text: "Новый текст",
			focus: true,
		});

		if (!node) {
			new Notice("Не удалось создать текст");
			return;
		}

		writeTextStyle(node, { ...DEFAULT_TEXT_STYLE });
		canvas.deselectAll?.();
		canvas.selectOnly?.(node) ?? canvas.select?.(node);

		const leaf = this.getActiveCanvasLeaf();
		if (leaf) {
			window.setTimeout(() => this.syncStylePanelsForLeaf(leaf), 50);
		}
		new Notice("Текст добавлен", 1500);
	}

	private injectToggle(leaf: WorkspaceLeaf) {
		const view = leaf.view as CanvasViewLike;
		const controls =
			view.canvas?.canvasControlsEl ??
			view.containerEl.querySelector<HTMLElement>(".canvas-controls");

		if (!controls) return;
		if (controls.querySelector(`[${BUTTON_ATTR}]`)) {
			this.syncToggleButton(controls.querySelector(`[${BUTTON_ATTR}]`)!);
			return;
		}

		const group = document.createElement("div");
		group.className = "canvas-control-group";
		group.setAttribute(BUTTON_ATTR, "1");

		const button = document.createElement("button");
		button.className = "clickable-icon intuition-canvas-toggle";
		button.type = "button";
		this.syncToggleButton(button);
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			void this.toggleHideImageLabels();
		});

		group.appendChild(button);
		controls.appendChild(group);
	}

	private injectAuraToggle(leaf: WorkspaceLeaf) {
		const view = leaf.view as CanvasViewLike;
		const controls =
			view.canvas?.canvasControlsEl ??
			view.containerEl.querySelector<HTMLElement>(".canvas-controls");

		if (!controls) return;
		if (controls.querySelector(`[${AURA_BTN_ATTR}]`)) {
			this.syncAuraToggleButton(controls.querySelector(`[${AURA_BTN_ATTR}]`)!);
			return;
		}

		const group = document.createElement("div");
		group.className = "canvas-control-group";
		group.setAttribute(AURA_BTN_ATTR, "1");

		const button = document.createElement("button");
		button.className = "clickable-icon intuition-canvas-toggle intuition-canvas-aura-toggle";
		button.type = "button";
		this.syncAuraToggleButton(button);
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			void this.toggleHideAuras();
		});

		group.appendChild(button);
		controls.appendChild(group);
	}

	private injectVibeToggle(leaf: WorkspaceLeaf) {
		const view = leaf.view as CanvasViewLike;
		const controls =
			view.canvas?.canvasControlsEl ??
			view.containerEl.querySelector<HTMLElement>(".canvas-controls");

		if (!controls) return;
		if (controls.querySelector(`[${VIBE_BTN_ATTR}]`)) {
			this.syncVibeToggleButton(controls.querySelector(`[${VIBE_BTN_ATTR}]`)!);
			return;
		}

		const group = document.createElement("div");
		group.className = "canvas-control-group";
		group.setAttribute(VIBE_BTN_ATTR, "1");

		const button = document.createElement("button");
		button.className = "clickable-icon intuition-canvas-toggle intuition-canvas-vibe-toggle";
		button.type = "button";
		this.syncVibeToggleButton(button);
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			void this.toggleVibeMode();
		});

		group.appendChild(button);
		controls.appendChild(group);
	}

	private injectChromeToggle(leaf: WorkspaceLeaf) {
		const view = leaf.view as CanvasViewLike;
		const controls =
			view.canvas?.canvasControlsEl ??
			view.containerEl.querySelector<HTMLElement>(".canvas-controls");

		if (!controls) return;
		if (controls.querySelector(`[${CHROME_BTN_ATTR}]`)) return;

		const group = document.createElement("div");
		group.className = "canvas-control-group";
		group.setAttribute(CHROME_BTN_ATTR, "1");

		const button = document.createElement("button");
		button.className = "clickable-icon intuition-canvas-toggle intuition-canvas-chrome-toggle";
		button.type = "button";
		setIcon(button, "palette");
		setTooltip(button, "Фон и точки канваса", { placement: "left" });
		button.setAttribute("aria-label", "Фон и точки канваса");
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.toggleCanvasPanel(leaf);
		});

		group.appendChild(button);
		controls.appendChild(group);
	}

	private syncAllToggleButtons() {
		document.querySelectorAll(`[${BUTTON_ATTR}]`).forEach((el) => {
			this.syncToggleButton(el);
		});
	}

	private syncAllAuraToggleButtons() {
		document.querySelectorAll(`[${AURA_BTN_ATTR}]`).forEach((el) => {
			this.syncAuraToggleButton(el);
		});
	}

	private syncAllVibeToggleButtons() {
		document.querySelectorAll(`[${VIBE_BTN_ATTR}]`).forEach((el) => {
			this.syncVibeToggleButton(el);
		});
	}

	private syncToggleButton(el: Element) {
		const button =
			el instanceof HTMLButtonElement ? el : el.querySelector("button");
		if (!button) return;

		const hidden = this.settings.hideImageLabels;
		button.classList.toggle("is-active", hidden);
		setIcon(button, hidden ? "eye-off" : "eye");
		setTooltip(button, hidden ? "Показать подписи" : "Скрыть подписи", {
			placement: "left",
		});
		button.setAttribute(
			"aria-label",
			hidden ? "Показать подписи" : "Скрыть подписи",
		);
	}

	private syncAuraToggleButton(el: Element) {
		const button =
			el instanceof HTMLButtonElement ? el : el.querySelector("button");
		if (!button) return;

		const hidden = this.settings.hideAuras;
		button.classList.toggle("is-active", hidden);
		setIcon(button, hidden ? "zap-off" : "sparkles");
		setTooltip(button, hidden ? "Показать ауры" : "Скрыть ауры", {
			placement: "left",
		});
		button.setAttribute(
			"aria-label",
			hidden ? "Показать ауры" : "Скрыть ауры",
		);
	}

	private syncVibeToggleButton(el: Element) {
		const button =
			el instanceof HTMLButtonElement ? el : el.querySelector("button");
		if (!button) return;

		const on = this.settings.vibeMode;
		button.classList.toggle("is-active", on);
		setIcon(button, "wand-2");
		setTooltip(
			button,
			on ? "Выключить вайб-наклон" : "Вайб-режим: наклон у курсора",
			{ placement: "left" },
		);
		button.setAttribute(
			"aria-label",
			on ? "Выключить вайб-наклон" : "Вайб-режим: наклон у курсора",
		);
	}

	// ── Smart image resize via DOM (cursor on handle) ───────────────────
	// More reliable than patching Obsidian internals.

	private installDomResizeHook(leaf: WorkspaceLeaf) {
		const view = leaf.view as CanvasViewLike;
		const root =
			view.canvas?.wrapperEl ??
			view.containerEl.querySelector<HTMLElement>(".canvas-wrapper") ??
			view.containerEl;

		if (root.getAttribute(DOM_HOOK_ATTR) === "1") return;
		root.setAttribute(DOM_HOOK_ATTR, "1");

		this.registerDomEvent(root, "pointerdown", (event: PointerEvent) => {
			this.onCanvasPointerDown(view, event);
		});
	}

	private onCanvasPointerDown(view: CanvasViewLike, event: PointerEvent) {
		if (this.aspectResizeActive) return;

		const cursorInfo = this.findResizeCursor(event);
		if (!cursorInfo) return;

		const node = this.getSelectedImageNode(view);
		if (!node || node.width <= 0 || node.height <= 0) return;

		console.log(
			"[intuition-canvas] resize start:",
			cursorInfo.kind,
			cursorInfo.cursor,
			node.file?.path ?? node.filePath ?? node.id,
		);

		if (cursorInfo.kind === "side-h") {
			this.startSideFreeStretch(node, "horizontal");
		} else if (cursorInfo.kind === "side-v") {
			this.startSideFreeStretch(node, "vertical");
		} else {
			this.startCornerAspectLock(node, cursorInfo.cursor);
		}
	}

	private findResizeCursor(
		event: PointerEvent,
	): { kind: "side-h" | "side-v" | "corner"; cursor: string } | null {
		let el: HTMLElement | null = event.target as HTMLElement | null;
		for (let i = 0; i < 6 && el; i++) {
			const cursor = window.getComputedStyle(el).cursor.toLowerCase();
			const kind = this.classifyCursor(cursor);
			if (kind) return { kind, cursor };

			const cls = el.className?.toString?.().toLowerCase?.() ?? "";
			if (/resiz/.test(cls)) {
				// Handle without useful cursor — classify by class name hints
				if (/left|right|e-|w-|east|west/.test(cls) && !/top|bottom|n-|s-/.test(cls)) {
					return { kind: "side-h", cursor: cls };
				}
				if (/top|bottom|n-|s-|north|south/.test(cls) && !/left|right|e-|w-/.test(cls)) {
					return { kind: "side-v", cursor: cls };
				}
				if (/corner|nw|ne|sw|se/.test(cls)) {
					return { kind: "corner", cursor: cls };
				}
			}
			el = el.parentElement;
		}

		// Fallback: hit-test against selected node edges near the pointer
		return null;
	}

	private classifyCursor(
		cursor: string,
	): "side-h" | "side-v" | "corner" | null {
		if (!cursor || cursor === "auto" || cursor === "default") return null;

		if (
			cursor === "ew-resize" ||
			cursor === "e-resize" ||
			cursor === "w-resize" ||
			cursor === "col-resize"
		) {
			return "side-h";
		}
		if (
			cursor === "ns-resize" ||
			cursor === "n-resize" ||
			cursor === "s-resize" ||
			cursor === "row-resize"
		) {
			return "side-v";
		}
		if (
			cursor === "nwse-resize" ||
			cursor === "nesw-resize" ||
			cursor === "nw-resize" ||
			cursor === "ne-resize" ||
			cursor === "sw-resize" ||
			cursor === "se-resize"
		) {
			return "corner";
		}
		if (cursor.includes("resize")) {
			// Unknown resize cursor — treat as corner (aspect lock)
			return "corner";
		}
		return null;
	}

	private getSelectedImageNodes(view: CanvasViewLike): ImageNodeLike[] {
		const canvas = view.canvas;
		if (!canvas?.nodes) return [];

		const out: ImageNodeLike[] = [];
		const seen = new Set<string>();

		const push = (node: CanvasNodeLike) => {
			if (!this.isImageNode(node) || seen.has(node.id)) return;
			seen.add(node.id);
			out.push(node as ImageNodeLike);
		};

		if (canvas.selection) {
			for (const item of canvas.selection) push(item);
		}

		if (out.length === 0) {
			for (const node of canvas.nodes.values()) {
				if (node.nodeEl?.classList.contains("is-selected")) push(node);
			}
		}

		return out;
	}

	private getSelectedImageNode(view: CanvasViewLike): CanvasNodeLike | null {
		return (this.getSelectedImageNodes(view)[0] as CanvasNodeLike | undefined) ?? null;
	}

	private isImageNode(node: CanvasNodeLike): boolean {
		return isImageNode(node as ImageNodeLike);
	}

	private startSideFreeStretch(
		node: CanvasNodeLike,
		axis: "horizontal" | "vertical",
	) {
		if (this.aspectResizeActive) return;
		this.aspectResizeActive = true;

		const start = {
			x: node.x,
			y: node.y,
			w: node.width,
			h: node.height,
		};

		const enforce = () => {
			if (axis === "horizontal") {
				node.height = start.h;
				node.y = start.y;
			} else {
				node.width = start.w;
				node.x = start.x;
			}
			node.render?.();
		};

		let raf = 0;
		const tick = () => {
			enforce();
			raf = window.requestAnimationFrame(tick);
		};
		raf = window.requestAnimationFrame(tick);

		const onMove = () => enforce();
		window.addEventListener("pointermove", onMove);

		const stop = () => {
			window.cancelAnimationFrame(raf);
			window.removeEventListener("pointermove", onMove);
			enforce();
			this.aspectResizeActive = false;
			window.removeEventListener("pointerup", stop);
			window.removeEventListener("pointercancel", stop);
			node.canvas?.requestSave?.();
		};

		window.addEventListener("pointerup", stop);
		window.addEventListener("pointercancel", stop);
	}

	private startCornerAspectLock(node: CanvasNodeLike, _cursorHint: string) {
		if (this.aspectResizeActive) return;
		this.aspectResizeActive = true;

		const start = {
			x: node.x,
			y: node.y,
			w: node.width,
			h: node.height,
		};
		const ratio = start.w / start.h;

		const tickApply = () => {
			const leftMoved = Math.abs(node.x - start.x) > 1;
			const topMoved = Math.abs(node.y - start.y) > 1;
			this.applyAspectLock(node, start, ratio, leftMoved, topMoved);
		};

		let raf = 0;
		const tick = () => {
			tickApply();
			raf = window.requestAnimationFrame(tick);
		};
		raf = window.requestAnimationFrame(tick);

		const onMove = () => tickApply();
		window.addEventListener("pointermove", onMove);

		const stop = () => {
			window.cancelAnimationFrame(raf);
			window.removeEventListener("pointermove", onMove);
			tickApply();
			this.aspectResizeActive = false;
			window.removeEventListener("pointerup", stop);
			window.removeEventListener("pointercancel", stop);
			node.canvas?.requestSave?.();
		};

		window.addEventListener("pointerup", stop);
		window.addEventListener("pointercancel", stop);
	}

	private applyAspectLock(
		node: CanvasNodeLike,
		start: { x: number; y: number; w: number; h: number },
		ratio: number,
		movesLeft: boolean,
		movesTop: boolean,
	) {
		const rightEdge = movesLeft ? start.x + start.w : node.x + node.width;
		const bottomEdge = movesTop ? start.y + start.h : node.y + node.height;

		const heightFromWidth = node.width / ratio;
		const widthFromHeight = node.height * ratio;
		const widthIsPrimary =
			Math.abs(heightFromWidth - node.height) <=
			Math.abs(widthFromHeight - node.width);

		let width: number;
		let height: number;
		if (widthIsPrimary) {
			width = Math.max(20, node.width);
			height = width / ratio;
		} else {
			height = Math.max(20, node.height);
			width = height * ratio;
		}

		node.x = movesLeft ? rightEdge - width : start.x;
		node.y = movesTop ? bottomEdge - height : start.y;
		node.width = width;
		node.height = height;
		node.render?.();
	}
}

function readElementScale(el: HTMLElement): number {
	const t = getComputedStyle(el).transform;
	if (!t || t === "none") return 0;
	const m2 = t.match(/matrix3d\(([^)]+)\)/);
	if (m2) {
		const a = Number.parseFloat(m2[1].split(",")[0] ?? "");
		if (Number.isFinite(a) && Math.abs(a) > 0.001) return Math.abs(a);
	}
	const m = t.match(/matrix\(([^)]+)\)/);
	if (!m) return 0;
	const a = Number.parseFloat(m[1].split(",")[0] ?? "");
	if (!Number.isFinite(a) || Math.abs(a) <= 0.001) return 0;
	return Math.abs(a);
}
