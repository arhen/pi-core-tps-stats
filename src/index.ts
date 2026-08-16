import type {
	ExtensionAPI,
	ExtensionContext,
	TurnStartEvent,
	MessageUpdateEvent,
	MessageEndEvent,
	ModelSelectEvent,
} from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// ── per-model segment ──
	let tpsValues: number[] = [];
	let effTpsValues: number[] = [];
	let ttftValues: number[] = [];

	// ── current-turn tracking ──
	let turnStart = 0;
	let textStart = 0;

	function median(sorted: number[]): number {
		if (sorted.length === 0) return 0;
		const mid = Math.floor(sorted.length / 2);
		return sorted.length % 2 === 1
			? sorted[mid]
			: (sorted[mid - 1] + sorted[mid]) / 2;
	}

	// ponytail: provider token counts may lump thinking into output. Align numerator
	// to the measured window: subtract reasoning tokens when reported, else estimate
	// text tokens from content blocks (chars/4).
	function textTokensOf(message: any): number {
		const usage = message.usage;
		if (!usage || typeof usage.output !== "number" || usage.output <= 0)
			return 0;
		if (typeof usage.reasoning === "number" && usage.reasoning >= 0) {
			return Math.max(0, usage.output - usage.reasoning);
		}
		const text = (message.content ?? [])
			.filter((b: any) => b.type === "text")
			.map((b: any) => b.text)
			.join("");
		return Math.ceil(text.length / 4);
	}

	function fmtDur(ms: number): string {
		if (ms < 10000) return `${(ms / 1000).toFixed(1).replace(".", ",")}s`;
		const s = Math.round(ms / 1000);
		if (s < 60) return `${s}s`;
		return `${Math.floor(s / 60)}m ${s % 60}s`;
	}

	// ponytail: color by speed — <=40 red, <=80 yellow, <=100 white, >=100 green
	function tpsColored(
		t: { fg(color: string, text: string): string },
		v: number,
	): string {
		const s = String(Math.round(v));
		if (v <= 40) return t.fg("error", s);
		if (v <= 80) return t.fg("warning", s);
		if (v < 100) return t.fg("text", s);
		return t.fg("success", s);
	}

	function updateStatus(ctx: ExtensionContext) {
		const n = tpsValues.length;
		if (n === 0) {
			ctx.ui.setStatus("tps", undefined);
			return;
		}

		const med = median([...tpsValues].sort((a, b) => a - b));
		const t = ctx.ui.theme;
		// ponytail: value first, label after — matches requested `xxx t/s` layout
		let text = `${t.fg("dim", "med")} ${tpsColored(t, med)} ${t.fg("dim", "t/s")}`;

		if (ttftValues.length > 0) {
			const avgTTFT = ttftValues.reduce((a, b) => a + b, 0) / ttftValues.length;
			text += ` | ${t.fg("warning", fmtDur(avgTTFT))} ${t.fg("dim", "ttft")}`;
		}

		ctx.ui.setStatus("tps", text);
	}

	function resetStats(ctx: ExtensionContext, modelLabel: string) {
		tpsValues = [];
		effTpsValues = [];
		ttftValues = [];
		const t = ctx.ui.theme;
		ctx.ui.setStatus(
			"tps",
			`${t.fg("dim", "t/s reset")} ${t.fg("accent", modelLabel)}`,
		);
		setTimeout(() => {
			if (tpsValues.length === 0) ctx.ui.setStatus("tps", undefined);
		}, 2000);
	}

	pi.on("turn_start", (_event: TurnStartEvent, ctx: ExtensionContext) => {
		turnStart = Date.now();
		textStart = 0;
	});

	pi.on(
		"message_update",
		(event: MessageUpdateEvent, _ctx: ExtensionContext) => {
			if (!turnStart) return;
			const ev = event.assistantMessageEvent;
			if (ev?.type === "text_start" && textStart === 0) {
				textStart = Date.now();
			}
		},
	);

	pi.on("message_end", (event: MessageEndEvent, ctx: ExtensionContext) => {
		if (event.message.role !== "assistant") return;
		if (!turnStart || textStart === 0) return;

		const now = Date.now();
		const usage = event.message.usage;
		if (!usage || typeof usage.output !== "number" || usage.output <= 0) return;

		const ttft = textStart - turnStart;
		if (ttft > 0) ttftValues.push(ttft);

		// streaming t/s: text tokens streamed inside [text_start, message_end]
		const textTokens = textTokensOf(event.message);
		const durationMs = now - textStart;
		if (durationMs > 0 && textTokens > 0) {
			tpsValues.push(textTokens / (durationMs / 1000));
		}

		// effective t/s: all output tokens over the full turn (incl. thinking time)
		const effDurationMs = now - turnStart;
		if (effDurationMs > 0) {
			effTpsValues.push(usage.output / (effDurationMs / 1000));
		}

		updateStatus(ctx);
		turnStart = 0;
		textStart = 0;
	});

	pi.on("model_select", (event: ModelSelectEvent, ctx: ExtensionContext) => {
		const modelLabel = event.model
			? `${event.model.provider}/${event.model.id}`
			: "?";
		// ponytail: reset stats on model change — different models have different speeds
		resetStats(ctx, modelLabel);
	});

	// ── detail via /tps-stats command ──
	pi.registerCommand("tps-stats", {
		description: "Show token-per-second statistics for current model",
		handler: async (_args, ctx) => {
			const n = tpsValues.length;
			if (n === 0) {
				await ctx.ui.confirm("t/s Stats", "No data yet. Send a prompt first.");
				return;
			}
			const avg = tpsValues.reduce((a, b) => a + b, 0) / n;
			const sorted = [...tpsValues].sort((a, b) => a - b);
			const med = median(sorted);
			const min = sorted[0];
			const max = sorted[n - 1];

			const lines = [
				`Streaming t/s (text tokens / text window)`,
				`Samples: ${n}`,
				`Average: ${avg.toFixed(1)}`,
				`Median:  ${med.toFixed(1)}`,
				`Min:     ${min.toFixed(1)}`,
				`Max:     ${max.toFixed(1)}`,
			];

			if (effTpsValues.length > 0) {
				const effAvg =
					effTpsValues.reduce((a, b) => a + b, 0) / effTpsValues.length;
				const effMed = median([...effTpsValues].sort((a, b) => a - b));
				lines.push(
					`---`,
					`Effective t/s (all tokens / full turn):`,
					`Average: ${effAvg.toFixed(1)}`,
					`Median:  ${effMed.toFixed(1)}`,
				);
			}

			if (ttftValues.length > 0) {
				const avgTTFT =
					ttftValues.reduce((a, b) => a + b, 0) / ttftValues.length;
				const sortedTTFT = [...ttftValues].sort((a, b) => a - b);
				const medTTFT = median(sortedTTFT);
				lines.push(
					`---`,
					`TTFT avg:   ${fmtDur(avgTTFT)}`,
					`TTFT median: ${fmtDur(medTTFT)}`,
				);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
