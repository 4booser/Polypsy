/**
 * Счётчики для Prometheus.
 *
 * Держим в памяти процесса и отдаём текстом: тянуть зависимость ради
 * четырёх типов метрик незачем, а формат простой и стабильный.
 *
 * Важное ограничение, о котором надо помнить при чтении цифр: счётчики
 * обнуляются при перезапуске и живут в одном процессе. При нескольких
 * репликах их надо складывать на стороне сбора — Prometheus это умеет, но
 * «всего запросов» с одного узла не равно «всего по системе».
 */

interface Histogram {
  /** Границы в миллисекундах */
  buckets: number[];
  counts: number[];
  sum: number;
  total: number;
}

const LATENCY_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

const counters = new Map<string, number>();
const gauges = new Map<string, number>();
const histograms = new Map<string, Histogram>();

/** Ключ «имя{метка="значение"}» — так же, как метрика выглядит в выдаче */
function key(name: string, labels: Record<string, string | number> = {}): string {
  const parts = Object.entries(labels)
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, "")}"`)
    .join(",");
  return parts ? `${name}{${parts}}` : name;
}

export function inc(name: string, labels?: Record<string, string | number>, by = 1): void {
  const k = key(name, labels);
  counters.set(k, (counters.get(k) ?? 0) + by);
}

export function setGauge(name: string, value: number, labels?: Record<string, string | number>): void {
  gauges.set(key(name, labels), value);
}

export function observe(name: string, ms: number, labels?: Record<string, string | number>): void {
  const k = key(name, labels);
  let h = histograms.get(k);
  if (!h) {
    h = { buckets: LATENCY_BUCKETS, counts: new Array(LATENCY_BUCKETS.length + 1).fill(0), sum: 0, total: 0 };
    histograms.set(k, h);
  }
  h.sum += ms;
  h.total++;
  const idx = h.buckets.findIndex((b) => ms <= b);
  h.counts[idx === -1 ? h.buckets.length : idx]!++;
}

/** Разбирает «имя{метки}» обратно, чтобы приписать суффикс к имени, а не к меткам */
function split(k: string): { name: string; labels: string } {
  const i = k.indexOf("{");
  return i === -1 ? { name: k, labels: "" } : { name: k.slice(0, i), labels: k.slice(i) };
}

export function render(): string {
  const lines: string[] = [];

  for (const [k, v] of counters) {
    const { name, labels } = split(k);
    lines.push(`${name}_total${labels} ${v}`);
  }
  for (const [k, v] of gauges) {
    lines.push(`${k} ${v}`);
  }
  for (const [k, h] of histograms) {
    const { name, labels } = split(k);
    const inner = labels.slice(1, -1);
    let cumulative = 0;
    for (let i = 0; i < h.buckets.length; i++) {
      cumulative += h.counts[i]!;
      const le = `le="${h.buckets[i]}"`;
      lines.push(`${name}_bucket{${inner ? inner + "," : ""}${le}} ${cumulative}`);
    }
    cumulative += h.counts[h.buckets.length]!;
    lines.push(`${name}_bucket{${inner ? inner + "," : ""}le="+Inf"} ${cumulative}`);
    lines.push(`${name}_sum${labels} ${h.sum}`);
    lines.push(`${name}_count${labels} ${h.total}`);
  }

  return lines.join("\n") + "\n";
}

/** Только для тестов: между проверками счётчики не должны протекать */
export function resetMetrics(): void {
  counters.clear();
  gauges.clear();
  histograms.clear();
}
