// SVG charts (no chart library: small, offline, printable).
export const COLORS = { ink: "#0f2433", open: "#8aa4ba", cloth: "#2a9d8f", canopy: "#e8a33d", coral: "#e4572e", sea: "#087e8b", muted: "#5b6b78", grid: "#eceae3" };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const f1 = (v: number) => v.toFixed(1);

export interface Series { name: string; x: ArrayLike<number>; y: ArrayLike<number>; color: string; dash?: string; fill?: boolean }

function niceStep(max: number, n = 5): number {
  const raw = max / n, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
  return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
}

/** Light over a day. x in minutes after midnight. */
export function lineChart(series: Series[], opts: { w?: number; h?: number; ylab: string; xmin?: number; xmax?: number; noon?: number }): string {
  const w = opts.w ?? 560, h = opts.h ?? 230, L = 52, B = 34, Tp = 10, R = 10;
  let xmin = opts.xmin ?? Infinity, xmax = opts.xmax ?? -Infinity, ymax = 1;
  for (const s of series) for (let i = 0; i < s.x.length; i++) if (s.y[i]! > 0.5) { if (opts.xmin === undefined) xmin = Math.min(xmin, s.x[i]! - 30); if (opts.xmax === undefined) xmax = Math.max(xmax, s.x[i]! + 30); }
  for (const s of series) for (let i = 0; i < s.y.length; i++) ymax = Math.max(ymax, s.y[i]!);
  if (!Number.isFinite(xmin)) { xmin = 300; xmax = 1140; }
  ymax *= 1.08;
  const X = (m: number) => L + ((m - xmin) / (xmax - xmin)) * (w - L - R), Y = (v: number) => Tp + (1 - v / ymax) * (h - Tp - B);
  const o: string[] = [`<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${esc(opts.ylab)}">`];
  const st = niceStep(ymax);
  for (let v = 0; v <= ymax; v += st) o.push(`<line x1="${L}" x2="${w - R}" y1="${f1(Y(v))}" y2="${f1(Y(v))}" stroke="${COLORS.grid}"/><text x="${L - 8}" y="${f1(Y(v) + 4)}" font-size="11" fill="${COLORS.muted}" text-anchor="end">${+v.toFixed(3)}</text>`);
  for (let hr = Math.ceil(xmin / 120) * 2; hr * 60 <= xmax; hr += 2) o.push(`<text x="${f1(X(hr * 60))}" y="${h - 12}" font-size="11" fill="${COLORS.muted}" text-anchor="middle">${String(hr).padStart(2, "0")}:00</text>`);
  if (opts.noon !== undefined) o.push(`<line x1="${f1(X(opts.noon))}" x2="${f1(X(opts.noon))}" y1="${Tp}" y2="${h - B}" stroke="${COLORS.muted}" stroke-dasharray="2 4" opacity=".6"/><text x="${f1(X(opts.noon) + 4)}" y="${Tp + 10}" font-size="10.5" fill="${COLORS.muted}">solar noon</text>`);
  for (const s of series) {
    const pts: string[] = [];
    for (let i = 0; i < s.x.length; i++) if (s.x[i]! >= xmin && s.x[i]! <= xmax) pts.push(`${f1(X(s.x[i]!))},${f1(Y(s.y[i]!))}`);
    if (!pts.length) continue;
    if (s.fill) o.push(`<polygon points="${pts[0]!.split(",")[0]},${f1(Y(0))} ${pts.join(" ")} ${pts[pts.length - 1]!.split(",")[0]},${f1(Y(0))}" fill="${s.color}" opacity=".10"/>`);
    o.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${s.color}" stroke-width="2.4" stroke-dasharray="${s.dash ?? ""}" stroke-linejoin="round"><title>${esc(s.name)}</title></polyline>`);
  }
  const cy = (h - B) / 2 + Tp;
  o.push(`<text x="14" y="${cy}" font-size="11" fill="${COLORS.muted}" transform="rotate(-90 14 ${cy})" text-anchor="middle">${esc(opts.ylab)}</text></svg>`);
  return o.join("");
}

export function ramp(t: number): string {
  const stops: [number, [number, number, number]][] = [[0, [12, 44, 74]], [0.35, [8, 126, 139]], [0.7, [120, 190, 160]], [1, [246, 220, 140]]];
  t = Math.max(0, Math.min(1, t));
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i]!, [b, cb] = stops[i + 1]!;
    if (t <= b) { const f = (t - a) / (b - a); return `rgb(${ca.map((c, k) => Math.round(c + f * (cb[k]! - c))).join(",")})`; }
  }
  return "rgb(246,220,140)";
}

export interface Outline { lx: number; ly: number; cx?: number; cy?: number; rot?: number }

/** Map of a per-point value over the target with the structure outline. North up. */
export function mapChart(points: ArrayLike<number>, values: ArrayLike<number>, cell: number, vmin: number, vmax: number, outline: Outline,
  target: { shape: string; lx: number; ly: number }, title: string, extent: number, mark?: ArrayLike<number>): string {
  const w = 250, scale = (w - 24) / extent, cx = w / 2, cy = w / 2;
  const o: string[] = [`<svg viewBox="0 0 ${w} ${w + 24}" width="100%" role="img" aria-label="${esc(title)}"><rect width="${w}" height="${w}" rx="10" fill="#f3f7f9"/>`];
  for (let p = 0; p < values.length; p++) {
    const x = points[2 * p]!, y = points[2 * p + 1]!, t = vmax > vmin ? (values[p]! - vmin) / (vmax - vmin) : 0.5;
    o.push(`<rect x="${f1(cx + (x - cell / 2) * scale)}" y="${f1(cy - (y + cell / 2) * scale)}" width="${f1(cell * scale + 0.6)}" height="${f1(cell * scale + 0.6)}" fill="${ramp(t)}"/>`);
    if (mark && mark[p]) o.push(`<circle cx="${f1(cx + x * scale)}" cy="${f1(cy - y * scale)}" r="1.6" fill="${COLORS.coral}"/>`);
  }
  const { lx, ly } = outline, ocx = outline.cx ?? 0, ocy = outline.cy ?? 0, rot = outline.rot ?? 0;
  o.push(`<rect x="${f1(cx + (ocx - lx / 2) * scale)}" y="${f1(cy - (ocy + ly / 2) * scale)}" width="${f1(lx * scale)}" height="${f1(ly * scale)}" fill="none" stroke="${COLORS.ink}" stroke-width="1.6" stroke-dasharray="5 3" transform="rotate(${rot} ${f1(cx + ocx * scale)} ${f1(cy - ocy * scale)})"/>`);
  if (target.shape === "circle") o.push(`<circle cx="${cx}" cy="${cy}" r="${f1((target.lx / 2) * scale)}" fill="none" stroke="#fff" stroke-width="1.2" opacity=".9"/>`);
  else o.push(`<rect x="${f1(cx - (target.lx / 2) * scale)}" y="${f1(cy - (target.ly / 2) * scale)}" width="${f1(target.lx * scale)}" height="${f1(target.ly * scale)}" fill="none" stroke="#fff" stroke-width="1.2"/>`);
  o.push(`<text x="${w - 10}" y="18" font-size="11" fill="${COLORS.muted}" text-anchor="end">N ↑</text><text x="${cx}" y="${w + 17}" font-size="12" font-weight="600" fill="${COLORS.ink}" text-anchor="middle">${esc(title)}</text></svg>`);
  return o.join("");
}

export function colorbar(vmin: number, vmax: number, label: string): string {
  const stops = Array.from({ length: 9 }, (_, i) => `<stop offset="${i / 8}" stop-color="${ramp(i / 8)}"/>`).join("");
  return `<svg viewBox="0 0 520 34" width="100%"><defs><linearGradient id="cb">${stops}</linearGradient></defs><rect x="40" y="4" width="440" height="10" rx="5" fill="url(#cb)"/>` +
    `<text x="40" y="29" font-size="11" fill="${COLORS.muted}">${vmin.toFixed(1)}</text><text x="480" y="29" font-size="11" fill="${COLORS.muted}" text-anchor="end">${vmax.toFixed(1)}</text>` +
    `<text x="260" y="29" font-size="11" fill="${COLORS.muted}" text-anchor="middle">${esc(label)}</text></svg>`;
}

const MON = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Daily reduction across the period. lines: per scenario mean; band: optional min/max for one scenario. */
export function seasonChart(days: [number, number, number][], lines: { y: number[]; color: string; name: string }[], band?: { lo: number[]; hi: number[]; color: string }): string {
  const w = 560, h = 170, L = 44, B = 28, Tp = 10, R = 10, n = days.length;
  let y0 = 100, y1 = 0;
  for (const l of lines) for (const v of l.y) { y0 = Math.min(y0, v); y1 = Math.max(y1, v); }
  if (band) for (let i = 0; i < n; i++) { y0 = Math.min(y0, band.lo[i]!); y1 = Math.max(y1, band.hi[i]!); }
  y0 = Math.max(0, Math.floor(y0 / 10) * 10); y1 = Math.min(100, Math.ceil(y1 / 10) * 10); if (y1 - y0 < 20) { y0 = Math.max(0, y0 - 10); y1 = Math.min(100, y1 + 10); }
  const X = (i: number) => L + (n > 1 ? i / (n - 1) : 0.5) * (w - L - R), Y = (v: number) => Tp + (1 - (v - y0) / (y1 - y0)) * (h - Tp - B);
  const o: string[] = [`<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="Daily light reduction">`];
  for (let v = y0; v <= y1; v += 10) o.push(`<line x1="${L}" x2="${w - R}" y1="${f1(Y(v))}" y2="${f1(Y(v))}" stroke="${COLORS.grid}"/><text x="${L - 8}" y="${f1(Y(v) + 4)}" font-size="11" fill="${COLORS.muted}" text-anchor="end">${v} %</text>`);
  if (band && n > 1) {
    const up = band.hi.map((v, i) => `${f1(X(i))},${f1(Y(v))}`), dn = band.lo.map((v, i) => `${f1(X(i))},${f1(Y(v))}`).reverse();
    o.push(`<polygon points="${up.join(" ")} ${dn.join(" ")}" fill="${band.color}" opacity=".18"/>`);
  }
  for (const l of lines) o.push(`<polyline points="${l.y.map((v, i) => `${f1(X(i))},${f1(Y(v))}`).join(" ")}" fill="none" stroke="${l.color}" stroke-width="2.4"><title>${esc(l.name)}</title></polyline>`);
  let lastM = -1;
  days.forEach(([, m, d], i) => { if (m !== lastM) { lastM = m; o.push(`<text x="${f1(X(i))}" y="${h - 8}" font-size="11" fill="${COLORS.muted}" text-anchor="middle">${MON[m]} ${d}</text>`); } });
  o.push("</svg>");
  return o.join("");
}

/** Zone colors for the P–E chart and table (light tints, so the lines stay readable). */
export const ZONE_TINTS = ["#eceff1", "#e3f1f4", "#fbf3dc", "#f9e3d9"];

/** P–E curve with the time the corals spend at each light level, for open water and each kind of shading. */
export function peChart(ek: number, ec: number, hists: { name: string; color: string; dash?: string; values: number[] }[], histMax: number): string {
  const w = 340, h = 220, L = 34, B = 34, Tp = 22, R = 10;
  const E = Math.max(histMax * 1.02, ek * 2.4, 100);
  const X = (e: number) => L + (Math.min(e, E) / E) * (w - L - R), Y = (p: number) => Tp + (1 - p) * (h - Tp - B);
  const o: string[] = [`<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="Photosynthesis versus light, with time spent at each light level">`];
  const edges = [0, ec, ek, 2 * ek, E];
  const names = ["below Ec", "light-limited", "near saturation", "saturated"];
  for (let z = 0; z < 4; z++) {
    const a = edges[z]!, b = edges[z + 1]!;
    if (!(b > a) || a >= E) continue;
    o.push(`<rect x="${f1(X(a))}" y="${Tp}" width="${f1(X(b) - X(a))}" height="${f1(h - Tp - B)}" fill="${ZONE_TINTS[z]}"/>`);
    if (X(b) - X(a) > 46) o.push(`<text x="${f1((X(a) + X(b)) / 2)}" y="${Tp - 7}" font-size="10" fill="${COLORS.muted}" text-anchor="middle">${names[z]}</text>`);
  }
  const nb = hists[0]?.values.length ?? 1, bw = histMax / nb;
  const hmax = Math.max(1e-9, ...hists.flatMap((s) => s.values));
  for (const s of hists) {
    const pts: string[] = [`${f1(X(0))},${f1(Y(0))}`];
    s.values.forEach((v, i) => { const y = Y((0.9 * v) / hmax); pts.push(`${f1(X(i * bw))},${f1(y)}`, `${f1(X((i + 1) * bw))},${f1(y)}`); });
    pts.push(`${f1(X(nb * bw))},${f1(Y(0))}`);
    o.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${s.color}" stroke-width="1.8"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}><title>${esc(s.name)}</title></polyline>`);
  }
  const cur = Array.from({ length: 90 }, (_, i) => (i / 89) * E).map((e) => `${f1(X(e))},${f1(Y(Math.tanh(e / ek)))}`);
  o.push(`<polyline points="${cur.join(" ")}" fill="none" stroke="${COLORS.ink}" stroke-width="2.2"/>`);
  o.push(`<line x1="${f1(X(ek))}" x2="${f1(X(ek))}" y1="${f1(Y(0))}" y2="${f1(Y(1))}" stroke="${COLORS.coral}" stroke-dasharray="4 3"/><text x="${f1(X(ek) + 3)}" y="${f1(Y(0.05))}" font-size="10.5" fill="${COLORS.coral}">Ek ${ek.toFixed(0)}</text>`);
  const st = niceStep(E, 4);
  for (let e = 0; e <= E; e += st) o.push(`<text x="${f1(X(e))}" y="${h - 20}" font-size="10.5" fill="${COLORS.muted}" text-anchor="middle">${e}</text>`);
  o.push(`<text x="${f1((L + w - R) / 2)}" y="${h - 4}" font-size="10.5" fill="${COLORS.muted}" text-anchor="middle">Light at the corals (µmol m⁻² s⁻¹)</text>`);
  o.push(`<text x="${L + 3}" y="${Tp + 11}" font-size="10.5" fill="${COLORS.ink}">P / Pmax</text></svg>`);
  return o.join("");
}

/** Daily light at the corals through the deployment: open water and each kind of shading. */
export function dailyLightChart(days: [number, number, number][], lines: { y: number[]; color: string; name: string; dash?: string }[]): string {
  const w = 560, h = 300, L = 40, B = 26, Tp = 10, R = 12, n = days.length;
  const ymax = Math.max(1, ...lines.flatMap((l) => l.y)) * 1.06, st = niceStep(ymax, 5);
  const X = (i: number) => L + (n > 1 ? i / (n - 1) : 0.5) * (w - L - R), Y = (v: number) => Tp + (1 - v / ymax) * (h - Tp - B);
  const o: string[] = [`<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="Daily light at the corals through the deployment">`];
  for (let v = 0; v <= ymax; v += st) o.push(`<line x1="${L}" x2="${w - R}" y1="${f1(Y(v))}" y2="${f1(Y(v))}" stroke="${COLORS.grid}"/><text x="${L - 6}" y="${f1(Y(v) + 4)}" font-size="11" fill="${COLORS.muted}" text-anchor="end">${+v.toFixed(1)}</text>`);
  for (const l of lines) o.push(`<polyline points="${l.y.map((v, i) => `${f1(X(i))},${f1(Y(v))}`).join(" ")}" fill="none" stroke="${l.color}" stroke-width="${l.dash ? 1.6 : 2.2}"${l.dash ? ` stroke-dasharray="${l.dash}"` : ""}><title>${esc(l.name)}</title></polyline>`);
  // month ticks on the 1st; the first day is labeled only if no tick follows within 8 days
  const ticks: [number, string][] = [];
  days.forEach(([, m, d], i) => { if (d === 1) ticks.push([i, `${MON[m]} 1`]); });
  if (!ticks.length || ticks[0]![0] > 8) ticks.unshift([0, `${MON[days[0]![1]]} ${days[0]![2]}`]);
  for (const [i, lab] of ticks) o.push(`<line x1="${f1(X(i))}" x2="${f1(X(i))}" y1="${f1(Y(0))}" y2="${f1(Y(0) + 4)}" stroke="${COLORS.muted}"/><text x="${f1(X(i))}" y="${h - 8}" font-size="11" fill="${COLORS.muted}" text-anchor="middle">${lab}</text>`);
  o.push(`<text x="${L + 4}" y="${Tp + 10}" font-size="10.5" fill="${COLORS.muted}">mol m⁻² d⁻¹</text></svg>`);
  return o.join("");
}
