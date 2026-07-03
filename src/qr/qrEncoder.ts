/**
 * Minimal, dependency-free QR Code encoder (ISO/IEC 18004).
 *
 * Scope is deliberately bounded to what this payment backend needs to render a
 * scannable code for a WeChat `code_url`, an Alipay `qr_code` URL, or a TRON
 * deposit address:
 *   - modes: numeric and 8-bit byte (UTF-8) — byte mode covers every payload
 *     here (URLs, base58 addresses); numeric is included mainly so the pipeline
 *     is exercised by the ISO worked example.
 *   - error-correction level: M (the payment-friendly default).
 *   - versions: 1–10 (symbol sizes 21×21 … 57×57), enough for any URL/address
 *     we produce; larger payloads throw rather than silently truncate.
 *
 * The Galois-field and Reed–Solomon primitives are exported so they can be
 * unit-tested against the published QR reference values.
 */

// ── Galois field GF(256), primitive polynomial 0x11D ────────────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGf(): void {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

/** Multiply two GF(256) elements. */
export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** Discrete log (base α) of a non-zero GF(256) element. Exposed for tests. */
export function gfLog(x: number): number {
  return LOG[x];
}

/**
 * Reed–Solomon generator polynomial for `degree` EC codewords, returned as
 * coefficients (index 0 = highest degree, leading coefficient 1).
 */
export function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Reed–Solomon EC codewords for a data block. */
export function rsEncode(data: number[], ecLen: number): number[] {
  const gen = rsGenerator(ecLen); // length ecLen+1
  const res = new Array<number>(ecLen).fill(0);
  for (const b of data) {
    const factor = b ^ res[0];
    res.shift();
    res.push(0);
    if (factor !== 0) {
      for (let i = 0; i < ecLen; i++) res[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return res;
}

// ── EC level M block structure, versions 1..10 ──────────────────────────────
// [ecCodewordsPerBlock, group1Blocks, group1DataCw, group2Blocks, group2DataCw]
const EC_M: Record<number, [number, number, number, number, number]> = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],
  8: [22, 2, 38, 2, 39],
  9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
};

/** Alignment-pattern centre coordinates per version. */
const ALIGN: Record<number, number[]> = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

const MAX_VERSION = 10;

function totalDataCodewords(version: number): number {
  const [, g1b, g1d, g2b, g2d] = EC_M[version];
  return g1b * g1d + g2b * g2d;
}

type Mode = 'numeric' | 'byte';

function detectMode(text: string): Mode {
  return /^[0-9]*$/.test(text) ? 'numeric' : 'byte';
}

/** Character-count-indicator length in bits, by mode and version group. */
function countBits(mode: Mode, version: number): number {
  if (version <= 9) return mode === 'numeric' ? 10 : 8;
  return mode === 'numeric' ? 12 : 16; // versions 10–26
}

// ── Bit buffer ──────────────────────────────────────────────────────────────
class BitBuffer {
  bits: number[] = [];
  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length(): number {
    return this.bits.length;
  }
}

function encodeData(text: string, mode: Mode, version: number): BitBuffer {
  const buf = new BitBuffer();
  const bytes = Buffer.from(text, 'utf8');
  const charCount = mode === 'numeric' ? text.length : bytes.length;
  buf.put(mode === 'numeric' ? 0b0001 : 0b0100, 4); // mode indicator
  buf.put(charCount, countBits(mode, version));
  if (mode === 'numeric') {
    for (let i = 0; i < text.length; i += 3) {
      const group = text.slice(i, i + 3);
      buf.put(parseInt(group, 10), group.length === 3 ? 10 : group.length === 2 ? 7 : 4);
    }
  } else {
    for (const b of bytes) buf.put(b, 8);
  }
  return buf;
}

/** Choose the smallest version (1..10) whose EC-M capacity fits the content. */
function chooseVersion(text: string, mode: Mode): number {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const capacityBits = totalDataCodewords(v) * 8;
    const need = 4 + countBits(mode, v) +
      (mode === 'numeric'
        ? Math.floor(text.length / 3) * 10 + [(0), 4, 7][text.length % 3]
        : Buffer.from(text, 'utf8').length * 8);
    if (need <= capacityBits) return v;
  }
  throw new Error(`content too large for a version-${MAX_VERSION} QR code (${text.length} chars)`);
}

/** Build the final, interleaved codeword stream (data + EC) for the symbol. */
function buildCodewords(text: string, mode: Mode, version: number): number[] {
  const [ecPerBlock, g1b, g1d, g2b, g2d] = EC_M[version];
  const totalData = totalDataCodewords(version);
  const buf = encodeData(text, mode, version);

  // Terminator (up to 4 zero bits) + pad to a byte boundary.
  const capacityBits = totalData * 8;
  for (let i = 0; i < 4 && buf.length < capacityBits; i++) buf.bits.push(0);
  while (buf.length % 8 !== 0) buf.bits.push(0);

  // Data codewords, then alternating pad bytes 0xEC / 0x11.
  const data: number[] = [];
  for (let i = 0; i < buf.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | buf.bits[i + j];
    data.push(byte);
  }
  const pads = [0xec, 0x11];
  for (let i = 0; data.length < totalData; i++) data.push(pads[i % 2]);

  // Split into blocks, compute EC per block.
  const blocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (let b = 0; b < g1b + g2b; b++) {
    const size = b < g1b ? g1d : g2d;
    const block = data.slice(offset, offset + size);
    offset += size;
    blocks.push(block);
    ecBlocks.push(rsEncode(block, ecPerBlock));
  }

  // Interleave data codewords, then EC codewords.
  const out: number[] = [];
  const maxData = Math.max(g1d, g2d);
  for (let i = 0; i < maxData; i++) {
    for (const block of blocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const ec of ecBlocks) out.push(ec[i]);
  }
  return out;
}

// ── Symbol matrix ───────────────────────────────────────────────────────────
export interface QrMatrix {
  size: number;
  version: number;
  mask: number;
  /** Row-major modules; true = dark. */
  modules: boolean[][];
}

function maskFn(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

function bchFormat(data: number): number {
  let d = data << 10;
  while (bitLen(d) - 11 >= 0) d ^= 0x537 << (bitLen(d) - 11);
  return ((data << 10) | d) ^ 0x5412;
}

function bchVersion(version: number): number {
  let d = version << 12;
  while (bitLen(d) - 13 >= 0) d ^= 0x1f25 << (bitLen(d) - 13);
  return (version << 12) | d;
}

function bitLen(n: number): number {
  let len = 0;
  while (n !== 0) {
    len++;
    n >>>= 1;
  }
  return len;
}

interface Layout {
  size: number;
  /** Function-pattern modules placed; data cells are null. */
  base: (boolean | null)[][];
  /** Cells occupied by function patterns / format / version info. */
  reserved: boolean[][];
}

/** Build the fixed function patterns + reserved-cell map for a version. */
function functionLayout(version: number): Layout {
  const size = 17 + version * 4;
  const base: (boolean | null)[][] = Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null));
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  const setFn = (r: number, c: number, v: boolean): void => {
    base[r][c] = v;
    reserved[r][c] = true;
  };

  // Finder patterns + separators at the three corners.
  const placeFinder = (r0: number, c0: number): void => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const inRing = r >= 0 && r <= 6 && c >= 0 && c <= 6 &&
          (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        setFn(rr, cc, inRing);
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }

  // Alignment patterns (skip where they would collide with a finder).
  const centres = ALIGN[version];
  for (const r of centres) {
    for (const c of centres) {
      if (reserved[r][c]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          setFn(r + dr, c + dc, ring !== 1);
        }
      }
    }
  }

  // Dark module + reserve format-info areas.
  setFn(size - 8, 8, true);
  for (let i = 0; i <= 8; i++) {
    reserved[8][i] = true;
    reserved[i][8] = true;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }

  // Reserve version-info areas (versions 7+).
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        reserved[i][size - 11 + j] = true;
        reserved[size - 11 + j][i] = true;
      }
    }
  }

  return { size, base, reserved };
}

/** Encode `text` into a masked QR matrix (EC level M). */
export function encodeToMatrix(text: string): QrMatrix {
  const mode = detectMode(text);
  const version = chooseVersion(text, mode);
  const codewords = buildCodewords(text, mode, version);
  const { size, base, reserved } = functionLayout(version);
  const modules: (boolean | null)[][] = base.map((row) => row.slice());

  // Place data bits in the zig-zag pattern, skipping reserved modules.
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip the vertical timing column
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (reserved[row][c]) continue;
        let dark = false;
        if (bitIndex < totalBits) {
          const byte = codewords[bitIndex >> 3];
          dark = ((byte >> (7 - (bitIndex & 7))) & 1) === 1;
          bitIndex++;
        }
        modules[row][c] = dark;
      }
    }
    upward = !upward;
  }

  // Choose the mask with the lowest penalty.
  let best = { mask: 0, penalty: Infinity, grid: [] as boolean[][] };
  for (let mask = 0; mask < 8; mask++) {
    const grid = modules.map((row, r) => row.map((v, c) => (reserved[r][c] ? v === true : (v === true) !== maskFn(mask, r, c))));
    writeFormat(grid, reserved, mask, size);
    if (version >= 7) writeVersion(grid, version, size);
    const penalty = scorePenalty(grid, size);
    if (penalty < best.penalty) best = { mask, penalty, grid };
  }

  return { size, version, mask: best.mask, modules: best.grid };
}

/** Write the 15-bit format information (EC level M) for `mask` into both copies. */
function writeFormat(grid: boolean[][], reserved: boolean[][], mask: number, size: number): void {
  const format = bchFormat((0b00 << 3) | mask); // EC level M = 00
  const bit = (i: number): boolean => ((format >> i) & 1) === 1;
  // Copy 1 — around the top-left finder.
  for (let i = 0; i <= 5; i++) grid[8][i] = bit(i);
  grid[8][7] = bit(6);
  grid[8][8] = bit(7);
  grid[7][8] = bit(8);
  for (let i = 9; i <= 14; i++) grid[14 - i][8] = bit(i);
  // Copy 2 — split across the other two finders.
  for (let i = 0; i <= 7; i++) grid[size - 1 - i][8] = bit(i);
  for (let i = 8; i <= 14; i++) grid[8][size - 15 + i] = bit(i);
  void reserved;
}

/** Write the 18-bit version information (versions 7+). */
function writeVersion(grid: boolean[][], version: number, size: number): void {
  const info = bchVersion(version);
  for (let i = 0; i < 18; i++) {
    const bit = ((info >> i) & 1) === 1;
    const r = Math.floor(i / 3);
    const c = i % 3;
    grid[r][size - 11 + c] = bit;
    grid[size - 11 + c][r] = bit;
  }
}

/** Penalty score used for mask selection (ISO rules 1–4). */
function scorePenalty(grid: boolean[][], size: number): number {
  let penalty = 0;
  // Rule 1: runs of 5+ same-colour modules in rows and columns.
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      // rows
      let run = 1;
      while (c + run < size && grid[r][c + run] === grid[r][c]) run++;
      if (run >= 5) { penalty += 3 + (run - 5); c += run - 1; }
    }
  }
  for (let c = 0; c < size; c++) {
    for (let r = 0; r < size; r++) {
      let run = 1;
      while (r + run < size && grid[r + run][c] === grid[r][c]) run++;
      if (run >= 5) { penalty += 3 + (run - 5); r += run - 1; }
    }
  }
  // Rule 2: 2×2 blocks of the same colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = grid[r][c];
      if (grid[r][c + 1] === v && grid[r + 1][c] === v && grid[r + 1][c + 1] === v) penalty += 3;
    }
  }
  // Rule 3: finder-like 1:1:3:1:1 patterns in rows and columns.
  const pat1 = [true, false, true, true, true, false, true, false, false, false, false];
  const pat2 = [false, false, false, false, true, false, true, true, true, false, true];
  const matches = (line: boolean[], i: number, pat: boolean[]): boolean =>
    pat.every((p, k) => line[i + k] === p);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c <= size - 11; c++) {
      if (matches(grid[r], c, pat1) || matches(grid[r], c, pat2)) penalty += 40;
    }
  }
  for (let c = 0; c < size; c++) {
    const col = grid.map((row) => row[c]);
    for (let r = 0; r <= size - 11; r++) {
      if (matches(col, r, pat1) || matches(col, r, pat2)) penalty += 40;
    }
  }
  // Rule 4: dark-module proportion.
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (grid[r][c]) dark++;
  const ratio = (dark * 100) / (size * size);
  penalty += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return penalty;
}

/**
 * TEST-ONLY companion decoder: recover the encoded text from a matrix, reusing
 * the same layout/mask logic (no Reed–Solomon error correction — it reads the
 * data codewords directly). A round-trip encode→decode proves the data packing,
 * interleaving, zig-zag placement and masking are mutual inverses.
 */
export function decodeForTest(qr: QrMatrix): string {
  const { reserved } = functionLayout(qr.version);

  // Read data modules in the same zig-zag order, reversing the mask.
  const bits: number[] = [];
  let upward = true;
  for (let col = qr.size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < qr.size; i++) {
      const row = upward ? qr.size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (reserved[row][c]) continue;
        bits.push(qr.modules[row][c] !== maskFn(qr.mask, row, c) ? 1 : 0);
      }
    }
    upward = !upward;
  }

  // Bits → codeword stream → de-interleave data codewords.
  const stream: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    stream.push(b);
  }
  const [, g1b, g1d, g2b, g2d] = EC_M[qr.version];
  const blockSizes = [...Array(g1b).fill(g1d), ...Array(g2b).fill(g2d)];
  const blocks: number[][] = blockSizes.map(() => []);
  let idx = 0;
  const maxData = Math.max(g1d, g2d);
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < blocks.length; b++) if (i < blockSizes[b]) blocks[b].push(stream[idx++]);
  }
  const data: number[] = [];
  for (const bl of blocks) data.push(...bl);

  // Parse mode + count + payload.
  const bb: number[] = [];
  for (const byte of data) for (let j = 7; j >= 0; j--) bb.push((byte >> j) & 1);
  let p = 0;
  const take = (n: number): number => {
    let v = 0;
    for (let k = 0; k < n; k++) v = (v << 1) | bb[p++];
    return v;
  };
  const mode = take(4);
  if (mode === 0b0001) {
    let count = take(countBits('numeric', qr.version));
    let out = '';
    while (count >= 3) { out += String(take(10)).padStart(3, '0'); count -= 3; }
    if (count === 2) out += String(take(7)).padStart(2, '0');
    else if (count === 1) out += String(take(4));
    return out;
  }
  const count = take(countBits('byte', qr.version));
  const bytes: number[] = [];
  for (let i = 0; i < count; i++) bytes.push(take(8));
  return Buffer.from(bytes).toString('utf8');
}
