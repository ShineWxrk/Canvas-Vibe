/** Fixed mini-player so Canvas audio keeps playing when the node leaves the viewport. */

import { setIcon } from "obsidian";
import { paintAuraLayer, removeAuraLayer } from "./imageAura";

const ATTR = "data-intuition-sticky-audio";
const AUDIO_ATTR = "data-intuition-sticky-audio-el";
const DEFAULT_VOLUME = 80;
const AURA_COLOR = "#7a6bb5";

export class StickyAudioPlayer {
	private el: HTMLElement | null = null;
	private shell: HTMLElement | null = null;
	private audio: HTMLAudioElement | null = null;
	private titleEl: HTMLElement | null = null;
	private timeEl: HTMLElement | null = null;
	private playBtn: HTMLButtonElement | null = null;
	private seek: HTMLInputElement | null = null;
	private volume: HTMLInputElement | null = null;
	private volumeValue: HTMLElement | null = null;
	private repeatBtn: HTMLButtonElement | null = null;
	private canvasRoot: HTMLElement | null = null;
	private listenRoot: HTMLElement | null = null;
	private seeking = false;
	private adopting = false;
	private volumePct = DEFAULT_VOLUME;
	private loop = false;
	private onVolumeChange: ((pct: number) => void) | null = null;
	private onLoopChange: ((loop: boolean) => void) | null = null;
	private onPlayCapture: ((e: Event) => void) | null = null;
	private onTimeUpdate: (() => void) | null = null;
	private onEnded: (() => void) | null = null;
	private onPlay: (() => void) | null = null;
	private onPause: (() => void) | null = null;

	setVolume(pct: number) {
		this.volumePct = clampVolume(pct);
		if (this.audio) this.audio.volume = this.volumePct / 100;
		if (this.volume) this.volume.value = String(this.volumePct);
		if (this.volumeValue) this.volumeValue.textContent = `${this.volumePct}%`;
		this.syncVolumeIcon();
	}

	setOnVolumeChange(fn: ((pct: number) => void) | null) {
		this.onVolumeChange = fn;
	}

	setLoop(loop: boolean) {
		this.loop = !!loop;
		if (this.audio) this.audio.loop = this.loop;
		this.syncRepeatUi();
	}

	setOnLoopChange(fn: ((loop: boolean) => void) | null) {
		this.onLoopChange = fn;
	}

	attach(host: HTMLElement, canvasRoot: HTMLElement) {
		if (this.el?.isConnected && this.listenRoot === host) {
			if (!this.el.isConnected) host.appendChild(this.el);
			this.ensureAura();
			return;
		}
		this.detachListeners();
		if (this.el) removeAuraLayer(this.el);
		this.el?.remove();

		const el = document.createElement("div");
		el.className = "intuition-sticky-audio";
		el.setAttribute(ATTR, "1");
		el.hidden = true;

		const shell = document.createElement("div");
		shell.className = "intuition-sticky-audio__shell";

		const playBtn = document.createElement("button");
		playBtn.type = "button";
		playBtn.className = "clickable-icon intuition-sticky-audio__play";
		playBtn.setAttribute("aria-label", "Пауза");
		setIcon(playBtn, "pause");
		playBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.togglePlay();
		});

		const meta = document.createElement("div");
		meta.className = "intuition-sticky-audio__meta";

		const titleEl = document.createElement("div");
		titleEl.className = "intuition-sticky-audio__title";
		titleEl.textContent = "Аудио";

		const seekRow = document.createElement("div");
		seekRow.className = "intuition-sticky-audio__seek-row";

		const seek = document.createElement("input");
		seek.type = "range";
		seek.className = "intuition-sticky-audio__seek";
		seek.min = "0";
		seek.max = "0";
		seek.step = "0.1";
		seek.value = "0";
		seek.setAttribute("aria-label", "Позиция трека");
		seek.addEventListener("pointerdown", (e) => e.stopPropagation());
		seek.addEventListener("input", () => {
			this.seeking = true;
			const t = Number(seek.value);
			const dur = Number(seek.max);
			if (this.timeEl) {
				this.timeEl.textContent =
					dur > 0
						? `${formatClock(t)} / ${formatClock(dur)}`
						: formatClock(t);
			}
		});
		seek.addEventListener("change", () => {
			const t = Number(seek.value);
			if (this.audio && Number.isFinite(t)) this.audio.currentTime = t;
			this.seeking = false;
			this.syncProgress();
		});

		const timeEl = document.createElement("span");
		timeEl.className = "intuition-sticky-audio__time";
		timeEl.textContent = "0:00";

		seekRow.appendChild(seek);
		seekRow.appendChild(timeEl);
		meta.appendChild(titleEl);
		meta.appendChild(seekRow);

		const volWrap = document.createElement("div");
		volWrap.className = "intuition-sticky-audio__volume";

		const volBtn = document.createElement("button");
		volBtn.type = "button";
		volBtn.className = "clickable-icon intuition-sticky-audio__vol-icon";
		volBtn.setAttribute("aria-label", "Громкость");
		setIcon(volBtn, "volume-2");
		volBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.setVolume(this.volumePct > 0 ? 0 : DEFAULT_VOLUME);
			this.onVolumeChange?.(this.volumePct);
		});

		const volume = document.createElement("input");
		volume.type = "range";
		volume.className = "intuition-sticky-audio__vol";
		volume.min = "0";
		volume.max = "100";
		volume.step = "1";
		volume.value = String(this.volumePct);
		volume.setAttribute("aria-label", "Громкость");
		volume.addEventListener("pointerdown", (e) => e.stopPropagation());
		volume.addEventListener("input", () => {
			this.setVolume(Number(volume.value));
			this.onVolumeChange?.(this.volumePct);
		});

		const volumeValue = document.createElement("span");
		volumeValue.className = "intuition-sticky-audio__vol-value";
		volumeValue.textContent = `${this.volumePct}%`;

		volWrap.appendChild(volBtn);
		volWrap.appendChild(volume);
		volWrap.appendChild(volumeValue);

		const repeatBtn = document.createElement("button");
		repeatBtn.type = "button";
		repeatBtn.className = "clickable-icon intuition-sticky-audio__repeat";
		repeatBtn.setAttribute("aria-label", "Повтор трека");
		repeatBtn.setAttribute("aria-pressed", "false");
		setIcon(repeatBtn, "repeat");
		repeatBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.setLoop(!this.loop);
			this.onLoopChange?.(this.loop);
		});

		const closeBtn = document.createElement("button");
		closeBtn.type = "button";
		closeBtn.className = "clickable-icon intuition-sticky-audio__close";
		closeBtn.setAttribute("aria-label", "Закрыть плеер");
		setIcon(closeBtn, "x");
		closeBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.stopAndHide();
		});

		const audio = document.createElement("audio");
		audio.setAttribute(AUDIO_ATTR, "1");
		audio.preload = "metadata";
		audio.volume = this.volumePct / 100;
		audio.loop = this.loop;

		shell.appendChild(playBtn);
		shell.appendChild(meta);
		shell.appendChild(volWrap);
		shell.appendChild(repeatBtn);
		shell.appendChild(closeBtn);
		shell.appendChild(audio);
		el.appendChild(shell);
		host.appendChild(el);

		this.el = el;
		this.shell = shell;
		this.audio = audio;
		this.titleEl = titleEl;
		this.timeEl = timeEl;
		this.playBtn = playBtn;
		this.seek = seek;
		this.volume = volume;
		this.volumeValue = volumeValue;
		this.repeatBtn = repeatBtn;
		this.listenRoot = host;
		this.canvasRoot = canvasRoot;
		this.volIconBtn = volBtn;

		this.onTimeUpdate = () => this.syncProgress();
		this.onEnded = () => {
			// Keep the bar visible so the user can replay / scrub.
			this.setPlayingUi(false);
			this.syncProgress();
		};
		this.onPlay = () => {
			this.setPlayingUi(true);
			this.show();
		};
		this.onPause = () => this.setPlayingUi(false);

		audio.addEventListener("timeupdate", this.onTimeUpdate);
		audio.addEventListener("ended", this.onEnded);
		audio.addEventListener("play", this.onPlay);
		audio.addEventListener("pause", this.onPause);
		audio.addEventListener("loadedmetadata", () => this.syncProgress());

		// Capture on the leaf host: media `play` does not bubble, but capture still fires.
		this.onPlayCapture = (e) => this.handleCanvasPlay(e);
		host.addEventListener("play", this.onPlayCapture, true);

		this.ensureAura();
		this.syncVolumeIcon();
		this.syncRepeatUi();
	}

	/** True when the sticky player is audible / visible. */
	isActive(): boolean {
		return !!this.el && !this.el.hidden;
	}

	destroy() {
		this.stopAndHide();
		this.detachListeners();
		if (this.el) removeAuraLayer(this.el);
		this.el?.remove();
		this.el = null;
		this.shell = null;
		this.audio = null;
		this.titleEl = null;
		this.timeEl = null;
		this.playBtn = null;
		this.seek = null;
		this.volume = null;
		this.volumeValue = null;
		this.repeatBtn = null;
		this.volIconBtn = null;
		this.canvasRoot = null;
		this.onVolumeChange = null;
		this.onLoopChange = null;
	}

	private volIconBtn: HTMLButtonElement | null = null;

	private detachListeners() {
		if (this.listenRoot && this.onPlayCapture) {
			this.listenRoot.removeEventListener("play", this.onPlayCapture, true);
		}
		this.onPlayCapture = null;
		this.listenRoot = null;
		if (this.audio) {
			if (this.onTimeUpdate)
				this.audio.removeEventListener("timeupdate", this.onTimeUpdate);
			if (this.onEnded) this.audio.removeEventListener("ended", this.onEnded);
			if (this.onPlay) this.audio.removeEventListener("play", this.onPlay);
			if (this.onPause) this.audio.removeEventListener("pause", this.onPause);
		}
		this.onTimeUpdate = null;
		this.onEnded = null;
		this.onPlay = null;
		this.onPause = null;
	}

	private ensureAura() {
		if (!this.el) return;
		paintAuraLayer(this.el, {
			color: AURA_COLOR,
			palette: [AURA_COLOR, "#a078c8", "#648cd0"],
			strength: 55,
			size: 130,
			shimmer: true,
			seed: "sticky-audio",
		});
	}

	private handleCanvasPlay(e: Event) {
		const target = e.target;
		if (!(target instanceof HTMLAudioElement)) return;
		if (target === this.audio) return;
		if (target.getAttribute(AUDIO_ATTR) === "1") return;
		if (!target.closest(".canvas-node")) return;
		if (this.adopting) return;

		this.adopting = true;
		try {
			const src = target.currentSrc || target.src;
			if (!src) return;
			const time = Number.isFinite(target.currentTime) ? target.currentTime : 0;
			const title = titleFromAudio(target);

			// Stop the in-node player so Obsidian can unload it freely.
			try {
				target.pause();
			} catch {
				/* ignore */
			}

			void this.adopt(src, time, title);
		} finally {
			this.adopting = false;
		}
	}

	private async adopt(src: string, time: number, title: string) {
		const audio = this.audio;
		if (!audio) return;

		if (this.titleEl) this.titleEl.textContent = title;
		this.ensureAura();
		this.show();
		this.setPlayingUi(true);
		audio.volume = this.volumePct / 100;
		audio.loop = this.loop;

		const same =
			!!audio.currentSrc &&
			(audio.currentSrc === src ||
				normalizeSrc(audio.currentSrc) === normalizeSrc(src) ||
				normalizeSrc(audio.src) === normalizeSrc(src));

		if (!same) {
			// Assigning src is enough — calling load() here can abort play().
			audio.src = src;
		}

		const resume = async () => {
			try {
				if (Number.isFinite(time) && time > 0.05) {
					audio.currentTime = time;
				} else if (!same) {
					audio.currentTime = 0;
				} else {
					// Re-open after close: restart from the beginning.
					audio.currentTime = 0;
				}
			} catch {
				/* metadata not ready yet */
			}
			try {
				await audio.play();
			} catch {
				this.setPlayingUi(false);
			}
			this.syncProgress();
		};

		if (!same && audio.readyState < 1) {
			audio.addEventListener(
				"loadedmetadata",
				() => {
					void resume();
				},
				{ once: true },
			);
			// Still poke play immediately to keep the user-gesture token when possible.
			void audio.play().catch(() => {
				/* metadata path will retry */
			});
			return;
		}

		await resume();
	}

	private togglePlay() {
		const audio = this.audio;
		if (!audio) return;
		if (audio.paused) void audio.play().catch(() => this.setPlayingUi(false));
		else audio.pause();
	}

	private stopAndHide() {
		const audio = this.audio;
		if (audio) {
			try {
				audio.pause();
			} catch {
				/* ignore */
			}
			// Keep src so the next Play from a canvas node can resume reliably
			// (clearing src + load() left the element in a state where play() failed).
			try {
				audio.currentTime = 0;
			} catch {
				/* ignore */
			}
		}
		this.setPlayingUi(false);
		this.hide();
	}

	private show() {
		if (this.el) this.el.hidden = false;
		this.ensureAura();
	}

	private hide() {
		if (this.el) this.el.hidden = true;
		if (this.seek) {
			this.seek.value = "0";
			this.seek.max = "0";
		}
		if (this.timeEl) this.timeEl.textContent = "0:00";
	}

	private setPlayingUi(playing: boolean) {
		if (!this.playBtn) return;
		this.playBtn.setAttribute("aria-label", playing ? "Пауза" : "Играть");
		setIcon(this.playBtn, playing ? "pause" : "play");
	}

	private syncVolumeIcon() {
		if (!this.volIconBtn) return;
		const icon =
			this.volumePct <= 0 ? "volume-x" : this.volumePct < 40 ? "volume-1" : "volume-2";
		setIcon(this.volIconBtn, icon);
	}

	private syncRepeatUi() {
		if (!this.repeatBtn) return;
		this.repeatBtn.classList.toggle("is-active", this.loop);
		this.repeatBtn.setAttribute("aria-pressed", this.loop ? "true" : "false");
		this.repeatBtn.setAttribute(
			"aria-label",
			this.loop ? "Повтор включён" : "Повтор трека",
		);
	}

	private syncProgress() {
		const audio = this.audio;
		const seek = this.seek;
		if (!audio || !seek || this.seeking) return;
		const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
		const cur = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
		if (dur > 0) {
			seek.max = String(dur);
			seek.value = String(cur);
		}
		if (this.timeEl) {
			this.timeEl.textContent =
				dur > 0 ? `${formatClock(cur)} / ${formatClock(dur)}` : formatClock(cur);
		}
	}
}

function clampVolume(n: number): number {
	if (!Number.isFinite(n)) return DEFAULT_VOLUME;
	return Math.min(100, Math.max(0, Math.round(n)));
}

function titleFromAudio(el: HTMLAudioElement): string {
	const node = el.closest(".canvas-node");
	const label = node
		?.querySelector(".canvas-node-label")
		?.textContent?.trim();
	if (label) return label;

	const src = el.currentSrc || el.src;
	if (!src) return "Аудио";
	try {
		const leaf = decodeURIComponent(
			src.split(/[/\\]/).pop()?.split("?")[0] ?? "",
		);
		return leaf || "Аудио";
	} catch {
		return "Аудио";
	}
}

function normalizeSrc(src: string): string {
	try {
		return decodeURIComponent(src.split("?")[0] ?? src);
	} catch {
		return src;
	}
}

function formatClock(sec: number): string {
	if (!Number.isFinite(sec) || sec < 0) return "0:00";
	const s = Math.floor(sec % 60);
	const m = Math.floor(sec / 60) % 60;
	const h = Math.floor(sec / 3600);
	const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
	const ss = String(s).padStart(2, "0");
	return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
