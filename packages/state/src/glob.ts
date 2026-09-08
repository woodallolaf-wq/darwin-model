/**
 * Glob intersection: could any single concrete path match both of these globs?
 *
 * This is the only genuinely subtle logic in the system. It decides whether two
 * live tasks own overlapping code, which is what stops two people implementing
 * adjacent things against contracts that quietly disagree.
 *
 * It is a deliberate port of the matcher in `tools/validate-state.js`, not an
 * independent implementation. That file must stay dependency-free CommonJS
 * because the daily routine runs it with a bare `node` in a fresh sandbox, so it
 * cannot import this one. Two implementations that disagree would be worse than
 * either — `test/glob.test.js` runs both against the same case table to make a
 * divergence impossible to merge.
 *
 * Both halves are language intersection, memoised so the recursion stays
 * polynomial rather than exponential on adversarial patterns like `a*a*a*a*b`.
 */

function splitGlob(glob: string): string[] {
  return glob.split("/").filter((s) => s.length > 0);
}

/** Within one path segment: `*` matches any run of characters, `?` exactly one. */
function charsIntersect(a: string, b: string): boolean {
  const memo = new Map<number, boolean>();

  const allStars = (s: string): boolean => [...s].every((c) => c === "*");

  const go = (i: number, j: number): boolean => {
    const key = i * (b.length + 1) + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let result: boolean;
    if (i === a.length && j === b.length) result = true;
    else if (i === a.length) result = allStars(b.slice(j));
    else if (j === b.length) result = allStars(a.slice(i));
    else if (a[i] === "*") result = go(i + 1, j) || go(i, j + 1);
    else if (b[j] === "*") result = go(i, j + 1) || go(i + 1, j);
    else if (a[i] === "?" || b[j] === "?" || a[i] === b[j]) result = go(i + 1, j + 1);
    else result = false;

    memo.set(key, result);
    return result;
  };

  return go(0, 0);
}

/** Across segments: `**` matches any number of segments, including none. */
function segmentsIntersect(a: string[], b: string[]): boolean {
  const memo = new Map<number, boolean>();

  const allDoubleStar = (segs: string[]): boolean => segs.every((s) => s === "**");

  const go = (i: number, j: number): boolean => {
    const key = i * (b.length + 1) + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let result: boolean;
    if (i === a.length && j === b.length) result = true;
    else if (i === a.length) result = allDoubleStar(b.slice(j));
    else if (j === b.length) result = allDoubleStar(a.slice(i));
    else if (a[i] === "**") result = go(i + 1, j) || go(i, j + 1);
    else if (b[j] === "**") result = go(i, j + 1) || go(i + 1, j);
    else result = charsIntersect(a[i] as string, b[j] as string) && go(i + 1, j + 1);

    memo.set(key, result);
    return result;
  };

  return go(0, 0);
}

/**
 * True when some concrete path would match both globs.
 *
 * `src/panel/**` and `src/panel/foo.ts` intersect — the case a naive string
 * comparison gets wrong, and the one the contract calls out by name.
 */
export function globsIntersect(a: string, b: string): boolean {
  return segmentsIntersect(splitGlob(a), splitGlob(b));
}

/** True when any path in `a` intersects any path in `b`. */
export function pathSetsIntersect(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.some((y) => globsIntersect(x, y)));
}

/** Every (a, b) pair that intersects. Useful for saying *why* a claim was refused. */
export function intersectingPairs(
  a: readonly string[],
  b: readonly string[]
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const x of a) {
    for (const y of b) {
      if (globsIntersect(x, y)) pairs.push([x, y]);
    }
  }
  return pairs;
}
