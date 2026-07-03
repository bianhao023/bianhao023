/**
 * Render a QR code as a self-contained SVG string (no external assets), so the
 * backend can serve a scannable image for WeChat/Alipay pay URLs and TRON
 * deposit addresses. SVG keeps the code crisp at any size and embeds cleanly as
 * a data URI.
 */

import { encodeToMatrix } from './qrEncoder';

export interface QrSvgOptions {
  /** Pixel size of one module (default 4). */
  moduleSize?: number;
  /** Quiet-zone width in modules (default 4, the spec minimum). */
  margin?: number;
}

/** Encode `text` and return an SVG document string. */
export function qrToSvg(text: string, opts: QrSvgOptions = {}): string {
  const { size, modules } = encodeToMatrix(text);
  const m = opts.moduleSize ?? 4;
  const margin = opts.margin ?? 4;
  const dim = (size + margin * 2) * m;

  let path = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!modules[r][c]) continue;
      const x = (c + margin) * m;
      const y = (r + margin) * m;
      path += `M${x} ${y}h${m}v${m}h-${m}z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" ` +
    `viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="#ffffff"/>` +
    `<path d="${path}" fill="#000000"/></svg>`
  );
}

/** Encode `text` as a `data:image/svg+xml;base64,…` URI (embeddable in JSON/HTML). */
export function qrToDataUri(text: string, opts: QrSvgOptions = {}): string {
  return 'data:image/svg+xml;base64,' + Buffer.from(qrToSvg(text, opts), 'utf8').toString('base64');
}
