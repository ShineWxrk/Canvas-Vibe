import {
	Notice,
	Plugin,
	WorkspaceLeaf,
	TFile,
	type View,
} from "obsidian";
import { ImageStylePanel } from "./ImageStylePanel";
import { TextStylePanel } from "./TextStylePanel";
import { CanvasStylePanel } from "./CanvasStylePanel";
import { VibePanel } from "./VibePanel";
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
	VibeSparkleController,
	normalizeSparkleConfig,
	type VibeSparkleConfig,
} from "./vibeSparkles";
import { FpsOverlay } from "./fpsOverlay";
import { StickyAudioPlayer } from "./stickyAudioPlayer";
import { PhotoPresentation, type PresentationSlide } from "./photoPresentation";
import {
	normalizePresentationSettings,
	type PresentationSettings,
} from "./presentationSettings";
import {
	aspectFromImageNode,
	boundingBox,
	clampCollageCount,
	clampCollageGap,
	layoutExactRows,
	layoutMasonry,
	normalizeCollagePackAxis,
	sortNodesReadingOrder,
} from "./collageLayout";
import {
	DEFAULT_GLOBAL_AURA,
	DEFAULT_SETTINGS,
	clampPercent,
	migrateSettings,
	normalizeGlobalAura,
	type GlobalAuraSettings,
	type IntuitionCanvasSettings,
} from "./settings";
import { canvasRoot, createDebouncedSave, leafId } from "./pluginUtils";
import {
	FAR_ZOOM_CLASS,
	PANNING_CLASS,
	ZOOM_SETTLING_CLASS,
	ZoomPanFxController,
} from "./zoomPanFx";
import {
	injectCardMenuButton,
	injectControlButton,
	syncControlButton,
} from "./toolbarToggles";
import {
	DOM_HOOK_ATTR,
	ImageResizeController,
} from "./imageResize";
import { ImageSwapController } from "./imageSwap";

const CANVAS_VIEW_TYPE = "canvas";
const BUTTON_ATTR = "data-intuition-canvas-labels-toggle";
const AURA_BTN_ATTR = "data-intuition-canvas-aura-toggle";
const VIBE_BTN_ATTR = "data-intuition-canvas-vibe-toggle";
const CHROME_BTN_ATTR = "data-intuition-canvas-chrome-toggle";
const TEXT_BTN_ATTR = "data-intuition-canvas-add-text";
const COLLAGE_BTN_ATTR = "data-intuition-canvas-collage";
const SWAP_BTN_ATTR = "data-intuition-canvas-swap";
const HIDE_CLASS = "intuition-canvas-hide-image-labels";
const HIDE_AURAS_CLASS = "intuition-canvas-hide-auras";
const TEXT_HOOK_ATTR = "data-intuition-canvas-text-hook";

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
	private textPanels = new Map<string, TextStylePanel>();
	private imagePanels = new Map<string, ImageStylePanel>();
	private vibeControllers = new Map<string, VibeTiltController>();
	private vibeSparkles = new Map<string, VibeSparkleController>();
	private vibePanels = new Map<string, VibePanel>();
	private canvasPanels = new Map<string, CanvasStylePanel>();
	private fpsOverlays = new Map<string, FpsOverlay>();
	private stickyAudioPlayers = new Map<string, StickyAudioPlayer>();
	private photoPresentations = new Map<string, PhotoPresentation>();
	private vibeSettingsSave = createDebouncedSave(() => this.saveSettings());
	private chromeSettingsSave = createDebouncedSave(() => this.saveSettings());
	private collageSettingsSave = createDebouncedSave(() => this.saveSettings());
	private presentationSettingsSave = createDebouncedSave(
		() => this.saveSettings(),
	);
	private workspaceRefreshTimer = 0;
	private zoomFx = new ZoomPanFxController({
		registerDomEvent: this.registerDomEvent.bind(this),
		getSparkles: (id) => this.vibeSparkles.get(id),
		getTilt: (id) => this.vibeControllers.get(id),
	});
	private imageResize = new ImageResizeController({
		registerDomEvent: this.registerDomEvent.bind(this),
	});
	private imageSwap = new ImageSwapController({
		registerDomEvent: this.registerDomEvent.bind(this),
		isResizeActive: () => this.imageResize.isActive,
	});

	async onload() {
		await this.loadSettings();
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
			id: "swap-selected-images",
			name: "Swap two selected images",
			checkCallback: (checking) => {
				const leaf = this.getActiveCanvasLeaf();
				if (!leaf) return false;
				const images = this.getSelectedImageNodes(
					leaf.view as CanvasViewLike,
				);
				if (checking) return images.length === 2;
				return this.imageSwap.swapTwoSelected(
					leaf.view as CanvasViewLike,
				);
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
					leafId(leaf);
				const active = this.photoPresentations.get(id)?.isActive();
				if (checking) return !!active;
				this.photoPresentations.get(id)?.stop();
				return true;
			},
		});
	}

	onunload() {
		this.zoomFx.destroy();
		for (const panel of this.textPanels.values()) panel.el.remove();
		this.textPanels.clear();
		for (const panel of this.imagePanels.values()) panel.el.remove();
		this.imagePanels.clear();
		for (const vibe of this.vibeControllers.values()) vibe.destroy();
		this.vibeControllers.clear();
		for (const sparkles of this.vibeSparkles.values()) sparkles.destroy();
		this.vibeSparkles.clear();
		for (const panel of this.vibePanels.values()) panel.destroy();
		this.vibePanels.clear();
		for (const panel of this.canvasPanels.values()) panel.el.remove();
		this.canvasPanels.clear();
		for (const fps of this.fpsOverlays.values()) fps.destroy();
		this.fpsOverlays.clear();
		for (const player of this.stickyAudioPlayers.values()) player.destroy();
		this.stickyAudioPlayers.clear();
		for (const present of this.photoPresentations.values()) present.destroy();
		this.photoPresentations.clear();
		this.vibeSettingsSave.cancel();
		this.chromeSettingsSave.cancel();
		this.collageSettingsSave.cancel();
		this.presentationSettingsSave.cancel();
		if (this.workspaceRefreshTimer) window.clearTimeout(this.workspaceRefreshTimer);
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
		document
			.querySelectorAll("[data-intuition-vibe-panel]")
			.forEach((el) => el.remove());
		document
			.querySelectorAll("[data-intuition-collage-panel]")
			.forEach((el) => el.remove());
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
		document.querySelectorAll(`[${SWAP_BTN_ATTR}]`).forEach((el) => el.remove());
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

	async loadSettings() {
		const { settings, migrated } = migrateSettings(await this.loadData());
		this.settings = settings;
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
			const id = leafId(leaf);
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
		return clampPercent(value, DEFAULT_SETTINGS.vibeStrength);
	}

	private clampVibeTextStrength(value: number) {
		return clampPercent(value, DEFAULT_SETTINGS.vibeTextStrength);
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
		this.vibeSettingsSave.schedule();
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
			this.injectSwapButton(leaf);
			this.imageResize.install(leaf);
			this.imageSwap.install(leaf);
			this.ensureTextPanel(leaf);
			this.ensureImagePanel(leaf);
			this.ensureCanvasPanel(leaf);
			this.installTextSelectionHook(leaf);
			this.ensureVibeStrengthPanel(leaf);
			this.ensureVibeController(leaf);
			this.ensureFpsOverlay(leaf);
			this.ensureStickyAudioPlayer(leaf);
			this.zoomFx.install(leaf);
		}
		this.applyVibeMode();
		this.applyAllCanvasChrome();
	}

	private ensureFpsOverlay(leaf: WorkspaceLeaf) {
		const id = leafId(leaf);
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
		fps.setZoomProvider(() => this.zoomFx.readZoom(view));
		fps.attach(host);
	}

	/** Sticky mini-player: keeps audio alive when the Canvas node leaves the viewport. */
	private ensureStickyAudioPlayer(leaf: WorkspaceLeaf) {
		const id = leafId(leaf);
		const view = leaf.view as CanvasViewLike;
		const host =
			view.containerEl.querySelector<HTMLElement>(".view-content") ??
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
		player.attach(host, canvasRoot(view));
	}

	private ensureVibeController(leaf: WorkspaceLeaf) {
		const id = leafId(leaf);
		const view = leaf.view as CanvasViewLike;
		const root = canvasRoot(view);

		const suspendOpts = {
			getSuspended: () =>
				this.imageResize.isActive || this.imageSwap.isActive,
			getSelectionCount: () => {
				const sel = view.canvas?.selection;
				if (sel) return sel.size;
				return view.containerEl.querySelectorAll(".canvas-node.is-selected")
					.length;
			},
			getZoom: () => this.zoomFx.readZoom(view),
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

	private vibePanelCallbacks(): ConstructorParameters<typeof VibePanel>[1] {
		return {
			getVibeStrength: () => this.clampVibeStrength(this.settings.vibeStrength),
			getVibeTextStrength: () =>
				this.clampVibeTextStrength(this.settings.vibeTextStrength),
			getSparkles: () => normalizeSparkleConfig(this.settings.vibeSparkles),
			getAura: () => normalizeGlobalAura(this.settings.globalAura),
			getSections: () => this.settings.vibePanelSections ?? {},
			onStrength: (n) => this.setVibeStrength(n, true),
			onTextStrength: (n) => this.setVibeTextStrength(n, true),
			onSparkles: (partial) => this.patchVibeSparkles(partial, true),
			onResetSparkles: () => this.resetVibeSparkles(),
			onAura: (partial) => this.patchGlobalAura(partial, true),
			onApplyAuraAll: () => this.applyGlobalAuraToAllImages(),
			onResetAura: () => this.resetGlobalAura(),
			onSectionToggle: (key, open) => {
				this.settings.vibePanelSections = {
					...(this.settings.vibePanelSections ?? {}),
					[key]: open,
				};
				this.queueVibeSettingsSave();
			},
		};
	}

	private ensureVibeStrengthPanel(leaf: WorkspaceLeaf) {
		const id = leafId(leaf);
		const view = leaf.view as CanvasViewLike;
		const host =
			view.containerEl.querySelector<HTMLElement>(".view-content") ??
			view.containerEl;

		const existing = this.vibePanels.get(id);
		if (existing) {
			existing.reattach(host);
			existing.setVisible(this.settings.vibeMode);
			return;
		}

		const panel = new VibePanel(host, this.vibePanelCallbacks());
		panel.setVisible(this.settings.vibeMode);
		this.vibePanels.set(id, panel);
	}

	private syncVibeStrengthPanel(leaf: WorkspaceLeaf, visible: boolean) {
		const id = leafId(leaf);
		let panel = this.vibePanels.get(id);
		if (!panel || !panel.el.isConnected) {
			this.ensureVibeStrengthPanel(leaf);
			panel = this.vibePanels.get(id);
		}
		if (!panel) return;
		panel.sync({
			visible,
			strength: this.clampVibeStrength(this.settings.vibeStrength),
			textStrength: this.clampVibeTextStrength(this.settings.vibeTextStrength),
			sparkles: normalizeSparkleConfig(this.settings.vibeSparkles),
			aura: normalizeGlobalAura(this.settings.globalAura),
		});
	}

	private syncAllVibeStrengthSliders() {
		const strength = this.clampVibeStrength(this.settings.vibeStrength);
		for (const panel of this.vibePanels.values()) {
			panel.syncStrength(strength);
		}
	}

	private syncAllVibeTextStrengthSliders() {
		const textStrength = this.clampVibeTextStrength(this.settings.vibeTextStrength);
		for (const panel of this.vibePanels.values()) {
			panel.syncTextStrength(textStrength);
		}
	}

	private syncVibeSparkleControls() {
		const cfg = normalizeSparkleConfig(this.settings.vibeSparkles);
		for (const panel of this.vibePanels.values()) {
			panel.syncSparkles(cfg);
		}
	}

	private syncGlobalAuraControls() {
		const g = normalizeGlobalAura(this.settings.globalAura);
		for (const panel of this.vibePanels.values()) {
			panel.syncAura(g);
		}
	}

	private ensureTextPanel(leaf: WorkspaceLeaf) {
		const id = leafId(leaf);
		if (this.textPanels.has(id)) return;

		const view = leaf.view as CanvasViewLike;
		const host =
			view.containerEl.querySelector<HTMLElement>(".view-content") ??
			view.containerEl;
		const panel = new TextStylePanel(host);
		this.textPanels.set(id, panel);
	}

	private ensureImagePanel(leaf: WorkspaceLeaf) {
		const id = leafId(leaf);
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
		const id = leafId(leaf);
		if (this.canvasPanels.has(id)) return;

		const view = leaf.view as CanvasViewLike;
		const host =
			view.containerEl.querySelector<HTMLElement>(".view-content") ??
			view.containerEl;
		const panel = new CanvasStylePanel(host);
		this.canvasPanels.set(id, panel);
	}

	private toggleCanvasPanel(leaf: WorkspaceLeaf) {
		const id = leafId(leaf);
		this.ensureCanvasPanel(leaf);
		const panel = this.canvasPanels.get(id);
		if (!panel) return;

		const view = leaf.view as CanvasViewLike;
		const root = canvasRoot(view);
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
		this.chromeSettingsSave.schedule();
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
		const root = canvasRoot(view);
		const path = view.file?.path ?? "";
		const stored =
			!!this.readChromeFromCanvas(view) ||
			!!(path && this.settings.canvasChrome[path]);
		applyCanvasChrome(root, style, stored);
	}

	private installTextSelectionHook(leaf: WorkspaceLeaf) {
		const view = leaf.view as CanvasViewLike;
		const root = canvasRoot(view);

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
		const id = leafId(leaf);
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
		injectCardMenuButton(menu, {
			attr: TEXT_BTN_ATTR,
			ariaLabel: "Текст без карточки",
			iconName: "type",
			onClick: () => this.addPlainTextNode(view),
		});
	}

	private injectCollageButton(leaf: WorkspaceLeaf) {
		const view = leaf.view as CanvasViewLike;
		const controls =
			view.canvas?.canvasControlsEl ??
			view.containerEl.querySelector<HTMLElement>(".canvas-controls");
		if (!controls) return;

		injectControlButton(controls, {
			attr: COLLAGE_BTN_ATTR,
			sync: (button) => this.syncCollageButton(leaf, button),
			onClick: () => this.arrangeSelectedImagesCollage(view),
		});
	}

	private injectSwapButton(leaf: WorkspaceLeaf) {
		const view = leaf.view as CanvasViewLike;
		const controls =
			view.canvas?.canvasControlsEl ??
			view.containerEl.querySelector<HTMLElement>(".canvas-controls");
		if (!controls) return;

		injectControlButton(controls, {
			attr: SWAP_BTN_ATTR,
			sync: (button) => {
				syncControlButton(button, {
					title: "Поменять две фото местами (или Alt+drag)",
					iconName: "arrow-left-right",
				});
			},
			onClick: () => {
				if (this.imageSwap.swapTwoSelected(view)) return;
				new Notice("Выдели ровно 2 фотографии", 1600);
			},
		});
	}

	private syncCollageButton(
		_leaf: WorkspaceLeaf,
		button: HTMLButtonElement | null,
	) {
		if (!button) return;
		const gap = clampCollageGap(this.settings.collageGap);
		const count = clampCollageCount(this.settings.collageCount);
		const axis = normalizeCollagePackAxis(this.settings.collagePackAxis);
		const axisLabel = axis === "rows" ? "строк" : "столбцов";
		syncControlButton(button, {
			title: `Коллаж · ${gap}px · ${count} ${axisLabel}`,
			iconName: "layout-grid",
		});
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
			this.imagePanels.get(leafId(leaf))?.syncCollageFromHooks();
		}
	}

	private queueCollageSettingsSave() {
		this.collageSettingsSave.schedule();
	}

	private queuePresentationSettingsSave() {
		this.presentationSettingsSave.schedule();
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
		const id = leafId(leaf);
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

		injectControlButton(controls, {
			attr: BUTTON_ATTR,
			sync: (button) => this.syncToggleButton(button),
			onClick: () => void this.toggleHideImageLabels(),
		});
	}

	private injectAuraToggle(leaf: WorkspaceLeaf) {
		const view = leaf.view as CanvasViewLike;
		const controls =
			view.canvas?.canvasControlsEl ??
			view.containerEl.querySelector<HTMLElement>(".canvas-controls");
		if (!controls) return;

		injectControlButton(controls, {
			attr: AURA_BTN_ATTR,
			buttonClass:
				"clickable-icon intuition-canvas-toggle intuition-canvas-aura-toggle",
			sync: (button) => this.syncAuraToggleButton(button),
			onClick: () => void this.toggleHideAuras(),
		});
	}

	private injectVibeToggle(leaf: WorkspaceLeaf) {
		const view = leaf.view as CanvasViewLike;
		const controls =
			view.canvas?.canvasControlsEl ??
			view.containerEl.querySelector<HTMLElement>(".canvas-controls");
		if (!controls) return;

		injectControlButton(controls, {
			attr: VIBE_BTN_ATTR,
			buttonClass:
				"clickable-icon intuition-canvas-toggle intuition-canvas-vibe-toggle",
			sync: (button) => this.syncVibeToggleButton(button),
			onClick: () => void this.toggleVibeMode(),
		});
	}

	private injectChromeToggle(leaf: WorkspaceLeaf) {
		const view = leaf.view as CanvasViewLike;
		const controls =
			view.canvas?.canvasControlsEl ??
			view.containerEl.querySelector<HTMLElement>(".canvas-controls");
		if (!controls) return;

		injectControlButton(controls, {
			attr: CHROME_BTN_ATTR,
			buttonClass:
				"clickable-icon intuition-canvas-toggle intuition-canvas-chrome-toggle",
			sync: (button) =>
				syncControlButton(button, {
					title: "Фон и точки канваса",
					iconName: "palette",
				}),
			onClick: () => this.toggleCanvasPanel(leaf),
		});
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
		const hidden = this.settings.hideImageLabels;
		syncControlButton(el, {
			active: hidden,
			title: hidden ? "Показать подписи" : "Скрыть подписи",
			iconName: hidden ? "eye-off" : "eye",
		});
	}

	private syncAuraToggleButton(el: Element) {
		const hidden = this.settings.hideAuras;
		syncControlButton(el, {
			active: hidden,
			title: hidden ? "Показать ауры" : "Скрыть ауры",
			iconName: hidden ? "zap-off" : "sparkles",
		});
	}

	private syncVibeToggleButton(el: Element) {
		const on = this.settings.vibeMode;
		syncControlButton(el, {
			active: on,
			title: on
				? "Выключить вайб-наклон"
				: "Вайб-режим: наклон у курсора",
			iconName: "wand-2",
		});
	}

	private getSelectedImageNodes(view: CanvasViewLike): ImageNodeLike[] {
		return this.imageResize.getSelectedImageNodes(view);
	}
}
