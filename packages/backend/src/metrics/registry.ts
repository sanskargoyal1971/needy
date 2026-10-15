/**
 * ── A minimal Prometheus registry ─────────────────────────────────────────
 *
 * Counters, gauges and histograms rendered in the Prometheus text exposition format (0.0.4).
 * Hand-rolled rather than `prom-client` because the backend takes no new dependencies for
 * operations tooling, and the subset needed here is small enough to own outright.
 *
 * Label NAMES are fixed when a metric is declared and every sample must supply exactly those.
 * That is deliberate: the usual way a metrics endpoint leaks personal data, or melts the
 * time-series database, is somebody passing an open-ended value — a user id, a raw URL with a
 * phone number in its query string — as a label. Declaring the names up front does not stop a
 * bad value, but it makes every label a reviewed decision instead of an ad-hoc object literal,
 * and a typo'd or extra label is a thrown error in tests rather than a silent new series.
 */

export type Labels = Record<string, string>;

/** A function run before every render to refresh gauges that are read rather than pushed
 *  (socket counts, open alarms, dependency probes). */
export type Collector = () => void | Promise<void>;

/** Prometheus metric and label names. Checked at declaration, so a bad name fails at boot. */
const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Escaping from the exposition format spec: backslash, double quote and newline. */
function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function escapeHelp(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

/** Prometheus spells the non-finite values its own way; `String(Infinity)` is not one of them. */
function formatValue(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (n === Infinity) return "+Inf";
  if (n === -Infinity) return "-Inf";
  return String(n);
}

function renderLabels(names: readonly string[], values: readonly string[], extra?: string): string {
  const parts = names.map((n, i) => `${n}="${escapeLabelValue(values[i]!)}"`);
  if (extra) parts.push(extra);
  return parts.length > 0 ? `{${parts.join(",")}}` : "";
}

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[],
  ) {
    if (!METRIC_NAME.test(name)) throw new Error(`invalid metric name: ${name}`);
    for (const l of labelNames) {
      if (!LABEL_NAME.test(l) || l.startsWith("__") || l === "le") {
        throw new Error(`invalid label name on ${name}: ${l}`);
      }
    }
  }

  abstract readonly type: "counter" | "gauge" | "histogram";

  /** The label values in declaration order, as the series key. Throws on a missing or extra
   *  label — see the note at the top of this file. */
  protected key(labels: Labels | undefined): string[] {
    const given = labels ?? {};
    const keys = Object.keys(given);
    if (keys.length !== this.labelNames.length || keys.some((k) => !this.labelNames.includes(k))) {
      throw new Error(
        `${this.name} takes labels [${this.labelNames.join(", ")}], got [${keys.join(", ")}]`,
      );
    }
    return this.labelNames.map((n) => String(given[n]));
  }

  abstract renderSamples(): string[];

  render(): string {
    return [
      `# HELP ${this.name} ${escapeHelp(this.help)}`,
      `# TYPE ${this.name} ${this.type}`,
      ...this.renderSamples(),
    ].join("\n");
  }
}

export class Counter extends Metric {
  readonly type = "counter" as const;
  private readonly series = new Map<string, { values: string[]; n: number }>();

  inc(labels?: Labels, by = 1): void {
    // A counter that goes down is a gauge; Prometheus' rate() would read it as a restart.
    if (!(by >= 0)) throw new Error(`${this.name}: counters only increase`);
    const values = this.key(labels);
    const id = JSON.stringify(values);
    const s = this.series.get(id) ?? { values, n: 0 };
    s.n += by;
    this.series.set(id, s);
  }

  /** For tests. */
  get(labels?: Labels): number {
    return this.series.get(JSON.stringify(this.key(labels)))?.n ?? 0;
  }

  renderSamples(): string[] {
    return [...this.series.values()].map(
      (s) => `${this.name}${renderLabels(this.labelNames, s.values)} ${formatValue(s.n)}`,
    );
  }
}

export class Gauge extends Metric {
  readonly type = "gauge" as const;
  private readonly series = new Map<string, { values: string[]; n: number }>();

  set(labels: Labels | undefined, value: number): void {
    const values = this.key(labels);
    this.series.set(JSON.stringify(values), { values, n: value });
  }

  /** Drop every sample. A collector whose source failed calls this, so the scrape shows the
   *  value as ABSENT rather than repeating the last good reading — a stale "0 open alarms"
   *  is the most dangerous number this endpoint could serve. */
  clear(): void {
    this.series.clear();
  }

  /** For tests. */
  get(labels?: Labels): number | undefined {
    return this.series.get(JSON.stringify(this.key(labels)))?.n;
  }

  renderSamples(): string[] {
    return [...this.series.values()].map(
      (s) => `${this.name}${renderLabels(this.labelNames, s.values)} ${formatValue(s.n)}`,
    );
  }
}

export class Histogram extends Metric {
  readonly type = "histogram" as const;
  private readonly buckets: readonly number[];
  private readonly series = new Map<
    string,
    { values: string[]; counts: number[]; sum: number; count: number }
  >();

  constructor(name: string, help: string, labelNames: readonly string[], buckets: number[]) {
    super(name, help, labelNames);
    const sorted = [...buckets].sort((a, b) => a - b);
    if (sorted.length === 0 || sorted.some((b) => !Number.isFinite(b))) {
      throw new Error(`${name}: buckets must be finite and non-empty`);
    }
    this.buckets = sorted;
  }

  observe(labels: Labels | undefined, value: number): void {
    const values = this.key(labels);
    const id = JSON.stringify(values);
    const s = this.series.get(id) ?? {
      values,
      counts: this.buckets.map(() => 0),
      sum: 0,
      count: 0,
    };
    // Per-bucket counts are stored non-cumulatively and summed at render.
    const i = this.buckets.findIndex((b) => value <= b);
    if (i >= 0) s.counts[i]! += 1;
    s.sum += value;
    s.count += 1;
    this.series.set(id, s);
  }

  /** For tests: how many observations a series has. */
  count(labels?: Labels): number {
    return this.series.get(JSON.stringify(this.key(labels)))?.count ?? 0;
  }

  renderSamples(): string[] {
    const out: string[] = [];
    for (const s of this.series.values()) {
      let cumulative = 0;
      this.buckets.forEach((b, i) => {
        cumulative += s.counts[i]!;
        out.push(
          `${this.name}_bucket${renderLabels(this.labelNames, s.values, `le="${formatValue(b)}"`)} ${cumulative}`,
        );
      });
      out.push(
        `${this.name}_bucket${renderLabels(this.labelNames, s.values, 'le="+Inf"')} ${s.count}`,
      );
      out.push(`${this.name}_sum${renderLabels(this.labelNames, s.values)} ${formatValue(s.sum)}`);
      out.push(`${this.name}_count${renderLabels(this.labelNames, s.values)} ${s.count}`);
    }
    return out;
  }
}

export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();
  private readonly collectors: { name: string; run: Collector }[] = [];

  private add<M extends Metric>(m: M): M {
    if (this.metrics.has(m.name)) throw new Error(`metric already registered: ${m.name}`);
    this.metrics.set(m.name, m);
    return m;
  }

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    return this.add(new Counter(name, help, labelNames));
  }

  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    return this.add(new Gauge(name, help, labelNames));
  }

  histogram(
    name: string,
    help: string,
    labelNames: readonly string[],
    buckets: number[],
  ): Histogram {
    return this.add(new Histogram(name, help, labelNames, buckets));
  }

  /** Register a scrape-time refresh. Named so a failing one can be reported by name. */
  collect(name: string, run: Collector): void {
    this.collectors.push({ name, run });
  }

  /**
   * Run every collector, then render. A collector that throws does not fail the scrape — the
   * rest of the numbers are still worth having during exactly the incident that broke it — but
   * it is handed back to the caller to log and count.
   */
  async render(): Promise<{ text: string; failed: { name: string; err: unknown }[] }> {
    const failed: { name: string; err: unknown }[] = [];
    for (const c of this.collectors) {
      try {
        await c.run();
      } catch (err) {
        failed.push({ name: c.name, err });
      }
    }
    const text = [...this.metrics.values()].map((m) => m.render()).join("\n") + "\n";
    return { text, failed };
  }
}
