"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fitSymmetricDdm, formatDrift, type DdmObservation } from "../lib/ddm";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const HOME_HREF = BASE_PATH ? BASE_PATH + "/" : "/";
const ANALYSIS_HREF = BASE_PATH + "/analysis";
const SERIAL_COMPARISON_HREF = BASE_PATH + "/comparison";
const PARTICIPANT_URL = process.env.NEXT_PUBLIC_PARTICIPANT_URL ?? "https://keiyamatani.github.io/opencampas-2026/";
const QR_IMAGE_URL = "https://api.qrserver.com/v1/create-qr-code/?size=260x260&format=svg&margin=0&data=" + encodeURIComponent(PARTICIPANT_URL);

type Phase = "intro" | "roundIntro" | "countdown" | "waiting" | "fixation" | "stimulus" | "response" | "feedback" | "roundComplete" | "results";
type RoundId = "a" | "b";
type Block = "practice" | "main";
type Outcome = "hit" | "miss" | "correct_rejection" | "false_alarm";
type TrialPlan = { duration: number; block: Block; round: RoundId };
type Trial = {
  round: RoundId;
  block: Block;
  index: number;
  duration: number;
  trialType: "go" | "no_go";
  correctAction: "press" | "no_go";
  response: "press" | null;
  outcome: Outcome;
  fixationOnset: number;
  fixationOffset: number;
  stimulusOnset: number;
  stimulusOffset: number;
  responseWindowOnset: number;
  responseTimestamp: number | null;
  rtFromOnset: number | null;
  rtFromOffset: number | null;
  rtFromResponseWindow: number | null;
  timeoutDuration: number;
};
type RoundSummary = {
  accuracy: number;
  hitRate: number;
  falseAlarmRate: number;
  correctRejectionRate: number;
  goMedianRt: number | null;
  falseAlarmMeanRt: number | null;
  count: number;
};
type AggregateRecord = {
  a: RoundSummary;
  b: RoundSummary;
  ddmTrials?: Record<RoundId, DdmObservation[]>;
  savedAt: number;
};

const PRACTICE_TOTAL = 4;
const MAIN_TOTAL = 14;
const FIXATION_DURATION = 1000;
const RESPONSE_WINDOW = 1200;
const GO_DISPLAY_DURATION = 1000;
const TASK_VERSION = "immediate-response-v1";
const STORAGE_KEY = "neuro-decision-lab-round-aggregate-v3";
const ROUNDS = {
  a: {
    label: "Round 1",
    comparison: "0.2秒 vs 0.8秒",
    short: 200,
    long: 800,
    absoluteDifference: 600,
    ratio: 4,
    role: "0.8秒は長い刺激（Go）",
  },
  b: {
    label: "Round 2",
    comparison: "0.8秒 vs 1.6秒",
    short: 800,
    long: 1600,
    absoluteDifference: 800,
    ratio: 2,
    role: "0.8秒は短い刺激（No-go）",
  },
} as const;

function nowTimestamp() {
  return performance.timeOrigin + performance.now();
}

function buildTrials(round: RoundId, block: Block) {
  const config = ROUNDS[round];
  const total = block === "practice" ? PRACTICE_TOTAL : MAIN_TOTAL;
  const sourcePlans: TrialPlan[] = [
    ...Array(total / 2).fill({ duration: config.short, block, round }),
    ...Array(total / 2).fill({ duration: config.long, block, round }),
  ];

  // 同じ刺激が3回以上続かないランダムな並びだけを採用する。
  for (let attempt = 0; attempt < 100; attempt++) {
    const plans = [...sourcePlans];
    for (let i = plans.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [plans[i], plans[j]] = [plans[j], plans[i]];
    }
    if (!plans.some((plan, index) => index >= 2 && plan.duration === plans[index - 1].duration && plan.duration === plans[index - 2].duration)) {
      return plans;
    }
  }

  // 念のためのフォールバック。開始側は毎回ランダムにする。
  const durations = Math.random() < 0.5
    ? [config.short, config.long]
    : [config.long, config.short];
  return Array.from({ length: total }, (_, index) => ({ duration: durations[index % 2], block, round }));
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function higherValueClass(value: number, comparison: number) {
  return value > comparison ? "metricBest" : "";
}

function lowerValueClass(value: number, comparison: number) {
  return value < comparison ? "metricBest" : "";
}

function csvCell(value: string | number | null) {
  const text = value === null ? "null" : String(value);
  return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function summarizeRound(trials: Trial[], round: RoundId): RoundSummary {
  const main = trials.filter(trial => trial.round === round && trial.block === "main");
  const go = main.filter(trial => trial.trialType === "go");
  const noGo = main.filter(trial => trial.trialType === "no_go");
  const hits = go.filter(trial => trial.outcome === "hit");
  const falseAlarms = noGo.filter(trial => trial.outcome === "false_alarm");
  const correctRejections = noGo.filter(trial => trial.outcome === "correct_rejection");
  const hitRts = hits.flatMap(trial => trial.rtFromOffset === null ? [] : [trial.rtFromOffset]);
  const falseAlarmRts = falseAlarms.flatMap(trial => trial.rtFromOffset === null ? [] : [trial.rtFromOffset]);
  return {
    accuracy: main.length ? Math.round(main.filter(trial => trial.outcome === "hit" || trial.outcome === "correct_rejection").length / main.length * 100) : 0,
    hitRate: go.length ? Math.round(hits.length / go.length * 100) : 0,
    falseAlarmRate: noGo.length ? Math.round(falseAlarms.length / noGo.length * 100) : 0,
    correctRejectionRate: noGo.length ? Math.round(correctRejections.length / noGo.length * 100) : 0,
    goMedianRt: median(hitRts),
    falseAlarmMeanRt: falseAlarmRts.length ? Math.round(falseAlarmRts.reduce((sum, value) => sum + value, 0) / falseAlarmRts.length) : null,
    count: main.length,
  };
}

function aggregate(records: AggregateRecord[], round: RoundId) {
  if (!records.length) return null;
  const summaries = records.map(record => record[round]);
  const mean = (key: keyof RoundSummary) => {
    const values = summaries.map(summary => summary[key]).filter((value): value is number => typeof value === "number");
    return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
  };
  return { count: records.length, accuracy: mean("accuracy"), goMedianRt: mean("goMedianRt") };
}

function observationsForFit(trials: Trial[], round: RoundId): DdmObservation[] {
  return trials
    .filter(trial => trial.round === round && trial.block === "main")
    .map(trial => ({
      trialType: trial.trialType,
      response: trial.response,
      rtFromOffset: trial.rtFromOffset,
    }));
}

function terminalObservations(records: AggregateRecord[], round: RoundId): DdmObservation[] {
  return records.flatMap(record => record.ddmTrials?.[round] ?? []);
}

function DdmIllustration() {
  return (
    <div className="ddmIllustration" role="img" aria-label="行動データから、証拠がたまってGoまたはNo-goを決めるモデルを使い、証拠の進みやすさを推定する図">
      <article>
        <span>① 行動を測る</span><b>押す？ 待つ？</b>
        <div className="actionIllustration"><i>長い → 押す</i><em>または</em><i className="wait">短い → 待つ</i></div>
        <small>反応の有無と、押すまでの時間を記録</small>
      </article>
      <div className="ddmArrow" aria-hidden="true">→</div>
      <article>
        <span>② 見えない過程を仮定</span><b>証拠がたまる</b>
        <div className="accumulatorIllustration"><strong>Go：押す</strong><i /><b>● 開始</b><em>証拠が揺れながら進む</em><strong>No-go：待つ</strong></div>
        <small>どちらかの線に届くと判断する、と考える</small>
      </article>
      <div className="ddmArrow" aria-hidden="true">→</div>
      <article>
        <span>③ もっとも合う値を探す</span><b>drift rate</b>
        <div className="driftIllustration"><i><b>|v| 大</b><small>早く分かれる</small></i><i><b>|v| 小</b><small>揺れて迷いやすい</small></i></div>
        <small>実際の行動に最も近い「進みやすさ」</small>
      </article>
    </div>
  );
}

export default function Home() {
  const [phase, setPhase] = useState<Phase>("intro");
  const [countdown, setCountdown] = useState(3);
  const [currentRound, setCurrentRound] = useState<RoundId>("a");
  const [currentBlock, setCurrentBlock] = useState<Block>("practice");
  const [plan, setPlan] = useState<TrialPlan[]>([]);
  const [trialIndex, setTrialIndex] = useState(0);
  const [trials, setTrials] = useState<Trial[]>([]);
  const [feedback, setFeedback] = useState("");
  const [soundOn, setSoundOn] = useState(true);
  const [participant, setParticipant] = useState("");
  const [aggregateRecords, setAggregateRecords] = useState<AggregateRecord[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fixationOnsetRef = useRef<number | null>(null);
  const fixationOffsetRef = useRef<number | null>(null);
  const stimulusOnsetRef = useRef<number | null>(null);
  const stimulusOffsetRef = useRef<number | null>(null);
  const responseWindowOnsetRef = useRef<number | null>(null);
  const lockedRef = useRef(false);
  const savedResultRef = useRef(false);
  const config = ROUNDS[currentRound];
  const totalForBlock = currentBlock === "practice" ? PRACTICE_TOTAL : MAIN_TOTAL;

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const beep = useCallback((frequency = 620, duration = 90) => {
    if (!soundOn) return;
    const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration / 1000);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + duration / 1000);
  }, [soundOn]);

  const finishTrial = useCallback((responded: boolean) => {
    if (lockedRef.current) return;
    lockedRef.current = true;
    clearTimer();
    const planned = plan[trialIndex];
    const roundConfig = ROUNDS[planned.round];
    const responseTimestamp = responded ? nowTimestamp() : null;
    const fixationOnset = fixationOnsetRef.current ?? nowTimestamp();
    const fixationOffset = fixationOffsetRef.current ?? fixationOnset + FIXATION_DURATION;
    const stimulusOnset = stimulusOnsetRef.current ?? nowTimestamp();
    const stimulusOffset = stimulusOffsetRef.current ?? nowTimestamp();
    const responseWindowOnset = responseWindowOnsetRef.current ?? stimulusOffset;
    const trialType = planned.duration === roundConfig.long ? "go" : "no_go";
    const outcome: Outcome = trialType === "go"
      ? responded ? "hit" : "miss"
      : responded ? "false_alarm" : "correct_rejection";
    setTrials(current => [...current, {
      round: planned.round,
      block: planned.block,
      index: trialIndex + 1,
      duration: planned.duration,
      trialType,
      correctAction: trialType === "go" ? "press" : "no_go",
      response: responded ? "press" : null,
      outcome,
      fixationOnset,
      fixationOffset,
      stimulusOnset,
      stimulusOffset,
      responseWindowOnset,
      responseTimestamp,
      rtFromOnset: responseTimestamp === null ? null : Math.round(responseTimestamp - stimulusOnset),
      rtFromOffset: responseTimestamp === null ? null : Math.round(responseTimestamp - stimulusOffset),
      rtFromResponseWindow: responseTimestamp === null ? null : Math.round(responseTimestamp - responseWindowOnset),
      timeoutDuration: RESPONSE_WINDOW,
    }]);
    setFeedback(outcome === "hit" || outcome === "correct_rejection" ? "正解！" : outcome === "miss" ? "見逃し" : "押し間違い");
    beep(outcome === "hit" || outcome === "correct_rejection" ? 760 : 220, 120);
    setPhase("feedback");
    timerRef.current = setTimeout(() => {
      if (trialIndex + 1 >= plan.length) {
        setPhase("roundComplete");
      } else {
        setTrialIndex(value => value + 1);
        lockedRef.current = false;
        setPhase("waiting");
      }
    }, 650);
  }, [beep, clearTimer, plan, trialIndex]);

  const beginFixation = useCallback(() => {
    fixationOnsetRef.current = nowTimestamp();
    fixationOffsetRef.current = null;
    setPhase("fixation");
  }, []);

  const beginStimulus = useCallback(() => {
    stimulusOnsetRef.current = nowTimestamp();
    stimulusOffsetRef.current = null;
    responseWindowOnsetRef.current = null;
    setPhase("stimulus");
    beep(520, 70);
    timerRef.current = setTimeout(() => {
      stimulusOffsetRef.current = nowTimestamp();
      responseWindowOnsetRef.current = stimulusOffsetRef.current;
      setPhase("response");
      timerRef.current = setTimeout(() => finishTrial(false), RESPONSE_WINDOW);
    }, plan[trialIndex].duration);
  }, [beep, finishTrial, plan, trialIndex]);

  useEffect(() => {
    if (phase !== "waiting") return;
    const waitingTimer = setTimeout(beginFixation, 650 + Math.floor(Math.random() * 850));
    return () => clearTimeout(waitingTimer);
  }, [beginFixation, phase, trialIndex]);

  useEffect(() => {
    if (phase !== "fixation") return;
    const fixationTimer = setTimeout(() => {
      fixationOffsetRef.current = nowTimestamp();
      beginStimulus();
    }, FIXATION_DURATION);
    return () => clearTimeout(fixationTimer);
  }, [beginStimulus, phase]);

  useEffect(() => {
    if (phase !== "countdown") return;
    if (countdown === 0) {
      timerRef.current = setTimeout(() => {
        lockedRef.current = false;
        setPhase("waiting");
      }, GO_DISPLAY_DURATION);
      return clearTimer;
    }
    timerRef.current = setTimeout(() => setCountdown(value => value - 1), 700);
    return clearTimer;
  }, [clearTimer, countdown, phase]);

  useEffect(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      if (Array.isArray(parsed)) setAggregateRecords(parsed);
    } catch {
      setAggregateRecords([]);
    }
  }, []);

  const press = useCallback(() => {
    if (phase === "response") finishTrial(true);
  }, [finishTrial, phase]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        event.preventDefault();
        press();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [press]);

  const beginBlock = (block: Block) => {
    clearTimer();
    setCurrentBlock(block);
    setPlan(buildTrials(currentRound, block));
    setTrialIndex(0);
    setCountdown(3);
    lockedRef.current = false;
    setPhase("countdown");
  };

  const summaries = useMemo(() => ({
    a: summarizeRound(trials, "a"),
    b: summarizeRound(trials, "b"),
  }), [trials]);
  const individualFitA = useMemo(() => phase === "results" ? fitSymmetricDdm(observationsForFit(trials, "a")) : null, [phase, trials]);
  const individualFitB = useMemo(() => phase === "results" ? fitSymmetricDdm(observationsForFit(trials, "b")) : null, [phase, trials]);
  const terminalFitA = useMemo(() => fitSymmetricDdm(terminalObservations(aggregateRecords, "a")), [aggregateRecords]);
  const terminalFitB = useMemo(() => fitSymmetricDdm(terminalObservations(aggregateRecords, "b")), [aggregateRecords]);

  useEffect(() => {
    if (phase !== "results" || savedResultRef.current || summaries.a.count !== MAIN_TOTAL || summaries.b.count !== MAIN_TOTAL) return;
    savedResultRef.current = true;
    const next = [...aggregateRecords, {
      a: summaries.a,
      b: summaries.b,
      ddmTrials: {
        a: observationsForFit(trials, "a"),
        b: observationsForFit(trials, "b"),
      },
      savedAt: Date.now(),
    }].slice(-500);
    setAggregateRecords(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage is optional; individual results and CSV remain available.
    }
  }, [aggregateRecords, phase, summaries]);

  const resetExperiment = () => {
    clearTimer();
    savedResultRef.current = false;
    setCurrentRound("a");
    setCurrentBlock("practice");
    setTrials([]);
    setPlan([]);
    setPhase("intro");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const exportCsv = () => {
    const header = [
      "participant_id", "task_version", "round", "comparison", "trial_block", "trial", "stimulus_duration",
      "trial_type", "correct_action", "response", "outcome", "fixation_onset", "fixation_offset", "stimulus_onset", "stimulus_offset", "response_window_onset",
      "response_timestamp", "rt_from_onset", "rt_from_offset", "rt_from_response_window", "timeout_duration",
    ].join(",") + "\n";
    const rows = trials.map(trial => [
      participant || "anonymous",
      TASK_VERSION,
      trial.round,
      ROUNDS[trial.round].comparison,
      trial.block,
      trial.index,
      trial.duration,
      trial.trialType,
      trial.correctAction,
      trial.response,
      trial.outcome,
      new Date(trial.fixationOnset).toISOString(),
      new Date(trial.fixationOffset).toISOString(),
      new Date(trial.stimulusOnset).toISOString(),
      new Date(trial.stimulusOffset).toISOString(),
      new Date(trial.responseWindowOnset).toISOString(),
      trial.responseTimestamp === null ? null : new Date(trial.responseTimestamp).toISOString(),
      trial.rtFromOnset,
      trial.rtFromOffset,
      trial.rtFromResponseWindow,
      trial.timeoutDuration,
    ].map(csvCell).join(",")).join("\n");
    const blob = new Blob(["\ufeff" + header + rows], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "time-context-gonogo-" + Date.now() + ".csv";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const active = ["countdown", "waiting", "fixation", "stimulus", "response", "feedback"].includes(phase);
  const aggregateA = aggregate(aggregateRecords, "a");
  const aggregateB = aggregate(aggregateRecords, "b");
  const isPracticeComplete = phase === "roundComplete" && currentBlock === "practice";
  const isRoundOneComplete = phase === "roundComplete" && currentBlock === "main" && currentRound === "a";
  const isRoundTwoComplete = phase === "roundComplete" && currentBlock === "main" && currentRound === "b";

  return (
    <main>
      <header className="topbar">
        <a className="brand" href={HOME_HREF} aria-label="トップへ">
          <span className="brandMark">N</span>
          <span>NEURO<br /><b>DECISION LAB</b></span>
        </a>
        <div className="topActions">
          <a className="analysisLink" href={ANALYSIS_HREF}>集計・解析</a>
          <button className="sound" onClick={() => setSoundOn(value => !value)} aria-pressed={soundOn}>
            <span>{soundOn ? "●" : "○"}</span> SOUND {soundOn ? "ON" : "OFF"}
          </button>
        </div>
      </header>

      {phase === "intro" && (
        <section className="intro">
          <div className="eyebrow"><span>TASK SELECT</span><i /></div>
          <p className="kicker">脳の意思決定ラボ</p>
          <h1>時間の感じ方を、<br /><em>二つの課題</em>で調べる。</h1>
          <p className="lead">行動と反応時間から、見えない脳内の判断過程を推理します。取り組みたい課題を選んでください。</p>
          <div className="taskPicker">
            <article>
              <span>課題 1 ／ GO・NO-GO</span><h2>0.8秒は長い？短い？</h2><p>長い刺激では押し、短い刺激では待ちます。同じ0.8秒の役割が、比較する相手によって入れ替わります。</p>
              <div className="taskMiniRules"><b>0.2 vs 0.8秒</b><i>→</i><b>0.8 vs 1.6秒</b></div>
              <label><small>参加者ID（任意）</small><input value={participant} onChange={event => setParticipant(event.target.value)} placeholder="例：A12" maxLength={20} /></label>
              <button className="start" onClick={() => { setCurrentRound("a"); setCurrentBlock("practice"); setPhase("roundIntro"); }}>この課題をはじめる <span>→</span></button>
            </article>
            <a href={SERIAL_COMPARISON_HREF}>
              <span>課題 2 ／ 連続比較</span><h2>今回の刺激は、前より長い？</h2><p>0.2、0.4、0.8、1.6秒が連続して現れます。直前の刺激と比べ、今回が長いか短いかを毎回選びます。</p>
              <div className="taskMiniRules"><b>2倍</b><i>／</i><b>4倍</b><i>／</i><b>8倍</b></div>
              <strong>この課題をはじめる　→</strong>
            </a>
          </div>
          <div className="qrInvite">
            <img src={QR_IMAGE_URL} alt="参加用QRコード" />
            <div><span>SMARTPHONE ENTRY</span><h2>スマホから参加</h2><p>このQRコードを読み取ると、スマホでも二つの時間判断課題を選べます。結果は各端末内に保存されます。</p></div>
          </div>
        </section>
      )}

      {phase === "roundIntro" && (
        <section className="roundIntro">
          <div className="eyebrow"><span>{config.label.toUpperCase()}</span><i /></div>
          <h1>{config.comparison}<br /><em>{config.role}</em></h1>
          <p className="lead">十字の注視点を1.0秒見たあとに刺激が出ます。刺激が消えたらすぐに、長いと思ったときだけ押します。短いと思ったときは何もしません。</p>
          {currentRound === "b" && <div className="flipNotice">今度は 0.8秒が「短い」です。</div>}
          <div className="roundRule"><span>短い {config.short / 1000}秒 → NO-GO</span><b>長い {config.long / 1000}秒 → SPACE / TAP</b></div>
          <p className="trialSequence">＋ 注視点 <b>1.0秒</b>　→　刺激　→　回答</p>
          <button className="start" onClick={() => beginBlock("practice")}>練習 {PRACTICE_TOTAL}試行をはじめる <span>→</span></button>
        </section>
      )}

      {active && (
        <section className="experiment">
          <div className="progressHead"><span>{config.label.toUpperCase()} / {currentBlock === "practice" ? "PRACTICE" : "MAIN"}</span><b>{String(Math.min(trialIndex + 1, totalForBlock)).padStart(2, "0")} <i>/ {totalForBlock}</i></b></div>
          <div className="progress"><i style={{ width: String((trialIndex / totalForBlock) * 100) + "%" }} /></div>
          <div className={"stage " + phase}>
            <div className="corner tl" /><div className="corner tr" /><div className="corner bl" /><div className="corner br" />
            {phase === "countdown" && <div className="count"><span>{currentBlock === "practice" ? "PRACTICE / GET READY" : "MAIN TASK / GET READY"}</span><b>{countdown || "GO"}</b></div>}
            {phase === "waiting" && <div className="fixation"><b>+</b><span>次の試行を準備中</span></div>}
            {phase === "fixation" && <div className="fixation" role="status"><b>+</b><span>十字の注視点を見て待つ</span></div>}
            {phase === "stimulus" && <div className="orb"><i /><span>WATCH — DO NOT PRESS</span></div>}
            {phase === "response" && <div className="respond"><h2>長いと思った？</h2><button type="button" className="responseButton" onPointerDown={event => { event.preventDefault(); press(); }} onClick={press}><b>長い → 押す</b><span>SPACEキー または このボタン</span></button><small>短いと思ったら、何もしない</small></div>}
            {phase === "feedback" && <div className={"feedback " + (feedback === "正解！" ? "ok" : "ng")}>{feedback}</div>}
          </div>
          <div className="experimentFoot"><p>{phase === "fixation" ? <><b>十字の注視点：待機</b><br />そのまま見て、次の刺激を待ちます。</> : phase === "stimulus" ? <><b>刺激提示中：観察</b><br />刺激が消えるまで、まだ押さないでください。</> : phase === "response" ? <><b>回答開始：判断</b><br />長いと思ったときだけ、大きいボタンを押してください。</> : <><b>回答は刺激終了と同時に開始</b><br />回答窓は {RESPONSE_WINDOW / 1000} 秒です。刺激提示中の入力は記録しません。</>}</p><button onClick={resetExperiment}>中止する</button></div>
        </section>
      )}

      {isPracticeComplete && (
        <section className="roundIntro">
          <div className="eyebrow"><span>PRACTICE COMPLETE</span><i /></div>
          <h1>練習終了。<br /><em>本試行</em>へ進もう。</h1>
          <p className="lead">ルールは同じです。Go・No-goは各50%、本試行は {MAIN_TOTAL} 試行です。</p>
          <button className="start" onClick={() => beginBlock("main")}>本試行をはじめる <span>→</span></button>
        </section>
      )}

      {isRoundOneComplete && (
        <section className="roundIntro">
          <div className="eyebrow"><span>ROUND 1 COMPLETE</span><i /></div>
          <h1>次は、0.8秒が<br /><em>短く</em>なります。</h1>
          <p className="lead">Round 2では、0.8秒と1.6秒を比べます。0.8秒はNo-goです。</p>
          <div className="flipNotice">今度は 0.8秒が「短い」です。</div>
          <button className="start" onClick={() => { setCurrentRound("b"); setCurrentBlock("practice"); setPhase("roundIntro"); }}>Round 2へ <span>→</span></button>
        </section>
      )}

      {isRoundTwoComplete && (
        <section className="roundIntro">
          <div className="eyebrow"><span>ROUND 2 COMPLETE</span><i /></div>
          <h1>二つの結果を<br /><em>比べよう。</em></h1>
          <button className="start" onClick={() => setPhase("results")}>結果を見る <span>→</span></button>
        </section>
      )}

      {phase === "results" && (
        <section className="results">
          <div className="eyebrow"><span>YOUR RESULTS</span><i /></div>
          <div className="resultTitle"><div><p>0.8秒の役割が変わる二つのRound</p><h1>時間差？<br /><em>それとも比率？</em></h1></div><div className="score"><b>{Math.round((summaries.a.accuracy + summaries.b.accuracy) / 2)}</b><span>%<br />MEAN ACCURACY</span></div></div>
          {individualFitA && individualFitB && <section className="driftHero">
            <div><span>YOUR DATA × DDM</span><h2>証拠の進み方 <em>drift rate</em></h2><p>全本試行の押下率・RT・無反応を合わせて推定した値です。<b>|v|</b> が大きいほど、Go／No-goの証拠が速く分かれました。</p></div>
            <div className="driftHeroGrid">
              <article className={higherValueClass(individualFitA.evidenceStrength, individualFitB.evidenceStrength)}><span>0.2 vs 0.8秒</span><b>{formatDrift(individualFitA.drift)}</b><strong>|v| = {individualFitA.evidenceStrength.toFixed(2)}</strong><small>近似95%範囲：{formatDrift(individualFitA.intervalLow)} ～ {formatDrift(individualFitA.intervalHigh)}</small></article>
              <article className={higherValueClass(individualFitB.evidenceStrength, individualFitA.evidenceStrength)}><span>0.8 vs 1.6秒</span><b>{formatDrift(individualFitB.drift)}</b><strong>|v| = {individualFitB.evidenceStrength.toFixed(2)}</strong><small>近似95%範囲：{formatDrift(individualFitB.intervalLow)} ～ {formatDrift(individualFitB.intervalHigh)}</small></article>
            </div>
          </section>}
          <div className="comparisonTable">
            <div className="tableHead"><span>あなたの結果</span><b>0.2 vs 0.8秒</b><b>0.8 vs 1.6秒</b></div>
            <div><span>正答率 <small>高い方を強調</small></span><b className={higherValueClass(summaries.a.accuracy, summaries.b.accuracy)}>{summaries.a.accuracy}%</b><b className={higherValueClass(summaries.b.accuracy, summaries.a.accuracy)}>{summaries.b.accuracy}%</b></div>
            <div><span>Hit率 <small>高い方を強調</small></span><b className={higherValueClass(summaries.a.hitRate, summaries.b.hitRate)}>{summaries.a.hitRate}%</b><b className={higherValueClass(summaries.b.hitRate, summaries.a.hitRate)}>{summaries.b.hitRate}%</b></div>
            <div><span>False alarm率 <small>低い方を強調</small></span><b className={lowerValueClass(summaries.a.falseAlarmRate, summaries.b.falseAlarmRate)}>{summaries.a.falseAlarmRate}%</b><b className={lowerValueClass(summaries.b.falseAlarmRate, summaries.a.falseAlarmRate)}>{summaries.b.falseAlarmRate}%</b></div>
            <div><span>Go RT 中央値 <small>速さのみを表示</small></span><b>{summaries.a.goMedianRt === null ? "—" : summaries.a.goMedianRt + " ms"}</b><b>{summaries.b.goMedianRt === null ? "—" : summaries.b.goMedianRt + " ms"}</b></div>
            <div><span>No-go誤反応 RT 平均</span><b>{summaries.a.falseAlarmMeanRt === null ? "—" : summaries.a.falseAlarmMeanRt + " ms"}</b><b>{summaries.b.falseAlarmMeanRt === null ? "—" : summaries.b.falseAlarmMeanRt + " ms"}</b></div>
          </div>
          <p className="comparisonNote">緑はその指標だけで相対的に良い値です。反応が速いことだけでは「より良い」とは決めず、正確さとあわせて読みます。</p>
          <div className="reveal">
            <span>種明かし</span>
            <h2>時間差が大きいのは問題B。でも比率が大きいのは問題A。</h2>
            <div><p><b>問題 A</b><br />0.2秒 → 0.8秒<br /><strong>4倍</strong></p><p><b>問題 B</b><br />0.8秒 → 1.6秒<br /><strong>2倍</strong></p></div>
            <p>あなたの結果は予想と合いましたか？ 変化量そのものだけでなく、もとの大きさに対してどれだけ変わったかを使って区別している可能性があります。</p>
          </div>
          <div className="ddmSection">
            <div><span>HOW THE MODEL WORKS</span><h2>行動から、決めるまでの「証拠の進み方」を推理する。</h2><p>脳の中は直接見えません。そこで、いつ押したか・どれくらい押さなかったかを手がかりにして、見えない証拠がどのくらい速く判断へ向かったかをモデルで探します。</p></div>
            <DdmIllustration />
            <div className="ddmConceptGrid">
              <article><b>|v| が大きい</b><p>証拠がどちらかの判断に届きやすい状態。押す／待つの区別がはっきりします。</p></article>
              <article><b>|v| が小さい</b><p>証拠が揺れやすく、どちらにするか決まりにくい状態。誤反応や遅い反応が増えると予想されます。</p></article>
            </div>
            <details className="modelDetails"><summary>研究用の推定方法を見る</summary><p>ボタンを押した割合・押したときのRT・刺激終了後1.2秒までに押さなかった試行を同時に用いた、固定スケールDDMの近似最尤推定です。<code>dx = ±v dt + dW</code> とし、長い刺激を <code>+v</code>（Go方向）、短い刺激を <code>−v</code>（No-go方向）に固定しています。境界 <code>a=1</code>、開始位置 <code>z=0.5</code>、ノイズ <code>σ=1</code>、非決定時間 <code>t₀=100 ms</code>は二条件で共通です。したがって、<b>絶対値はこの固定スケール内での値</b>であり、二条件の <code>|v|</code> を比較するために使います。各Roundは本試行 {MAIN_TOTAL} 試行なので、範囲が広いときは参加者全体のデータで確かめます。</p></details>
          </div>
          <div className="aggregatePanel">
            <span>この展示端末の参加者全体</span>
            {aggregateA && aggregateB ? <>
              <p>{aggregateA.count}人分の端末内集計：0.2 vs 0.8秒の平均正答率 {aggregateA.accuracy}% ／ 0.8 vs 1.6秒は {aggregateB.accuracy}%</p>
              {terminalFitA && terminalFitB && <p className="terminalFit">プールしたDDM推定（本試行 {terminalFitA.count} 試行／条件）：|v| は {terminalFitA.evidenceStrength.toFixed(2)} vs {terminalFitB.evidenceStrength.toFixed(2)}。参加者が増えるほど、個人の偶然のばらつきの影響は小さくなります。</p>}
            </> : <p>まだ端末内の集計データはありません。結果はこのブラウザ内にのみ保存され、外部へ送信されません。</p>}
          </div>
          <details>
            <summary>試行ごとのデータを見る（練習・本試行）</summary>
            <div className="tableWrap"><table><thead><tr><th>Round</th><th>区分</th><th>刺激</th><th>試行種別</th><th>結果</th><th>RT（刺激終了後）</th></tr></thead><tbody>{trials.map(trial => <tr key={trial.round + "-" + trial.block + "-" + trial.index}><td>{trial.round.toUpperCase()}</td><td>{trial.block === "practice" ? "練習" : "本試行"}</td><td>{trial.duration / 1000}秒</td><td>{trial.trialType === "go" ? "Go" : "No-go"}</td><td className={trial.outcome === "hit" || trial.outcome === "correct_rejection" ? "good" : "bad"}>{trial.outcome}</td><td>{trial.rtFromOffset === null ? "null" : trial.rtFromOffset + " ms"}</td></tr>)}</tbody></table></div>
          </details>
          <div className="resultActions"><button className="secondary" onClick={resetExperiment}>ホームへ戻る</button><button className="secondary" onClick={exportCsv}>CSVを保存</button><button className="start" onClick={resetExperiment}>もう一度挑戦 <span>↻</span></button></div>
        </section>
      )}
      <footer><span>OBSERVE</span><i /> <span>MEASURE</span><i /> <span>MODEL</span><b>行動から見えない計算へ</b></footer>
    </main>
  );
}
