"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { COMPARISON_DDM_SETTINGS, fitComparisonDdm, formatComparisonDrift, type ComparisonObservation, type ComparisonResponse } from "../../lib/comparison-ddm";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const HOME_HREF = BASE_PATH ? BASE_PATH + "/" : "/";
const DURATIONS = [200, 400, 800, 1600] as const;
const PRACTICE_REPEATS = { 2: 1, 4: 1, 8: 1 } as const;
const MAIN_REPEATS = { 2: 4, 4: 6, 8: 12 } as const;
const FIXATION_DURATION = 800;
const RESPONSE_WINDOW = COMPARISON_DDM_SETTINGS.responseWindowMs;
const GO_DISPLAY_DURATION = 1000;
const TASK_VERSION = "serial-comparison-v1";

type Block = "practice" | "main";
type Phase = "intro" | "countdown" | "reference" | "waiting" | "fixation" | "stimulus" | "response" | "feedback" | "practiceComplete" | "results";
type Ratio = 2 | 4 | 8;
type TrialOutcome = "correct" | "incorrect" | "timeout";
type Trial = ComparisonObservation & {
  block: Block;
  index: number;
  previousDuration: number;
  currentDuration: number;
  outcome: TrialOutcome;
  stimulusOnset: number;
  stimulusOffset: number;
  responseWindowOnset: number;
  responseTimestamp: number | null;
};

function nowTimestamp() {
  return performance.timeOrigin + performance.now();
}

function durationRatio(first: number, second: number): Ratio {
  return Math.max(first, second) / Math.min(first, second) as Ratio;
}

function shuffle<T>(items: T[]) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }
  return items;
}

/** Builds a randomized Eulerian path, so each directed duration pair has its planned count. */
function buildStimulusSequence(block: Block) {
  const repeats = block === "practice" ? PRACTICE_REPEATS : MAIN_REPEATS;
  const adjacency = DURATIONS.map(() => [] as number[]);
  for (let from = 0; from < DURATIONS.length; from += 1) {
    for (let to = 0; to < DURATIONS.length; to += 1) {
      if (from === to) continue;
      const ratio = durationRatio(DURATIONS[from], DURATIONS[to]);
      for (let repeat = 0; repeat < repeats[ratio]; repeat += 1) adjacency[from].push(to);
    }
  }
  adjacency.forEach(shuffle);
  const start = Math.floor(Math.random() * DURATIONS.length);
  const stack = [start];
  const reversedCircuit: number[] = [];
  while (stack.length) {
    const node = stack[stack.length - 1];
    const next = adjacency[node].pop();
    if (next === undefined) reversedCircuit.push(stack.pop()!);
    else stack.push(next);
  }
  return reversedCircuit.reverse().map(index => DURATIONS[index]);
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function csvCell(value: string | number | null) {
  const text = value === null ? "null" : String(value);
  return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function ratioSummary(trials: Trial[], ratio: Ratio) {
  const selected = trials.filter(trial => trial.block === "main" && trial.ratio === ratio);
  const responded = selected.flatMap(trial => trial.rtFromOffset === null ? [] : [trial.rtFromOffset]);
  const correct = selected.filter(trial => trial.outcome === "correct").length;
  return {
    count: selected.length,
    accuracy: selected.length ? Math.round(correct / selected.length * 100) : 0,
    medianRt: median(responded),
    timeouts: selected.filter(trial => trial.outcome === "timeout").length,
  };
}

export default function ComparisonPage() {
  const [phase, setPhase] = useState<Phase>("intro");
  const [block, setBlock] = useState<Block>("practice");
  const [countdown, setCountdown] = useState(3);
  const [participant, setParticipant] = useState("");
  const [stimulusSequence, setStimulusSequence] = useState<number[]>([]);
  const [trialIndex, setTrialIndex] = useState(0);
  const [trials, setTrials] = useState<Trial[]>([]);
  const [feedback, setFeedback] = useState("");
  const [soundOn, setSoundOn] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stimulusOnsetRef = useRef<number | null>(null);
  const stimulusOffsetRef = useRef<number | null>(null);
  const responseWindowOnsetRef = useRef<number | null>(null);
  const lockedRef = useRef(false);

  const comparisonsTotal = Math.max(0, stimulusSequence.length - 1);
  const previousDuration = stimulusSequence[trialIndex];
  const currentDuration = stimulusSequence[trialIndex + 1];

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const beep = useCallback((frequency = 620, duration = 90) => {
    if (!soundOn) return;
    const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const context = new AudioCtx();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.08, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + duration / 1000);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + duration / 1000);
  }, [soundOn]);

  const beginReference = useCallback(() => {
    const referenceDuration = stimulusSequence[0];
    if (!referenceDuration) return;
    stimulusOnsetRef.current = nowTimestamp();
    setPhase("reference");
    beep(520, 70);
  }, [beep, stimulusSequence]);

  const finishTrial = useCallback((response: ComparisonResponse | null) => {
    if (lockedRef.current || previousDuration === undefined || currentDuration === undefined) return;
    lockedRef.current = true;
    clearTimer();
    const correctResponse: ComparisonResponse = currentDuration > previousDuration ? "longer" : "shorter";
    const responseTimestamp = response === null ? null : nowTimestamp();
    const stimulusOnset = stimulusOnsetRef.current ?? nowTimestamp();
    const stimulusOffset = stimulusOffsetRef.current ?? nowTimestamp();
    const responseWindowOnset = responseWindowOnsetRef.current ?? stimulusOffset;
    const outcome: TrialOutcome = response === null ? "timeout" : response === correctResponse ? "correct" : "incorrect";
    setTrials(current => [...current, {
      block,
      index: trialIndex + 1,
      previousDuration,
      currentDuration,
      ratio: durationRatio(previousDuration, currentDuration),
      correctResponse,
      response,
      outcome,
      stimulusOnset,
      stimulusOffset,
      responseWindowOnset,
      responseTimestamp,
      rtFromOffset: responseTimestamp === null ? null : Math.round(responseTimestamp - stimulusOffset),
    }]);
    setFeedback(outcome === "correct" ? "正解！" : outcome === "incorrect" ? "反対です" : "時間切れ");
    beep(outcome === "correct" ? 760 : 220, 120);
    setPhase("feedback");
    timerRef.current = setTimeout(() => {
      if (trialIndex + 1 >= comparisonsTotal) {
        setPhase(block === "practice" ? "practiceComplete" : "results");
      } else {
        setTrialIndex(index => index + 1);
        lockedRef.current = false;
        setPhase("waiting");
      }
    }, 650);
  }, [beep, block, clearTimer, comparisonsTotal, currentDuration, previousDuration, trialIndex]);

  const beginComparisonStimulus = useCallback(() => {
    if (!currentDuration) return;
    stimulusOnsetRef.current = nowTimestamp();
    stimulusOffsetRef.current = null;
    responseWindowOnsetRef.current = null;
    setPhase("stimulus");
    beep(520, 70);
    timerRef.current = setTimeout(() => {
      const offset = nowTimestamp();
      stimulusOffsetRef.current = offset;
      responseWindowOnsetRef.current = offset;
      setPhase("response");
      timerRef.current = setTimeout(() => finishTrial(null), RESPONSE_WINDOW);
    }, currentDuration);
  }, [beep, currentDuration, finishTrial]);

  // Re-create the stimulus callback after finishTrial is available.
  useEffect(() => {
    if (phase !== "waiting") return;
    const waitingTimer = setTimeout(() => {
      setPhase("fixation");
    }, 650 + Math.floor(Math.random() * 650));
    return () => clearTimeout(waitingTimer);
  }, [phase, trialIndex]);

  useEffect(() => {
    if (phase !== "fixation") return;
    const fixationTimer = setTimeout(() => {
      beginComparisonStimulus();
    }, FIXATION_DURATION);
    return () => clearTimeout(fixationTimer);
  }, [beginComparisonStimulus, phase]);

  useEffect(() => {
    if (phase !== "countdown") return;
    if (countdown === 0) {
      timerRef.current = setTimeout(() => {
        lockedRef.current = false;
        beginReference();
      }, GO_DISPLAY_DURATION);
      return clearTimer;
    }
    timerRef.current = setTimeout(() => setCountdown(value => value - 1), 700);
    return clearTimer;
  }, [beginReference, clearTimer, countdown, phase]);

  useEffect(() => {
    if (phase !== "reference") return;
    const referenceDuration = stimulusSequence[0];
    if (!referenceDuration) return;
    const referenceTimer = setTimeout(() => {
      stimulusOffsetRef.current = nowTimestamp();
      setPhase("waiting");
    }, referenceDuration);
    return () => clearTimeout(referenceTimer);
  }, [phase, stimulusSequence]);

  const chooseResponse = useCallback((response: ComparisonResponse) => {
    if (phase === "response") finishTrial(response);
  }, [finishTrial, phase]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "ArrowLeft") {
        event.preventDefault();
        chooseResponse("shorter");
      }
      if (event.code === "ArrowRight") {
        event.preventDefault();
        chooseResponse("longer");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chooseResponse]);

  const beginBlock = (nextBlock: Block) => {
    clearTimer();
    setBlock(nextBlock);
    setStimulusSequence(buildStimulusSequence(nextBlock));
    setTrialIndex(0);
    setCountdown(3);
    lockedRef.current = false;
    setPhase("countdown");
  };

  const reset = () => {
    clearTimer();
    lockedRef.current = false;
    setBlock("practice");
    setStimulusSequence([]);
    setTrialIndex(0);
    setTrials([]);
    setPhase("intro");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const mainTrials = useMemo(() => trials.filter(trial => trial.block === "main"), [trials]);
  // DDM fitting is computationally intensive.  Do it once the task has ended,
  // not while the participant needs responsive buttons during the main block.
  const fits = useMemo(() => {
    if (phase !== "results") return [];
    return ([2, 4, 8] as Ratio[]).map(ratio => ({
      ratio,
      summary: ratioSummary(trials, ratio),
      fit: fitComparisonDdm(mainTrials.filter(trial => trial.ratio === ratio)),
    }));
  }, [mainTrials, phase, trials]);
  const overallAccuracy = mainTrials.length ? Math.round(mainTrials.filter(trial => trial.outcome === "correct").length / mainTrials.length * 100) : 0;

  const exportCsv = () => {
    const header = ["participant_id", "task_version", "trial_block", "trial", "previous_duration", "current_duration", "ratio", "correct_response", "response", "outcome", "stimulus_onset", "stimulus_offset", "response_window_onset", "response_timestamp", "rt_from_offset", "timeout_duration"].join(",") + "\n";
    const rows = trials.map(trial => [
      participant || "anonymous", TASK_VERSION, trial.block, trial.index, trial.previousDuration, trial.currentDuration,
      trial.ratio, trial.correctResponse, trial.response, trial.outcome,
      new Date(trial.stimulusOnset).toISOString(), new Date(trial.stimulusOffset).toISOString(), new Date(trial.responseWindowOnset).toISOString(),
      trial.responseTimestamp === null ? null : new Date(trial.responseTimestamp).toISOString(), trial.rtFromOffset, RESPONSE_WINDOW,
    ].map(csvCell).join(",")).join("\n");
    const blob = new Blob(["\ufeff" + header + rows], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "serial-time-comparison-" + Date.now() + ".csv";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const active = ["countdown", "reference", "waiting", "fixation", "stimulus", "response", "feedback"].includes(phase);

  return (
    <main>
      <header className="topbar">
        <a className="brand" href={HOME_HREF} aria-label="課題選択へ"><span className="brandMark">N</span><span>NEURO<br /><b>DECISION LAB</b></span></a>
        <button className="sound" onClick={() => setSoundOn(value => !value)} aria-pressed={soundOn}><span>{soundOn ? "●" : "○"}</span> SOUND {soundOn ? "ON" : "OFF"}</button>
      </header>

      {phase === "intro" && <section className="comparisonIntro">
        <div className="eyebrow"><span>SERIAL COMPARISON</span><i /></div>
        <p className="kicker">時間比較課題</p>
        <h1>今回の刺激は、<br /><em>前より長い？</em></h1>
        <p className="lead">0.2、0.4、0.8、1.6秒の刺激が続けて現れます。今回の刺激が直前の刺激より長いか短いかを、毎回選びます。</p>
        <div className="serialProtocol"><span>前の刺激を記憶</span><i>→</i><span>今回の刺激を見る</span><i>→</i><b>長い／短いを選ぶ</b></div>
        <div className="ratioGuide"><article><b>2倍</b><span>0.2↔0.4<br />0.4↔0.8<br />0.8↔1.6</span></article><article><b>4倍</b><span>0.2↔0.8<br />0.4↔1.6</span></article><article><b>8倍</b><span>0.2↔1.6</span></article></div>
        <div className="startRow"><label><span>参加者ID（任意）</span><input value={participant} onChange={event => setParticipant(event.target.value)} placeholder="例：A12" maxLength={20} /></label><button className="start" onClick={() => beginBlock("practice")}>練習をはじめる <span>→</span></button><p>練習 12比較 → 本試行 72比較。比率ごとに24比較ずつ、前後の順序は同数です。</p></div>
      </section>}

      {active && <section className="experiment comparisonExperiment">
        <div className="progressHead"><span>{block === "practice" ? "PRACTICE" : "MAIN TASK"} / SERIAL COMPARISON</span><b>{phase === "reference" ? "00" : String(Math.min(trialIndex + 1, comparisonsTotal)).padStart(2, "0")} <i>/ {comparisonsTotal}</i></b></div>
        <div className="progress"><i style={{ width: comparisonsTotal ? String((trialIndex / comparisonsTotal) * 100) + "%" : "0%" }} /></div>
        <div className={"stage " + phase}>
          <div className="corner tl" /><div className="corner tr" /><div className="corner bl" /><div className="corner br" />
          {phase === "countdown" && <div className="count"><span>{block === "practice" ? "PRACTICE / GET READY" : "MAIN TASK / GET READY"}</span><b>{countdown || "GO"}</b></div>}
          {phase === "reference" && <div className="serialStimulus"><span>最初の刺激 — 覚えておく</span><div className="orb"><i /></div><small>まだ回答しません</small></div>}
          {phase === "waiting" && <div className="fixation"><b>+</b><span>前の刺激を覚えて待つ</span></div>}
          {phase === "fixation" && <div className="fixation"><b>+</b><span>次の刺激を見比べる</span></div>}
          {phase === "stimulus" && <div className="serialStimulus"><span>今回の刺激</span><div className="orb"><i /></div><small>まだ回答しません</small></div>}
          {phase === "response" && <div className="comparisonRespond"><h2>今回の刺激は？</h2><div className="comparisonResponseButtons"><button type="button" className="shorterButton" onPointerDown={event => { event.preventDefault(); chooseResponse("shorter"); }} onClick={() => chooseResponse("shorter")}><b>短い</b><span>← 左矢印キー</span></button><button type="button" className="longerButton" onPointerDown={event => { event.preventDefault(); chooseResponse("longer"); }} onClick={() => chooseResponse("longer")}><b>長い</b><span>右矢印キー →</span></button></div><small>直前の刺激と比べて選んでください</small></div>}
          {phase === "feedback" && <div className={"feedback " + (feedback === "正解！" ? "ok" : "ng")}>{feedback}</div>}
        </div>
        <div className="experimentFoot"><p>{phase === "reference" ? <><b>最初の刺激</b><br />長さを覚えてください。</> : phase === "stimulus" ? <><b>今回の刺激を観察</b><br />直前の刺激と比べます。</> : phase === "response" ? <><b>回答開始</b><br />前の刺激より短いか長いかを選びます。</> : <><b>回答は今回の刺激終了直後</b><br />回答窓は {RESPONSE_WINDOW / 1000} 秒です。</>}</p><button onClick={reset}>中止する</button></div>
      </section>}

      {phase === "practiceComplete" && <section className="comparisonIntro"><div className="eyebrow"><span>PRACTICE COMPLETE</span><i /></div><h1>練習終了。<br /><em>本試行</em>へ進もう。</h1><p className="lead">ここからは、比率2倍・4倍・8倍の比較が各24回ずつ現れます。</p><button className="start" onClick={() => beginBlock("main")}>本試行 72比較をはじめる <span>→</span></button></section>}

      {phase === "results" && <section className="comparisonResults">
        <div className="eyebrow"><span>YOUR SERIAL-COMPARISON RESULTS</span><i /></div>
        <div className="resultTitle"><div><p>直前の刺激と比べる時間判断</p><h1>比率ごとの<br /><em>証拠の進み方</em></h1></div><div className="score"><b>{overallAccuracy}</b><span>%<br />ACCURACY</span></div></div>
        <div className="serialResultTable"><div className="tableHead"><span>比率</span><b>正答率</b><b>RT中央値</b><b>|v|</b></div>{fits.map(({ ratio, summary, fit }) => <div key={ratio}><span><b>{ratio}倍</b><small>{summary.count} 比較</small></span><b>{summary.accuracy}%</b><b>{summary.medianRt === null ? "—" : summary.medianRt + " ms"}</b><b>{fit ? fit.evidenceStrength.toFixed(2) : "—"}</b></div>)}</div>
        <div className="serialDdm"><span>2-BOUNDARY DDM</span><h2>両方の選択と反応時間を使って推定。</h2><p>上側の境界を「今回の方が長い」、下側を「今回の方が短い」とし、比率ごとにドリフト率を別々に推定します。<b>|v|</b> が大きいほど、正しい選択に向かう証拠が速く進むことを示します。</p><div>{fits.map(({ ratio, fit }) => <article key={ratio}><span>{ratio}倍</span><b>{fit ? formatComparisonDrift(fit.drift) : "—"}</b><strong>{fit ? "|v| = " + fit.evidenceStrength.toFixed(2) : "データなし"}</strong><small>{fit ? "近似95%範囲：" + formatComparisonDrift(fit.intervalLow) + " ～ " + formatComparisonDrift(fit.intervalHigh) : ""}</small></article>)}</div><p className="fitReadout">本試行72比較でも、比率ごとの個人推定は探索的な値です。複数参加者のCSVを同じ条件内でまとめると、比率差をより安定して調べられます。</p></div>
        <details><summary>試行ごとのデータを見る</summary><div className="tableWrap"><table><thead><tr><th>比較</th><th>前</th><th>今回</th><th>比率</th><th>回答</th><th>結果</th><th>RT</th></tr></thead><tbody>{trials.map(trial => <tr key={trial.block + "-" + trial.index}><td>{trial.index}</td><td>{trial.previousDuration / 1000}s</td><td>{trial.currentDuration / 1000}s</td><td>{trial.ratio}倍</td><td>{trial.response ?? "—"}</td><td className={trial.outcome === "correct" ? "good" : "bad"}>{trial.outcome}</td><td>{trial.rtFromOffset === null ? "—" : trial.rtFromOffset + " ms"}</td></tr>)}</tbody></table></div></details>
        <div className="resultActions"><a className="secondary" href={HOME_HREF}>課題選択へ戻る</a><button className="secondary" onClick={exportCsv}>CSVを保存</button><button className="start" onClick={reset}>もう一度挑戦 <span>↻</span></button></div>
      </section>}
      <footer><span>REMEMBER</span><i /> <span>COMPARE</span><i /> <span>MODEL</span><b>連続する行動から見えない計算へ</b></footer>
    </main>
  );
}
