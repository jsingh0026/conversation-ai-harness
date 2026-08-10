import YAML from 'yaml';
import type { Provenance } from './types.js';

/** Leading `---\n<yaml>\n---\n` block (Open Knowledge Format frontmatter). */
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

const asDateString = (v: unknown): string | undefined => {
  if (v == null) return undefined;
  const t = Date.parse(v instanceof Date ? v.toISOString() : String(v));
  return Number.isNaN(t) ? String(v) : new Date(t).toISOString().slice(0, 10);
};

/**
 * Split OKF frontmatter from the markdown body. A doc with no frontmatter is
 * returned unchanged with no provenance (plain-markdown docs still work). The
 * frontmatter is always stripped from the body so it's never chunked/embedded.
 * We map the OKF fields we act on: `status`, latest `verified`, `stale_after`,
 * and the first `sources` id (citation key).
 */
export function parseOkf(content: string): { body: string; provenance?: Provenance } {
  const m = FRONTMATTER.exec(content);
  if (!m) return { body: content };

  const body = content.slice(m[0].length);
  let fm: Record<string, unknown>;
  try {
    fm = (YAML.parse(m[1]!) as Record<string, unknown>) ?? {};
  } catch {
    return { body }; // malformed frontmatter — still strip it, no provenance
  }

  const verifiedList = Array.isArray(fm.verified) ? fm.verified : [];
  const last = verifiedList[verifiedList.length - 1] as { by?: string; at?: unknown } | undefined;
  const source = (Array.isArray(fm.sources) ? fm.sources[0] : undefined) as
    | { id?: string }
    | undefined;

  const status = fm.status === 'draft' || fm.status === 'deprecated' ? fm.status : 'stable';
  const provenance: Provenance = {
    status,
    verifiedBy: last?.by,
    verifiedAt: asDateString(last?.at),
    staleAfter: asDateString(fm.stale_after),
    sourceId: source?.id,
  };
  return { body, provenance };
}
