import { describe, expect, it } from 'vitest';
import { chunkMarkdown } from './chunk.js';

describe('chunkMarkdown', () => {
  it('splits on headings and keeps them from straddling sections', () => {
    const doc = `# Fees\n\nIntro line.\n\n## Commission\n\nWe charge 5%.\n\n## Rentals\n\nWe charge 8%.`;
    const chunks = chunkMarkdown('fees', doc);

    expect(chunks.every((c) => c.title === 'Fees')).toBe(true);
    const sections = chunks.map((c) => c.section);
    expect(sections).toContain('Commission');
    expect(sections).toContain('Rentals');
    // Each section's chunk text is prefixed with its heading for embedding context.
    const commission = chunks.find((c) => c.section === 'Commission');
    expect(commission?.text).toContain('Commission');
    expect(commission?.text).toContain('5%');
    expect(commission?.text).not.toContain('8%'); // did not bleed into Rentals
  });

  it('assigns stable ids and the first heading as the title', () => {
    const chunks = chunkMarkdown('about', '# About Us\n\nWe are a brokerage.');
    expect(chunks[0]?.id).toBe('about#0');
    expect(chunks[0]?.title).toBe('About Us');
  });

  it('splits an over-long section into overlapping windows', () => {
    const long = 'sentence. '.repeat(400); // ~4000 chars
    const chunks = chunkMarkdown('big', `# Big\n\n${long}`);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= 2100)).toBe(true);
  });

  it('falls back to a title when there is no heading', () => {
    const chunks = chunkMarkdown('note', 'just some text with no heading');
    expect(chunks[0]?.title).toBe('just some text with no heading');
  });
});
