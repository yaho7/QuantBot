import assert from "node:assert/strict";
import test from "node:test";
import { effectiveWidgets, suggestedWidgets } from "../src/shared/layout-defaults.ts";

const declare = (id, presentation) => ({ id, presentation });
const source = (strategyId, capabilities) => ({ strategyId, catalog: { capabilities } });

test("initial layout follows explicit surface and stable order across strategies", () => {
  const show = { suggested: true, surface: ["overview"] };
  const defaults = suggestedWidgets([
    source("z", [declare("first", { ...show, order: -1, default_size: "large" }), declare("third", show)]),
    source("a", [declare("hidden", { ...show, suggested: false }), declare("detail", { ...show, surface: ["strategy"] }), declare("second", show)]),
  ], "overview");
  assert.deepEqual(defaults.map(({ controlId, size }) => [controlId, size]),
    [["first", "large"], ["second", "medium"], ["third", "medium"]]);
  assert.deepEqual(effectiveWidgets({ revision: 0, widgets: [] }, defaults), defaults);
});

test("saved layouts keep removed and hidden widgets, and preserve an empty layout", () => {
  const show = { suggested: true, surface: ["strategy"] };
  const previous = suggestedWidgets([source("a", [declare("old", show)])], "strategy");
  const next = suggestedWidgets([source("a", [declare("new", show)])], "strategy");
  const saved = [{ ...previous[0], size: "small", hidden: true }];
  assert.deepEqual(effectiveWidgets({ revision: 2, widgets: saved }, next), saved);
  assert.deepEqual(effectiveWidgets({ revision: 3, widgets: [] }, next), []);
});

test("initial suggestions fit a layout that can be saved", () => {
  const show = { suggested: true, surface: ["overview"] };
  const sources = Array.from({ length: 10 }, (_, i) =>
    source("a" + i, Array.from({ length: 30 }, (_, j) => declare("metric" + j, show))),
  );
  assert.equal(suggestedWidgets(sources, "overview").length, 256);
});
