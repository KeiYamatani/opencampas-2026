"use client";

import { ChangeEvent, useMemo, useState } from "react";
import { fitSymmetricDdm, formatDrift, type DdmObservation } from "../../lib/ddm";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const HOME_HREF = BASE_PATH ? BASE_PATH + "/" : "/";
const SUPPORTED_TASK_VERSION = "immediate-response-v1";

type RoundId = "a" | "b";
type Outcome = "hit" | "miss" | "correct_rejection" | "false_alarm";
type ImportedTrial = DdmObservation & {
  round: RoundId;
  outcome: Outcome;
};
type ImportedSession = {
  fileName: string;
  participantId: string;
  trials: ImportedTrial[];
};
type GroupSummary = {
  participants: number;
  trials: number;
  accuracy: number | null;
  hitRate: number | null;
  falseAlarmRate: number | null;
  goMedianRt: number | null;
  falseAlarmMeanRt: number | null;
};

const ROUND_LABEL: Record<RoundId, string> = {
  a: "0.2秒 vs 0.8秒",
  b: "0.8秒 vs 1.6秒",
};

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some(value => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  row.push(cell);
  if (row.some(value => value !== "")) rows.push(row);
  return rows;
}

function nullableNumber(value: string | undefined) {
  if (value === undefined || value === "" || value.toLowerCase() === "null") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function parseSession(fileName: string, text: string): ImportedSession {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("試行データが見つかりません。");
  const headers = rows[0].map(header => header.replace(/^\uFEFF/, "").trim());
  const column = (name: string) => headers.indexOf(name);
  const required = ["task_version", "round", "trial_block", "trial_type", "response", "outcome", "rt_from_offset"];
  const missing = required.filter(name => column(name) === -1);
  if (missing.length) throw new Error("このCSVは課題の出力形式ではありません（不足：" + missing.join(", ") + "）。");

  const valueAt = (row: string[], name: string) => row[column(name)]?.trim() ?? "";
  const taskVersion = valueAt(rows[1], "task_version");
  if (taskVersion !== SUPPORTED_TASK_VERSION) throw new Error("現在の即時回答版（" + SUPPORTED_TASK_VERSION + "）のCSVではありません。");
  const participantColumn = column("participant_id");
  const participantId = participantColumn === -1 ? "匿名" : (rows[1][participantColumn]?.trim() || "匿名");
  const trials: ImportedTrial[] = [];

  for (const row of rows.slice(1)) {
    if (valueAt(row, "trial_block") !== "main") continue;
    const round = valueAt(row, "round").toLowerCase();
    const trialType = valueAt(row, "trial_type");
    const outcome = valueAt(row, "outcome") as Outcome;
    if ((round !== "a" && round !== "b") || (trialType !== "go" && trialType !== "no_go")) continue;
    if (!["hit", "miss", "correct_rejection", "false_alarm"].includes(outcome)) continue;
    trials.push({
      round,
      trialType,
      response: valueAt(row, "response") === "press" ? "press" : null,
      outcome,
      rtFromOffset: nullableNumber(valueAt(row, "rt_from_offset")),
    });
  }
  if (!trials.length) throw new Error("本試行（trial_block=main）の有効な行がありません。");
  return { fileName, participantId, trials };
}

function summarize(sessions: ImportedSession[], round: RoundId): GroupSummary {
  const trials = sessions.flatMap(session => session.trials.filter(trial => trial.round === round));
  const go = trials.filter(trial => trial.trialType === "go");
  const noGo = trials.filter(trial => trial.trialType === "no_go");
  const hits = go.filter(trial => trial.outcome === "hit");
  const falseAlarms = noGo.filter(trial => trial.outcome === "false_alarm");
  const hitRts = hits.flatMap(trial => trial.rtFromOffset === null ? [] : [trial.rtFromOffset]);
  const falseAlarmRts = falseAlarms.flatMap(trial => trial.rtFromOffset === null ? [] : [trial.rtFromOffset]);
  return {
    participants: new Set(sessions.filter(session => session.trials.some(trial => trial.round === round)).map(session => session.fileName)).size,
    trials: trials.length,
    accuracy: trials.length ? trials.filter(trial => trial.outcome === "hit" || trial.outcome === "correct_rejection").length / trials.length * 100 : null,
    hitRate: go.length ? hits.length / go.length * 100 : null,
    falseAlarmRate: noGo.length ? falseAlarms.length / noGo.length * 100 : null,
    goMedianRt: median(hitRts),
    falseAlarmMeanRt: falseAlarmRts.length ? falseAlarmRts.reduce((sum, value) => sum + value, 0) / falseAlarmRts.length : null,
  };
}

function groupObservations(sessions: ImportedSession[], round: RoundId) {
  return sessions.flatMap(session => session.trials.filter(trial => trial.round === round).map(({ trialType, response, rtFromOffset }) => ({ trialType, response, rtFromOffset })));
}

function rate(value: number | null) {
  return value === null ? "—" : value.toFixed(1) + "%";
}

function milliseconds(value: number | null) {
  return value === null ? "—" : Math.round(value) + " ms";
}

function csvCell(value: string | number | null) {
  const text = value === null ? "" : String(value);
  return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

export default function AnalysisPage() {
  const [sessions, setSessions] = useState<ImportedSession[]>([]);
  const [messages, setMessages] = useState<string[]>([]);

  const summaryA = useMemo(() => summarize(sessions, "a"), [sessions]);
  const summaryB = useMemo(() => summarize(sessions, "b"), [sessions]);
  const fitA = useMemo(() => fitSymmetricDdm(groupObservations(sessions, "a")), [sessions]);
  const fitB = useMemo(() => fitSymmetricDdm(groupObservations(sessions, "b")), [sessions]);

  const importFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    const parsed = await Promise.all(files.map(async file => {
      try {
        return { session: parseSession(file.name, await file.text()), message: null };
      } catch (error) {
        return { session: null, message: file.name + "：" + (error instanceof Error ? error.message : "読み込みに失敗しました。") };
      }
    }));
    const incoming = parsed.flatMap(result => result.session ? [result.session] : []);
    setSessions(current => [...current.filter(session => !incoming.some(next => next.fileName === session.fileName)), ...incoming]);
    setMessages(parsed.flatMap(result => result.message ? [result.message] : []));
    event.target.value = "";
  };

  const exportSummary = () => {
    const rows = [
      ["metric", ROUND_LABEL.a, ROUND_LABEL.b],
      ["participants", summaryA.participants, summaryB.participants],
      ["main_trials", summaryA.trials, summaryB.trials],
      ["accuracy_percent", summaryA.accuracy, summaryB.accuracy],
      ["hit_rate_percent", summaryA.hitRate, summaryB.hitRate],
      ["false_alarm_rate_percent", summaryA.falseAlarmRate, summaryB.falseAlarmRate],
      ["go_rt_median_ms", summaryA.goMedianRt, summaryB.goMedianRt],
      ["false_alarm_rt_mean_ms", summaryA.falseAlarmMeanRt, summaryB.falseAlarmMeanRt],
      ["ddm_drift_v_per_second", fitA?.drift ?? null, fitB?.drift ?? null],
      ["ddm_evidence_strength_abs_v", fitA?.evidenceStrength ?? null, fitB?.evidenceStrength ?? null],
      ["ddm_profile_95_low", fitA?.intervalLow ?? null, fitB?.intervalLow ?? null],
      ["ddm_profile_95_high", fitA?.intervalHigh ?? null, fitB?.intervalHigh ?? null],
    ];
    const csv = "\ufeff" + rows.map(row => row.map(value => csvCell(value)).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "gonogo-group-summary-" + Date.now() + ".csv";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const evidenceMessage = !fitA || !fitB ? "CSVを読み込むと、二条件の推定ドリフト率を比較できます。"
    : fitA.evidenceStrength > fitB.evidenceStrength ? "この集計では、0.2 vs 0.8秒の方が |v| が大きくなりました。"
      : fitA.evidenceStrength < fitB.evidenceStrength ? "この集計では、0.8 vs 1.6秒の方が |v| が大きくなりました。"
        : "この集計では、二条件の |v| は同じでした。";

  return (
    <main>
      <header className="topbar">
        <a className="brand" href={HOME_HREF} aria-label="課題トップへ">
          <span className="brandMark">N</span>
          <span>NEURO<br /><b>DECISION LAB</b></span>
        </a>
        <a className="analysisLink" href={HOME_HREF}>← 課題に戻る</a>
      </header>

      <section className="analysisPage">
        <div className="eyebrow"><span>GROUP ANALYSIS</span><i /></div>
        <p className="kicker">複数参加者の集計</p>
        <h1>みんなの行動から、<br /><em>証拠の進み方</em>を読む。</h1>
        <p className="lead">参加者ごとに保存したCSVを複数選択して読み込みます。本試行だけを集計し、二つの条件の成績とDDMドリフト率を同じ方法で計算します。</p>

        <label className="uploadPanel">
          <input type="file" accept=".csv,text/csv" multiple onChange={importFiles} />
          <span>CSVを選択する</span>
          <b>参加者ごとの <code>time-context-gonogo-*.csv</code> を複数選択できます</b>
          <small>ファイルはこのブラウザ内でだけ処理され、サーバーには送信されません。</small>
        </label>

        {messages.length > 0 && <div className="importMessages">{messages.map(message => <p key={message}>{message}</p>)}</div>}

        {sessions.length === 0 ? (
          <div className="emptyAnalysis">
            <b>まず参加者CSVを読み込んでください。</b>
            <p>課題の結果画面にある「CSVを保存」から出力したファイルに対応しています。匿名参加者でも、1ファイルを1セッションとして集計します。</p>
          </div>
        ) : <>
          <div className="groupOverview">
            <article><span>IMPORTED SESSIONS</span><b>{sessions.length}</b><p>CSVファイル数</p></article>
            <article><span>MAIN TRIALS</span><b>{summaryA.trials + summaryB.trials}</b><p>練習試行は除外</p></article>
            <article><span>PARTICIPANTS</span><b>{new Set(sessions.map(session => session.participantId).filter(id => id !== "匿名")).size || sessions.length}</b><p>匿名時はセッション数</p></article>
          </div>

          <div className="analysisTable">
            <div className="tableHead"><span>参加者全体の結果</span><b>{ROUND_LABEL.a}</b><b>{ROUND_LABEL.b}</b></div>
            <div><span>参加セッション数</span><b>{summaryA.participants}</b><b>{summaryB.participants}</b></div>
            <div><span>本試行数</span><b>{summaryA.trials}</b><b>{summaryB.trials}</b></div>
            <div><span>正答率</span><b>{rate(summaryA.accuracy)}</b><b>{rate(summaryB.accuracy)}</b></div>
            <div><span>Hit率</span><b>{rate(summaryA.hitRate)}</b><b>{rate(summaryB.hitRate)}</b></div>
            <div><span>False alarm率</span><b>{rate(summaryA.falseAlarmRate)}</b><b>{rate(summaryB.falseAlarmRate)}</b></div>
            <div><span>Go RT 中央値</span><b>{milliseconds(summaryA.goMedianRt)}</b><b>{milliseconds(summaryB.goMedianRt)}</b></div>
            <div><span>No-go誤反応 RT 平均</span><b>{milliseconds(summaryA.falseAlarmMeanRt)}</b><b>{milliseconds(summaryB.falseAlarmMeanRt)}</b></div>
          </div>

          {fitA && fitB && <section className="groupDdm">
            <div><span>POOLED DDM ESTIMATE</span><h2>全参加者の試行をまとめて、ドリフト率を推定。</h2><p>各CSVの推定値を平均するのではなく、すべての本試行の押下率・RT・無反応を一つの尤度へ入れて推定します。</p></div>
            <div className="groupDdmGrid">
              <article><span>0.2 vs 0.8秒</span><b>{formatDrift(fitA.drift)}</b><strong>|v| = {fitA.evidenceStrength.toFixed(2)}</strong><p>近似95%範囲：{formatDrift(fitA.intervalLow)} ～ {formatDrift(fitA.intervalHigh)}</p></article>
              <article><span>0.8 vs 1.6秒</span><b>{formatDrift(fitB.drift)}</b><strong>|v| = {fitB.evidenceStrength.toFixed(2)}</strong><p>近似95%範囲：{formatDrift(fitB.intervalLow)} ～ {formatDrift(fitB.intervalHigh)}</p></article>
            </div>
            <p className="fitReadout">{evidenceMessage} <b>|v|</b> が大きいほど、この固定スケールDDMではGo／No-goの証拠が速く分かれることを表します。</p>
            <details className="modelDetails"><summary>集計DDMの前提を見る</summary><p><code>dx = ±v dt + dW</code>。長い刺激を <code>+v</code>、短い刺激を <code>−v</code> とし、<code>a=1</code>、<code>z=0.5</code>、<code>σ=1</code>、<code>t₀=100 ms</code>を固定しています。No-goは下側境界または刺激終了後1.2秒までの未到達を含む打ち切りデータです。異なる参加者の個人差を分けて推定する階層モデルではありません。</p></details>
          </section>}

          <section className="sessionList">
            <div><span>IMPORTED FILES</span><button className="secondary" onClick={() => { setSessions([]); setMessages([]); }}>集計をクリア</button></div>
            <ul>{sessions.map(session => <li key={session.fileName}><b>{session.participantId}</b><span>{session.fileName}</span><small>本試行 {session.trials.length} 試行</small><button onClick={() => setSessions(current => current.filter(item => item.fileName !== session.fileName))}>除く</button></li>)}</ul>
          </section>
          <div className="resultActions"><a className="secondary" href={HOME_HREF}>課題ページへ戻る</a><button className="start" onClick={exportSummary}>集計CSVを保存 <span>↓</span></button></div>
        </>}
      </section>
      <footer><span>IMPORT</span><i /> <span>AGGREGATE</span><i /> <span>MODEL</span><b>複数の行動から見えない計算へ</b></footer>
    </main>
  );
}
