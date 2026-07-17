import { setIcon, setTooltip } from "obsidian";

export type SyncControlButtonOpts = {
	active?: boolean;
	title: string;
	iconName: string;
};

export function syncControlButton(
	el: Element | null,
	opts: SyncControlButtonOpts,
) {
	if (!el) return;
	const button =
		el instanceof HTMLButtonElement ? el : el.querySelector("button");
	if (!button) return;

	if (opts.active !== undefined) {
		button.classList.toggle("is-active", opts.active);
	}
	setIcon(button, opts.iconName);
	setTooltip(button, opts.title, { placement: "left" });
	button.setAttribute("aria-label", opts.title);
}

export type InjectControlButtonOpts = {
	attr: string;
	buttonClass?: string;
	sync?: (button: HTMLButtonElement) => void;
	onClick: () => void;
};

/** Inject a button into `.canvas-controls` as a control group (idempotent). */
export function injectControlButton(
	controls: HTMLElement,
	opts: InjectControlButtonOpts,
): HTMLButtonElement | null {
	const existing = controls.querySelector(`[${opts.attr}]`);
	if (existing) {
		const btn =
			existing instanceof HTMLButtonElement
				? existing
				: existing.querySelector("button");
		if (btn instanceof HTMLButtonElement) {
			opts.sync?.(btn);
			return btn;
		}
		return null;
	}

	const group = document.createElement("div");
	group.className = "canvas-control-group";
	group.setAttribute(opts.attr, "1");

	const button = document.createElement("button");
	button.className =
		opts.buttonClass ?? "clickable-icon intuition-canvas-toggle";
	button.type = "button";
	opts.sync?.(button);
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		opts.onClick();
	});

	group.appendChild(button);
	controls.appendChild(group);
	return button;
}

export type InjectCardMenuButtonOpts = {
	attr: string;
	ariaLabel: string;
	iconName: string;
	tooltip?: string;
	onClick: () => void;
};

/** Inject a button into `.canvas-card-menu` (idempotent). */
export function injectCardMenuButton(
	menu: HTMLElement,
	opts: InjectCardMenuButtonOpts,
): HTMLElement | null {
	if (menu.querySelector(`[${opts.attr}]`)) return null;

	const btn = document.createElement("div");
	btn.className = "canvas-card-menu-button";
	btn.setAttribute(opts.attr, "1");
	btn.setAttribute("aria-label", opts.ariaLabel);
	setIcon(btn, opts.iconName);
	setTooltip(btn, opts.tooltip ?? opts.ariaLabel, { placement: "top" });
	btn.addEventListener("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
		opts.onClick();
	});
	menu.appendChild(btn);
	return btn;
}
