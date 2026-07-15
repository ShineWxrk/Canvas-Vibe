import { Notice, setIcon } from "obsidian";
import {
	BORDER_STYLE_OPTIONS,
	DEFAULT_IMAGE_STYLE,
	clearImageStyle,
	type ImageBorderStyle,
	type ImageNodeLike,
	type IntuitionImageStyle,
	readImageStyle,
	writeImageStyle,
} from "./imageStyles";
import {
	clampCollageFixedSize,
	clampCollageGap,
	COLLAGE_FIXED_SIZE_MAX,
	COLLAGE_FIXED_SIZE_MIN,
	COLLAGE_GAP_MAX,
	COLLAGE_GAP_SLIDER_MAX,
	normalizeCollageFixedAxis,
	normalizeCollageSizeMode,
	restoreNaturalAspectPreservingArea,
	type CollageFixedAxis,
	type CollageSizeMode,
} from "./collageLayout";
import {
	copyImageFormat,
	getCopiedImageFormat,
	hasImageFormat,
	peekStyleClipboard,
} from "./styleClipboard";

/** UI shows transparency % (0 = opaque, 100 = invisible). Stored style uses opacity. */
function toTransparency(opacity: number): number {
	return Math.min(100, Math.max(0, 100 - opacity));
}

function toOpacity(transparency: number): number {
	return Math.min(100, Math.max(0, 100 - transparency));
}

export type ImageStylePanelCollageHooks = {
	getGap: () => number;
	onGapChange: (gap: number) => void;
	getSizeMode: () => CollageSizeMode;
	onSizeModeChange: (mode: CollageSizeMode) => void;
	getFixedAxis: () => CollageFixedAxis;
	onFixedAxisChange: (axis: CollageFixedAxis) => void;
	getFixedSize: () => number;
	onFixedSizeChange: (size: number) => void;
	onArrange: () => void;
};

export class ImageStylePanel {
	readonly el: HTMLElement;
	private nodes: ImageNodeLike[] = [];
	private style: IntuitionImageStyle = { ...DEFAULT_IMAGE_STYLE };
	private titleEl: HTMLElement;
	private pasteBtn: HTMLButtonElement;
	private collageSection: HTMLElement;
	private collageGap: HTMLInputElement;
	private collageGapPx: HTMLInputElement;
	private collageMode: HTMLSelectElement;
	private collageFixedBlock: HTMLElement;
	private collageAxis: HTMLSelectElement;
	private collageFixedSize: HTMLInputElement;
	private collageFixedSizeSlider: HTMLInputElement;
	private collageHooks: ImageStylePanelCollageHooks | null = null;
	private inputs: {
		transparency: HTMLInputElement;
		transparencyValue: HTMLElement;
		borderColor: HTMLInputElement;
		borderWidth: HTMLInputElement;
		borderWidthValue: HTMLElement;
		borderRadius: HTMLInputElement;
		borderRadiusValue: HTMLElement;
		borderStyle: HTMLSelectElement;
		aura: HTMLInputElement;
		auraShimmer: HTMLInputElement;
		auraStrength: HTMLInputElement;
		auraStrengthValue: HTMLElement;
		auraSize: HTMLInputElement;
		auraSizeValue: HTMLElement;
		auraColor: HTMLInputElement;
		vibeTilt: HTMLInputElement;
		vibeTiltStrength: HTMLInputElement;
		vibeTiltStrengthValue: HTMLElement;
	};

	constructor(parent: HTMLElement) {
		this.el = parent.createDiv({ cls: "intuition-image-panel" });
		this.el.setAttribute("data-intuition-image-panel", "1");
		this.el.hide();

		const header = this.el.createDiv({ cls: "intuition-panel__header" });
		this.titleEl = header.createSpan({ text: "Картинка" });
		const closeBtn = header.createEl("button", {
			cls: "clickable-icon intuition-panel__close",
			attr: { "aria-label": "Закрыть" },
		});
		setIcon(closeBtn, "x");
		closeBtn.addEventListener("click", () => this.hide());

		const body = this.el.createDiv({ cls: "intuition-panel__body" });

		const opacityRow = body.createDiv({ cls: "intuition-panel__row" });
		opacityRow.createSpan({
			text: "Прозрачность",
			cls: "intuition-panel__label",
		});
		const opacityWrap = opacityRow.createDiv({ cls: "intuition-panel__size" });
		const transparency = opacityWrap.createEl("input", {
			type: "range",
			attr: { min: "0", max: "100", step: "1" },
		});
		const transparencyValue = opacityWrap.createSpan({
			cls: "intuition-panel__value",
		});

		const colorRow = body.createDiv({ cls: "intuition-panel__row" });
		colorRow.createSpan({
			text: "Цвет обводки",
			cls: "intuition-panel__label",
		});
		const borderColor = colorRow.createEl("input", {
			type: "color",
			cls: "intuition-panel__color",
		});

		const widthRow = body.createDiv({ cls: "intuition-panel__row" });
		widthRow.createSpan({
			text: "Ширина",
			cls: "intuition-panel__label",
		});
		const widthWrap = widthRow.createDiv({ cls: "intuition-panel__size" });
		const borderWidth = widthWrap.createEl("input", {
			type: "range",
			attr: { min: "0", max: "24", step: "1" },
		});
		const borderWidthValue = widthWrap.createSpan({
			cls: "intuition-panel__value",
		});

		const radiusRow = body.createDiv({ cls: "intuition-panel__row" });
		radiusRow.createSpan({
			text: "Скругление",
			cls: "intuition-panel__label",
		});
		const radiusWrap = radiusRow.createDiv({ cls: "intuition-panel__size" });
		const borderRadius = radiusWrap.createEl("input", {
			type: "range",
			attr: { min: "0", max: "64", step: "1" },
		});
		const borderRadiusValue = radiusWrap.createSpan({
			cls: "intuition-panel__value",
		});

		const styleRow = body.createDiv({ cls: "intuition-panel__row" });
		styleRow.createSpan({
			text: "Стиль",
			cls: "intuition-panel__label",
		});
		const borderStyle = styleRow.createEl("select", {
			cls: "dropdown intuition-panel__select",
		});
		for (const opt of BORDER_STYLE_OPTIONS) {
			borderStyle.createEl("option", { text: opt.label, value: opt.value });
		}

		const auraRow = body.createDiv({ cls: "intuition-panel__row" });
		auraRow.createSpan({ text: "Аура", cls: "intuition-panel__label" });
		const auraLabel = auraRow.createEl("label", {
			cls: "intuition-text-panel__toggle",
		});
		const aura = auraLabel.createEl("input", { type: "checkbox" });
		auraLabel.createSpan({ cls: "intuition-text-panel__toggle-ui" });

		const shimmerRow = body.createDiv({ cls: "intuition-panel__row" });
		shimmerRow.createSpan({ text: "Перелив", cls: "intuition-panel__label" });
		const shimmerLabel = shimmerRow.createEl("label", {
			cls: "intuition-text-panel__toggle",
		});
		const auraShimmer = shimmerLabel.createEl("input", { type: "checkbox" });
		shimmerLabel.createSpan({ cls: "intuition-text-panel__toggle-ui" });

		const auraStrengthRow = body.createDiv({ cls: "intuition-panel__row" });
		auraStrengthRow.createSpan({
			text: "Сила ауры",
			cls: "intuition-panel__label",
		});
		const auraStrengthWrap = auraStrengthRow.createDiv({
			cls: "intuition-panel__size",
		});
		const auraStrength = auraStrengthWrap.createEl("input", {
			type: "range",
			attr: { min: "0", max: "100", step: "1" },
		});
		const auraStrengthValue = auraStrengthWrap.createSpan({
			cls: "intuition-panel__value",
		});

		const auraSizeRow = body.createDiv({ cls: "intuition-panel__row" });
		auraSizeRow.createSpan({
			text: "Площадь",
			cls: "intuition-panel__label",
		});
		const auraSizeWrap = auraSizeRow.createDiv({
			cls: "intuition-panel__size",
		});
		const auraSize = auraSizeWrap.createEl("input", {
			type: "range",
			attr: { min: "0", max: "200", step: "5" },
		});
		const auraSizeValue = auraSizeWrap.createSpan({
			cls: "intuition-panel__value",
		});

		const auraColorRow = body.createDiv({ cls: "intuition-panel__row" });
		auraColorRow.createSpan({
			text: "Цвет ауры",
			cls: "intuition-panel__label",
		});
		const auraColor = auraColorRow.createEl("input", {
			type: "color",
			cls: "intuition-panel__color",
			attr: { title: "Авто из картинки, можно переопределить" },
		});

		const tiltRow = body.createDiv({ cls: "intuition-panel__row" });
		tiltRow.createSpan({ text: "Наклон", cls: "intuition-panel__label" });
		const tiltLabel = tiltRow.createEl("label", {
			cls: "intuition-text-panel__toggle",
		});
		const vibeTilt = tiltLabel.createEl("input", { type: "checkbox" });
		tiltLabel.createSpan({ cls: "intuition-text-panel__toggle-ui" });

		const tiltStrengthRow = body.createDiv({ cls: "intuition-panel__row" });
		tiltStrengthRow.createSpan({
			text: "Сила наклона",
			cls: "intuition-panel__label",
		});
		const tiltStrengthWrap = tiltStrengthRow.createDiv({
			cls: "intuition-panel__size",
		});
		const vibeTiltStrength = tiltStrengthWrap.createEl("input", {
			type: "range",
			attr: {
				min: "0",
				max: "100",
				step: "1",
				"aria-label": "Сила наклона картинки",
			},
		});
		const vibeTiltStrengthValue = tiltStrengthWrap.createSpan({
			cls: "intuition-panel__value",
		});

		this.inputs = {
			transparency,
			transparencyValue,
			borderColor,
			borderWidth,
			borderWidthValue,
			borderRadius,
			borderRadiusValue,
			borderStyle,
			aura,
			auraShimmer,
			auraStrength,
			auraStrengthValue,
			auraSize,
			auraSizeValue,
			auraColor,
			vibeTilt,
			vibeTiltStrength,
			vibeTiltStrengthValue,
		};

		transparency.addEventListener("input", () => {
			const value = Number(transparency.value);
			transparencyValue.setText(`${value}%`);
			this.commit({ opacity: toOpacity(value) });
		});
		borderColor.addEventListener("input", () =>
			this.commit({ borderColor: borderColor.value }),
		);
		borderWidth.addEventListener("input", () => {
			const value = Number(borderWidth.value);
			borderWidthValue.setText(`${value}px`);
			this.commit({ borderWidth: value });
		});
		borderRadius.addEventListener("input", () => {
			const value = Number(borderRadius.value);
			borderRadiusValue.setText(`${value}px`);
			this.commit({ borderRadius: value });
		});
		borderStyle.addEventListener("change", () =>
			this.commit({
				borderStyle: borderStyle.value as ImageBorderStyle,
			}),
		);
		aura.addEventListener("change", () => {
			const next: Partial<IntuitionImageStyle> = { aura: aura.checked };
			if (aura.checked) {
				next.auraColor = "";
				next.auraPalette = [];
			}
			this.commit(next);
		});
		auraShimmer.addEventListener("change", () =>
			this.commit({ auraShimmer: auraShimmer.checked }),
		);
		auraStrength.addEventListener("input", () => {
			const value = Number(auraStrength.value);
			auraStrengthValue.setText(`${value}%`);
			this.commit({ auraStrength: value });
		});
		auraSize.addEventListener("input", () => {
			const value = Number(auraSize.value);
			auraSizeValue.setText(`${value}%`);
			this.commit({ auraSize: value });
		});
		auraColor.addEventListener("input", () =>
			this.commit({ auraColor: auraColor.value, auraPalette: [] }),
		);
		vibeTilt.addEventListener("change", () =>
			this.commit({ vibeTilt: vibeTilt.checked }),
		);
		vibeTiltStrength.addEventListener("input", () => {
			const value = Number(vibeTiltStrength.value);
			vibeTiltStrengthValue.setText(`${value}%`);
			this.commit({ vibeTiltStrength: value });
		});

		this.collageSection = body.createDiv({
			cls: "intuition-panel__collage",
		});
		this.collageSection.hide();

		const collageGapRow = this.collageSection.createDiv({
			cls: "intuition-panel__row",
		});
		collageGapRow.createSpan({
			text: "Зазор",
			cls: "intuition-panel__label",
		});
		const collageGapWrap = collageGapRow.createDiv({
			cls: "intuition-panel__size intuition-panel__size--number",
		});
		this.collageGap = collageGapWrap.createEl("input", {
			type: "range",
			attr: {
				min: "0",
				max: String(COLLAGE_GAP_SLIDER_MAX),
				step: "1",
				"aria-label": "Зазор между фото",
			},
		});
		this.collageGapPx = collageGapWrap.createEl("input", {
			type: "number",
			cls: "intuition-panel__number",
			attr: {
				min: "0",
				max: String(COLLAGE_GAP_MAX),
				step: "1",
				"aria-label": "Зазор в пикселях",
			},
		});
		const applyGap = (raw: number) => {
			const gap = clampCollageGap(raw);
			this.collageGap.value = String(Math.min(COLLAGE_GAP_SLIDER_MAX, gap));
			this.collageGapPx.value = String(gap);
			this.collageHooks?.onGapChange(gap);
		};
		this.collageGap.addEventListener("input", () =>
			applyGap(Number(this.collageGap.value)),
		);
		const commitGapPx = () => applyGap(Number(this.collageGapPx.value));
		this.collageGapPx.addEventListener("change", commitGapPx);
		this.collageGapPx.addEventListener("blur", commitGapPx);
		this.collageGapPx.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				commitGapPx();
				this.collageGapPx.blur();
			}
		});

		const collageModeRow = this.collageSection.createDiv({
			cls: "intuition-panel__row",
		});
		collageModeRow.createSpan({
			text: "Размер",
			cls: "intuition-panel__label",
		});
		this.collageMode = collageModeRow.createEl("select", {
			cls: "dropdown intuition-panel__select",
			attr: { "aria-label": "Режим размера коллажа" },
		});
		this.collageMode.createEl("option", { text: "Авто", value: "auto" });
		this.collageMode.createEl("option", {
			text: "Фиксированный",
			value: "fixed",
		});
		this.collageMode.addEventListener("change", () => {
			const mode = normalizeCollageSizeMode(this.collageMode.value);
			this.collageHooks?.onSizeModeChange(mode);
			this.syncCollageFixedVisibility(mode);
		});

		this.collageFixedBlock = this.collageSection.createDiv({
			cls: "intuition-panel__collage-fixed",
		});

		const collageAxisRow = this.collageFixedBlock.createDiv({
			cls: "intuition-panel__row",
		});
		collageAxisRow.createSpan({
			text: "Ось",
			cls: "intuition-panel__label",
		});
		this.collageAxis = collageAxisRow.createEl("select", {
			cls: "dropdown intuition-panel__select",
			attr: { "aria-label": "Ширина или высота" },
		});
		this.collageAxis.createEl("option", { text: "Ширина", value: "width" });
		this.collageAxis.createEl("option", { text: "Высота", value: "height" });
		this.collageAxis.addEventListener("change", () => {
			this.collageHooks?.onFixedAxisChange(
				normalizeCollageFixedAxis(this.collageAxis.value),
			);
		});

		const collageSizeRow = this.collageFixedBlock.createDiv({
			cls: "intuition-panel__row",
		});
		collageSizeRow.createSpan({
			text: "px",
			cls: "intuition-panel__label",
		});
		const collageSizeWrap = collageSizeRow.createDiv({
			cls: "intuition-panel__size intuition-panel__size--number",
		});
		this.collageFixedSizeSlider = collageSizeWrap.createEl("input", {
			type: "range",
			attr: {
				min: "40",
				max: "800",
				step: "10",
				"aria-label": "Быстрый размер",
			},
		});
		this.collageFixedSize = collageSizeWrap.createEl("input", {
			type: "number",
			cls: "intuition-panel__number",
			attr: {
				min: String(COLLAGE_FIXED_SIZE_MIN),
				max: String(COLLAGE_FIXED_SIZE_MAX),
				step: "1",
				"aria-label": "Размер в пикселях",
			},
		});
		const commitFixedSize = () => {
			const size = clampCollageFixedSize(Number(this.collageFixedSize.value));
			this.collageFixedSize.value = String(size);
			this.collageFixedSizeSlider.value = String(
				Math.min(800, Math.max(40, size)),
			);
			this.collageHooks?.onFixedSizeChange(size);
		};
		this.collageFixedSize.addEventListener("change", commitFixedSize);
		this.collageFixedSize.addEventListener("blur", commitFixedSize);
		this.collageFixedSizeSlider.addEventListener("input", () => {
			const size = clampCollageFixedSize(
				Number(this.collageFixedSizeSlider.value),
			);
			this.collageFixedSize.value = String(size);
			this.collageHooks?.onFixedSizeChange(size);
		});

		const collageApplyRow = this.collageSection.createDiv({
			cls: "intuition-panel__row intuition-panel__row--full",
		});
		const arrangeBtn = collageApplyRow.createEl("button", {
			cls: "mod-cta intuition-panel__reset",
			text: "В сетку",
		});
		arrangeBtn.addEventListener("click", () => this.collageHooks?.onArrange());

		const actions = body.createDiv({
			cls: "intuition-panel__row intuition-panel__row--full intuition-panel__actions",
		});
		const copyBtn = actions.createEl("button", {
			cls: "mod-muted intuition-panel__action",
			text: "Копировать",
		});
		this.pasteBtn = actions.createEl("button", {
			cls: "mod-muted intuition-panel__action",
			text: "Вставить",
		});
		copyBtn.addEventListener("click", () => this.copyStyle());
		this.pasteBtn.addEventListener("click", () => this.pasteStyle());

		const aspectRow = body.createDiv({
			cls: "intuition-panel__row intuition-panel__row--full",
		});
		const aspectBtn = aspectRow.createEl("button", {
			cls: "mod-muted intuition-panel__reset",
			text: "Исходные пропорции",
			attr: {
				title:
					"Вернуть соотношение сторон картинки, сохранив приблизительный размер (площадь)",
			},
		});
		aspectBtn.addEventListener("click", () => this.restoreNaturalAspect());

		const resetRow = body.createDiv({
			cls: "intuition-panel__row intuition-panel__row--full",
		});
		const resetBtn = resetRow.createEl("button", {
			cls: "mod-muted intuition-panel__reset",
			text: "Сбросить",
		});
		resetBtn.addEventListener("click", () => {
			if (!this.nodes.length) return;
			for (const node of this.nodes) clearImageStyle(node);
			this.style = { ...DEFAULT_IMAGE_STYLE };
			this.syncInputs();
		});
	}

	setCollageHooks(hooks: ImageStylePanelCollageHooks) {
		this.collageHooks = hooks;
		this.syncCollageControls();
	}

	showFor(nodes: ImageNodeLike | ImageNodeLike[]) {
		const list = Array.isArray(nodes) ? nodes : [nodes];
		this.nodes = list.filter(Boolean);
		const primary = this.nodes[0] ?? null;
		if (!primary) {
			this.hide();
			return;
		}
		this.style = readImageStyle(primary);
		this.titleEl.setText(
			this.nodes.length > 1 ? `Картинки (${this.nodes.length})` : "Картинка",
		);
		this.syncInputs();
		this.syncPasteBtn();
		this.syncCollageControls();
		this.el.show();
	}

	hide() {
		this.nodes = [];
		this.el.hide();
	}

	getActiveNodeId(): string | null {
		return this.nodes[0]?.id ?? null;
	}

	/** Fit selection to intrinsic AR; keep area so size doesn’t “reset”. */
	private restoreNaturalAspect() {
		if (!this.nodes.length) return;

		let ok = 0;
		let canvas: { requestSave?: () => void } | undefined;
		for (const node of this.nodes) {
			if (
				typeof node.x !== "number" ||
				typeof node.y !== "number" ||
				typeof node.width !== "number" ||
				typeof node.height !== "number"
			) {
				continue;
			}
			const sized = node as ImageNodeLike & {
				x: number;
				y: number;
				width: number;
				height: number;
			};
			if (restoreNaturalAspectPreservingArea(sized)) {
				ok++;
				canvas = node.canvas;
			}
		}

		if (ok === 0) {
			new Notice("Не удалось прочитать размер картинки", 1800);
			return;
		}
		canvas?.requestSave?.();
		new Notice(
			ok === 1
				? "Пропорции восстановлены"
				: `Пропорции восстановлены (${ok})`,
			1400,
		);
	}

	private copyStyle() {
		if (!this.nodes.length) return;
		copyImageFormat(this.style);
		this.syncPasteBtn();
		new Notice("Стиль картинки скопирован", 1400);
	}

	private pasteStyle() {
		if (!this.nodes.length) return;
		const clip = peekStyleClipboard();
		if (!clip) {
			new Notice("Сначала скопируйте стиль", 1600);
			return;
		}
		if (clip.kind !== "image") {
			new Notice("В буфере стиль карточки текста", 1800);
			return;
		}
		const next = getCopiedImageFormat();
		if (!next) return;
		this.style = next;
		this.syncInputs();
		for (const node of this.nodes) {
			writeImageStyle(node, {
				...next,
				auraPalette: [...next.auraPalette],
			});
		}
		new Notice("Стиль вставлен", 1400);
	}

	private syncPasteBtn() {
		this.pasteBtn.disabled = !hasImageFormat();
		this.pasteBtn.toggleClass("is-disabled", !hasImageFormat());
	}

	/** Refresh collage gap row from hooks (e.g. after gap changed elsewhere). */
	syncCollageFromHooks() {
		this.syncCollageControls();
	}

	private syncCollageFixedVisibility(mode: CollageSizeMode) {
		if (mode === "fixed") this.collageFixedBlock.show();
		else this.collageFixedBlock.hide();
	}

	private syncCollageControls() {
		const show = this.nodes.length >= 2 && !!this.collageHooks;
		if (show) {
			const hooks = this.collageHooks!;
			const gap = clampCollageGap(hooks.getGap());
			this.collageGap.value = String(Math.min(COLLAGE_GAP_SLIDER_MAX, gap));
			this.collageGapPx.value = String(gap);

			const mode = normalizeCollageSizeMode(hooks.getSizeMode());
			this.collageMode.value = mode;
			this.syncCollageFixedVisibility(mode);

			this.collageAxis.value = normalizeCollageFixedAxis(hooks.getFixedAxis());
			const size = clampCollageFixedSize(hooks.getFixedSize());
			this.collageFixedSize.value = String(size);
			this.collageFixedSizeSlider.value = String(
				Math.min(800, Math.max(40, size)),
			);

			this.collageSection.show();
		} else {
			this.collageSection.hide();
		}
	}

	private syncInputs() {
		const transparency = toTransparency(this.style.opacity);
		this.inputs.transparency.value = String(transparency);
		this.inputs.transparencyValue.setText(`${transparency}%`);
		this.inputs.borderColor.value = this.style.borderColor;
		this.inputs.borderWidth.value = String(this.style.borderWidth);
		this.inputs.borderWidthValue.setText(`${this.style.borderWidth}px`);
		this.inputs.borderRadius.value = String(this.style.borderRadius);
		this.inputs.borderRadiusValue.setText(`${this.style.borderRadius}px`);
		this.inputs.borderStyle.value = this.style.borderStyle;
		this.inputs.aura.checked = this.style.aura;
		this.inputs.auraShimmer.checked = this.style.auraShimmer;
		this.inputs.auraStrength.value = String(this.style.auraStrength);
		this.inputs.auraStrengthValue.setText(`${this.style.auraStrength}%`);
		this.inputs.auraSize.value = String(this.style.auraSize);
		this.inputs.auraSizeValue.setText(`${this.style.auraSize}%`);
		this.inputs.auraColor.value = this.style.auraColor || "#7a6bb5";
		this.inputs.vibeTilt.checked = this.style.vibeTilt !== false;
		const tiltOn = this.style.vibeTilt !== false;
		const tiltStr = this.style.vibeTiltStrength ?? 100;
		this.inputs.vibeTiltStrength.value = String(tiltStr);
		this.inputs.vibeTiltStrengthValue.setText(`${tiltStr}%`);
		this.inputs.vibeTiltStrength.disabled = !tiltOn;
		this.inputs.auraShimmer.disabled = !this.style.aura;
		this.inputs.auraStrength.disabled = !this.style.aura;
		this.inputs.auraSize.disabled = !this.style.aura;
		this.inputs.auraColor.disabled = !this.style.aura;
	}

	/** Apply changed fields to every selected image (keeps per-image aura colors unless overridden). */
	private commit(partial: Partial<IntuitionImageStyle>) {
		if (!this.nodes.length) return;
		this.style = { ...this.style, ...partial };
		this.syncInputs();

		for (const node of this.nodes) {
			const base = readImageStyle(node);
			const next: IntuitionImageStyle = { ...base, ...partial };
			if (partial.aura === true && partial.auraColor === "") {
				next.auraColor = "";
				next.auraPalette = [];
			}
			if ("auraColor" in partial) {
				next.auraPalette = partial.auraPalette ?? [];
			}
			writeImageStyle(node, next);
		}
	}
}
