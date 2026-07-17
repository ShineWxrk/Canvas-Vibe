/** Obsidian's WorkspaceLeaf typing omits `id`, but it exists at runtime. */
export function leafId(leaf: { id?: string } | object): string {
	return (leaf as { id?: string }).id ?? String(leaf);
}

export function canvasRoot(view: {
	canvas?: { wrapperEl?: HTMLElement; canvasEl?: HTMLElement };
	containerEl: HTMLElement;
}): HTMLElement {
	return (
		view.canvas?.wrapperEl ??
		view.containerEl.querySelector<HTMLElement>(".canvas-wrapper") ??
		view.containerEl
	);
}

export function toggleCanvasFxClass(
	view: {
		canvas?: { wrapperEl?: HTMLElement; canvasEl?: HTMLElement };
		containerEl: HTMLElement;
	},
	className: string,
	on: boolean,
) {
	const root = canvasRoot(view);
	root.classList.toggle(className, on);
	view.containerEl.classList.toggle(className, on);
	view.canvas?.canvasEl?.classList.toggle(className, on);
}

/** Debounced save helper. Returns a function that schedules save. */
export function createDebouncedSave(
	save: () => void | Promise<void>,
	ms = 200,
): { schedule: () => void; cancel: () => void } {
	let timer = 0;
	return {
		schedule() {
			if (timer) window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				timer = 0;
				void save();
			}, ms);
		},
		cancel() {
			if (timer) {
				window.clearTimeout(timer);
				timer = 0;
			}
		},
	};
}
