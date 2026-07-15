import { Notice, setIcon } from "obsidian";
import {
	DEFAULT_TEXT_STYLE,
	FONT_OPTIONS,
	clearTextStyle,
	type IntuitionTextStyle,
	type TextNodeLike,
	readTextStyle,
	writeTextStyle,
} from "./textStyles";
import {
	copyTextFormat,
	getCopiedTextFormat,
	hasTextFormat,
	peekStyleClipboard,
} from "./styleClipboard";

export class TextStylePanel {
	readonly el: HTMLElement;
	private node: TextNodeLike | null = null;
	private style: IntuitionTextStyle = { ...DEFAULT_TEXT_STYLE };
	private pasteBtn!: HTMLButtonElement;
	private inputs: {
		color: HTMLInputElement;
		fontSize: HTMLInputElement;
		fontSizeValue: HTMLElement;
		fontFamily: HTMLSelectElement;
		fontWeight: HTMLSelectElement;
		lineHeight: HTMLInputElement;
		alignLeft: HTMLButtonElement;
		alignCenter: HTMLButtonElement;
		alignRight: HTMLButtonElement;
		alignTop: HTMLButtonElement;
		alignMiddle: HTMLButtonElement;
		alignBottom: HTMLButtonElement;
		plain: HTMLInputElement;
		cardBgColor: HTMLInputElement;
		cardBgOpacity: HTMLInputElement;
		cardBgOpacityValue: HTMLElement;
		cardBorderColor: HTMLInputElement;
		cardBorderWidth: HTMLInputElement;
		cardBorderWidthValue: HTMLElement;
		cardRows: HTMLElement[];
	};

	constructor(parent: HTMLElement) {
		this.el = parent.createDiv({ cls: "intuition-text-panel" });
		this.el.setAttribute("data-intuition-text-panel", "1");
		this.el.hide();

		const header = this.el.createDiv({ cls: "intuition-text-panel__header" });
		header.createSpan({ text: "Текст" });
		const closeBtn = header.createEl("button", {
			cls: "clickable-icon intuition-text-panel__close",
			attr: { "aria-label": "Закрыть" },
		});
		setIcon(closeBtn, "x");
		closeBtn.addEventListener("click", () => this.hide());

		const body = this.el.createDiv({ cls: "intuition-text-panel__body" });

		const plainRow = body.createDiv({ cls: "intuition-text-panel__row" });
		plainRow.createSpan({ text: "Без карточки", cls: "intuition-text-panel__label" });
		const plainLabel = plainRow.createEl("label", {
			cls: "intuition-text-panel__toggle",
		});
		const plain = plainLabel.createEl("input", { type: "checkbox" });
		plainLabel.createSpan({ cls: "intuition-text-panel__toggle-ui" });

		const cardBgRow = body.createDiv({ cls: "intuition-text-panel__row" });
		cardBgRow.createSpan({ text: "Фон", cls: "intuition-text-panel__label" });
		const cardBgColor = cardBgRow.createEl("input", {
			type: "color",
			cls: "intuition-text-panel__color",
		});

		const cardBgOpRow = body.createDiv({ cls: "intuition-text-panel__row" });
		cardBgOpRow.createSpan({
			text: "Прозр. фона",
			cls: "intuition-text-panel__label",
		});
		const cardBgOpWrap = cardBgOpRow.createDiv({
			cls: "intuition-text-panel__size",
		});
		const cardBgOpacity = cardBgOpWrap.createEl("input", {
			type: "range",
			attr: { min: "0", max: "100", step: "1" },
		});
		const cardBgOpacityValue = cardBgOpWrap.createSpan({
			cls: "intuition-text-panel__value",
		});

		const cardBorderColorRow = body.createDiv({
			cls: "intuition-text-panel__row",
		});
		cardBorderColorRow.createSpan({
			text: "Цвет рамки",
			cls: "intuition-text-panel__label",
		});
		const cardBorderColor = cardBorderColorRow.createEl("input", {
			type: "color",
			cls: "intuition-text-panel__color",
		});

		const cardBorderWidthRow = body.createDiv({
			cls: "intuition-text-panel__row",
		});
		cardBorderWidthRow.createSpan({
			text: "Толщина",
			cls: "intuition-text-panel__label",
		});
		const cardBorderWidthWrap = cardBorderWidthRow.createDiv({
			cls: "intuition-text-panel__size",
		});
		const cardBorderWidth = cardBorderWidthWrap.createEl("input", {
			type: "range",
			attr: { min: "0", max: "12", step: "1" },
		});
		const cardBorderWidthValue = cardBorderWidthWrap.createSpan({
			cls: "intuition-text-panel__value",
		});

		const colorRow = body.createDiv({ cls: "intuition-text-panel__row" });
		colorRow.createSpan({ text: "Цвет текста", cls: "intuition-text-panel__label" });
		const color = colorRow.createEl("input", {
			type: "color",
			cls: "intuition-text-panel__color",
		});

		const sizeRow = body.createDiv({ cls: "intuition-text-panel__row" });
		sizeRow.createSpan({ text: "Размер", cls: "intuition-text-panel__label" });
		const sizeWrap = sizeRow.createDiv({ cls: "intuition-text-panel__size" });
		const fontSize = sizeWrap.createEl("input", {
			type: "range",
			attr: { min: "12", max: "200", step: "1" },
		});
		const fontSizeValue = sizeWrap.createSpan({
			cls: "intuition-text-panel__value",
		});

		const fontRow = body.createDiv({ cls: "intuition-text-panel__row" });
		fontRow.createSpan({ text: "Шрифт", cls: "intuition-text-panel__label" });
		const fontFamily = fontRow.createEl("select", {
			cls: "dropdown intuition-text-panel__select",
		});
		for (const opt of FONT_OPTIONS) {
			fontFamily.createEl("option", { text: opt.label, value: opt.value });
		}

		const weightRow = body.createDiv({ cls: "intuition-text-panel__row" });
		weightRow.createSpan({ text: "Насыщ.", cls: "intuition-text-panel__label" });
		const fontWeight = weightRow.createEl("select", {
			cls: "dropdown intuition-text-panel__select",
		});
		for (const [label, value] of [
			["Обычный", "400"],
			["Средний", "500"],
			["Полужирный", "600"],
			["Жирный", "700"],
		] as const) {
			fontWeight.createEl("option", { text: label, value });
		}

		const lhRow = body.createDiv({ cls: "intuition-text-panel__row" });
		lhRow.createSpan({ text: "Интервал", cls: "intuition-text-panel__label" });
		const lineHeight = lhRow.createEl("input", {
			type: "range",
			attr: { min: "1", max: "2.2", step: "0.05" },
		});

		const alignHRow = body.createDiv({ cls: "intuition-text-panel__row" });
		alignHRow.createSpan({ text: "По ширине", cls: "intuition-text-panel__label" });
		const alignHGroup = alignHRow.createDiv({ cls: "intuition-text-panel__align" });
		const alignLeft = this.makeAlignBtn(alignHGroup, "align-left", "left");
		const alignCenter = this.makeAlignBtn(alignHGroup, "align-center", "center");
		const alignRight = this.makeAlignBtn(alignHGroup, "align-right", "right");

		const alignVRow = body.createDiv({ cls: "intuition-text-panel__row" });
		alignVRow.createSpan({ text: "По высоте", cls: "intuition-text-panel__label" });
		const alignVGroup = alignVRow.createDiv({ cls: "intuition-text-panel__align" });
		const alignTop = this.makeVAlignBtn(alignVGroup, "align-vertical-justify-start", "top");
		const alignMiddle = this.makeVAlignBtn(alignVGroup, "align-vertical-justify-center", "middle");
		const alignBottom = this.makeVAlignBtn(alignVGroup, "align-vertical-justify-end", "bottom");

		this.inputs = {
			color,
			fontSize,
			fontSizeValue,
			fontFamily,
			fontWeight,
			lineHeight,
			alignLeft,
			alignCenter,
			alignRight,
			alignTop,
			alignMiddle,
			alignBottom,
			plain,
			cardBgColor,
			cardBgOpacity,
			cardBgOpacityValue,
			cardBorderColor,
			cardBorderWidth,
			cardBorderWidthValue,
			cardRows: [cardBgRow, cardBgOpRow, cardBorderColorRow, cardBorderWidthRow],
		};

		plain.addEventListener("change", () => this.commit({ plain: plain.checked }));
		cardBgColor.addEventListener("input", () =>
			this.commit({ cardBgColor: cardBgColor.value }),
		);
		cardBgOpacity.addEventListener("input", () => {
			const v = Number(cardBgOpacity.value);
			// UI: transparency % (0 = opaque bg, 100 = invisible bg)
			cardBgOpacityValue.setText(`${v}%`);
			this.commit({ cardBgOpacity: 100 - v });
		});
		cardBorderColor.addEventListener("input", () =>
			this.commit({ cardBorderColor: cardBorderColor.value }),
		);
		cardBorderWidth.addEventListener("input", () => {
			const v = Number(cardBorderWidth.value);
			cardBorderWidthValue.setText(`${v}px`);
			this.commit({ cardBorderWidth: v });
		});
		color.addEventListener("input", () => this.commit({ color: color.value }));
		fontSize.addEventListener("input", () => {
			const v = Number(fontSize.value);
			fontSizeValue.setText(`${v}px`);
			this.commit({ fontSize: v });
		});
		fontFamily.addEventListener("change", () =>
			this.commit({ fontFamily: fontFamily.value }),
		);
		fontWeight.addEventListener("change", () =>
			this.commit({ fontWeight: fontWeight.value }),
		);
		lineHeight.addEventListener("input", () =>
			this.commit({ lineHeight: Number(lineHeight.value) }),
		);
		alignLeft.addEventListener("click", () => this.commit({ textAlign: "left" }));
		alignCenter.addEventListener("click", () => this.commit({ textAlign: "center" }));
		alignRight.addEventListener("click", () => this.commit({ textAlign: "right" }));
		alignTop.addEventListener("click", () => this.commit({ verticalAlign: "top" }));
		alignMiddle.addEventListener("click", () => this.commit({ verticalAlign: "middle" }));
		alignBottom.addEventListener("click", () => this.commit({ verticalAlign: "bottom" }));

		const actions = body.createDiv({
			cls: "intuition-text-panel__row intuition-text-panel__row--full intuition-panel__actions",
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

		const resetRow = body.createDiv({ cls: "intuition-text-panel__row intuition-text-panel__row--full" });
		const resetBtn = resetRow.createEl("button", {
			cls: "mod-muted intuition-text-panel__reset",
			text: "Сбросить стили",
		});
		resetBtn.addEventListener("click", () => {
			if (!this.node) return;
			clearTextStyle(this.node, true);
			this.style = readTextStyle(this.node);
			this.syncInputs();
		});
	}

	private makeAlignBtn(
		parent: HTMLElement,
		icon: string,
		align: IntuitionTextStyle["textAlign"],
	): HTMLButtonElement {
		const btn = parent.createEl("button", {
			cls: "clickable-icon intuition-text-panel__align-btn",
			attr: { "data-align": align, "aria-label": align },
		});
		setIcon(btn, icon);
		return btn;
	}

	private makeVAlignBtn(
		parent: HTMLElement,
		icon: string,
		align: IntuitionTextStyle["verticalAlign"],
	): HTMLButtonElement {
		const btn = parent.createEl("button", {
			cls: "clickable-icon intuition-text-panel__align-btn",
			attr: { "data-v-align": align, "aria-label": align },
		});
		setIcon(btn, icon);
		return btn;
	}

	showFor(node: TextNodeLike) {
		this.node = node;
		this.style = readTextStyle(node);
		this.syncInputs();
		this.syncPasteBtn();
		this.el.show();
	}

	hide() {
		this.node = null;
		this.el.hide();
	}

	getActiveNodeId(): string | null {
		return this.node?.id ?? null;
	}

	private copyStyle() {
		if (!this.node) return;
		copyTextFormat(this.style);
		this.syncPasteBtn();
		new Notice("Стиль карточки скопирован", 1400);
	}

	private pasteStyle() {
		if (!this.node) return;
		const clip = peekStyleClipboard();
		if (!clip) {
			new Notice("Сначала скопируйте стиль", 1600);
			return;
		}
		if (clip.kind !== "text") {
			new Notice("В буфере стиль картинки", 1800);
			return;
		}
		const next = getCopiedTextFormat();
		if (!next) return;
		this.style = next;
		this.syncInputs();
		writeTextStyle(this.node, this.style);
		new Notice("Стиль вставлен", 1400);
	}

	private syncPasteBtn() {
		this.pasteBtn.disabled = !hasTextFormat();
		this.pasteBtn.toggleClass("is-disabled", !hasTextFormat());
	}

	private syncInputs() {
		const s = this.style;
		this.inputs.plain.checked = s.plain;
		this.inputs.color.value = this.toHexColor(s.color);
		this.inputs.fontSize.value = String(s.fontSize);
		this.inputs.fontSizeValue.setText(`${s.fontSize}px`);
		this.inputs.fontFamily.value = this.matchFont(s.fontFamily);
		this.inputs.fontWeight.value = s.fontWeight;
		this.inputs.lineHeight.value = String(s.lineHeight);
		this.inputs.alignLeft.toggleClass("is-active", s.textAlign === "left");
		this.inputs.alignCenter.toggleClass("is-active", s.textAlign === "center");
		this.inputs.alignRight.toggleClass("is-active", s.textAlign === "right");
		this.inputs.alignTop.toggleClass("is-active", s.verticalAlign === "top");
		this.inputs.alignMiddle.toggleClass("is-active", s.verticalAlign === "middle");
		this.inputs.alignBottom.toggleClass("is-active", s.verticalAlign === "bottom");

		this.inputs.cardBgColor.value = this.toHexColor(s.cardBgColor);
		const bgTransparency = Math.min(100, Math.max(0, 100 - s.cardBgOpacity));
		this.inputs.cardBgOpacity.value = String(bgTransparency);
		this.inputs.cardBgOpacityValue.setText(`${bgTransparency}%`);
		this.inputs.cardBorderColor.value = this.toHexColor(s.cardBorderColor);
		this.inputs.cardBorderWidth.value = String(s.cardBorderWidth);
		this.inputs.cardBorderWidthValue.setText(`${s.cardBorderWidth}px`);

		const cardEnabled = !s.plain;
		for (const row of this.inputs.cardRows) {
			row.toggleClass("is-disabled", !cardEnabled);
		}
		this.inputs.cardBgColor.disabled = !cardEnabled;
		this.inputs.cardBgOpacity.disabled = !cardEnabled;
		this.inputs.cardBorderColor.disabled = !cardEnabled;
		this.inputs.cardBorderWidth.disabled = !cardEnabled;
	}

	private matchFont(family: string): string {
		const found = FONT_OPTIONS.find(
			(o) => o.value === family || o.value.startsWith(family.split(",")[0]),
		);
		return found?.value ?? FONT_OPTIONS[0].value;
	}

	private toHexColor(color: string): string {
		if (/^#[0-9a-fA-F]{6}$/.test(color)) return color;
		if (/^#[0-9a-fA-F]{3}$/.test(color)) {
			const r = color[1];
			const g = color[2];
			const b = color[3];
			return `#${r}${r}${g}${g}${b}${b}`;
		}
		return "#e8eaed";
	}

	private commit(partial: Partial<IntuitionTextStyle>) {
		if (!this.node) return;
		this.style = { ...this.style, ...partial };
		this.syncInputs();
		writeTextStyle(this.node, this.style);
	}
}
