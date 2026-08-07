import type { Chunk } from './types.js';

/** ~500 tokens ≈ 2000 chars; overlap keeps context across window boundaries. */
const MAX_CHARS = 2000;
const OVERLAP_CHARS = 200;

interface Section {
  heading?: string;
  body: string;
}

/**
 * Split a markdown doc into heading-aware chunks. Sections (delimited by `#`/
 * `##` headings) are the primary unit so a chunk never straddles topics; only
 * an over-long section is further split with a sliding window + overlap.
 *
 * The first `#`/`##` heading becomes the doc title.
 */
export function chunkMarkdown(docId: string, content: string): Chunk[] {
  const { title, sections } = splitSections(content);
  const chunks: Chunk[] = [];

  for (const section of sections) {
    const body = section.body.trim();
    if (!body) continue;
    for (const piece of slidingWindow(body)) {
      chunks.push({
        id: `${docId}#${chunks.length}`,
        docId,
        title,
        section: section.heading,
        // Prefix the heading so the embedding captures the section topic.
        text: section.heading ? `${section.heading}\n${piece}` : piece,
      });
    }
  }

  return chunks;
}

function splitSections(content: string): { title: string; sections: Section[] } {
  const lines = content.split('\n');
  const sections: Section[] = [];
  let title = '';
  let current: Section = { body: '' };

  const push = (): void => {
    if (current.heading !== undefined || current.body.trim()) sections.push(current);
  };

  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const text = heading[2]!.trim();
      if (!title) title = text; // first heading = doc title
      push();
      current = { heading: text, body: '' };
    } else {
      current.body += line + '\n';
    }
  }
  push();

  if (!title) title = docTitleFallback(content);
  return { title, sections };
}

function docTitleFallback(content: string): string {
  const firstLine = content.split('\n').find((l) => l.trim().length > 0);
  return firstLine?.trim().slice(0, 80) ?? 'Untitled';
}

/** Split text into ≤MAX_CHARS windows on paragraph/sentence boundaries with overlap. */
function slidingWindow(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];

  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + MAX_CHARS, text.length);
    if (end < text.length) {
      // Prefer to break at a paragraph or sentence boundary near the window end.
      const slice = text.slice(start, end);
      const brk = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('. '));
      if (brk > MAX_CHARS * 0.5) end = start + brk + 1;
    }
    pieces.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(end - OVERLAP_CHARS, start + 1);
  }
  return pieces;
}
