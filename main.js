/*!
 * main.js — 画面と操作だけを持つ層。数学的な判断は questions.js / domain-judge.js に置く。
 *
 * 設計の3規則（崩すと画面が二重に出る）:
 *   1. hidden を書き換えるのは applyScreen() 一箇所だけ。
 *   2. すべてのハンドラの先頭で session.screen / session.phase をガードする。
 *   3. addEventListener は init() で一度だけ。画面を描き直すたびに登録しない。
 */

import {
  COURSE_ID, SET_SIZE, CLEAR_THRESHOLD, SCHEMA_VERSION, RNG_VERSION,
  generateSet, generateReviewQuestion, deriveSeed, promptSummary
} from './questions.js?v=20261024c';

import { judge, consumes } from './domain-judge.js?v=20261024c';   // questions.js と同じ URL（違うと二重に読み込まれる）

/* ============================================================
 * 保存（このアプリの2キーだけを扱う）
 * ========================================================== */

const KEYS = {
  course: `nyushi-series:v2:course:${COURSE_ID}`,
  history: `nyushi-series:v2:history:${COURSE_ID}`
};

const memory = {};                       // localStorage が使えない端末のフォールバック
const HISTORY_LIMIT = 20;

function storageGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return key in memory ? memory[key] : fallback;
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return key in memory ? memory[key] : fallback;
  }
}

function storageSet(key, value) {
  memory[key] = value;
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 容量超過などは無視して続行 */ }
}

function storageRemove(key) {
  delete memory[key];
  try { localStorage.removeItem(key); } catch { /* 続行 */ }
}

function defaultCourse() {
  return {
    schemaVersion: SCHEMA_VERSION, rngVersion: RNG_VERSION, bestScore: 0,
    lastMistakes: [], lastTypeKeys: []
  };
}

/** 壊れた保存データを読み込んでも落ちないように、型を検証してから使う。 */
function courseData() {
  const raw = storageGet(KEYS.course, null);
  const base = defaultCourse();
  if (!raw || typeof raw !== 'object') return base;
  return {
    schemaVersion: SCHEMA_VERSION,
    rngVersion: RNG_VERSION,
    bestScore: Number.isFinite(raw.bestScore) ? raw.bestScore : 0,
    lastMistakes: Array.isArray(raw.lastMistakes)
      ? raw.lastMistakes.filter(m => m && Number.isFinite(m.seed) && Number.isInteger(m.slotIndex))
      : [],
    // 直前セットで出た型。連続したセットで同じ型が続かないようにするために持つ
    lastTypeKeys: Array.isArray(raw.lastTypeKeys) ? raw.lastTypeKeys.filter(k => typeof k === 'string') : []
  };
}

function historyData() {
  const raw = storageGet(KEYS.history, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter(item => item && Number.isFinite(item.at) && Number.isFinite(item.score)).slice(0, HISTORY_LIMIT);
}

/* ============================================================
 * セッション（唯一の状態）
 * ========================================================== */

const session = {
  screen: 'HOME',            // HOME | QUESTION | RESULT
  mode: 'normal',            // normal | review
  phase: 'INPUT',            // INPUT | FEEDBACK
  items: [],                 // [{ question, hintLevel, status, valueCorrect, raw, studentLatex, code }]
  index: 0,
  score: 0,
  reviewRound: 0,
  reviewQueue: [],
  recorded: false,
  feedbackAt: null,
  autoAdvancing: false
};

const $ = id => document.getElementById(id);
let handwriting = null;
let scrollHint = null;
let overflowHint = null;
const NEXT_LOCK_MS = 500;      // M-4: 採点直後に「次へ」を受け付けない時間（Enter の連打・長押しで解説を読み飛ばさない）
const AUTO_NEXT_MS = 1000;     // 正解の演出を見せてから次の問題へ送るまで
const BADGE_HIDE_MS = 1200;    // 不正解などで演出を消すまで（解説の邪魔をしない）
let autoNextTimer = null;
let badgeTimer = null;

/* ============================================================
 * MathJax / MathLive
 * ========================================================== */

function typeset(element) {
  const mj = window.MathJax;
  if (!mj || !mj.typesetPromise) { updateSupportOverflow(); return Promise.resolve(); }
  try { if (mj.typesetClear) mj.typesetClear([element]); } catch { /* 続行 */ }
  return mj.typesetPromise([element])
    .catch(error => { console.warn('数式の表示に失敗しました', error); })
    .then(() => { updateSupportOverflow(); updateQuestionOverflow(); });
}

/** 問題文の式が横に続いていることを、生徒に見える形で知らせる。 */
function updateQuestionOverflow() {
  if (!overflowHint) return;
  const box = $('question-heading');
  const scrollable = box.scrollWidth - box.clientWidth > 4;
  box.classList.toggle('is-scrollable', scrollable);
  const remaining = box.scrollWidth - box.clientWidth - box.scrollLeft;
  overflowHint.hidden = box.hidden || remaining <= 4;
}

/** 解説パネルに隠れている部分があることを、生徒に見える形で知らせる。 */
function updateSupportOverflow() {
  if (!scrollHint) return;
  const panel = $('support-content');
  const remaining = panel.scrollHeight - panel.clientHeight - panel.scrollTop;
  scrollHint.hidden = remaining <= 4;
  panel.classList.toggle('is-scrollable', panel.scrollHeight - panel.clientHeight > 4);
}

function setupScrollHint() {
  overflowHint = document.createElement('p');
  overflowHint.className = 'overflow-hint';
  overflowHint.hidden = true;
  overflowHint.textContent = '→ 右に続きます（式を横にスクロールできます）';
  $('question-heading').after(overflowHint);

  scrollHint = document.createElement('p');
  scrollHint.className = 'scroll-hint';
  scrollHint.hidden = true;
  scrollHint.textContent = '↓ 続きがあります（この枠の中をスクロールできます）';
  $('support-content').after(scrollHint);
}

function mathField() { return $('answer-field'); }

function answerLatex() {
  const field = mathField();
  try {
    if (typeof field.getValue === 'function') return field.getValue('latex-expanded') || '';
  } catch { /* 下のフォールバックへ */ }
  return field.value || '';
}

function setupMathField() {
  const field = mathField();
  const apply = () => {
    try {
      field.smartMode = false;          // 連続した文字が \mathrm 化されるのを止める
      field.smartFence = false;
      field.inlineShortcuts = {};
      // スペースキーの空白を \\: として残す（-2 5 が 25 に化けて採点されないように。採点で「書きかけ」にする）
      field.mathModeSpace = '\\:';
      // manual はタッチだけの端末で入力できなくなるので使わない（シリーズ共通の決まり）
      field.mathVirtualKeyboardPolicy = 'auto';
    } catch { /* 属性側の指定で足りる */ }
  };
  apply();
  if (window.customElements && customElements.whenDefined) {
    customElements.whenDefined('math-field').then(apply).catch(() => {});
  }
  // 全角・上付き数字（ａ³・x²）は欄へ書き戻さない。採点のときに domain-judge.js がそろえて読む。
  // （書き戻すと NFKC で a³ が a3 に化けていた）
  installSqrtImeFix(field);

  // 採点後（FEEDBACK）に何かの拍子で欄へフォーカスが戻ったら（入力補助ボタンのあとの遅れたフォーカスなど）、
  // 欄から外して「次へ」へ移す。read-only の欄が Enter を吸って「次へ」に進めなくなるのを防ぐ。
  field.addEventListener('focusin', () => {
    if (session.screen !== 'QUESTION' || session.phase === 'INPUT') return;
    try { field.blur(); } catch { /* 続行 */ }
    focusNextButton();
  });

  bindMathFieldSubmit(field, () => {
    if (session.screen !== 'QUESTION' || session.phase !== 'INPUT') return;
    if (document.querySelector('dialog[open]')) return;
    submit();
  });
  followVirtualKeyboard(() => [
    document.querySelector('.answer-area'),
    document.querySelector('#verdict-badge:not([hidden])'),
    document.querySelector('.answer-actions')
  ]);
}

/* ------------------------------------------------------------
 * 決定と仮想キーボード（大問2シリーズ8本でそろえる小さな部品。linear-equation-master の手本を写した）
 * ---------------------------------------------------------- */

/**
 * 入力欄の「決定」を、実キーの Enter と、仮想キーボードの ↵（MathLive の change）の両方で受ける。
 *   実キー: 欄の keydown を capture で受け、!isComposing && keyCode!==229 && !repeat のときだけ（IME の確定では決定しない）。
 *   ↵: keydown を出さないので change で拾う。change は欄からフォーカスが外れたときにも出るので、欄にフォーカスがあるときだけ。
 * 同じ操作で両方が来ても、400ms 以内の2回目は無視して二重採点を防ぐ。欄ごとに1回だけ。
 */
function bindMathFieldSubmit(field, onSubmit) {
  if (!field || field.dataset.submitBound) return;
  field.dataset.submitBound = '1';
  let last = 0;
  const fire = () => { const now = Date.now(); if (now - last < 400) return; last = now; onSubmit(); };
  field.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    if (event.isComposing || event.keyCode === 229) return;
    // 解説を出している間（FEEDBACK）は document の「次へ」に任せる
    if (session.screen !== 'QUESTION' || session.phase !== 'INPUT') return;
    event.preventDefault();
    event.stopPropagation();                        // document の Enter（次へ）と二重にしない
    if (event.repeat) return;                       // 長押し（キーリピート）では動かさない
    fire();
  }, true);
  field.addEventListener('change', () => {
    const focused = typeof field.hasFocus === 'function' ? field.hasFocus() : document.activeElement === field;
    if (focused) fire();
  });
}

/**
 * 仮想キーボードが出ている間は、<html> に vk-open と --vk-height を付けて高さ固定をゆるめ（CSS 側）、
 * getTargets() が返す要素（入力欄・判定・決定ボタン）がキーボードの上に見えるようにスクロールする。閉じたら先頭へ戻す。
 */
function followVirtualKeyboard(getTargets) {
  const vk = window.mathVirtualKeyboard;
  if (!vk || followVirtualKeyboard.bound) return;
  followVirtualKeyboard.bound = true;
  followVirtualKeyboard.getTargets = getTargets;
  const update = () => {
    const h = Math.round((vk.boundingRect && vk.boundingRect.height) || 0);
    const open = vk.visible !== false && h > 0;
    const root = document.documentElement;
    const was = root.classList.contains('vk-open');
    root.classList.toggle('vk-open', open);
    root.style.setProperty('--vk-height', `${open ? h : 0}px`);
    if (!open) { if (was) window.scrollTo(0, 0); return; }
    requestAnimationFrame(() => {
      const els = (followVirtualKeyboard.getTargets() || []).filter(Boolean);
      if (!els.length) return;
      const rects = els.map(e => e.getBoundingClientRect());
      const top = Math.min(...rects.map(r => r.top));
      const bottom = Math.max(...rects.map(r => r.bottom));
      const visibleBottom = window.innerHeight - h - 8;
      let dy = 0;
      if (bottom > visibleBottom) dy = bottom - visibleBottom;
      if (top - dy < 8) dy = top - 8;
      if (dy) window.scrollBy(0, dy);
    });
  };
  vk.addEventListener('geometrychange', update);
  // MathLive 0.98.4 では、出したときに geometrychange が来ず virtual-keyboard-toggle だけが来ることがある
  vk.addEventListener('virtual-keyboard-toggle', update);
  window.addEventListener('resize', update);
  followVirtualKeyboard.update = update;
}

/* ------------------------------------------------------------
 * IME の √ 対策（平方根・二次方程式のドリルにも同じものを写す）
 *
 * 全角のまま「２るーと３」を変換して「２√３」を1回で確定すると、MathLive 0.98.4 は
 * 欄を \sqrt{２\surd３} に変えてしまう（決定しても読めない）。
 * 確定した文字列に √ が含まれ2文字以上のときだけ、MathLive の既定の処理を止めて、
 * 半角にした LaTeX（2\sqrt{3}）を入れ直す。√ を含まない確定（ａ³・ｘ²・－４８）には一切手を出さない。
 * ---------------------------------------------------------- */
const IME_SUPERSCRIPT = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };

/** 「２√３」→「2\sqrt{3}」。√ の直後の数（小数可）・文字1つ・(...) だけを根号の中にする。読めない文字があれば null。 */
function imeSqrtToLatex(text) {
  let s = String(text).replace(/[⁰¹²³⁴-⁹]+/g, m => `^{${[...m].map(c => IME_SUPERSCRIPT[c]).join('')}}`);
  // 空白を消してから × を置きかえる（\times の後ろの空白まで消すと、最後の照合に通らない）
  s = s.normalize('NFKC').replace(/[−‐‑‒–—―ー]/g, '-').replace(/\s+/g, '')
    .replace(/[×✕]/g, '\\times ').replace(/[・･·⋅]/g, '\\cdot ');   // 中点（・ ･ · ⋅）はかけ算の記号
  s = s.replace(/√(\(([^()]*)\)|\d+(?:\.\d+)?|[A-Za-z])?/g, (_, all, inner) =>
    `\\sqrt{${all === undefined ? '#?' : (inner !== undefined ? inner : all)}}`);
  return /^(?:[0-9A-Za-z.+\-*/()=^{}#?]|\\sqrt|\\times |\\cdot )*$/.test(s) ? s : null;
}

function installSqrtImeFix(field) {
  let replaying = false;
  field.addEventListener('compositionend', event => {
    if (replaying) return;
    const text = event.data;
    if (typeof text !== 'string' || text.length < 2 || !text.includes('√')) return;
    const latex = imeSqrtToLatex(text);
    if (latex === null) return;
    event.stopImmediatePropagation();          // MathLive の既定の挿入（\sqrt{２\surd３} になる）を止める
    event.preventDefault();
    // MathLive の「変換中」の状態は終わらせる（止めたままだと、その後のキー入力を受け付けなくなる）。
    // 中身の無い compositionend を同じ要素へ送り直す。
    const sink = event.composedPath()[0];
    replaying = true;
    try {
      if (sink && sink.dispatchEvent) {
        if ('textContent' in sink) sink.textContent = '';
        sink.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, composed: true, data: '' }));
      }
    } catch { /* 続行 */ } finally { replaying = false; }
    // 「２√」のように根号の中が空のときは、カーソルを根号の枠の中に置く（続けて打った 3 が根号の中に入る）
    const options = { selectionMode: latex.includes('#?') ? 'placeholder' : 'after', focus: true };
    try { field.insert(latex, options); }
    catch { try { field.executeCommand(['insert', latex, options]); } catch { /* 続行 */ } }
  }, true);
}

function setFieldLocked(locked) {
  const field = mathField();
  try {
    field.readOnly = locked;
    if (locked) { field.setAttribute('read-only', ''); field.blur(); }
    else field.removeAttribute('read-only');
  } catch { /* 続行 */ }
}

/** 入力中（INPUT）でロックしていないときだけ欄にフォーカスを入れる。遅れて走っても、採点後の欄には戻さない。 */
function focusField() {
  requestAnimationFrame(() => {
    if (session.screen !== 'QUESTION' || session.phase !== 'INPUT') return;
    const field = mathField();
    if (!field || field.readOnly || field.hasAttribute('read-only')) return;
    try { field.focus(); } catch { /* 続行 */ }
  });
}

/** 採点後は「次へ」にフォーカスを移す（実キーの Enter が欄に吸われないように）。 */
function focusNextButton() {
  const button = $('next-button');
  if (!button || button.hidden || button.disabled) return;
  try { button.focus({ preventScroll: true }); } catch { /* 続行 */ }
}

/** √・分数・指数は枠を入れて、カーソルを枠の中へ置く（selectionMode: 'placeholder'） */
function insertToField(text) {
  if (session.screen !== 'QUESTION' || session.phase !== 'INPUT') return;
  const field = mathField();
  const options = { selectionMode: 'placeholder', focus: true };
  try {
    if (typeof field.insert === 'function') field.insert(text, options);
    else field.executeCommand(['insert', text, options]);
  } catch {
    try { field.executeCommand(['insert', text, options]); } catch { /* 続行 */ }
  }
  focusField();
}

function runFieldCommand(command) {
  if (session.screen !== 'QUESTION' || session.phase !== 'INPUT') return;
  const field = mathField();
  try { field.executeCommand(command); } catch { /* 続行 */ }
  focusField();
}

/* ============================================================
 * 画面の切り替え（hidden を書き換えるのはここだけ）
 * ========================================================== */

const SCREENS = { HOME: 'home-screen', QUESTION: 'question-screen', RESULT: 'result-screen' };

function applyScreen() {
  for (const [name, id] of Object.entries(SCREENS)) $(id).hidden = (name !== session.screen);
  if (handwriting) {
    if (session.screen === 'QUESTION') handwriting.setAvailable(true);
    else handwriting.reset(false);
  }
}

/* ============================================================
 * HOME
 * ========================================================== */

function formatDate(value) {
  try {
    return new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      .format(new Date(value));
  } catch { return ''; }
}

function renderHistory() {
  const list = $('history-list');
  list.replaceChildren();
  const items = historyData();
  if (!items.length) {
    list.textContent = 'まだ記録はありません。';
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'history-item';
    const state = item.aborted ? '中断' : item.cleared ? 'クリア' : '挑戦中';
    row.textContent = `${formatDate(item.at)}　${item.score} / ${item.total}　${state}`;
    list.append(row);
  }
}

function goHome() {
  clearAutoNext();
  // 通常セットを1問以上進めた状態で抜けたときだけ「中断」を残す（二重記録を recorded で防ぐ）
  if (session.screen === 'QUESTION' && session.mode === 'normal' && session.index > 0 && !session.recorded) {
    pushHistory({ score: session.score, total: session.items.length, cleared: false, aborted: true });
    session.recorded = true;
  }
  session.screen = 'HOME';
  session.phase = 'INPUT';
  applyScreen();
  renderHistory();
}

/* ============================================================
 * セットの開始
 * ========================================================== */

function newSessionSeed() {
  return deriveSeed([Date.now(), Math.trunc(performance.now() * 1000), session.reviewRound]);
}

function startNormal() {
  clearAutoNext();
  const course = courseData();
  const questions = generateSet(newSessionSeed(), 'normal', { avoidTypeKeys: course.lastTypeKeys });
  session.mode = 'normal';
  session.items = questions.map(question => newItem(question));
  session.index = 0;
  session.score = 0;
  session.reviewQueue = [];
  session.reviewRound = 0;
  session.recorded = false;
  session.phase = 'INPUT';
  session.screen = 'QUESTION';
  applyScreen();
  renderQuestion();
}

function startReview() {
  clearAutoNext();
  const queue = session.reviewQueue.length ? session.reviewQueue : courseData().lastMistakes;
  if (!queue.length) return;
  session.mode = 'review';
  session.reviewRound += 1;
  session.items = queue.map(entry => newItem(generateReviewQuestion(entry, session.reviewRound)));
  session.index = 0;
  session.score = 0;
  session.recorded = true;           // 復習は記録に残さない
  session.phase = 'INPUT';
  session.screen = 'QUESTION';
  applyScreen();
  renderQuestion();
}

function newItem(question) {
  return { question, hintLevel: 0, status: null, kind: null, valueCorrect: false, raw: '', studentLatex: null, code: null };
}

function currentItem() { return session.items[session.index]; }

/* ============================================================
 * QUESTION
 * ========================================================== */

const KEYPAD_BASE = [
  { label: '√', insert: '\\sqrt{#0}' },
  { label: '分数', insert: '\\frac{#0}{#?}' },
  { label: '指数', insert: '^{#?}' },
  { label: '＋', insert: '+' },
  { label: '−', insert: '-' },
  // 指数・根号・分数の中から出るための移動キー。タッチ操作だけの端末ではこれがないと詰む。
  { label: '→', command: 'moveToNextChar', title: '指数や根号の外に出る' }
];

/** 単位は入力欄の右のラベルに表示する。math-field の中には入れない。 */
function renderUnitLabel(question) {
  const label = $('unit-label');
  const unit = question.answerSpec.unit;
  if (unit && unit.symbol) {
    // 生LaTeXを出さないよう MathJax に組ませる
    label.textContent = `\\(\\mathrm{${unit.symbol}}\\)`;
    label.classList.remove('is-empty');
    label.setAttribute('aria-hidden', 'false');
    label.setAttribute('aria-label', `単位は ${unit.symbol}。答えの欄には式だけを入力する`);
  } else {
    label.textContent = '';
    label.classList.add('is-empty');
    label.setAttribute('aria-hidden', 'true');
    label.removeAttribute('aria-label');
  }
}

function renderKeypad(question) {
  const keypad = $('keypad');
  keypad.replaceChildren();
  const buttons = [
    ...question.answerSpec.allowedVariables.map(name => ({ label: name, insert: name })),
    ...KEYPAD_BASE
  ];
  for (const item of buttons) {
    const button = document.createElement('button');
    button.type = 'button';
    if (item.command) button.dataset.command = item.command;
    else button.dataset.insert = item.insert;
    if (item.title) button.title = item.title;
    button.textContent = item.label;
    keypad.append(button);
  }
}

function setKeypadDisabled(disabled) {
  for (const button of $('keypad').querySelectorAll('button')) button.disabled = disabled;
}

/** M-4: 採点直後の短い間はキー操作で次へ進めない（Enter の長押しで解説を読み飛ばすのを防ぐ） */
function nextLocked() {
  return session.feedbackAt != null && Date.now() - session.feedbackAt < NEXT_LOCK_MS;
}

/** 予約している自動送り・演出の消灯をすべて取り消す。画面を離れるときに必ず呼ぶ。 */
function clearAutoNext() {
  if (autoNextTimer !== null) { clearTimeout(autoNextTimer); autoNextTimer = null; }
  if (badgeTimer !== null) { clearTimeout(badgeTimer); badgeTimer = null; }
  session.autoAdvancing = false;
}

function hideVerdict() {
  const badge = $('verdict-badge');
  badge.hidden = true;
  badge.className = 'verdict-badge';
  $('verdict-mark').textContent = '';
  $('verdict-text').textContent = '';
  const wrap = document.querySelector('.math-field-wrap');
  wrap.classList.remove('is-correct', 'is-incorrect', 'is-unfinished', 'is-notation', 'is-negden');
}

/**
 * 正誤の演出。記号と文字の両方で示す（色だけに意味を持たせない）。
 * アニメーションはCSSのみ。prefers-reduced-motion では記号の表示だけになる。
 */
function showVerdict(kind, mark, text) {
  const badge = $('verdict-badge');
  badge.className = `verdict-badge is-${kind}`;
  $('verdict-mark').textContent = mark;
  $('verdict-text').textContent = text;
  badge.hidden = false;
  // アニメーションを問題ごとに必ず再生させる
  badge.getAnimations?.().forEach(a => a.cancel());
  for (const child of badge.children) child.getAnimations?.().forEach(a => { a.cancel(); a.play(); });
  document.querySelector('.math-field-wrap').classList.add(`is-${kind}`);
}

function renderQuestion() {
  const item = currentItem();
  const question = item.question;

  // 前の問題の欄を先に外す（古いフォーカスと新しい問題の切り替えが重ならないように）
  try { mathField().blur(); } catch { /* 続行 */ }

  $('mode-note').hidden = session.mode !== 'review';
  $('progress-label').textContent = `Q ${session.index + 1} / ${session.items.length}`;
  $('score-label').textContent = `正解 ${session.score}`;
  $('progress-bar').style.width = `${(session.index / session.items.length) * 100}%`;

  const lead = question.promptParts.filter(part => part.type === 'text').map(part => part.value).join(' ');
  const math = question.promptParts.filter(part => part.type === 'math').map(part => part.value).join(' ');
  $('question-lead').textContent = lead;
  $('question-heading').textContent = math ? `\\[${math}\\]` : '';
  $('question-heading').hidden = !math;
  $('question-heading').scrollLeft = 0;
  if (overflowHint) overflowHint.hidden = true;

  const support = $('support-content');
  support.replaceChildren(Object.assign(document.createElement('p'), {
    className: 'support-placeholder',
    textContent: 'つまずいたら、ヒントを1つずつ開こう。'
  }));

  renderUnitLabel(question);
  renderKeypad(question);
  setKeypadDisabled(false);
  try { mathField().value = ''; } catch { /* 続行 */ }
  setFieldLocked(false);

  clearAutoNext();
  hideVerdict();
  session.phase = 'INPUT';
  $('submit-button').hidden = false;
  $('submit-button').disabled = false;
  $('next-button').hidden = true;
  $('next-button').disabled = false;
  $('hint-button').disabled = false;
  $('hint-button').textContent = 'ヒント1を見る';

  typeset($('question-screen').querySelector('.question-card'));
  typeset(support);
  window.scrollTo(0, 0);
  focusField();
  if (followVirtualKeyboard.update) followVirtualKeyboard.update();
}

function appendMath(target, latex, className = 'math-line') {
  const p = document.createElement('p');
  p.className = className;
  p.textContent = `\\[${latex}\\]`;
  target.append(p);
  return p;
}

function appendLabel(target, text) {
  const p = document.createElement('p');
  p.className = 'feedback-label';
  p.textContent = text;
  target.append(p);
}

function appendNote(target, text) {
  const p = document.createElement('p');
  p.className = 'feedback-note';
  p.textContent = text;
  target.append(p);
}

/* ---- ヒント（1つのボタンで3段階を順に開く） ---- */
function showHint() {
  if (session.screen !== 'QUESTION' || session.phase !== 'INPUT') return;
  const item = currentItem();
  if (item.hintLevel >= 2) {
    const dialog = $('final-hint-dialog');
    if (!dialog.open) dialog.showModal();
    return;
  }
  item.hintLevel += 1;
  const support = $('support-content');
  if (item.hintLevel === 1) support.replaceChildren();

  const card = document.createElement('section');
  card.className = 'hint-step';
  const heading = document.createElement('div');
  heading.className = 'hint-step-heading';
  const badge = document.createElement('span');
  badge.className = 'hint-step-badge';
  badge.textContent = String(item.hintLevel);
  const title = document.createElement('strong');
  title.textContent = item.hintLevel === 1 ? '着眼点' : '最初の変形';
  heading.append(badge, title);
  const body = document.createElement('p');
  body.className = 'hint-step-body';
  body.textContent = item.question.hints[item.hintLevel - 1];
  card.append(heading, body);
  support.append(card);

  $('hint-button').textContent = item.hintLevel === 1 ? 'ヒント2を見る' : '答えを見る';
  typeset(support);
}

function confirmFinalHint() {
  const dialog = $('final-hint-dialog');
  if (dialog.open) dialog.close();
  if (session.screen !== 'QUESTION' || session.phase !== 'INPUT') return;
  const item = currentItem();
  item.hintLevel = 3;
  finishQuestion({ status: 'GIVE_UP', code: 'GIVE_UP', valueCorrect: false, message: '', studentLatex: null }, answerLatex());
}

/* ---- 提出 ---- */
function submit() {
  if (session.screen !== 'QUESTION' || session.phase !== 'INPUT') return;
  const item = currentItem();
  const raw = answerLatex();
  const verdict = judge(raw, item.question);

  if (!consumes(verdict)) {
    // 空欄・答えとして読めない入力は「1回の提出」に数えない（採点・記録・ロックしない）。書き直させる。
    const support = $('support-content');
    support.replaceChildren();
    const p = document.createElement('p');
    p.className = 'feedback warn';
    p.textContent = verdict.status === 'empty' ? 'まだ答えが入っていません' : 'まだ答えとして読み取れません';
    support.append(p);
    appendNote(support, verdict.message || '式の書き方を確かめよう。');
    typeset(support);
    focusField();
    if (followVirtualKeyboard.update) followVirtualKeyboard.update();
    return;
  }
  finishQuestion(verdict, raw);
}

function finishQuestion(verdict, raw) {
  const item = currentItem();
  const question = item.question;
  const correct = verdict.status === 'correct';
  const view = verdictView(verdict);

  item.status = verdict.status;
  item.kind = verdict.kind || null;
  item.valueCorrect = Boolean(verdict.valueCorrect);
  item.raw = raw;
  item.studentLatex = verdict.studentLatex || null;
  item.studentCanonical = verdict.studentCanonical || null;
  item.code = verdict.formCode || verdict.code || null;
  if (correct) session.score += 1;

  session.phase = 'FEEDBACK';
  session.feedbackAt = Date.now();
  $('submit-button').hidden = true;
  $('next-button').hidden = false;
  $('hint-button').disabled = true;
  setKeypadDisabled(true);
  setFieldLocked(true);
  focusNextButton();

  clearAutoNext();
  if (correct) {
    showVerdict(view.badge, view.mark, view.text);
    // 正解のときは解説を読ませる必要がないので、演出を見せてから自動で次へ送る
    session.autoAdvancing = true;
    $('next-button').disabled = true;
    autoNextTimer = setTimeout(() => { autoNextTimer = null; advance(); }, AUTO_NEXT_MS);
  } else {
    showVerdict(view.badge, view.mark, view.text);
    // 不正解・形式エラー・ギブアップは自動で送らない（解説を読む必要があるため）
    badgeTimer = setTimeout(() => { badgeTimer = null; $('verdict-badge').hidden = true; }, BADGE_HIDE_MS);
  }
  $('score-label').textContent = `正解 ${session.score}`;
  $('progress-bar').style.width = `${((session.index + 1) / session.items.length) * 100}%`;

  const support = $('support-content');
  support.replaceChildren();

  const title = document.createElement('p');
  title.className = `feedback ${view.titleClass}`;
  title.textContent = view.title;
  support.append(title);

  if (correct) {
    appendNote(support, '値も答えの形も正しく書けたね。');
  } else {
    appendLabel(support, verdict.valueCorrect ? 'あなたが書いた形' : 'あなたの答え');
    if (item.studentLatex) {
      // 生の入力は typeset しない。読み取れた式だけを組み直して表示する。
      appendMath(support, item.studentLatex);
    } else {
      const plain = document.createElement('p');
      plain.className = 'feedback-note plain-answer mathjax-ignore';
      plain.textContent = raw ? raw : '入力なし';
      support.append(plain);
    }

    appendLabel(support, verdict.valueCorrect ? '整理した答えの形' : '正しい答え');
    appendMath(support, question.answerLatex);

    appendLabel(support, verdict.valueCorrect ? '直すところ' : '考えられる原因');
    appendNote(support, verdict.status === 'GIVE_UP'
      ? '答えを見たので、この問題は不正解として記録します。'
      : (verdict.message || '式の書き方を確かめよう。'));

    // 「次の注意」はいちばん持ち帰ってほしい一文なので、背の高い解説より前に置く
    appendLabel(support, '次の注意');
    appendNote(support, nextTimeNote(item, verdict));

    appendLabel(support, '全部の手順');
    const solution = document.createElement('p');
    solution.className = 'math-line solution-line';
    solution.textContent = question.workedSolution;
    support.append(solution);
  }

  typeset(support);
  if (followVirtualKeyboard.update) followVirtualKeyboard.update();
}

/**
 * 判定ごとの見せ方。色だけに意味を持たせず、記号と文言でも区別する。
 *   ○ 正解（緑）／△ 分母のマイナス（青。0点）／× あと一歩＝途中（橙）／× 書き方（紫）／× 値の誤り（赤）
 */
function verdictView(verdict) {
  switch (verdict.status) {
    case 'correct':
      return { badge: 'correct', mark: '◯', text: '正解', title: '○ 正解', titleClass: 'good', review: 'correct', head: '○ 正解' };
    case 'negDenominator':
      return { badge: 'negden', mark: '△', text: '書き直そう', title: '△ 書き直そう（値は合っているけれど、正解には数えません）', titleClass: 'negden', review: 'negden', head: '△ 書き直そう（正解に数えない）' };
    case 'notReduced':
      return verdict.kind === 'notation'
        ? { badge: 'notation', mark: '×', text: '不正解（書き方）', title: '× 不正解（書き方）', titleClass: 'notation', review: 'notation', head: '× 不正解（書き方）' }
        : { badge: 'unfinished', mark: '×', text: '不正解（あと一歩）', title: '× 不正解（あと一歩）', titleClass: 'unfinished', review: 'unfinished', head: '× 不正解（あと一歩）' };
    case 'GIVE_UP':
      return { badge: 'incorrect', mark: '×', text: '不正解', title: '× 不正解（答えを確認しました）', titleClass: 'bad', review: 'incorrect', head: '× 不正解' };
    default:
      return { badge: 'incorrect', mark: '×', text: '不正解', title: '× 不正解', titleClass: 'bad', review: 'incorrect', head: '× 不正解' };
  }
}

function nextTimeNote(item, verdict) {
  if (verdict.status === 'negDenominator') {
    return '次は、マイナスを分母に書かず、分子か分数の前に書く。';
  }
  if (verdict.status === 'notReduced' && verdict.kind === 'notation') {
    return '次は、決定を押す前に「答えの書き方の決まり」（問題の指示・1や×の省略・文字の順など）に合っているかを確かめる。';
  }
  if (verdict.status === 'notReduced') {
    return '次は「これ以上簡単にできないか」を、決定を押す前に1回だけ確かめる。';
  }
  const tag = item.question.subskillTag;
  return ({
    'calc.signed': '次は、かっこをはずした直後に符号だけをもう一度見直す。',
    'calc.fraction': '次は、通分したあとに分母をそのまま書き写せているかを確かめる。',
    'calc.decimal': '次は、小数点の位置をそろえてから計算し、答えの小数点をもう一度確かめる。',
    'calc.monomial': '次は、係数どうしと文字どうしを分けて書いてから計算する。',
    'calc.expression': '次は、かっこの前の符号をすべての項に配ってから同類項をまとめる。',
    'calc.radical': '次は、根号の中を最も簡単にしてから、係数の計算に進む。'
  })[tag] || '次は、式を左から1手ずつ書き出して確かめる。';
}

/* ---- 次へ ---- */
/** 生徒の操作から呼ぶ「次へ」。自動送りが走っている間は追い越せない。 */
function next() {
  if (session.screen !== 'QUESTION' || session.phase !== 'FEEDBACK') return;
  if (session.autoAdvancing) return;
  if (nextLocked()) return;                          // 採点から 500ms は受け付けない
  advance();
}

/** 実際に次へ進む処理。自動送りのタイマーと生徒の操作の両方から呼ぶ。 */
function advance() {
  if (session.screen !== 'QUESTION' || session.phase !== 'FEEDBACK') return;
  clearAutoNext();
  hideVerdict();
  if (handwriting) handwriting.clearInk();          // 採点直後は消さず、次へ進むときに消す
  if (session.index < session.items.length - 1) {
    session.index += 1;
    renderQuestion();
    return;
  }
  finishSet();
}

/* ============================================================
 * セットの終了と結果
 * ========================================================== */

function pushHistory(entry) {
  const history = historyData();
  history.unshift({ at: Date.now(), ...entry });
  storageSet(KEYS.history, history.slice(0, HISTORY_LIMIT));
}

function finishSet() {
  clearAutoNext();
  hideVerdict();
  // 次のラウンドの母集団は「このラウンドで間違えたもの」。通常・復習で共通。
  session.reviewQueue = session.items
    .filter(item => item.status !== 'correct')
    .map(item => ({
      seed: item.question.seed,
      slotIndex: item.question.slotIndex,
      templateId: item.question.templateId,
      subskillTag: item.question.subskillTag
    }));

  if (session.mode === 'normal' && !session.recorded) {
    const course = courseData();
    course.bestScore = Math.max(course.bestScore, session.score);
    course.lastMistakes = session.reviewQueue;
    course.lastTypeKeys = session.items.map(item => item.question.generatorConstraints.typeKey);
    storageSet(KEYS.course, course);
    pushHistory({
      score: session.score,
      total: session.items.length,
      cleared: session.score >= CLEAR_THRESHOLD,
      aborted: false
    });
    session.recorded = true;
  }

  session.screen = 'RESULT';
  session.phase = 'INPUT';
  applyScreen();
  renderResult();
}

function renderResult() {
  const isReview = session.mode === 'review';
  const total = session.items.length;
  const cleared = session.score >= CLEAR_THRESHOLD;

  $('result-score').textContent = `${session.score} / ${total} 問 正解`;
  $('result-message').textContent = isReview
    ? (session.reviewQueue.length
        ? 'まちがえた問題は、別の数値でもう一度練習できます。'
        : 'すべて正解！復習は完了です。')
    : (cleared
        ? 'クリア！この正確さを本番でも保とう。'
        : `あと ${Math.max(0, CLEAR_THRESHOLD - session.score)} 問でクリアです。まちがえた型を復習しよう。`);

  const note = isReview ? '復習の結果は、得点・最高記録・履歴には入りません。' : '';
  let noteEl = $('result-summary-note');
  if (!noteEl) {
    noteEl = document.createElement('p');
    noteEl.id = 'result-summary-note';
    $('result-message').after(noteEl);
  }
  noteEl.textContent = note;
  noteEl.hidden = !note;

  const list = $('review-list');
  list.replaceChildren();
  session.items.forEach((item, index) => {
    const card = document.createElement('article');
    const view = verdictView({ status: item.status, kind: item.kind });
    card.className = `review-item ${view.review}`;

    const heading = document.createElement('h2');
    heading.textContent = `Q${index + 1}　${view.head}`;
    card.append(heading);

    const prompt = document.createElement('p');
    prompt.className = 'review-prompt';
    // 文字数で切らない（数式デリミタの内側で切れると生LaTeXが露出する）
    prompt.textContent = `問題：${promptSummary(item.question)}`;
    card.append(prompt);

    const answer = document.createElement('p');
    if (item.studentLatex) answer.textContent = `あなたの答え：\\(${item.studentLatex}\\)　正答：\\(${item.question.answerLatex}\\)`;
    else answer.textContent = `あなたの答え：入力なし　正答：\\(${item.question.answerLatex}\\)`;
    card.append(answer);

    list.append(card);
  });

  $('review-button').hidden = session.reviewQueue.length === 0;
  typeset($('result-screen'));
}

/* ============================================================
 * 起動
 * ========================================================== */

function setupHandwriting() {
  if (typeof window.initHandwriting !== 'function') return;
  try {
    handwriting = window.initHandwriting({
      mount: '#handwriting-mount',
      penColor: '#0a4f4b',
      // MathLive・キーパッド・数式の上をなぞってもインクが乗らないようにする
      // 除外するのは「操作する要素」だけ。解説パネルや数式の上にも書けるようにする。
      // ペンONの間はスクロール領域を指でスクロールできなくなるが、これは承知のうえの仕様。
      // （ペンOFFのときは描画レイヤーがイベントを奪わないので、これまでどおりスクロールできる）
      controlSelector: 'button,math-field,input,textarea,select,a,[role="button"],label,'
        + '.math-field-wrap,.keypad,.hw-bar,dialog,'
        // 仮想キーボード（MathLive 0.98.4）のキーを押しても手書きの点が付かないように
        + '.ML__keyboard,.ML__keyboard *,[class^="MLK__"],[class*=" MLK__"]',
      classNames: { button: '' }
    });
    if (handwriting) handwriting.reset(false);
  } catch (error) {
    console.warn('手書きレイヤーを初期化できませんでした', error);
    handwriting = null;
  }
}

function clearLocalRecords() {
  storageRemove(KEYS.course);
  storageRemove(KEYS.history);
  renderHistory();
}

function init() {
  setupMathField();
  setupScrollHint();
  setupHandwriting();
  renderHistory();
  session.screen = 'HOME';
  applyScreen();

  $('start-button').addEventListener('click', () => { if (session.screen === 'HOME') startNormal(); });

  $('clear-history-button').addEventListener('click', () => {
    const dialog = $('clear-history-dialog');
    if (!dialog.open) dialog.showModal();
  });
  $('confirm-clear-history').addEventListener('click', () => {
    $('clear-history-dialog').close();
    clearLocalRecords();
  });
  $('cancel-clear-history').addEventListener('click', () => $('clear-history-dialog').close());

  $('submit-button').addEventListener('click', submit);
  $('next-button').addEventListener('click', next);
  $('hint-button').addEventListener('click', showHint);
  $('confirm-final-hint').addEventListener('click', confirmFinalHint);
  $('cancel-final-hint').addEventListener('click', () => $('final-hint-dialog').close());
  $('quit-button').addEventListener('click', goHome);
  $('result-home-button').addEventListener('click', goHome);
  $('again-button').addEventListener('click', () => { if (session.screen === 'RESULT') startNormal(); });
  $('review-button').addEventListener('click', () => { if (session.screen === 'RESULT') startReview(); });

  // 入力補助ボタンを押しても欄からフォーカスを奪わない（押した直後の Enter がボタンに行って決定できない、を防ぐ）
  $('keypad').addEventListener('mousedown', event => {
    if (event.target.closest('button')) event.preventDefault();
  });
  // キーパッドは毎問作り直すのでデリゲート（二重登録を作らない）
  $('keypad').addEventListener('click', event => {
    const button = event.target.closest('button[data-insert],button[data-command]');
    if (!button || button.disabled) return;
    if (session.screen !== 'QUESTION' || session.phase !== 'INPUT') return;
    if (button.dataset.command) runFieldCommand(button.dataset.command);
    else insertToField(button.dataset.insert);
  });

  // Enter で次へ。決定（INPUT）は入力欄の capture の keydown だけが受け持つ（二重採点を作らない）。
  document.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
    if (event.repeat) return;                       // 長押し（キーリピート）では動かさない
    if (session.screen !== 'QUESTION') return;
    if (document.querySelector('dialog[open]')) return;
    if (session.phase === 'FEEDBACK' && !nextLocked()) { event.preventDefault(); next(); }
  });

  $('support-content').addEventListener('scroll', updateSupportOverflow);
  $('question-heading').addEventListener('scroll', updateQuestionOverflow);
  window.addEventListener('resize', () => { updateSupportOverflow(); updateQuestionOverflow(); });

  window.addEventListener('error', event => console.warn('画面処理エラー', event.error));
  window.addEventListener('unhandledrejection', event => console.warn('未処理のPromise', event.reason));
}

window.addEventListener('DOMContentLoaded', init);
