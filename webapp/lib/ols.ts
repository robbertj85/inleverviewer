/**
 * Ordinary least squares with k-fold cross-validation, in the browser.
 *
 * Backs the "kies zelf variabelen" panel on the Schatting tab: the server
 * ships the fitted models it recommends, but a user picking their own feature
 * combination needs a fit without a round trip.
 *
 * Solved via the normal equations (XᵀX)β = Xᵀy with Gaussian elimination and
 * partial pivoting. That is numerically the weaker choice — squaring X squares
 * its condition number — but with at most a dozen columns of CBS statistics
 * and a ridge fallback for the singular case, it is well inside its comfort
 * zone and needs no matrix library.
 */

export interface OlsFit {
  intercept: number;
  /** One coefficient per feature, in the order they were passed. */
  coefficients: number[];
  /** In-sample R². Cannot fall when a feature is added. */
  r2: number;
  /** k-fold cross-validated R². The one worth comparing models on. */
  r2cv: number;
  r2cvStd: number;
  /** Rows that had a value for every feature and the target. */
  n: number;
  folds: number;
}

/** Tiny ridge term, only applied when the plain solve hits a zero pivot —
 * i.e. when two chosen variables are perfectly collinear. */
const RIDGE = 1e-8;

function solve(matrix: number[][], vector: number[]): number[] | null {
  const n = vector.length;
  // Work on copies; the caller may retry with a ridge term.
  const a = matrix.map((row, i) => [...row, vector[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];

    for (let row = col + 1; row < n; row++) {
      const factor = a[row][col] / a[col][col];
      if (factor === 0) continue;
      for (let k = col; k <= n; k++) a[row][k] -= factor * a[col][k];
    }
  }

  const out = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = a[row][n];
    for (let col = row + 1; col < n; col++) sum -= a[row][col] * out[col];
    out[row] = sum / a[row][row];
  }
  return out;
}

/** Fit β for a design matrix that already carries its intercept column. */
function fitBeta(design: number[][], y: number[]): number[] | null {
  const p = design[0].length;
  const xtx: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  const xty = new Array<number>(p).fill(0);

  for (let i = 0; i < design.length; i++) {
    const row = design[i];
    for (let j = 0; j < p; j++) {
      xty[j] += row[j] * y[i];
      for (let k = j; k < p; k++) xtx[j][k] += row[j] * row[k];
    }
  }
  for (let j = 0; j < p; j++) {
    for (let k = 0; k < j; k++) xtx[j][k] = xtx[k][j];
  }

  const beta = solve(xtx, xty);
  if (beta) return beta;

  // Perfectly collinear columns: nudge the diagonal so the solve completes.
  // The resulting coefficients are not individually meaningful, but the fit
  // still is, and returning null would just blank the panel.
  const scale = xtx[0][0] || 1;
  for (let j = 0; j < p; j++) xtx[j][j] += RIDGE * scale;
  return solve(xtx, xty);
}

function rSquared(actual: number[], predicted: number[]): number {
  const mean = actual.reduce((a, b) => a + b, 0) / actual.length;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < actual.length; i++) {
    ssRes += (actual[i] - predicted[i]) ** 2;
    ssTot += (actual[i] - mean) ** 2;
  }
  return ssTot === 0 ? 0 : 1 - ssRes / ssTot;
}

function predictWith(beta: number[], row: number[]): number {
  let sum = beta[0];
  for (let j = 0; j < row.length; j++) sum += beta[j + 1] * row[j];
  return sum;
}

/**
 * Deterministic shuffle so the same feature selection always yields the same
 * CV score — a number that moved on every re-render would be unusable.
 */
function seededOrder(n: number, seed = 20260801): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  let state = seed;
  for (let i = n - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const j = state % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

export function fitOls(
  rows: number[][],
  y: number[],
  folds = 5
): OlsFit | null {
  if (rows.length < 20 || rows[0].length === 0) return null;

  const design = rows.map((row) => [1, ...row]);
  const beta = fitBeta(design, y);
  if (!beta) return null;

  const fitted = rows.map((row) => predictWith(beta, row));
  const r2 = rSquared(y, fitted);

  // k-fold CV on a fixed shuffle.
  const order = seededOrder(rows.length);
  const usableFolds = Math.max(2, Math.min(folds, Math.floor(rows.length / 20)));
  const scores: number[] = [];
  for (let f = 0; f < usableFolds; f++) {
    const testIdx = order.filter((_, i) => i % usableFolds === f);
    const trainIdx = order.filter((_, i) => i % usableFolds !== f);
    if (testIdx.length < 2 || trainIdx.length <= rows[0].length + 1) continue;

    const trainBeta = fitBeta(
      trainIdx.map((i) => design[i]),
      trainIdx.map((i) => y[i])
    );
    if (!trainBeta) continue;
    const testActual = testIdx.map((i) => y[i]);
    const testPred = testIdx.map((i) => predictWith(trainBeta, rows[i]));
    scores.push(rSquared(testActual, testPred));
  }

  const r2cv = scores.length
    ? scores.reduce((a, b) => a + b, 0) / scores.length
    : r2;
  const variance = scores.length
    ? scores.reduce((a, b) => a + (b - r2cv) ** 2, 0) / scores.length
    : 0;

  return {
    intercept: beta[0],
    coefficients: beta.slice(1),
    r2,
    r2cv,
    r2cvStd: Math.sqrt(variance),
    n: rows.length,
    folds: scores.length || 1,
  };
}

/**
 * Variance inflation factor per feature: 1 / (1 − R²) of that feature
 * regressed on the others. Above 5 the coefficients start trading variance
 * between them and stop being individually readable.
 */
export function varianceInflationFactors(rows: number[][]): number[] {
  const p = rows[0]?.length ?? 0;
  if (p < 2) return new Array(p).fill(1);
  return Array.from({ length: p }, (_, target) => {
    const y = rows.map((row) => row[target]);
    const others = rows.map((row) => row.filter((_, j) => j !== target));
    const fit = fitOls(others, y, 2);
    if (!fit) return Number.POSITIVE_INFINITY;
    return fit.r2 >= 0.9999 ? Number.POSITIVE_INFINITY : 1 / (1 - fit.r2);
  });
}
