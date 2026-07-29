export type DdmObservation = {
  trialType: "go" | "no_go";
  response: "press" | null;
  rtFromOffset: number | null;
};

export type DdmFit = {
  drift: number;
  evidenceStrength: number;
  intervalLow: number;
  intervalHigh: number;
  logLikelihood: number;
  count: number;
  presses: number;
  boundaryHit: boolean;
};

export const DDM_SETTINGS = {
  boundary: 1,
  start: 0.5,
  noise: 1,
  nonDecisionMs: 100,
  responseWindowMs: 1200,
} as const;

const GRID_STEP = 0.05;
const GRID_LIMIT = 5;
const SERIES_TERMS = 48;
const CDF_STEP_MS = 4;
const EPSILON = 1e-12;

/**
 * First-passage density to the Go (upper) boundary for
 * dX = v dt + sigma dW, with boundaries 0 and a and fixed start z.
 */
function upperBoundaryDensity(decisionTimeMs: number, drift: number) {
  const { boundary, start, noise } = DDM_SETTINGS;
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

function logLikelihoodForDrift(observations: DdmObservation[], drift: number) {
  const decisionDeadline = DDM_SETTINGS.responseWindowMs - DDM_SETTINGS.nonDecisionMs;
  const goPressProbability = upperBoundaryProbability(decisionDeadline, drift);
  const noGoPressProbability = upperBoundaryProbability(decisionDeadline, -drift);

  return observations.reduce((logLikelihood, observation) => {
    const signedDrift = observation.trialType === "go" ? drift : -drift;
    const pressProbability = observation.trialType === "go" ? goPressProbability : noGoPressProbability;
    if (observation.response === "press" && observation.rtFromOffset !== null) {
      const densityPerSecond = upperBoundaryDensity(observation.rtFromOffset - DDM_SETTINGS.nonDecisionMs, signedDrift);
      // Conversion to milliseconds is constant across v, but makes this a
      // proper likelihood density for RT values stored in milliseconds.
      return logLikelihood + Math.log(Math.max(EPSILON, densityPerSecond / 1000));
    }
    // No press is censored: lower-bound hits and paths not reaching Go in time.
    return logLikelihood + Math.log(Math.max(EPSILON, 1 - pressProbability));
  }, 0);
}

/**
 * Fits one signed, symmetric drift for a pair of durations.
 * Long (Go) trials use +v and short (No-go) trials use -v.
 */
export function fitSymmetricDdm(observations: DdmObservation[]): DdmFit | null {
  if (!observations.length) return null;
  const candidates = Array.from(
    { length: Math.round((GRID_LIMIT * 2) / GRID_STEP) + 1 },
    (_, index) => Number((-GRID_LIMIT + index * GRID_STEP).toFixed(2)),
  );
  const scored = candidates.map(drift => ({ drift, logLikelihood: logLikelihoodForDrift(observations, drift) }));
  const best = scored.reduce((current, candidate) => candidate.logLikelihood > current.logLikelihood ? candidate : current);
  // Profile likelihood: 2*(LLmax - LL) <= 3.84 (approx. 95%, one parameter).
  const plausible = scored.filter(candidate => candidate.logLikelihood >= best.logLikelihood - 1.92);
  return {
    drift: best.drift,
    evidenceStrength: Math.abs(best.drift),
    intervalLow: plausible[0]?.drift ?? best.drift,
    intervalHigh: plausible[plausible.length - 1]?.drift ?? best.drift,
    logLikelihood: best.logLikelihood,
    count: observations.length,
    presses: observations.filter(observation => observation.response === "press").length,
    boundaryHit: Math.abs(best.drift) >= GRID_LIMIT,
  };
}

export function formatDrift(value: number) {
  return (value >= 0 ? "+" : "") + value.toFixed(2) + " s⁻¹";
}
