import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { renderMermaid, MERMAID_FONT_SIZE } from "../components/mermaid-render.ts";
import { chartSize } from "../components/session-overlay.tsx";

const diagrams = [
	["flowchart", 'flowchart LR\n A["Current understanding"] --> B["Goal"]'],
	["sequence", "sequenceDiagram\n Learner->>Teacher: Why?\n Teacher-->>Learner: Because"],
	["class", "classDiagram\n Animal <|-- Duck"],
	["state", "stateDiagram-v2\n [*] --> Learning\n Learning --> [*]"],
	["er", "erDiagram\n COURSE ||--o{ LESSON : contains"],
	["gantt", "gantt\n dateFormat YYYY-MM-DD\n section Lesson\n Read :2026-01-01, 2d"],
	["pie", 'pie\n "Known" : 3\n "New" : 2'],
	["git", "gitGraph\n commit\n commit"],
	["mindmap", "mindmap\n root((Understanding))\n  Facts\n  Reasoning"],
	["timeline", "timeline\n 2025 : Learn\n 2026 : Practice"],
	["quadrant", "quadrantChart\n Concept: [0.3, 0.6]"],
	["xychart", "xychart-beta\n x-axis [A, B]\n y-axis 0 --> 10\n bar [3, 7]"],
	["journey", "journey\n section Lesson\n Read: 5: Learner"],
] as const;

describe("lesson diagrams — Pele renderer", () => {
	for (const [type, source] of diagrams) {
		it(`renders ${type} source as a measurable SVG`, async () => {
			const svg = await renderMermaid(source);
			assert.match(svg, /class="pele /, "the shared path uses Pele");
			const { w, h } = chartSize(svg);
			assert.ok(w > 0 && h > 0);
			assert.match(svg, /\bviewBox="/, "inline size cap and overlay fit use the real extent");
			assert.match(svg, new RegExp(`font:${MERMAID_FONT_SIZE}px`));
		});
	}

	it("keeps quoted labels and Mermaid source direction", async () => {
		const svg = await renderMermaid('flowchart LR\n A["Learner\'s question: why?"] --> B["An answer"]');
		const { document } = parseHTML(svg);
		assert.match(document.querySelector("svg")!.textContent!, /Learner's question: why\?/);
		const from = document.querySelector('[data-id="A"]')!.getAttribute("transform");
		const to = document.querySelector('[data-id="B"]')!.getAttribute("transform");
		assert.notEqual(from, to);
		// The nodes stay on one row; Pele's narrow-container auto-direction
		// must not turn an authored LR chart into a vertical one.
		const position = (transform: string | null) => /translate\(([^,]+),([^)]+)\)/.exec(transform!)!;
		assert.equal(position(from)[2], position(to)[2]);
		assert.notEqual(position(from)[1], position(to)[1]);
	});

	it("isolates SVG IDs across inline, expanded, and concurrent diagrams", async () => {
		const source = "flowchart TD\n accTitle: Lesson\n A --> B";
		const svgs = await Promise.all([renderMermaid(source), renderMermaid(source), renderMermaid(source)]);
		const ids = svgs.map((svg) => {
			const { document } = parseHTML(svg);
			return Array.from(document.querySelectorAll("[id]"), (node) => node.id);
		});
		assert.ok(ids.every((group) => group.length > 0), "exercise actual prefixed IDs");
		const all = ids.flat();
		assert.equal(new Set(all).size, all.length);
	});

	it("rejects invalid source through the existing async error contract", async () => {
		await assert.rejects(renderMermaid("not a diagram @@@"));
		// A failed render must not poison the shared lazy registry.
		assert.match(await renderMermaid("graph TD\n A --> B"), /class="pele /);
	});

	it("limits model-authored diagram source", async () => {
		await assert.rejects(renderMermaid(`flowchart TD\n A["${"x".repeat(50_001)}"]`));
	});

	it("keeps hostile labels inert without executable SVG content", async () => {
		const svg = await renderMermaid('flowchart TD\n A["<script>alert(1)</script>"] --> B["<img src=x onerror=alert(1)>"]');
		const { document } = parseHTML(svg);
		assert.equal(document.querySelector("script, img, foreignObject"), null);
		assert.equal(document.querySelector("[onerror], [onload], [onclick]"), null);
		assert.match(document.querySelector("svg")!.textContent!, /alert\(1\)/);
	});

	it("does not emit model-authored remote image requests", async () => {
		const svg = await renderMermaid('flowchart TD\n A@{ img: "https://example.com/tracker.svg", label: "Image" }\n A --> B');
		const { document } = parseHTML(svg);
		assert.equal(document.querySelector("image, img"), null);
		assert.ok(!svg.includes("https://example.com/tracker.svg"));
	});

	it("does not turn diagram click statements into links or callbacks", async () => {
		for (const action of ['href "https://example.com"', 'href "javascript:alert(1)"', "call alert()"]) {
			const svg = await renderMermaid(`flowchart TD\n A --> B\n click A ${action}`);
			const { document } = parseHTML(svg);
			assert.equal(document.querySelector("a, script, [onclick]"), null);
		}
	});
});
