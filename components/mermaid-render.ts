/**
 * Shared renderer for Mermaid source in lesson messages and their focus
 * overlay. Pele supplies the SVG; the existing callers retain streaming,
 * errors, copy, and pan/zoom. Lesson-plan layout and the knowledge graph
 * have separate renderers and do not go through this module.
 */

import { renderAsync } from "pele/lazy";
import type { MathMarkup } from "pele";
import katex from "katex";

/** Shared with the inline display-width cap: a chart may shrink to fit
 *  the column, but its base font must never scale past the session text.
 *  Keep this explicit rather than relying on the rendering engine's default. */
export const MERMAID_FONT_SIZE = 16;

/**
 * Pele delegates math labels to the host. Reuse the app's KaTeX with
 * trust disabled and measure MathML in the browser before Pele lays out
 * the node. MathML avoids WebKit's HTML-in-SVG positioning issue.
 * The renderer is used from effects; non-browser callers retain TeX.
 */
function renderMath(tex: string, size: number): MathMarkup | null {
	if (typeof document === "undefined") return null;
	const probe = document.createElement("span");
	probe.style.cssText = `position:absolute;left:-9999px;visibility:hidden;display:inline-block;white-space:nowrap;font-size:${size}px`;
	try {
		probe.innerHTML = katex.renderToString(tex, {
			displayMode: true,
			output: "mathml",
			trust: false,
		});
		document.body.appendChild(probe);
		const math = probe.querySelector("math")!;
		const { width, height } = math.getBoundingClientRect();
		return { html: math.outerHTML, width, height };
	} finally {
		probe.remove();
	}
}

/** Preserve the async contract while loading only the diagram type needed.
 *  Each render gets its own SVG IDs so inline and expanded charts coexist.
 *  Links, image requests, and executable callbacks must not be introduced
 *  by model-authored diagrams (the previous renderer used strict mode).
 *  Colors inherit the app's tokens through Pele variables in globals.css. */
export async function renderMermaid(chart: string): Promise<string> {
	const id = `lh-mermaid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
	const { svg } = await renderAsync(chart, {
		fontFamily: "ui-sans-serif, system-ui, sans-serif",
		fontSize: MERMAID_FONT_SIZE,
		idPrefix: id,
		autoDirection: false,
		links: false,
		images: false,
		math: renderMath,
	});
	return svg;
}
