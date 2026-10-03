/** Map validation issue paths (`nodes[3].aims[0].metric`) to source ranges in YAML text. */
import { isMap, isSeq, parseDocument } from 'yaml';

/** Parse `nodes[3].aims[0].metric` into YAML path segments. */
export function issuePath(path: string): Array<string | number> {
  const out: Array<string | number> = [];
  for (const part of path.split('.')) {
    const re = /([^[\]]+)|\[(\d+)\]/g;
    let m: RegExpExecArray | null = re.exec(part);
    while (m) {
      if (m[1] !== undefined) out.push(m[1]);
      else if (m[2] !== undefined) out.push(Number(m[2]));
      m = re.exec(part);
    }
  }
  return out;
}

/** Source range of an issue path in the YAML text (falls back to the nearest existing parent). */
export function rangeOf(text: string, path: string): { from: number; to: number } {
  const firstLine = (from: number) => {
    const nl = text.indexOf('\n', from);
    return { from, to: Math.max(from + 1, nl < 0 ? text.length : nl) };
  };
  try {
    const doc = parseDocument(text);
    let segs = issuePath(path);
    let exact = true;
    while (segs.length) {
      const node = doc.getIn(segs, true) as { range?: [number, number, number] } | undefined;
      if (node && typeof node === 'object' && node.range) {
        // A missing field falls back to its parent: mark only the parent's first line.
        return exact
          ? { from: node.range[0], to: Math.max(node.range[1], node.range[0] + 1) }
          : firstLine(node.range[0]);
      }
      // Scalars: mark the key of the pair in the parent map.
      const parent = doc.getIn(segs.slice(0, -1), true) as unknown;
      const last = segs.at(-1);
      if (isMap(parent)) {
        const pair = parent.items.find((p) => (p.key as { value?: unknown })?.value === last);
        const r = (pair?.key as { range?: [number, number] } | undefined)?.range;
        if (r) return { from: r[0], to: r[1] };
      }
      if (isSeq(parent) && typeof last === 'number') {
        const item = parent.items[last] as { range?: [number, number] } | undefined;
        if (item?.range)
          return exact ? { from: item.range[0], to: item.range[1] } : firstLine(item.range[0]);
      }
      segs = segs.slice(0, -1);
      exact = false;
    }
  } catch {
    // fall through
  }
  return firstLine(0);
}
