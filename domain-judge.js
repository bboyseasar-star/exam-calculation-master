/*!
 * domain-judge.js — 入試基本計算コースの数学的中核（DOM非依存）
 *
 * 役割:
 *   1. 値モデル（BigInt有理数 × 平方因数を外した根号 × 変数指数辞書）
 *   2. MathLiveのLaTeXを厳密に読む再帰下降パーサ（eval/Function不使用）
 *   3. 「値の同値判定」と「答案形式の判定」の二層分離
 *
 * 触る前に読むこと:
 *   - 値は正規形（Value）だけで比べる。形式は構文木（AST）だけで見る。
 *     正規形は「未約分・√8のまま・同類項未整理」の情報を既に失っているため、
 *     正規形から形式違反を検出することは原理的にできない。
 *   - 浮動小数で一致判定をしない。係数は必ず BigInt の分子分母ペア。
 *   - 単項マイナスは冪より優先度が低い。-3^2 = -9、(-3)^2 = 9。
 */

/* ============================================================
 * 0. エラーと上限
 * ========================================================== */

export class AnswerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AnswerError';
    this.code = code;
  }
}

const LIMIT_INT = 10n ** 18n;   // 係数の分子・分母の上限
const MAX_TERMS = 64;           // 1つの値が持てる項数
const MAX_RADICAND = 100000;    // 根号の中身の上限
const MAX_INPUT_CHARS = 200;    // 入力文字数
const MAX_TOKENS = 200;         // トークン数
const MAX_DEPTH = 12;           // 括弧の深さ
const MAX_EXPONENT = 6;         // 指数

const TOO_LARGE = () => new AnswerError('TOO_LARGE', '数が大きすぎます。式をもう一度確かめよう。');

/* ============================================================
 * 1. BigInt有理数
 * ========================================================== */

function babs(a) { return a < 0n ? -a : a; }

function bgcd(a, b) {
  a = babs(a); b = babs(b);
  while (b) { const t = a % b; a = b; b = t; }
  return a;
}

export function rat(n, d = 1n) {
  n = BigInt(n); d = BigInt(d);
  if (d === 0n) throw new AnswerError('DIV_ZERO', '0でわることはできません。');
  if (d < 0n) { n = -n; d = -d; }
  if (n === 0n) return { n: 0n, d: 1n };
  const g = bgcd(n, d) || 1n;
  n /= g; d /= g;
  if (babs(n) > LIMIT_INT || d > LIMIT_INT) throw TOO_LARGE();
  return { n, d };
}

export function ratAdd(a, b) { return rat(a.n * b.d + b.n * a.d, a.d * b.d); }
export function ratMul(a, b) { return rat(a.n * b.n, a.d * b.d); }
export function ratNeg(a) { return { n: -a.n, d: a.d }; }
export function ratEq(a, b) { return a.n === b.n && a.d === b.d; }
export function ratIsZero(a) { return a.n === 0n; }
const ZERO = { n: 0n, d: 1n };

/* ============================================================
 * 2. 値モデル（サード多項式）
 *
 *   Value = { [key]: Rational }
 *   key   = `${radicand}|${vars}`   radicand は平方因数を外した squarefree 正整数（1 = 根号なし）
 *   vars  = "a:2,b:1"（名前昇順・指数付き。空文字 = 定数）
 * ========================================================== */

export function extractSquare(n) {
  let rest = Math.trunc(n), square = 1;
  if (!Number.isFinite(rest) || rest < 1) throw new AnswerError('BAD_RADICAND', '根号の中は正の数にしてね。');
  for (let i = 2; i * i <= rest; i++) {
    while (rest % (i * i) === 0) { rest /= i * i; square *= i; }
  }
  return { square, rest };
}

function parseVars(s) {
  const out = {};
  if (!s) return out;
  for (const part of s.split(',')) {
    const [name, exp] = part.split(':');
    out[name] = Number(exp);
  }
  return out;
}

function varsKey(map) {
  return Object.keys(map).filter(k => map[k] !== 0).sort()
    .map(k => `${k}:${map[k]}`).join(',');
}

function addVars(a, b, sign = 1) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] || 0) + sign * v;
  return out;
}

function splitKey(key) {
  const i = key.indexOf('|');
  return { radicand: Number(key.slice(0, i)), vars: parseVars(key.slice(i + 1)) };
}

function makeKey(radicand, vars) { return `${radicand}|${varsKey(vars)}`; }

function guardTerms(value) {
  if (Object.keys(value).length > MAX_TERMS) throw TOO_LARGE();
  return value;
}

/** 1項の値を作る。radicand は自動で最簡化され、外に出た分は係数へ掛かる。 */
export function vTerm(n, d = 1n, radicand = 1, vars = {}) {
  const coef0 = rat(n, d);
  if (ratIsZero(coef0)) return {};
  const r = Math.trunc(radicand);
  if (r < 1 || r > MAX_RADICAND) throw TOO_LARGE();
  const { square, rest } = extractSquare(r);
  const coef = ratMul(coef0, rat(BigInt(square), 1n));
  return { [makeKey(rest, vars)]: coef };
}

export function vZero() { return {}; }
export function vInt(n) { return vTerm(BigInt(n), 1n); }
export function vRat(n, d) { return vTerm(BigInt(n), BigInt(d)); }
/** 係数 n/d の単項式。vars は { a: 2, b: 1 } 形式。 */
export function vMono(n, d, vars) { return vTerm(BigInt(n), BigInt(d), 1, vars); }
/** (n/d)·√radicand */
export function vRadical(n, d, radicand) { return vTerm(BigInt(n), BigInt(d), radicand); }

export function vAdd(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const sum = ratAdd(out[k] || ZERO, v);
    if (ratIsZero(sum)) delete out[k]; else out[k] = sum;
  }
  return guardTerms(out);
}

export function vNeg(a) {
  const out = {};
  for (const [k, v] of Object.entries(a)) out[k] = ratNeg(v);
  return out;
}

export function vSub(a, b) { return vAdd(a, vNeg(b)); }

export function vMul(a, b) {
  const out = {};
  for (const [ka, va] of Object.entries(a)) {
    const ta = splitKey(ka);
    for (const [kb, vb] of Object.entries(b)) {
      const tb = splitKey(kb);
      const product = ta.radicand * tb.radicand;
      if (product > MAX_RADICAND * MAX_RADICAND) throw TOO_LARGE();
      const { square, rest } = extractSquare(product);
      if (rest > MAX_RADICAND) throw TOO_LARGE();
      const coef = ratMul(ratMul(va, vb), rat(BigInt(square), 1n));
      const key = makeKey(rest, addVars(ta.vars, tb.vars));
      const sum = ratAdd(out[key] || ZERO, coef);
      if (ratIsZero(sum)) delete out[key]; else out[key] = sum;
    }
  }
  return guardTerms(out);
}

/** 単項の逆数。1/(c√r·V) = √r/(c·r·V) */
export function vInverse(a) {
  const keys = Object.keys(a);
  if (keys.length === 0) throw new AnswerError('DIV_ZERO', '0でわることはできません。');
  if (keys.length > 1) {
    throw new AnswerError('UNSUPPORTED_DIVISION', '2つ以上の項でわる形は、この問題では使いません。');
  }
  const { radicand, vars } = splitKey(keys[0]);
  const coef = a[keys[0]];
  // 1/(coef·√r) = √r / (coef·r)
  const denom = ratMul(coef, rat(BigInt(radicand), 1n));
  const inv = rat(denom.d, denom.n);
  const invVars = addVars({}, vars, -1);
  return { [makeKey(radicand, invVars)]: inv };
}

export function vDiv(a, b) { return vMul(a, vInverse(b)); }

export function vPow(a, k) {
  const e = Number(k);
  if (!Number.isInteger(e) || e < 0) throw new AnswerError('BAD_EXPONENT', '指数は0以上の整数にしてね。');
  if (e > MAX_EXPONENT) throw new AnswerError('BAD_EXPONENT', '指数が大きすぎます。');
  let out = vInt(1);
  for (let i = 0; i < e; i++) out = vMul(out, a);
  return out;
}

/** √(値)。中身は「変数なし・根号なし・0以上の有理数」に限る。 */
export function vSqrt(a) {
  const keys = Object.keys(a);
  if (keys.length === 0) return {};
  if (keys.length > 1) throw new AnswerError('UNSUPPORTED_RADICAND', '根号の中は1つの数にしてね。');
  const { radicand, vars } = splitKey(keys[0]);
  if (radicand !== 1 || varsKey(vars) !== '') {
    throw new AnswerError('UNSUPPORTED_RADICAND', '二重根号や文字の入った根号は、この問題では使いません。');
  }
  const coef = a[keys[0]];
  if (coef.n < 0n) throw new AnswerError('NEGATIVE_RADICAND', '根号の中は0以上にしてね。');
  // √(n/d) = √(n·d)/d
  const nd = coef.n * coef.d;
  if (nd > BigInt(MAX_RADICAND)) throw TOO_LARGE();
  return vTerm(1n, coef.d, Number(nd));
}

/** 値の正準文字列。等値比較・fingerprintに使う。 */
export function valueKey(value) {
  return Object.keys(value).sort()
    .map(k => `${k}=${value[k].n}/${value[k].d}`).join(';') || '0';
}

export function valueEquals(a, b) { return valueKey(a) === valueKey(b); }

export function isZeroValue(value) { return Object.keys(value).length === 0; }

/** 値が「変数なしの有理数1つ」ならその有理数を返す。そうでなければ null。 */
export function asRational(value) {
  const keys = Object.keys(value);
  if (keys.length === 0) return { n: 0n, d: 1n };
  if (keys.length > 1) return null;
  const { radicand, vars } = splitKey(keys[0]);
  if (radicand !== 1 || varsKey(vars) !== '') return null;
  return value[keys[0]];
}

/* ============================================================
 * 3. 正答のLaTeX整形
 * ========================================================== */

function varsLatex(vars) {
  return Object.keys(vars).filter(k => vars[k] !== 0).sort()
    .map(k => (vars[k] === 1 ? k : `${k}^{${vars[k]}}`)).join('');
}

/** 1項を「符号を除いた本体」のLaTeXにする。 */
function termBodyLatex(key, coef) {
  const { radicand, vars } = splitKey(key);
  const v = varsLatex(vars);
  const radical = radicand > 1 ? `\\sqrt{${radicand}}` : '';
  const absN = babs(coef.n);
  if (coef.d === 1n) {
    const showNumber = !(absN === 1n && (radical || v));
    return `${showNumber ? absN : ''}${radical}${v}`;
  }
  // 分数係数。根号は分子へ、文字は分数の外へ置く（\frac{2}{3}x / \frac{2\sqrt{3}}{3}）。
  const numberPart = (absN === 1n && radical) ? '' : String(absN);
  return `\\frac{${numberPart}${radical}}{${coef.d}}${v}`;
}

function termSortInfo(key) {
  const { radicand, vars } = splitKey(key);
  const degree = Object.values(vars).reduce((s, e) => s + e, 0);
  return { degree, radicand, varsText: varsKey(vars) };
}

/** 値を答案の標準形LaTeXへ。項順は判定に影響しない（表示専用）。 */
export function canonicalLatex(value) {
  const keys = Object.keys(value);
  if (!keys.length) return '0';
  keys.sort((a, b) => {
    const ia = termSortInfo(a), ib = termSortInfo(b);
    if (ia.degree !== ib.degree) return ib.degree - ia.degree;
    if (ia.varsText !== ib.varsText) return ia.varsText < ib.varsText ? -1 : 1;
    return ia.radicand - ib.radicand;
  });
  // 文字を含まず、根号項と正の定数項が混在するときは「2+√5」の並びにする。
  const hasVars = keys.some(k => termSortInfo(k).degree !== 0);
  const hasRadical = keys.some(k => termSortInfo(k).radicand > 1);
  if (!hasVars && hasRadical && keys.length > 1) {
    const ci = keys.findIndex(k => termSortInfo(k).radicand === 1);
    if (ci > 0 && value[keys[ci]].n > 0n) keys.unshift(keys.splice(ci, 1)[0]);
  }
  return keys.map((k, i) => {
    const coef = value[k];
    const body = termBodyLatex(k, coef);
    if (i === 0) return coef.n < 0n ? `-${body}` : body;
    return coef.n < 0n ? `-${body}` : `+${body}`;
  }).join('');
}

/* ============================================================
 * 4. 前処理とトークナイザ
 * ========================================================== */

const SUPERSCRIPT_CHARS = /[⁰¹²³⁴⁵⁶⁷⁸⁹]/;
const INVISIBLE_CHARS = /[​-‍⁠﻿]/;

function preprocess(source) {
  const raw = String(source);

  // NFKC は「²」を「2」へ潰してしまう（4⁴ が 44、a³ が a3 に化ける）。
  // 値が黙って別物になるので、正規化の前に検出して明示的に拒否する。
  if (SUPERSCRIPT_CHARS.test(raw)) {
    throw new AnswerError('SUPERSCRIPT_CHAR',
      '「²」のような小さい数字は使えません。キーパッドの「指数」ボタンで書いてね。');
  }
  if (INVISIBLE_CHARS.test(raw)) {
    throw new AnswerError('INVISIBLE_CHAR', '見えない文字が入っています。入力を消してやり直そう。');
  }

  let s = raw.normalize('NFKC');

  if (/\\placeholder/.test(s)) {
    throw new AnswerError('INCOMPLETE', 'まだ入力していないところがあるよ。');
  }
  if (/\\sqrt\s*\[/.test(s)) {
    throw new AnswerError('UNSUPPORTED', '3乗根は、この問題では使いません。');
  }

  // Unicode記号の吸収（IME・貼り付け対策）
  s = s.replace(/[−‐‑‒–—―ー]/g, '-')
       .replace(/[×✕✖]/g, '*')
       .replace(/[・⋅]/g, '*');
  // ÷ と \div は「わり算の記号」、ASCIIの / は「分数のつもりのスラッシュ」として区別する（案内文が変わる）

  // 単一文字の \mathrm{x} などは中身を取り出す
  s = s.replace(/\\(?:mathrm|mathit|text|operatorname)\s*\{\s*([A-Za-z])\s*\}/g, '$1');

  // 空白コマンド（長いものから順に）
  s = s.replace(/\\qquad|\\quad|\\left|\\right|\\!|\\,|\\;|\\:|\\ |~/g, '');

  // 別名の統一
  s = s.replace(/\\dfrac|\\tfrac|\\cfrac/g, '\\frac')
       .replace(/\\cdot|\\times/g, '*');

  s = s.replace(/\s+/g, '');

  if (/\{\}/.test(s)) throw new AnswerError('INCOMPLETE', 'まだ入力していないところがあるよ。');
  if (s.length > MAX_INPUT_CHARS) throw new AnswerError('TOO_LONG', '式が長すぎます。答えの形まで整理してから入力しよう。');
  return s;
}

function tokenize(source) {
  const s = preprocess(source);
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    if (rest[0] === '\\') {
      const m = /^\\[a-zA-Z]+/.exec(rest);
      if (!m) throw new AnswerError('UNKNOWN_TOKEN', '使えない記号があります。');
      if (m[0] === '\\frac') tokens.push({ t: 'FRAC' });
      else if (m[0] === '\\sqrt') tokens.push({ t: 'SQRT' });
      else if (m[0] === '\\div') tokens.push({ t: '/', slash: false });
      else throw new AnswerError('UNKNOWN_COMMAND', `「${m[0]}」は、この問題では使えません。`);
      i += m[0].length; continue;
    }
    const num = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(rest);
    if (num) {
      const text = num[0];
      // 「2.5.3」のように小数点が続く入力は、黙って別の数として読まない
      if (rest[text.length] === '.') {
        throw new AnswerError('SYNTAX', '小数点の位置を確かめよう。');
      }
      if (text.includes('.')) {
        const [a, b] = text.split('.');
        tokens.push({ t: 'DEC', n: BigInt((a || '0') + b), d: 10n ** BigInt(b.length), raw: text });
      } else {
        tokens.push({ t: 'NUM', n: BigInt(text), raw: text });
      }
      i += text.length; continue;
    }
    const ch = rest[0];
    // 大文字で書いても受理する（X → x）。文字の種類の判定は allowedVariables 側で行う。
    if (/[A-Za-z]/.test(ch)) { tokens.push({ t: 'VAR', name: ch.toLowerCase() }); i++; continue; }
    if (ch === '/') { tokens.push({ t: '/', slash: true }); i++; continue; }
    if (ch === '÷') { tokens.push({ t: '/', slash: false }); i++; continue; }
    if ('+-*^(){}'.includes(ch)) { tokens.push({ t: ch }); i++; continue; }
    if (ch === '[' || ch === ']') throw new AnswerError('UNSUPPORTED', '3乗根は、この問題では使いません。');
    throw new AnswerError('UNKNOWN_TOKEN', `「${ch}」は使えない記号です。`);
  }
  if (tokens.length > MAX_TOKENS) throw new AnswerError('TOO_LONG', '式が長すぎます。');
  if (!tokens.length) throw new AnswerError('EMPTY', '答えを入力してから決定しよう。');
  return tokens;
}

/* ============================================================
 * 5. 再帰下降パーサ
 *
 *   expr   := term (('+'|'-') term)*
 *   term   := unary ( ('*'|'/')? unary )*        暗黙の乗算を含む
 *   unary  := ('+'|'-') unary | power            ← 単項マイナスは冪より弱い
 *   power  := atom ('^' expGroup)?
 *   atom   := NUM | DEC | VAR | '(' expr ')' | '{' expr '}'
 *           | FRAC group group | SQRT group
 * ========================================================== */

const ATOM_START = new Set(['NUM', 'DEC', 'VAR', '(', '{', 'FRAC', 'SQRT']);

export function parseAst(latex) {
  const tokens = tokenize(latex);
  let p = 0, depth = 0;
  const peek = () => (tokens[p] ? tokens[p].t : null);
  const accept = t => (peek() === t ? (p++, true) : false);
  const expect = (t, message) => { if (!accept(t)) throw new AnswerError('SYNTAX', message); };

  function group(what) {
    if (peek() === '{') {
      accept('{'); depth++;
      if (depth > MAX_DEPTH) throw new AnswerError('TOO_DEEP', '括弧が深すぎます。');
      const v = expr();
      expect('}', `${what}の書き方を確かめよう。`);
      depth--;
      return { k: 'group', a: v };
    }
    // \frac16 のようにブレースを省略した書き方では、数字を1桁だけ取る（LaTeX と同じ規則）
    if (peek() === 'NUM') {
      const token = tokens[p];
      if (token.raw && token.raw.length > 1) {
        tokens[p] = { t: 'NUM', n: BigInt(token.raw.slice(1)), raw: token.raw.slice(1) };
        return { k: 'num', n: BigInt(token.raw[0]), raw: token.raw[0] };
      }
      p++;
      return { k: 'num', n: token.n, raw: token.raw };
    }
    if (peek() === 'DEC' || peek() === 'VAR') return atom();
    throw new AnswerError('SYNTAX', `${what}の中身が読み取れません。`);
  }

  function atom() {
    const t = peek();
    if (t === 'NUM') { const tok = tokens[p++]; return { k: 'num', n: tok.n, raw: tok.raw }; }
    if (t === 'DEC') { const tok = tokens[p++]; return { k: 'dec', n: tok.n, d: tok.d, raw: tok.raw }; }
    if (t === 'VAR') { const tok = tokens[p++]; return { k: 'var', name: tok.name }; }
    if (t === '(' || t === '{') {
      const close = t === '(' ? ')' : '}';
      p++; depth++;
      if (depth > MAX_DEPTH) throw new AnswerError('TOO_DEEP', '括弧が深すぎます。');
      const v = expr();
      expect(close, '括弧が閉じていません。');
      depth--;
      return { k: 'group', a: v, paren: t === '(' };
    }
    if (t === 'FRAC') {
      p++;
      const num = group('分数の分子');
      const den = group('分数の分母');
      return { k: 'frac', num, den };
    }
    if (t === 'SQRT') { p++; return { k: 'sqrt', a: group('根号') }; }
    throw new AnswerError('SYNTAX', '式として読み取れません。');
  }

  function power() {
    const base = atom();
    if (accept('^')) {
      let e;
      if (peek() === 'NUM') e = Number(tokens[p++].n);
      else if (peek() === '{') {
        accept('{');
        if (peek() !== 'NUM') throw new AnswerError('BAD_EXPONENT', '指数は0以上の整数にしてね。');
        e = Number(tokens[p++].n);
        expect('}', '指数の中に文字が入っているよ。指数の右に続けて書くときは、キーパッドの「→」で指数の外に出てから書こう。');
      } else throw new AnswerError('BAD_EXPONENT', '指数は0以上の整数にしてね。');
      if (e > MAX_EXPONENT) throw new AnswerError('BAD_EXPONENT', '指数が大きすぎます。');
      return { k: 'pow', a: base, e };
    }
    return base;
  }

  function unary() {
    if (accept('+')) return unary();
    if (accept('-')) return { k: 'neg', a: unary() };
    return power();
  }

  function term() {
    let node = unary();
    for (;;) {
      if (accept('*')) { node = { k: 'mul', a: node, b: unary(), explicit: true }; continue; }
      if (peek() === '/') {
        const token = tokens[p++];
        node = { k: 'div', a: node, b: unary(), slash: Boolean(token.slash) };
        continue;
      }
      // 帯分数（2\frac{1}{2}）は積か帯分数か区別できないので受理しない。
      // 先頭に単項マイナスが付くと node.k は 'neg' になるため、剥がしてから判定する。
      // （-2\frac{1}{2} を黙って積として読むと、正の帯分数と扱いが食い違う）
      if (peek() === 'FRAC') {
        let base = node;
        while (base && base.k === 'neg') base = base.a;
        if (base && (base.k === 'num' || base.k === 'dec')) {
          throw new AnswerError('AMBIGUOUS_MIXED_NUMBER',
            '数の右に分数が続いています。帯分数は使いません。分数だけで答えるときは、先に書いた数を消してから分数を入れてね。');
        }
      }
      if (ATOM_START.has(peek())) { node = { k: 'mul', a: node, b: unary(), explicit: false }; continue; }
      return node;
    }
  }

  function expr() {
    let node = term();
    for (;;) {
      if (accept('+')) { node = { k: 'add', a: node, b: term() }; continue; }
      if (accept('-')) { node = { k: 'sub', a: node, b: term() }; continue; }
      return node;
    }
  }

  const ast = expr();
  if (p !== tokens.length) throw new AnswerError('SYNTAX', '式の続きが読み取れません。');
  return ast;
}

/* ============================================================
 * 6. AST → 値
 * ========================================================== */

export function evalAst(ast, options = {}) {
  const allowed = options.allowedVariables || null;   // null なら任意の文字を許す
  function walk(node) {
    switch (node.k) {
      case 'num': return vTerm(node.n, 1n);
      case 'dec': return vTerm(node.n, node.d);
      case 'var': {
        if (allowed && !allowed.includes(node.name)) {
          throw new AnswerError('BAD_VARIABLE', `この問題では文字「${node.name}」は使いません。`);
        }
        return vTerm(1n, 1n, 1, { [node.name]: 1 });
      }
      case 'group': return walk(node.a);
      case 'neg': return vNeg(walk(node.a));
      case 'add': return vAdd(walk(node.a), walk(node.b));
      case 'sub': return vSub(walk(node.a), walk(node.b));
      case 'mul': return vMul(walk(node.a), walk(node.b));
      case 'div': return vDiv(walk(node.a), walk(node.b));
      case 'frac': return vDiv(walk(node.num), walk(node.den));
      case 'sqrt': return vSqrt(walk(node.a));
      case 'pow': return vPow(walk(node.a), node.e);
      default: throw new AnswerError('SYNTAX', '式として読み取れません。');
    }
  }
  return walk(ast);
}

export function parseExpression(latex, options = {}) {
  if (latex == null || !String(latex).trim()) {
    throw new AnswerError('EMPTY', '答えを入力してから決定しよう。');
  }
  const ast = parseAst(latex);
  return { ast, value: evalAst(ast, options) };
}

/* ------------------------------------------------------------
 * AST → LaTeX（生徒が書いた形を安全に描き直す）
 *
 * 生の入力を MathJax へ渡さないための出力器。ここが作る文字列には
 * \frac / \sqrt / \times / \div / \left( \right) と英数字しか現れない。
 * ---------------------------------------------------------- */

/** \frac{...} や \sqrt{...} の中は、外側の波かっこが区切りになるので丸かっこを足さない。 */
function bareLatex(node) {
  return (node.k === 'group' && !node.paren) ? astToLatex(node.a) : astToLatex(node);
}

export function astToLatex(node) {
  switch (node.k) {
    case 'num': return node.raw !== undefined ? String(node.raw) : String(node.n);
    case 'dec': return String(node.raw);
    case 'var': return node.name;
    case 'group': {
      const inner = astToLatex(node.a);
      // 波かっこの{ }は、和・差を包んでいるときだけ丸かっこにする（意味を変えないため）
      if (node.paren || node.a.k === 'add' || node.a.k === 'sub') return `\\left(${inner}\\right)`;
      return inner;
    }
    case 'neg': return `-${astToLatex(node.a)}`;
    case 'add': return `${astToLatex(node.a)}+${astToLatex(node.b)}`;
    case 'sub': return `${astToLatex(node.a)}-${astToLatex(node.b)}`;
    // 生の / は画面へ出さない。スラッシュで書かれた分数は分数の形で描き直す。
    case 'div': return node.slash
      ? `\\frac{${bareLatex(node.a)}}{${bareLatex(node.b)}}`
      : `${astToLatex(node.a)}\\div ${astToLatex(node.b)}`;
    case 'frac': return `\\frac{${bareLatex(node.num)}}{${bareLatex(node.den)}}`;
    case 'sqrt': return `\\sqrt{${bareLatex(node.a)}}`;
    case 'pow': return `${astToLatex(node.a)}^{${node.e}}`;
    case 'mul': {
      const left = astToLatex(node.a);
      const right = astToLatex(node.b);
      // 数字どうしが並ぶと別の数に見えるので、そのときだけ明示的な × を書く
      const needsSign = node.explicit || /[0-9.]$/.test(left) && /^[0-9.]/.test(right);
      return needsSign ? `${left}\\times ${right}` : `${left}${right}`;
    }
    default: return '';
  }
}

/* ============================================================
 * 7. 形式判定（ASTだけを見る）
 * ========================================================== */

function unwrapGroup(node) {
  let n = node;
  while (n && n.k === 'group') n = n.a;
  return n;
}

/** 加減で結ばれた項へ分解する（深さ0のみ）。 */
function splitTerms(node) {
  const out = [];
  (function walk(n) {
    const u = unwrapGroup(n);
    if (u.k === 'add' || u.k === 'sub') { walk(u.a); walk(u.b); return; }
    out.push(u);
  })(node);
  return out;
}

function flattenFactors(node, out) {
  const u = unwrapGroup(node);
  if (u.k === 'mul') { flattenFactors(u.a, out); flattenFactors(u.b, out); return; }
  if (u.k === 'neg') { flattenFactors(u.a, out); return; }
  out.push(u);
}

function constantValue(node) {
  try {
    const v = evalAst(node, {});
    return asRational(v);
  } catch { return null; }
}

const FORM_MESSAGES = {
  FRACTION_NOT_REDUCED: '分数は約分して、これ以上簡単にできない形で答えよう。',
  NEGATIVE_DENOMINATOR: '分母は正の数にして、符号は分数の前に出そう。',
  RADICAL_NOT_SIMPLE: '根号の中に平方の因数を残さない形（最も簡単な形）にしよう。',
  RADICAL_IN_DENOMINATOR: '分母に根号を残さない形（有理化した形）にしよう。',
  RADICAL_REPEATED: '根号どうしは1つの根号にまとめてから簡単にしよう。',
  VAR_REPEATED: '同じ文字どうしは指数を使って1つにまとめよう。',
  VAR_IN_DENOMINATOR: '分母に文字が残らない形にしよう。',
  NOT_EXPANDED: 'かっこを残さず、展開した形で答えよう。',
  NOT_COLLECTED: '同じ文字・同じ根号の項は、係数をまとめて1つにしよう。',
  UNEVALUATED_CONSTANT: '数どうしの計算は最後まで済ませてから答えよう。',
  ZERO_COEFFICIENT_TERM: '係数が0の項は書かず、必要な項だけで答えよう。',
  FRACTION_NESTED: '分数の中に分数を残さない形にしよう。',
  DECIMAL_NOT_ALLOWED: 'この問題は小数ではない形で答えよう。',
  DECIMAL_REQUIRED: '小数で答える指示があります。分数ではなく小数の形で書こう。',
  UNKNOWN_FORM: '答えの形をもう一度確かめよう。'
};

/** 小数を受け付けない理由は、正答が整数か分数か根号かで書き分ける。 */
function decimalMessage(spec) {
  if (!spec) return FORM_MESSAGES.DECIMAL_NOT_ALLOWED;
  if (spec.kind === 'radical') return '小数（およその値）ではなく、根号を使った正確な形で答えよう。';
  const rational = asRational(spec.canonicalValue);
  if (rational && rational.d === 1n) return '小数ではなく整数で答えよう。';
  if (rational) return 'この問題は分数で答えよう。小数ではなく、分数の形で書くよ。';
  return '小数を使わずに、分数や文字式の形で答えよう。';
}

export function formMessage(flag, spec) {
  if (flag === 'DECIMAL_NOT_ALLOWED') return decimalMessage(spec);
  return FORM_MESSAGES[flag] || FORM_MESSAGES.UNKNOWN_FORM;
}

function analyzeFraction(node, policy, flags, depthInfo) {
  const num = node.k === 'frac' ? node.num : node.a;
  const den = node.k === 'frac' ? node.den : node.b;

  // 6÷2 のように「÷ の記号で書かれた数どうしのわり算」は、計算し切っていない扱いにする。
  // スラッシュ（-5/6）は分数を意図した書き方なので、ここには入れない。
  if (node.k === 'div' && !node.slash && constantValue(num) && constantValue(den)) {
    flags.push('UNEVALUATED_CONSTANT');
    return;
  }

  // 分母
  const denNode = unwrapGroup(den);
  const denFactors = [];
  flattenFactors(denNode, denFactors);
  for (const f of denFactors) {
    if (f.k === 'sqrt') { if (policy.requireSimplestRadical !== false) flags.push('RADICAL_IN_DENOMINATOR'); }
    else if (f.k === 'var') flags.push('VAR_IN_DENOMINATOR');
    else if (f.k === 'pow' && unwrapGroup(f.a).k === 'var') flags.push('VAR_IN_DENOMINATOR');
    else if (f.k === 'frac' || f.k === 'div') flags.push('FRACTION_NESTED');
    else if (f.k === 'add' || f.k === 'sub') flags.push('NOT_EXPANDED');
  }
  const denValue = constantValue(den);
  if (denValue) {
    if (denValue.n < 0n && policy.requirePositiveDenominator !== false) flags.push('NEGATIVE_DENOMINATOR');
    if (denValue.d !== 1n) flags.push('FRACTION_NESTED');
    if (babs(denValue.n) === 1n && denValue.d === 1n) flags.push('FRACTION_NOT_REDUCED');
  }

  // 分子（和でもよい。ただし各項は整理されていること）
  inspectNode(num, policy, flags, depthInfo + 1);

  // 約分できるか
  if (denValue && denValue.d === 1n && policy.requireReducedFraction !== false) {
    let numValue = null;
    try { numValue = evalAst(num, {}); } catch { numValue = null; }
    if (numValue) {
      const coefs = Object.values(numValue);
      if (coefs.length && coefs.every(c => c.d === 1n)) {
        let g = babs(denValue.n);
        for (const c of coefs) g = bgcd(g, c.n);
        if (g > 1n) flags.push('FRACTION_NOT_REDUCED');
      }
    }
  }
}

function analyzeTerm(node, policy, flags, depthInfo) {
  const factors = [];
  flattenFactors(node, factors);
  let numeric = 0, radicals = 0, fractions = 0;
  const seenVars = new Set();

  for (const raw of factors) {
    const f = unwrapGroup(raw);
    switch (f.k) {
      case 'num': numeric++; break;
      case 'dec':
        numeric++;
        if (!policy.decimalAllowed) flags.push('DECIMAL_NOT_ALLOWED');
        break;
      case 'var':
        if (seenVars.has(f.name)) flags.push('VAR_REPEATED');
        seenVars.add(f.name);
        break;
      case 'pow': {
        let base = unwrapGroup(f.a);
        while (base.k === 'neg') base = unwrapGroup(base.a);   // (-3)^2 は数の計算として扱う
        if (base.k === 'var') {
          if (seenVars.has(base.name)) flags.push('VAR_REPEATED');
          seenVars.add(base.name);
        } else if (base.k === 'num' || base.k === 'dec') {
          flags.push('UNEVALUATED_CONSTANT');
        } else if (base.k === 'sqrt') {
          flags.push('RADICAL_NOT_SIMPLE');
        } else {
          flags.push('NOT_EXPANDED');
        }
        break;
      }
      case 'sqrt': {
        radicals++;
        if (radicals > 1) flags.push('RADICAL_REPEATED');
        const inner = unwrapGroup(f.a);
        if (policy.requireSimplestRadical === false) {
          /* 最簡形を求めない問題では中身の平方因数を問わない */
        } else if (inner.k !== 'num') {
          flags.push('RADICAL_NOT_SIMPLE');
        } else {
          const n = Number(inner.n);
          if (n <= 1) flags.push('RADICAL_NOT_SIMPLE');
          else if (extractSquare(n).square > 1) flags.push('RADICAL_NOT_SIMPLE');
        }
        break;
      }
      case 'frac':
      case 'div': {
        // スラッシュで書いた分数（-5/6）は分数として扱う。入力の書き方で不正解にしない。
        // ただし「小数で答えなさい」の指示がある問題では、分数の形そのものが形式エラー。
        // 「6.8÷2」のように ÷ の記号で数どうしのわり算を残しただけの入力は分数ではないので、
        // 「分数ではなく小数で」ではなく「計算し切っていない」として扱う。
        const constantDivision = f.k === 'div' && !f.slash
          && constantValue(f.a) !== null && constantValue(f.b) !== null;
        if (policy.decimalRequired && !constantDivision) flags.push('DECIMAL_REQUIRED');
        fractions++;
        if (fractions > 1 || depthInfo > 0) flags.push('FRACTION_NESTED');
        analyzeFraction(f, policy, flags, depthInfo);
        break;
      }
      case 'add':
      case 'sub':
        if (policy.requireExpanded !== false) flags.push('NOT_EXPANDED');
        break;
      default:
        flags.push('UNKNOWN_FORM');
    }
  }
  if (numeric > 1) flags.push('UNEVALUATED_CONSTANT');
  if (numeric >= 1 && fractions >= 1) flags.push('UNEVALUATED_CONSTANT');
}

/** 和として分解し、各項の形と同類項の重複を調べる。 */
function inspectNode(node, policy, flags, depthInfo = 0) {
  const terms = splitTerms(node);
  const seen = new Set();
  for (const term of terms) {
    analyzeTerm(term, policy, flags, depthInfo);
    let key = null;
    try {
      const v = evalAst(term, {});
      const keys = Object.keys(v);
      // 0y や 3x-3x のように、項そのものが 0 になる形は答えに残さない。
      // 単独の「0」は正しい最簡形なので、和・差の中に現れたときだけ未整理にする。
      if (terms.length > 1 && keys.length === 0) flags.push('ZERO_COEFFICIENT_TERM');
      if (keys.length === 1) key = keys[0];
    } catch { key = null; }
    if (key) {
      if (seen.has(key) && policy.requireCollected !== false) {
        flags.push(key === '1|' ? 'UNEVALUATED_CONSTANT' : 'NOT_COLLECTED');
      }
      seen.add(key);
    }
  }
}

/** 答案形式の違反を配列で返す。空配列なら形式も正しい。 */
export function inspectForm(ast, formPolicy = {}) {
  const flags = [];
  inspectNode(ast, formPolicy, flags, 0);
  return [...new Set(flags)];
}

/* ============================================================
 * 8. 誤因メッセージと判定
 * ========================================================== */

const DIAGNOSTIC_MESSAGES = {
  'CALC-SIGN': '符号を確かめよう。ひく数が負のときは「たす」に直してから計算する。',
  'CALC-ORDER': '計算の順番を確かめよう。累乗 → かけ算・わり算 → たし算・ひき算の順。',
  'CALC-FRACTION': '分数は通分してから分子だけを計算する。わり算は逆数のかけ算に直す。',
  'CALC-RADICAL': '根号の中の平方の因数を外し、同じ根号どうしだけを係数でまとめよう。',
  'CALC-POWER': '指数の計算を確かめよう。かけ算は指数の和、わり算は指数の差。',
  'CALC-COLLECT': '同じ文字・同じ次数の項どうしだけをまとめよう。ちがう項は足せない。',
  'CALC-DECIMAL': '小数点の位置を確かめよう。答えの小数点は、計算の前に位取りで見当をつけられる。',
  'CALC-UNIT': '単位は入力欄の右に書いてあるよ。答えの欄には式だけを入れよう。',
  UNCLASSIFIED: 'もう一度、式の左から順に1手ずつ確かめてみよう。'
};

export function diagnosticMessage(code) {
  return DIAGNOSTIC_MESSAGES[code] || DIAGNOSTIC_MESSAGES.UNCLASSIFIED;
}

/**
 * 誤答候補との照合。
 * matchers の各値は { key, message } か、文字列（key だけ）を受け付ける。
 * 生徒に見せる文言はテンプレート由来を優先し、無いときだけ既定文言へ落とす。
 */
function matchMisconception(value, matchers) {
  if (!matchers) return null;
  const key = valueKey(value);
  for (const [code, expected] of Object.entries(matchers)) {
    const expectedKey = typeof expected === 'string' ? expected : (expected && expected.key);
    if (expectedKey !== key) continue;
    const message = (expected && typeof expected === 'object' && expected.message) || diagnosticMessage(code);
    return { code, message };
  }
  return null;
}

/**
 * 採点。値の同値判定と形式判定を分けて返す。
 *   status: 'CORRECT' | 'INCORRECT' | 'FORM_ERROR' | 'INVALID_INPUT'（共通仕様6-1の列挙）
 *   formCode: 'NOT_SIMPLIFIED' | 'CALC-COLLECT'（FORM_ERROR時のみ）
 *   valueCorrect: 値として正しいか（形式技能と別記録するため）
 */
// 「単位を書いたのだろう」と判断するためのゆるい検出。取り除いてよいかの判断は stripUnit（厳格）が持つ。
const UNIT_SUFFIX = /(?:cm|mm|km|kg|mL|ml|L|g|m)(?:\^?\{?\d\}?|[²³])?$|(?:度|個|本|冊|円|人|分|秒|回|枚)$/;

/**
 * 末尾に書かれた単位を切り分ける。
 *
 * 単位は入力欄の右に表示してあるので、答案に書いたら誤答にする。
 * この関数は「単位を書いたかどうか」の判定にだけ使い、受理のためには使わない。
 * 「cm」「 cm」「cm^2」「cm²」「CM」「\mathrm{cm}」を同じものとして扱う。
 */
function splitUnitSuffix(input, unit) {
  const text = String(input);
  if (!unit || !unit.symbol) return { body: text, hadUnit: false };
  const symbol = String(unit.symbol).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(?:\\\\mathrm\\s*\\{\\s*)?${symbol}\\s*\\}?\\s*(?:\\^\\s*\\{?\\s*\\d\\s*\\}?|[²³])?\\s*$`, 'i');
  if (!pattern.test(text)) return { body: text, hadUnit: false };
  return { body: text.replace(pattern, ''), hadUnit: true };
}

/**
 * 値のおよその大きさ。**メッセージの選択にだけ**使う。
 * 正誤判定には一切使わない（判定は BigInt の厳密比較のみ）。
 */
function approximate(value) {
  let sum = 0;
  for (const [key, coef] of Object.entries(value)) {
    const { radicand, vars } = splitKey(key);
    if (varsKey(vars) !== '') return null;
    sum += (Number(coef.n) / Number(coef.d)) * Math.sqrt(radicand);
  }
  return sum;
}

function containsDecimal(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.k === 'dec') return true;
  return ['a', 'b', 'num', 'den'].some(field => containsDecimal(node[field]));
}

/** 「4a+16cm」のように単位を書いた入力かどうか。 */
function looksLikeUnitSuffix(input) {
  const text = String(input).normalize('NFKC')
    .replace(/\\left|\\right|\\!|\\,|\\;|\\:|\\ |~/g, '')
    .replace(/\s+/g, '');
  return UNIT_SUFFIX.test(text);
}

export function judge(input, question) {
  const spec = question.answerSpec;

  // 単位を持つ問題で答案に単位まで書いた場合は「誤答」にする（書き直しではない）。
  // 単位のせいだと特定できる（外すと式として読める）ときだけこの扱いにする。
  if (spec.unit && spec.unit.symbol) {
    const { body, hadUnit } = splitUnitSuffix(input, spec.unit);
    if (hadUnit) {
      let withoutUnit = null;
      try { withoutUnit = parseExpression(body, { allowedVariables: spec.allowedVariables }); }
      catch { withoutUnit = null; }
      if (withoutUnit) {
        return {
          status: 'INCORRECT', code: 'CALC-UNIT', formCode: null,
          valueCorrect: false, formFlags: [],
          message: diagnosticMessage('CALC-UNIT'),
          studentLatex: `${astToLatex(withoutUnit.ast)}\\;\\mathrm{${spec.unit.symbol}}`,
          studentCanonical: canonicalLatex(withoutUnit.value)
        };
      }
    }
  }

  let parsed;
  try {
    parsed = parseExpression(input, { allowedVariables: spec.allowedVariables });
  } catch (error) {
    if (!(error instanceof AnswerError)) throw error;
    // 単位の案内は、単位を持つ問題だけに出す。
    // 単位のない問題で「am」のように文字を打ち間違えた場合は、文字そのものを指摘する。
    const message = (error.code === 'BAD_VARIABLE' && spec.unit && looksLikeUnitSuffix(input))
      ? diagnosticMessage('CALC-UNIT')
      : error.message;
    return {
      status: 'INVALID_INPUT', code: error.code, formCode: null,
      valueCorrect: false, formFlags: [], message, studentLatex: null, studentCanonical: null
    };
  }

  const studentLatex = astToLatex(parsed.ast);          // 生徒が書いた形（安全に組み直したもの）
  const studentCanonical = canonicalLatex(parsed.value);  // その値を最も簡単な形にしたもの

  if (valueEquals(parsed.value, spec.canonicalValue)) {
    const flags = inspectForm(parsed.ast, spec.formPolicy || {});
    if (flags.length) {
      const first = flags[0];
      const formCode = first === 'NOT_COLLECTED' ? 'CALC-COLLECT'
        : first === 'DECIMAL_REQUIRED' ? 'FORM-DECIMAL_REQUIRED'
        : 'NOT_SIMPLIFIED';
      return {
        status: 'FORM_ERROR', code: formCode, formCode,
        valueCorrect: true, formFlags: flags,
        message: formMessage(first, spec), studentLatex, studentCanonical
      };
    }
    return {
      status: 'CORRECT', code: null, formCode: null,
      valueCorrect: true, formFlags: [], message: null, studentLatex, studentCanonical
    };
  }

  const matched = matchMisconception(parsed.value, question.diagnosticMatchers);
  let message = matched ? matched.message : diagnosticMessage('UNCLASSIFIED');
  // 小数で「およその値」を書いた誤答は、原因が計算ではなく答案形式にある。
  // ただし小数を受理している問題（正答が整数）では、誤りは値そのものなので通常の診断文にする。
  const decimalRejected = !(spec.formPolicy && spec.formPolicy.decimalAllowed);
  if (!matched && decimalRejected && containsDecimal(parsed.ast)) {
    const student = approximate(parsed.value);
    const truth = approximate(spec.canonicalValue);
    if (student !== null && truth !== null && Math.abs(student - truth) <= Math.max(1, Math.abs(truth)) * 0.02) {
      message = decimalMessage(spec);
    }
  }
  return {
    status: 'INCORRECT', code: matched ? matched.code : 'UNCLASSIFIED', formCode: null,
    valueCorrect: false, formFlags: [],
    message, studentLatex, studentCanonical
  };
}
