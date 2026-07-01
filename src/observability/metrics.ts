/**
 * A tiny, dependency-free metrics registry that renders the Prometheus text
 * exposition format. Supports counters, gauges, histograms, and scrape-time
 * collectors (for gauges derived from current state, e.g. active subscriptions).
 */

type Labels = Record<string, string>;

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function seriesKey(labelNames: string[], labels: Labels): string {
  return labelNames.map((n) => `${n}=${labels[n] ?? ''}`).join('|');
}

function renderLabels(labelNames: string[], labels: Labels, extra?: [string, string]): string {
  const parts = labelNames.map((n) => `${n}="${escapeLabelValue(labels[n] ?? '')}"`);
  if (extra) parts.push(`${extra[0]}="${escapeLabelValue(extra[1])}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
}

export class Counter {
  private series = new Map<string, { labels: Labels; value: number }>();
  constructor(readonly name: string, readonly help: string, readonly labelNames: string[] = []) {}

  inc(labels: Labels = {}, value = 1): void {
    const key = seriesKey(this.labelNames, labels);
    const cur = this.series.get(key);
    if (cur) cur.value += value;
    else this.series.set(key, { labels, value });
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.series.values()) {
      lines.push(`${this.name}${renderLabels(this.labelNames, labels)} ${value}`);
    }
    return lines.join('\n');
  }
}

export class Gauge {
  private series = new Map<string, { labels: Labels; value: number }>();
  constructor(readonly name: string, readonly help: string, readonly labelNames: string[] = []) {}

  set(labels: Labels, value: number): void {
    this.series.set(seriesKey(this.labelNames, labels), { labels, value });
  }

  /** Replace all series (used by collectors that recompute a full set each scrape). */
  reset(): void {
    this.series.clear();
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const { labels, value } of this.series.values()) {
      lines.push(`${this.name}${renderLabels(this.labelNames, labels)} ${value}`);
    }
    return lines.join('\n');
  }
}

const DEFAULT_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

export class Histogram {
  private series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: string[] = [],
    readonly buckets: number[] = DEFAULT_BUCKETS,
  ) {}

  observe(labels: Labels, value: number): void {
    const key = seriesKey(this.labelNames, labels);
    let s = this.series.get(key);
    if (!s) {
      s = { labels, counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    s.sum += value;
    s.count += 1;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) s.counts[i] += 1;
    }
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this.series.values()) {
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        cumulative = s.counts[i];
        lines.push(`${this.name}_bucket${renderLabels(this.labelNames, s.labels, ['le', String(this.buckets[i])])} ${cumulative}`);
      }
      lines.push(`${this.name}_bucket${renderLabels(this.labelNames, s.labels, ['le', '+Inf'])} ${s.count}`);
      lines.push(`${this.name}_sum${renderLabels(this.labelNames, s.labels)} ${s.sum}`);
      lines.push(`${this.name}_count${renderLabels(this.labelNames, s.labels)} ${s.count}`);
    }
    return lines.join('\n');
  }
}

export class Metrics {
  private counters: Counter[] = [];
  private gauges: Gauge[] = [];
  private histograms: Histogram[] = [];
  private collectors: Array<() => void | Promise<void>> = [];

  counter(name: string, help: string, labelNames: string[] = []): Counter {
    const c = new Counter(name, help, labelNames);
    this.counters.push(c);
    return c;
  }
  gauge(name: string, help: string, labelNames: string[] = []): Gauge {
    const g = new Gauge(name, help, labelNames);
    this.gauges.push(g);
    return g;
  }
  histogram(name: string, help: string, labelNames: string[] = [], buckets?: number[]): Histogram {
    const h = new Histogram(name, help, labelNames, buckets);
    this.histograms.push(h);
    return h;
  }

  /** Register a function invoked at scrape time (typically to set gauges). */
  addCollector(fn: () => void | Promise<void>): void {
    this.collectors.push(fn);
  }

  async render(): Promise<string> {
    for (const c of this.collectors) await c();
    return [...this.counters, ...this.gauges, ...this.histograms]
      .map((m) => m.render())
      .join('\n\n') + '\n';
  }
}
