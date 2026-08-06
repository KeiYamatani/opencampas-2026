export type ComparisonResponse = "longer" | "shorter";

export type ComparisonObservation = {
  ratio: 2 | 4 | 8;
  correctResponse: ComparisonResponse;
  response: ComparisonResponse | null;
  rtFromOffset: number | null;
};

export type ComparisonDdmFit = {
  drift: number;
  evidenceStrength: number;
  intervalLow: number;
  intervalHigh: number;
  logLikelihood: number;
  count: number;
  correct: number;
  timeouts: number;
  boundaryHit: boolean;
};

export const COMPARISON_DDM_SETTINGS = {
  boundary: 1,
  start: 0.5,
  noise: 1,
  nonDecisionMs: 100,
  responseWindowMs: 1800,
} as const;

const GRID_STEP = 0.05;
const GRID_LIMIT = 5;
const SERIES_TERMS = 48;
const CDF_STEP_MS = 4;
const EPSILON = 1e-12;

/** First-passage density to the upper boundary of a two-choice DDM. */
function upperBoundaryDensity(decisionTimeMs: number, drift: number) {
  const { boundary, start, noise } = COMPARISON_DDM_SETTINGS;
  const time = decisionTimeMs / 1000;
  if (time <= 0) return 0;

  let series = 0;
  for (let n = 1; n <= SERIES_TERMS; n += 1) {
    const eigenvalue = n * Math.PI / boundary;
    series += n
      * Math.sin(n * Math.PI * (boundary - start) / boundary)
      * Math.exp(-(eigenvalue * eigenvalue * noise * noise * time) / 2);
  }
  const tilt = Math.exp(
    drift * (boundary - start) / (noise * noise)
      - (drift * drift * time) / (2 * noise * noise),
  );
  return Math.max(0, (Math.PI / (boundary * boundary)) * tilt * series);
}

function upperBoundaryProbability(decisionDeadlineMs: number, drift: number) {
  if (decisionDeadlineMs <= 0) return 0;
  let probability = 0;
  let previous = 0;
  for (let time = CDF_STEP_MS; time <= decisionDeadlineMs; time += CDF_STEP_MS) {
    const density = upperBoundaryDensity(time, drift);
    probability += (previous + density) / 2 * (CDF_STEP_MS / 1000);
    previous = density;
  }
  const remainder = decisionDeadlineMs % CDF_STEP_MS;
  if (remainder) {
    const density = upperBoundaryDensity(decisionDeadlineMs, drift);
    probability += (previous + density) / 2 * (remainder / 1000);
  }
  return Math.min(1 - EPSILON, Math.max(EPSILON, probability));
}

function logLikelihoodForDrift(observations: ComparisonObservation[], drift: number) {
  const decisionDeadline = COMPARISON_DDM_SETTINGS.responseWindowMs - COMPARISON_DDM_SETTINGS.nonDecisionMs;
  const upperProbability = upperBoundaryProbability(decisionDeadline, drift);
  const lowerProbability = upperBoundaryProbability(decisionDeadline, -drift);
  const timeoutProbability = Math.max(EPSILON, 1 - upperProbability - lowerProbability);

  return observations.reduce((logLikelihood, observation) => {
    if (observation.response === null || observation.rtFromOffset === null) {
      return logLikelihood + Math.log(timeoutProbability);
    }
    const correct = observation.response === observation.correctResponse;
    const signedDrift = correct ? drift : -drift;
    const densityPerSecond = upperBoundaryDensity(
      observation.rtFromOffset - COMPARISON_DDM_SETTINGS.nonDecisionMs,
      signedDrift,
    );
    return logLikelihood + Math.log(Math.max(EPSILON, densityPerSecond / 1000));
  }, 0);
}

/**
 * Fits a two-boundary DDM separately for each duration-ratio condition.
 * The correct response is coded as the upper boundary, so positive drift
 * represents evidence toward the objectively correct longer/shorter choice.
 */
export function fitComparisonDdm(observations: ComparisonObservation[]): ComparisonDdmFit | null {
  if (!observations.length) return null;
  const candidates = Array.from(
    { length: Math.round((GRID_LIMIT * 2) / GRID_STEP) + 1 },
    (_, index) => Number((-GRID_LIMIT + index * GRID_STEP).toFixed(2)),
  );
  const scored = candidates.map(drift => ({ drift, logLikelihood: logLikelihoodForDrift(observations, drift) }));
  const best = scored.reduce((current, candidate) => candidate.logLikelihood > current.logLikelihood ? candidate : current);
  const plausible = scored.filter(candidate => candidate.logLikelihood >= best.logLikelihood - 1.92);
  return {
    drift: best.drift,
    evidenceStrength: Math.abs(best.drift),
    intervalLow: plausible[0]?.drift ?? best.drift,
    intervalHigh: plausible[plausible.length - 1]?.drift ?? best.drift,
    logLikelihood: best.logLikelihood,
    count: observations.length,
    correct: observations.filter(observation => observation.response === observation.correctResponse).length,
    timeouts: observations.filter(observation => observation.response === null).length,
    boundaryHit: Math.abs(best.drift) >= GRID_LIMIT,
  };
}

export function formatComparisonDrift(value: number) {
  return (value >= 0 ? "+" : "") + value.toFixed(2) + " s⁻¹";
}
