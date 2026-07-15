import { setIcon } from "obsidian";
import {
	DEFAULT_CANVAS_CHROME,
	normalizeCanvasChrome,
	sampleCanvasBackground,
	type CanvasChromeStyle,
} from "./canvasChrome";

export class CanvasStylePanel {
	readonly el: HTMLElement;
	private style: CanvasChromeStyle = { ...DEFAULT_CANVAS_CHROME };
	private root: HTMLElement | null = null;
	private onChange: ((style: CanvasChromeStyle) => void) | null = null;
	private inputs: {
		backgroundColor: HTMLInputElement;
		dots: HTMLInputElement;
		dotColor: HTMLInputElement;
		dotOpacity: HTMLInputElement;
		dotOpacityValue: HTMLElement;
	};

	constructor(parent: HTMLElement) {
		this.el = parent.createDiv({ cls: "intuition-canvas-panel" });
		this.el.setAttribute("data-intuition-canvas-panel", "1");
		this.el.hide();

		const header = this.el.createDiv({ cls: "intuition-panel__header" });
		header.createSpan({ text: "Канвас" });
		const closeBtn = header.createEl("button", {
			cls: "clickable-icon intuition-panel__close",
			attr: { "aria-label": "Закрыть" },
		});
		setIcon(closeBtn, "x");
		closeBtn.addEventListener("click", () => this.hide());

		const body = this.el.createDiv({ cls: "intuition-panel__body" });

		const bgRow = body.createDiv({ cls: "intuition-panel__row" });
		bgRow.createSpan({ text: "Фон", cls: "intuition-panel__label" });
		const backgroundColor = bgRow.createEl("input", {
			type: "color",
			cls: "intuition-panel__color",
		});

		const dotsRow = body.createDiv({ cls: "intuition-panel__row" });
		dotsRow.createSpan({ text: "Точки", cls: "intuition-panel__label" });
		const dotsLabel = dotsRow.createEl("label", {
			cls: "intuition-text-panel__toggle",
		});
		const dots = dotsLabel.createEl("input", { type: "checkbox" });
		dotsLabel.createSpan({ cls: "intuition-text-panel__toggle-ui" });

		const dotColorRow = body.createDiv({ cls: "intuition-panel__row" });
		dotColorRow.createSpan({
			text: "Цвет точек",
			cls: "intuition-panel__label",
		});
		const dotColor = dotColorRow.createEl("input", {
			type: "color",
			cls: "intuition-panel__color",
		});

		const opacityRow = body.createDiv({ cls: "intuition-panel__row" });
		opacityRow.createSpan({
			text: "Прозр. точек",
			cls: "intuition-panel__label",
		});
		const opacityWrap = opacityRow.createDiv({ cls: "intuition-panel__size" });
		const dotOpacity = opacityWrap.createEl("input", {
			type: "range",
			attr: { min: "0", max: "100", step: "1" },
		});
		const dotOpacityValue = opacityWrap.createSpan({
			cls: "intuition-panel__value",
		});

		this.inputs = {
			backgroundColor,
			dots,
			dotColor,
			dotOpacity,
			dotOpacityValue,
		};

		backgroundColor.addEventListener("input", () =>
			this.commit({ backgroundColor: backgroundColor.value }),
		);
		dots.addEventListener("change", () => this.commit({ dots: dots.checked }));
		dotColor.addEventListener("input", () =>
			this.commit({ dotColor: dotColor.value }),
		);
		dotOpacity.addEventListener("input", () => {
			const v = Number(dotOpacity.value);
			dotOpacityValue.setText(`${v}%`);
			this.commit({ dotOpacity: v });
		});

		const resetRow = body.createDiv({
			cls: "intuition-panel__row intuition-panel__row--full",
		});
		const resetBtn = resetRow.createEl("button", {
			cls: "mod-muted intuition-panel__reset",
			text: "Сбросить фон",
		});
		resetBtn.addEventListener("click", () => {
			const sampled = this.root
				? sampleCanvasBackground(this.root)
				: "#1e1f24";
			this.commit({
				...DEFAULT_CANVAS_CHROME,
				backgroundColor: "",
			});
			this.inputs.backgroundColor.value = sampled;
			this.syncDotControlsEnabled();
		});
	}

	show(
		root: HTMLElement,
		style: CanvasChromeStyle,
		onChange: (style: CanvasChromeStyle) => void,
	) {
		this.root = root;
		this.onChange = onChange;
		this.style = normalizeCanvasChrome(style);
		this.syncInputs();
		this.el.show();
	}

	hide() {
		this.root = null;
		this.onChange = null;
		this.el.hide();
	}

	toggle(
		root: HTMLElement,
		style: CanvasChromeStyle,
		onChange: (style: CanvasChromeStyle) => void,
	) {
		const open =
			typeof (this.el as HTMLElement & { isShown?: () => boolean }).isShown ===
			"function"
				? (this.el as HTMLElement & { isShown: () => boolean }).isShown()
				: this.el.style.display !== "none";
		if (open) this.hide();
		else this.show(root, style, onChange);
	}

	private syncInputs() {
		const s = this.style;
		const bg =
			s.backgroundColor ||
			(this.root ? sampleCanvasBackground(this.root) : "#1e1f24");
		this.inputs.backgroundColor.value = bg;
		this.inputs.dots.checked = s.dots;
		this.inputs.dotColor.value = s.dotColor;
		this.inputs.dotOpacity.value = String(s.dotOpacity);
		this.inputs.dotOpacityValue.setText(`${s.dotOpacity}%`);
		this.syncDotControlsEnabled();
	}

	private syncDotControlsEnabled() {
		const on = this.inputs.dots.checked;
		this.inputs.dotColor.disabled = !on;
		this.inputs.dotOpacity.disabled = !on;
	}

	private commit(partial: Partial<CanvasChromeStyle>) {
		this.style = normalizeCanvasChrome({ ...this.style, ...partial });
		this.syncDotControlsEnabled();
		this.onChange?.(this.style);
	}
}
