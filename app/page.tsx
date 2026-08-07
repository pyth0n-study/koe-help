"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getStatusCommand, isCancelCommand, isHelpCommand } from "../lib/voiceCommands.js";

type Mode = "dish" | "hall" | "history" | "settings";
type HelpState = {
  status: "idle" | "busy" | "critical" | "waiting" | "claimed";
  requestedAt: number | null;
  claimedAt: number | null;
  responder: string | null;
  updatedAt?: number;
  revision?: number;
};

type SpeechRecognitionEventLike = { results: ArrayLike<{ 0: { transcript: string } }> };
type HistoryEvent = { id: number; action: string; status: string; responseMs: number | null; createdAt: number };
type HistoryData = {
  events: HistoryEvent[];
  summary: { busyCount: number | null; urgentCount: number | null; acknowledgedCount: number | null; averageResponseMs: number | null };
};
type AppSettings = { busyWarningMinutes: number; urgentWarningMinutes: number; updatedAt?: number };
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  start: () => void;
  stop: () => void;
};

const INITIAL: HelpState = { status: "idle", requestedAt: null, claimedAt: null, responder: null };
const STORAGE_KEY = "koehelp-state-v1";
const PENDING_KEY = "koehelp-pending-v1";

function formatElapsed(start: number | null, now: number) {
  if (!start) return "00:00";
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatClock(timestamp: number | null) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatDuration(milliseconds: number | null) {
  if (milliseconds === null) return "—";
  const seconds = Math.floor(milliseconds / 1000);
  return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}

export default function Home() {
  const [mode, setMode] = useState<Mode>("dish");
  const [help, setHelp] = useState<HelpState>(INITIAL);
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(true);
  const [heard, setHeard] = useState("まだ音声は検出されていません");
  const [now, setNow] = useState(0);
  const [connection, setConnection] = useState<"connecting" | "online" | "offline">("connecting");
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | "unsupported">("default");
  const [hasPending, setHasPending] = useState(false);
  const [settings, setSettings] = useState<AppSettings>({ busyWarningMinutes: 10, urgentWarningMinutes: 5 });
  const [vibrationEnabled, setVibrationEnabled] = useState(true);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const shouldListenRef = useRef(false);
  const writingRef = useRef(false);
  const helpRef = useRef<HelpState>(INITIAL);
  const previousRevisionRef = useRef<number | null>(null);

  const persistHelp = useCallback(async (next: HelpState) => {
    writingRef.current = true;
    const mutationId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    const payload = { ...next, mutationId };
    try {
      const response = await fetch("/api/status", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error("status_update_failed");
      const saved = await response.json() as HelpState;
      setHelp(saved);
      helpRef.current = saved;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
      localStorage.removeItem(PENDING_KEY);
      setHasPending(false);
      setConnection("online");
    } catch {
      localStorage.setItem(PENDING_KEY, JSON.stringify(payload));
      setHasPending(true);
      setConnection("offline");
    } finally {
      writingRef.current = false;
    }
  }, []);

  const updateHelp = useCallback((next: HelpState) => {
    setHelp(next);
    helpRef.current = next;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY, newValue: JSON.stringify(next) }));
    void persistHelp(next);
  }, [persistHelp]);

  const requestHelp = useCallback(() => {
    const current = helpRef.current;
    if (current.status === "waiting" || current.status === "claimed") return;
    updateHelp({ status: "waiting", requestedAt: Date.now(), claimedAt: null, responder: null });
  }, [updateHelp]);

  const cancelHelp = useCallback(() => {
    updateHelp(INITIAL);
  }, [updateHelp]);

  const updateStatus = useCallback((status: "idle" | "busy" | "critical") => {
    const next: HelpState = {
      status,
      requestedAt: status === "idle" ? null : Date.now(),
      claimedAt: null,
      responder: null,
    };
    updateHelp(next);
  }, [updateHelp]);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    const pendingAtStart = localStorage.getItem(PENDING_KEY);
    if (pendingAtStart) queueMicrotask(() => setHasPending(true));
    if (saved) queueMicrotask(() => {
      const cached = JSON.parse(saved) as HelpState;
      setHelp(cached);
      helpRef.current = cached;
    });
    const sync = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY && event.newValue) {
        const shared = JSON.parse(event.newValue) as HelpState;
        setHelp(shared);
        helpRef.current = shared;
      }
    };
    window.addEventListener("storage", sync);
    let active = true;
    const syncServer = async () => {
      if (writingRef.current) return;
      try {
        const pending = localStorage.getItem(PENDING_KEY);
        if (pending) {
          const retry = await fetch("/api/status", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: pending,
          });
          if (!retry.ok) throw new Error("pending_sync_failed");
          const savedPending = await retry.json() as HelpState;
          if (!active) return;
          setHelp(savedPending);
          helpRef.current = savedPending;
          localStorage.setItem(STORAGE_KEY, JSON.stringify(savedPending));
          localStorage.removeItem(PENDING_KEY);
          setHasPending(false);
        }
        const response = await fetch("/api/status", { cache: "no-store" });
        if (!response.ok) throw new Error("status_sync_failed");
        const remote = await response.json() as HelpState;
        if (!active) return;
        setHelp(remote);
        helpRef.current = remote;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(remote));
        setConnection("online");
      } catch {
        if (active) setConnection("offline");
      }
    };
    void syncServer();
    const syncTimer = window.setInterval(syncServer, 2000);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    queueMicrotask(() => setNow(Date.now()));
    return () => {
      active = false;
      window.removeEventListener("storage", sync);
      window.clearInterval(timer);
      window.clearInterval(syncTimer);
    };
  }, []);

  useEffect(() => {
    if (mode !== "history") return;
    let active = true;
    const loadHistory = async () => {
      try {
        const response = await fetch("/api/history", { cache: "no-store" });
        if (!response.ok) throw new Error("history_load_failed");
        const data = await response.json() as HistoryData;
        if (active) setHistory(data);
      } catch {
        if (active) setHistory(null);
      }
    };
    void loadHistory();
    const timer = window.setInterval(loadHistory, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [mode]);

  useEffect(() => {
    queueMicrotask(() => setNotificationPermission("Notification" in window ? Notification.permission : "unsupported"));
    const storedVibration = localStorage.getItem("koehelp-vibration");
    if (storedVibration !== null) queueMicrotask(() => setVibrationEnabled(storedVibration === "true"));
  }, []);

  useEffect(() => {
    let active = true;
    const loadSettings = async () => {
      try {
        const response = await fetch("/api/settings", { cache: "no-store" });
        if (!response.ok) return;
        const remote = await response.json() as AppSettings;
        if (active) setSettings(remote);
      } catch { /* Defaults remain available while offline. */ }
    };
    void loadSettings();
    const timer = window.setInterval(loadSettings, 10000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    const titles: Record<HelpState["status"], string> = {
      idle: "🟦 大丈夫｜声ヘルプ",
      busy: "🟨 少し忙しい｜声ヘルプ",
      critical: "🔴 かなり忙しい｜声ヘルプ",
      waiting: "🆘 緊急HELP｜声ヘルプ",
      claimed: "🟢 対応中｜声ヘルプ",
    };
    document.title = titles[help.status];

    if (typeof help.revision !== "number") return;
    const previousRevision = previousRevisionRef.current;
    previousRevisionRef.current = help.revision;
    if (previousRevision === null || help.revision <= previousRevision || mode !== "hall") return;
    if (help.status !== "busy" && help.status !== "critical" && help.status !== "waiting") return;

    if (vibrationEnabled && "vibrate" in navigator) {
      navigator.vibrate(help.status === "busy" ? 120 : [180, 100, 180]);
    }
    if (notificationPermission === "granted" && document.hidden) {
      const body = help.status === "busy" ? "手が空いたら洗い場を確認してください。" : help.status === "critical" ? "対応できるスタッフは洗い場を確認してください。" : "洗い場から緊急ヘルプです。";
      try { new Notification(titles[help.status].split("｜")[0], { body, tag: "koehelp-status" }); } catch { /* Some mobile browsers only support notifications in installed apps. */ }
    }
  }, [help.revision, help.status, mode, notificationPermission, vibrationEnabled]);

  const enableNotifications = async () => {
    if (!("Notification" in window)) { setNotificationPermission("unsupported"); return; }
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
  };

  const saveSettings = async () => {
    setSettingsSaved(false);
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (!response.ok) throw new Error("settings_save_failed");
      setSettings(await response.json() as AppSettings);
      localStorage.setItem("koehelp-vibration", String(vibrationEnabled));
      setSettingsSaved(true);
    } catch {
      setConnection("offline");
    }
  };

  useEffect(() => {
    const SpeechRecognition = (window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition;

    if (!SpeechRecognition) { queueMicrotask(() => setSupported(false)); return; }
    const recognition = new SpeechRecognition();
    recognition.lang = "ja-JP";
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onstart = () => {
      setListening(true);
      setHeard("マイクを起動しました。合言葉を待っています");
    };
    recognition.onresult = (event) => {
      const transcript = event.results[event.results.length - 1][0].transcript.trim();
      const statusCommand = getStatusCommand(transcript);
      if (statusCommand) {
        setHeard(`「${transcript}」→ ステータスを変更しました`);
        updateStatus(statusCommand);
        return;
      }
      if (isHelpCommand(transcript)) {
        setHeard(`「${transcript}」→ ヘルプ要請として認識しました`);
        requestHelp();
        return;
      }
      if (isCancelCommand(transcript)) {
        setHeard(`「${transcript}」→ 解除として認識しました`);
        cancelHelp();
        return;
      }
      setHeard(`「${transcript}」`);
    };
    recognition.onend = () => {
      if (shouldListenRef.current) {
        window.setTimeout(() => {
          if (!shouldListenRef.current) return;
          try { recognition.start(); } catch {
            shouldListenRef.current = false;
            setListening(false);
            setHeard("マイクを再起動できませんでした。ページを再読み込みしてください");
          }
        }, 250);
      } else {
        setListening(false);
      }
    };
    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        shouldListenRef.current = false;
        setListening(false);
        setHeard("マイクの使用が許可されていません。ブラウザの設定を確認してください");
      }
    };
    recognitionRef.current = recognition;
    return () => {
      shouldListenRef.current = false;
      recognition.onend = null;
      recognition.stop();
      recognitionRef.current = null;
    };
  }, [cancelHelp, requestHelp, updateStatus]);

  const toggleListening = () => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    if (listening) {
      shouldListenRef.current = false;
      recognition.stop();
      setListening(false);
      setHeard("音声待機を停止しました");
    } else {
      shouldListenRef.current = true;
      setHeard("マイクを起動しています…");
      try { recognition.start(); } catch {
        shouldListenRef.current = false;
        setListening(false);
        setHeard("起動に失敗しました。ページを再読み込みして、もう一度お試しください");
      }
    }
  };

  const claim = () => {
    const status = help.status === "claimed" ? "critical" : help.status;
    updateHelp({ ...help, status, claimedAt: Date.now(), responder: "対応中" });
  };

  const acknowledge = () => {
    const status = help.status === "claimed" ? "critical" : help.status;
    updateHelp({ ...help, status, claimedAt: Date.now(), responder: "確認済み" });
  };

  const elapsed = formatElapsed(help.requestedAt, now);
  const responseState = help.responder === "確認済み" ? "seen" : help.responder === "対応中" || help.status === "claimed" ? "coming" : null;
  const staleLimit = help.status === "busy" ? settings.busyWarningMinutes * 60 * 1000 : help.status === "critical" || help.status === "waiting" ? settings.urgentWarningMinutes * 60 * 1000 : Number.POSITIVE_INFINITY;
  const isStale = Boolean(help.requestedAt && now - help.requestedAt >= staleLimit && responseState !== "coming");
  const statusClock = formatClock(help.requestedAt);

  return (
    <main className={`app ${help.status === "waiting" ? "is-alert" : ""}`}>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="声ヘルプ ホーム">
          <span className="brand-mark">声</span><span>声ヘルプ</span>
        </a>
        <span className="prototype">PROTOTYPE 01</span>
      </header>

      <section className="hero" id="top">
        <div className="eyebrow"><span className="pulse-dot" /> HANDS-FREE SUPPORT</div>
        <h1>声ひとつで、<br /><em>助けが届く。</em></h1>
        <p>手が離せない洗い場と、状況が見えないホールをつなぐ音声ヘルプシステム。</p>
      </section>

      <nav className="mode-switch" aria-label="表示モード">
        <button className={mode === "dish" ? "active" : ""} onClick={() => setMode("dish")}>
          <span>01</span> 洗い場モード
        </button>
        <button className={mode === "hall" ? "active" : ""} onClick={() => setMode("hall")}>
          <span>02</span> ホールモード
        </button>
        <button className={mode === "history" ? "active" : ""} onClick={() => setMode("history")}>
          <span>03</span> 履歴
        </button>
        <button className={mode === "settings" ? "active" : ""} onClick={() => setMode("settings")}>
          <span>04</span> 設定
        </button>
      </nav>

      {connection === "offline" && (
        <div className="offline-banner" role="status">
          <strong>オフライン</strong>
          <span>{hasPending ? "操作はこの端末に一時保存されています。接続が戻ると自動送信します。" : "最新状態を確認できません。接続が戻るまで表示内容に注意してください。"}</span>
        </div>
      )}

      {mode === "dish" ? (
        <section className={`console dish-console console-${help.status}`} aria-live="polite">
          <div className="console-head">
            <span>洗い場端末</span>
            <span className={`connection ${connection === "online" ? "online" : ""}`}>
              {connection === "online" ? (listening ? "同期中・音声待機中" : "同期中") : connection === "connecting" ? "接続中…" : "オフライン"}
            </span>
          </div>
          <div className={`glance-status glance-${help.status}`}>
            <span className="glance-dot" />
            <div>
              <small>現在の洗い場</small>
              <strong>{help.status === "idle" ? "大丈夫" : help.status === "busy" ? "少し忙しい" : help.status === "critical" ? "かなり忙しい" : help.status === "waiting" ? "緊急ヘルプ" : "対応に向かっています"}</strong>
            </div>
            {help.status !== "idle" && <b>{elapsed}</b>}
            {responseState && <span className={`response-chip response-${responseState}`}>{responseState === "seen" ? "ホール確認済み" : "スタッフ対応中"}</span>}
            {isStale && <span className="stale-chip">情報が古い可能性があります</span>}
          </div>
          <div className={`mic-orb ${listening ? "listening" : ""}`} aria-hidden="true">
            <span className="mic-icon">●</span><i /><i /><i />
          </div>
          <div className="command">
            <small>SAY THE COMMAND</small>
            <strong>「ステータス 黄色」</strong>
            <p>「ステータス青／黄色／赤」で状況を共有<br />緊急時は「ホールヘルプ」</p>
          </div>
          <button className={`listen-button ${listening ? "stop" : ""}`} onClick={toggleListening} disabled={!supported}>
            {supported ? (listening ? "音声待機を停止" : "音声待機を開始") : "この端末は音声認識に未対応です"}
          </button>
          <p className="heard">認識結果　{heard}</p>

          <div className="test-actions">
            <span>テスト操作</span>
            <div className="status-buttons">
              <button onClick={() => updateStatus("idle")}>青</button>
              <button onClick={() => updateStatus("busy")}>黄</button>
              <button onClick={() => updateStatus("critical")}>赤</button>
              <button onClick={requestHelp}>緊急HELP</button>
            </div>
          </div>
        </section>
      ) : mode === "hall" ? (
        <section className={`console hall-console console-${help.status}`} aria-live="assertive">
          <div className="console-head">
            <span>ホール共有画面</span>
            <span className={`connection ${connection === "online" ? "online" : ""}`}>
              {connection === "online" ? "同期中" : connection === "connecting" ? "接続中…" : "オフライン"}
            </span>
          </div>
          {notificationPermission !== "granted" && (
            <button className="notification-enable" onClick={enableNotifications} disabled={notificationPermission === "denied" || notificationPermission === "unsupported"}>
              <span>{notificationPermission === "denied" ? "通知がブロックされています" : notificationPermission === "unsupported" ? "この端末は通知に未対応です" : "端末の通知を有効にする"}</span>
              <small>{notificationPermission === "default" ? "画面を見ていない時に状態変更を知らせます" : "タブ表示によるお知らせは利用できます"}</small>
            </button>
          )}
          <div className={`glance-status hall-glance glance-${help.status}`}>
            <span className="glance-dot" />
            <div>
              <small>洗い場の現在状況</small>
              <strong>{help.status === "idle" ? "大丈夫" : help.status === "busy" ? "少し忙しい" : help.status === "critical" ? "かなり忙しい" : help.status === "waiting" ? "緊急ヘルプ" : "スタッフが対応中"}</strong>
            </div>
            {help.status !== "idle" && <b>{elapsed}</b>}
            {responseState && <span className={`response-chip response-${responseState}`}>{responseState === "seen" ? "確認済み" : "対応中"}</span>}
            {isStale && <span className="stale-chip">要確認｜{statusClock}の状態</span>}
          </div>
          {help.status === "idle" ? (
            <div className="all-clear">
              <span className="check">✓</span>
              <small>DISH STATION</small>
              <h2>洗い場は落ち着いています</h2>
              <p>現在のステータスは青です。</p>
            </div>
          ) : help.status === "busy" || help.status === "critical" ? (
            <div className={`situation situation-${help.status}`}>
              <small>NEXT ACTION</small>
              <h2>{help.status === "busy" ? "手が空いたら、様子を確認" : "洗い場の確認をお願いします"}</h2>
              <p>{help.status === "busy" ? "急ぎではありません。次に手が空いたタイミングで大丈夫です。" : "対応できるスタッフがいれば、洗い場へ向かってください。"}</p>
              {isStale && <p className="stale-message">この状態はしばらく更新されていません。現在の洗い場を確認してください。</p>}
              {responseState === "coming" ? (
                <button className="complete-button" onClick={cancelHelp}>対応を完了する</button>
              ) : (
                <div className="response-actions">
                  <button className="ack-button" onClick={acknowledge} disabled={responseState === "seen"}>{responseState === "seen" ? "確認済みです" : "確認しました"}</button>
                  <button className="claim-button" onClick={claim}>今から向かいます <span>→</span></button>
                </div>
              )}
              <button className="quiet-reset" onClick={() => updateStatus("idle")}>通常に戻す</button>
            </div>
          ) : (
            <div className="help-alert">
              <div className="alert-label"><span /> 洗い場からヘルプ要請</div>
              <div className="timer">{elapsed}</div>
              <p>{responseState === "seen" ? "ホールで状況を確認しています" : responseState === "coming" ? "スタッフが洗い場へ向かっています" : "対応できるスタッフを探しています"}</p>
              {responseState === "coming" ? (
                <button className="complete-button" onClick={cancelHelp}>対応を完了する</button>
              ) : (
                <div className="response-actions">
                  <button className="ack-button" onClick={acknowledge} disabled={responseState === "seen"}>{responseState === "seen" ? "確認済みです" : "確認しました"}</button>
                  <button className="claim-button" onClick={claim}>今から向かいます <span>→</span></button>
                </div>
              )}
            </div>
          )}
          <div className="hall-note"><b>共有の約束</b><p>状況に気づいた人がボタンを押します。対応中の表示に変わるため、他のスタッフとの重複を防げます。</p></div>
        </section>
      ) : mode === "history" ? (
        <section className="console history-console">
          <div className="console-head">
            <span>直近24時間の記録</span>
            <span className={`connection ${history ? "online" : ""}`}>{history ? "更新中" : "読み込み中…"}</span>
          </div>
          <div className="history-title">
            <small>ACTIVITY REPORT</small>
            <h2>洗い場の状況を、<br />改善につなげる。</h2>
            <p>個人名や音声は保存せず、状態と対応時間だけを記録しています。</p>
          </div>
          <div className="summary-grid">
            <article><small>少し忙しい</small><strong>{history?.summary.busyCount ?? 0}</strong><span>回</span></article>
            <article><small>赤・緊急</small><strong>{history?.summary.urgentCount ?? 0}</strong><span>回</span></article>
            <article><small>確認された回数</small><strong>{history?.summary.acknowledgedCount ?? 0}</strong><span>回</span></article>
            <article><small>平均反応時間</small><strong className="duration-value">{formatDuration(history?.summary.averageResponseMs ?? null)}</strong></article>
          </div>
          <div className="event-list">
            <div className="event-list-head"><span>最近の動き</span><span>最大40件</span></div>
            {!history?.events.length ? <p className="empty-history">記録はまだありません。ステータスを変更すると、ここに表示されます。</p> : history.events.map((event) => {
              const labels: Record<string, string> = {
                status_idle: "通常に変更", status_busy: "少し忙しい", status_critical: "かなり忙しい",
                status_waiting: "緊急ヘルプ", acknowledged: "ホールが確認", responding: "スタッフが対応", completed: "対応完了",
              };
              return (
                <div className={`event-row event-${event.status}`} key={event.id}>
                  <span className="event-dot" />
                  <div><strong>{labels[event.action] ?? event.action}</strong><small>{new Date(event.createdAt).toLocaleString("ja-JP", { month:"numeric", day:"numeric", hour:"2-digit", minute:"2-digit" })}</small></div>
                  <b>{event.action === "acknowledged" || event.action === "responding" ? formatDuration(event.responseMs) : ""}</b>
                </div>
              );
            })}
          </div>
        </section>
      ) : (
        <section className="console settings-console">
          <div className="console-head"><span>店舗・端末設定</span><span className={`connection ${connection === "online" ? "online" : ""}`}>{connection === "online" ? "同期中" : "オフライン"}</span></div>
          <div className="settings-title"><small>SETTINGS</small><h2>現場に合わせて、<br />無理なく調整。</h2><p>警告時間は店舗で共有され、振動設定はこの端末だけに保存されます。</p></div>
          <div className="settings-list">
            <label className="setting-row">
              <div><strong>黄色の更新警告</strong><small>「少し忙しい」が古い可能性を知らせるまで</small></div>
              <select value={settings.busyWarningMinutes} onChange={(event) => { setSettings({ ...settings, busyWarningMinutes: Number(event.target.value) }); setSettingsSaved(false); }}>
                {[5, 10, 15, 20, 30].map((minute) => <option value={minute} key={minute}>{minute}分</option>)}
              </select>
            </label>
            <label className="setting-row">
              <div><strong>赤・緊急の更新警告</strong><small>重要な状態が古い可能性を知らせるまで</small></div>
              <select value={settings.urgentWarningMinutes} onChange={(event) => { setSettings({ ...settings, urgentWarningMinutes: Number(event.target.value) }); setSettingsSaved(false); }}>
                {[3, 5, 10, 15].map((minute) => <option value={minute} key={minute}>{minute}分</option>)}
              </select>
            </label>
            <label className="setting-row toggle-row">
              <div><strong>状態変更時の振動</strong><small>この端末が対応している場合のみ振動します</small></div>
              <input type="checkbox" checked={vibrationEnabled} onChange={(event) => { setVibrationEnabled(event.target.checked); setSettingsSaved(false); }} />
            </label>
          </div>
          <button className="save-settings" onClick={saveSettings}>{settingsSaved ? "保存しました" : "設定を保存する"}</button>
          <div className="command-guide"><b>現在の音声コマンド</b><span>ステータス青</span><span>ステータス黄色</span><span>ステータス赤</span><span>ホールヘルプ</span></div>
        </section>
      )}

      <footer><span>KOE HELP / FIELD TEST</span><span>音声は保存されません</span></footer>
    </main>
  );
}

