/**
 * Returns true when two normalized tokens are identical or one edit apart.
 * Adjacent transpositions count as one edit, which is important for common
 * typing mistakes such as "macquaire" for "macquarie".
 */
export function isWithinOneEdit(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;

  if (left.length === right.length) {
    const differences: number[] = [];
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) differences.push(index);
      if (differences.length > 2) return false;
    }
    if (differences.length === 1) return true;
    return (
      differences.length === 2 &&
      differences[1] === differences[0] + 1 &&
      left[differences[0]] === right[differences[1]] &&
      left[differences[1]] === right[differences[0]]
    );
  }

  const [shorter, longer] =
    left.length < right.length ? [left, right] : [right, left];
  let shortIndex = 0;
  let longIndex = 0;
  let skipped = false;
  while (shortIndex < shorter.length && longIndex < longer.length) {
    if (shorter[shortIndex] === longer[longIndex]) {
      shortIndex += 1;
      longIndex += 1;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    longIndex += 1;
  }
  return true;
}

/**
 * Bounded Damerau-Levenshtein matching for long, distinctive catalog aliases.
 * This is intentionally separate from the one-edit safety matcher: entity
 * recovery can tolerate two independent transpositions only when the catalog
 * later proves the match is unique.
 */
export function isWithinTwoEdits(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 2) return false;
  const rows = left.length + 1;
  const columns = right.length + 1;
  const distance = Array.from({ length: rows }, () =>
    Array<number>(columns).fill(0)
  );
  for (let row = 0; row < rows; row += 1) distance[row][0] = row;
  for (let column = 0; column < columns; column += 1) {
    distance[0][column] = column;
  }
  for (let row = 1; row < rows; row += 1) {
    let rowMinimum = Number.POSITIVE_INFINITY;
    for (let column = 1; column < columns; column += 1) {
      const substitutionCost =
        left[row - 1] === right[column - 1] ? 0 : 1;
      distance[row][column] = Math.min(
        distance[row - 1][column] + 1,
        distance[row][column - 1] + 1,
        distance[row - 1][column - 1] + substitutionCost
      );
      if (
        row > 1 &&
        column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      ) {
        distance[row][column] = Math.min(
          distance[row][column],
          distance[row - 2][column - 2] + 1
        );
      }
      rowMinimum = Math.min(rowMinimum, distance[row][column]);
    }
    if (rowMinimum > 2) return false;
  }
  return distance[left.length][right.length] <= 2;
}
