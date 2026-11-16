/** Resolve theme colors through CSS before handing them to canvas-based charts.
 * Custom-property text may contain light-dark(), which chart libraries do not
 * consistently resolve in the canvas's color space.
 */
export function chartColors(element: HTMLElement) {
  const probe = document.createElement("i");
  probe.hidden = true;
  element.append(probe);
  const resolve = (token: string) => {
    probe.style.color = `var(${token})`;
    return getComputedStyle(probe).color;
  };
  const colors = [
    getComputedStyle(element).getPropertyValue("--theme-chart").trim() ? resolve("--theme-chart") : resolve("--color-text-accent"),
    resolve("--color-text-secondary"), resolve("--color-border"),
    resolve("--color-text-green"), resolve("--color-text-red"),
  ];
  probe.remove();
  return colors.join("|");
}
