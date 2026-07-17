import { setIcon } from "obsidian";
import {
	normalizeGlobalAura,
	type GlobalAuraSettings,
} from "./settings";
import {
	normalizeSparkleConfig,
	type VibeSparkleConfig,
	SPARKLE_LIMITS,
} from "./vibeSparkles";

export type VibePanelCallbacks = {
	getVibeStrength: () => number;
	getVibeTextStrength: () => number;
	getSparkles: () => VibeSparkleConfig;
	getAura: () => GlobalAuraSettings;
	getSections: () => Record<string, boolean>;
	onStrength: (n: number) => void;
	onTextStrength: (n: number) => void;
	onSparkles: (partial: Partial<VibeSparkleConfig>) => void;
	onResetSparkles: () => void;
	onAura: (partial: Partial<GlobalAuraSettings>) => void;
	onApplyAuraAll: () => void;
	onResetAura: () => void;
	onSectionToggle: (key: string, open: boolean) => void;
};

export class VibePanel {
	readonly el: HTMLElement;

	constructor(
		parent: HTMLElement,
		private callbacks: VibePanelCallbacks,
	) {
		this.el = document.createElement("div");
		this.el.className = "intuition-vibe-panel";
		this.el.setAttribute("data-intuition-vibe-panel", "1");

		const sections = callbacks.getSections();
		const cfg = normalizeSparkleConfig(callbacks.getSparkles());
		const aura = normalizeGlobalAura(callbacks.getAura());

		// ── Tilt ──
		const tiltSec = this.createAccordion("tilt", "Реакция", !!sections.tilt);
		tiltSec.body.appendChild(
			this.createSliderRow({
				label: "Наклон",
				sliderClass: "intuition-vibe-panel__slider--tilt",
				valueClass: "intuition-vibe-panel__value--tilt",
				aria: "Сила наклона картинок",
				initial: callbacks.getVibeStrength(),
				onInput: (n) => callbacks.onStrength(n),
			}),
		);
		tiltSec.body.appendChild(
			this.createSliderRow({
				label: "Текст",
				sliderClass: "intuition-vibe-panel__slider--text",
				valueClass: "intuition-vibe-panel__value--text",
				aria: "Сила свечения текста при наведении",
				initial: callbacks.getVibeTextStrength(),
				onInput: (n) => callbacks.onTextStrength(n),
			}),
		);

		// ── Sparkles ──
		const sparkSec = this.createAccordion(
			"sparkles",
			"Блестки",
			!!sections.sparkles,
		);
		sparkSec.body.appendChild(
			this.createSliderRow({
				label: "Кол-во",
				sliderClass: "intuition-vibe-panel__slider--amount",
				valueClass: "intuition-vibe-panel__value--amount",
				aria: "Максимальное количество блесток",
				min: SPARKLE_LIMITS.amount.min,
				max: SPARKLE_LIMITS.amount.max,
				initial: cfg.amount,
				format: (n) => String(n),
				onInput: (n) => callbacks.onSparkles({ amount: n }),
			}),
		);
		sparkSec.body.appendChild(
			this.createSliderRow({
				label: "Частота",
				sliderClass: "intuition-vibe-panel__slider--freq",
				valueClass: "intuition-vibe-panel__value--freq",
				aria: "Частота спавна блесток",
				min: SPARKLE_LIMITS.frequency.min,
				max: SPARKLE_LIMITS.frequency.max,
				initial: cfg.frequency,
				format: (n) => String(n),
				onInput: (n) => callbacks.onSparkles({ frequency: n }),
			}),
		);
		sparkSec.body.appendChild(
			this.createSliderRow({
				label: "Размер",
				sliderClass: "intuition-vibe-panel__slider--size",
				valueClass: "intuition-vibe-panel__value--size",
				aria: "Размер блесток",
				min: SPARKLE_LIMITS.size.min,
				max: SPARKLE_LIMITS.size.max,
				initial: cfg.size,
				format: (n) => `${n}px`,
				onInput: (n) => callbacks.onSparkles({ size: n }),
			}),
		);
		sparkSec.body.appendChild(
			this.createSliderRow({
				label: "Жизнь",
				sliderClass: "intuition-vibe-panel__slider--life",
				valueClass: "intuition-vibe-panel__value--life",
				aria: "Время жизни блесток",
				min: SPARKLE_LIMITS.lifetime.min,
				max: SPARKLE_LIMITS.lifetime.max,
				step: 100,
				initial: cfg.lifetime,
				format: (n) => `${(n / 1000).toFixed(1)}с`,
				onInput: (n) => callbacks.onSparkles({ lifetime: n }),
			}),
		);
		sparkSec.body.appendChild(
			this.createSliderRow({
				label: "Яркость",
				sliderClass: "intuition-vibe-panel__slider--opacity",
				valueClass: "intuition-vibe-panel__value--opacity",
				aria: "Яркость блесток",
				min: SPARKLE_LIMITS.opacity.min,
				max: SPARKLE_LIMITS.opacity.max,
				initial: cfg.opacity,
				onInput: (n) => callbacks.onSparkles({ opacity: n }),
			}),
		);
		sparkSec.body.appendChild(
			this.createSliderRow({
				label: "Подъём",
				sliderClass: "intuition-vibe-panel__slider--drift",
				valueClass: "intuition-vibe-panel__value--drift",
				aria: "Скорость подъёма блесток",
				min: SPARKLE_LIMITS.drift.min,
				max: SPARKLE_LIMITS.drift.max,
				initial: cfg.drift,
				format: (n) => String(n),
				onInput: (n) => callbacks.onSparkles({ drift: n }),
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
			callbacks.onSparkles({ color: colorInput.value }),
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
			callbacks.onResetSparkles();
		});
		resetSparkle.appendChild(resetSparkleBtn);
		sparkSec.body.appendChild(resetSparkle);

		// ── Global auras ──
		const auraSec = this.createAccordion("auras", "Ауры", !!sections.auras);

		auraSec.body.appendChild(
			this.createToggleRow({
				label: "Вкл.",
				inputClass: "intuition-vibe-panel__aura-enabled",
				checked: aura.enabled,
				aria: "Ауры на всех картинках",
				onChange: (on) => callbacks.onAura({ enabled: on }),
			}),
		);
		auraSec.body.appendChild(
			this.createToggleRow({
				label: "Перелив",
				inputClass: "intuition-vibe-panel__aura-shimmer",
				checked: aura.shimmer,
				aria: "Перелив ауры",
				onChange: (on) => callbacks.onAura({ shimmer: on }),
			}),
		);
		auraSec.body.appendChild(
			this.createSliderRow({
				label: "Сила",
				sliderClass: "intuition-vibe-panel__slider--aura-str",
				valueClass: "intuition-vibe-panel__value--aura-str",
				aria: "Сила ауры",
				initial: aura.strength,
				onInput: (n) => callbacks.onAura({ strength: n }),
			}),
		);
		auraSec.body.appendChild(
			this.createSliderRow({
				label: "Площадь",
				sliderClass: "intuition-vibe-panel__slider--aura-size",
				valueClass: "intuition-vibe-panel__value--aura-size",
				aria: "Размер ауры",
				min: 0,
				max: 200,
				step: 5,
				initial: aura.size,
				format: (n) => `${n}%`,
				onInput: (n) => callbacks.onAura({ size: n }),
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
			callbacks.onApplyAuraAll();
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
			callbacks.onResetAura();
		});
		resetAuraRow.appendChild(resetAuraBtn);
		auraSec.body.appendChild(resetAuraRow);

		parent.appendChild(this.el);
	}

	setVisible(visible: boolean) {
		this.el.hidden = !visible;
	}

	reattach(parent: HTMLElement) {
		if (!this.el.isConnected) parent.appendChild(this.el);
	}

	destroy() {
		this.el.remove();
	}

	sync(opts: {
		visible: boolean;
		strength: number;
		textStrength: number;
		sparkles: VibeSparkleConfig;
		aura: GlobalAuraSettings;
	}) {
		this.el.hidden = !opts.visible;
		this.syncSlider(
			".intuition-vibe-panel__slider--tilt",
			".intuition-vibe-panel__value--tilt",
			opts.strength,
			(n) => `${n}%`,
		);
		this.syncSlider(
			".intuition-vibe-panel__slider--text",
			".intuition-vibe-panel__value--text",
			opts.textStrength,
			(n) => `${n}%`,
		);
		this.syncSparkleControls(opts.sparkles);
		this.syncAuraControls(opts.aura);
	}

	syncStrength(pct: number) {
		this.syncSlider(
			".intuition-vibe-panel__slider--tilt",
			".intuition-vibe-panel__value--tilt",
			pct,
		);
	}

	syncTextStrength(pct: number) {
		this.syncSlider(
			".intuition-vibe-panel__slider--text",
			".intuition-vibe-panel__value--text",
			pct,
		);
	}

	syncSparkles(cfg: VibeSparkleConfig = normalizeSparkleConfig(
		this.callbacks.getSparkles(),
	)) {
		this.syncSparkleControls(cfg);
	}

	syncAura(g: GlobalAuraSettings = normalizeGlobalAura(this.callbacks.getAura())) {
		this.syncAuraControls(g);
	}

	private syncSparkleControls(cfg: VibeSparkleConfig) {
		this.syncSlider(
			".intuition-vibe-panel__slider--amount",
			".intuition-vibe-panel__value--amount",
			cfg.amount,
			(n) => String(n),
		);
		this.syncSlider(
			".intuition-vibe-panel__slider--freq",
			".intuition-vibe-panel__value--freq",
			cfg.frequency,
			(n) => String(n),
		);
		this.syncSlider(
			".intuition-vibe-panel__slider--size",
			".intuition-vibe-panel__value--size",
			cfg.size,
			(n) => `${n}px`,
		);
		this.syncSlider(
			".intuition-vibe-panel__slider--life",
			".intuition-vibe-panel__value--life",
			cfg.lifetime,
			(n) => `${(n / 1000).toFixed(1)}с`,
		);
		this.syncSlider(
			".intuition-vibe-panel__slider--opacity",
			".intuition-vibe-panel__value--opacity",
			cfg.opacity,
		);
		this.syncSlider(
			".intuition-vibe-panel__slider--drift",
			".intuition-vibe-panel__value--drift",
			cfg.drift,
			(n) => String(n),
		);
		const color = this.el.querySelector<HTMLInputElement>(
			".intuition-vibe-panel__slider--color",
		);
		if (color) color.value = cfg.color;
	}

	private syncAuraControls(g: GlobalAuraSettings) {
		const enabled = this.el.querySelector<HTMLInputElement>(
			".intuition-vibe-panel__aura-enabled",
		);
		const shimmer = this.el.querySelector<HTMLInputElement>(
			".intuition-vibe-panel__aura-shimmer",
		);
		if (enabled) enabled.checked = g.enabled;
		if (shimmer) shimmer.checked = g.shimmer;
		this.syncSlider(
			".intuition-vibe-panel__slider--aura-str",
			".intuition-vibe-panel__value--aura-str",
			g.strength,
		);
		this.syncSlider(
			".intuition-vibe-panel__slider--aura-size",
			".intuition-vibe-panel__value--aura-size",
			g.size,
			(n) => `${n}%`,
		);
		if (shimmer) shimmer.disabled = !g.enabled;
		const str = this.el.querySelector<HTMLInputElement>(
			".intuition-vibe-panel__slider--aura-str",
		);
		const size = this.el.querySelector<HTMLInputElement>(
			".intuition-vibe-panel__slider--aura-size",
		);
		if (str) str.disabled = !g.enabled;
		if (size) size.disabled = !g.enabled;
	}

	private syncSlider(
		sliderSel: string,
		valueSel: string,
		pct: number,
		format: (n: number) => string = (n) => `${n}%`,
	) {
		const slider = this.el.querySelector<HTMLInputElement>(sliderSel);
		const value = this.el.querySelector<HTMLElement>(valueSel);
		if (slider) slider.value = String(pct);
		if (value) value.textContent = format(pct);
	}

	private createAccordion(key: string, title: string, open: boolean) {
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
			this.callbacks.onSectionToggle(key, next);
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
		this.el.appendChild(section);
		return { section, body, head };
	}

	private createToggleRow(opts: {
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

	private createSliderRow(opts: {
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
}
