export function innerGridLines(start: number, span: number, sections: number) {
  return Array.from(
    { length: Math.max(sections - 1, 0) },
    (_, i) => start + (span * (i + 1)) / sections
  );
}
