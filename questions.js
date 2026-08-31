/*!
 * questions.js — 入試基本計算コースの問題生成（DOM非依存）
 *
 * 出題型は SPEC.md 2-3節の表にあるものだけ。過去問（H21〜R08・大問1）で実績のある
 * 6型＝正負の数／分数／小数／平方根／単項式／一次式に限る。
 * 「変化形」「転移」に相当する型は過去問に存在しないため、枠ごと持たない。
 *
 * 制約:
 *   - Math.random() を使わない。seed から mulberry32 で決定的に生成する。
 *   - 正答は文字列の列挙ではなく domain-judge.js の値モデルで持つ。
 *   - 問題文・正答・ヒント・解説はすべて同じ generatedParams から作る。
 *   - 過去問の本文・固有の数値を転載しない。抽出したのは型・構造・数値の範囲だけ。
 */

import {
  vInt, vRat, vMono, vRadical, vAdd, vSub, vTerm,
  valueKey, canonicalLatex, extractSquare, asRational
} from './domain-judge.js';

export const COURSE_ID = 'exam-calculation';
export const RNG_VERSION = 'mulberry32-v1';
export const SCHEMA_VERSION = 2;
export const SET_SIZE = 10;
export const CLEAR_THRESHOLD = 9;
export const MAX_SET_STEPS = 22;          // セット合計手数の上限（SPEC 3-3）
export const MAX_SAME_AXIS = 2;           // 同一軸の最大枠数（SPEC 2-5）
export const MAX_RETRY = 50;

export const COVERAGE_REQUIRED_GROUPS = [
  'calc.signed', 'calc.fraction', 'calc.decimal', 'calc.radical', 'calc.monomial', 'calc.expression'
];

export const COVERAGE_GROUP_MAP = {
  'calc.signed': ['calc.signed'],
  'calc.fraction': ['calc.fraction'],
  'calc.decimal': ['calc.decimal'],
  'calc.radical': ['calc.radical'],
  'calc.monomial': ['calc.monomial'],
  'calc.expression': ['calc.expression']
};

/**
 * 出題を許す型キーの全集合（SPEC 2-3節の表）。
 * ここに無い型が1つでも生成されたら受入条件1の違反。
 */
export const ALLOWED_TYPE_KEYS = [
  'signed.add2', 'signed.mix3',
  'frac.addSub', 'frac.withInt', 'frac.mulDiv',
  'dec.addSub', 'dec.div', 'dec.mul', 'dec.mix',
  'rad.simplifyAdd', 'rad.product', 'rad.quotient', 'rad.rationalize', 'rad.simplifyAdd3',
  'mono.powerOnly', 'mono.mulPower', 'mono.mulDiv3', 'mono.div2', 'mono.polyDiv',
  'expr.two2var', 'expr.two1var'
];

/* ============================================================
 * スロット表（SPEC 2-2）
 * ========================================================== */

export const SLOTS = [
  { tag: 'calc.signed', templateId: 'EXC-SIGNED-01', difficulty: 1, variantIndex: 1, band: '基本', axis: 'signed',
    typeKeys: ['signed.add2'] },
  { tag: 'calc.fraction', templateId: 'EXC-FRAC-01', difficulty: 1, variantIndex: 1, band: '基本', axis: 'fraction',
    typeKeys: ['frac.addSub', 'frac.withInt'], weights: [0.7, 0.3] },
  { tag: 'calc.decimal', templateId: 'EXC-DEC-01', difficulty: 1, variantIndex: 1, band: '基本', axis: 'decimal',
    typeKeys: ['dec.addSub', 'dec.div', 'dec.mul', 'dec.mix'], weights: [0.35, 0.25, 0.25, 0.15] },
  { tag: 'calc.monomial', templateId: 'EXC-MONO-01', difficulty: 1, variantIndex: 1, band: '基本', axis: 'monomial',
    typeKeys: ['mono.powerOnly', 'mono.mulPower'], weights: [0.35, 0.65] },
  { tag: 'calc.radical', templateId: 'EXC-RAD-01', difficulty: 2, variantIndex: 1, band: '標準', axis: 'radical',
    typeKeys: ['rad.simplifyAdd'] },
  { tag: 'calc.expression', templateId: 'EXC-EXPR-01', difficulty: 2, variantIndex: 1, band: '標準', axis: 'expression',
    typeKeys: ['expr.two2var', 'expr.two1var'], weights: [0.65, 0.35] },
  { tag: 'calc.signed', templateId: 'EXC-SIGNED-02', difficulty: 2, variantIndex: 2, band: '標準', axis: 'signed',
    typeKeys: ['signed.mix3'] },
  { tag: 'calc.fraction', templateId: 'EXC-FRAC-02', difficulty: 2, variantIndex: 2, band: '標準', axis: 'fraction',
    typeKeys: ['frac.mulDiv'] },
  { tag: 'calc.monomial', templateId: 'EXC-MONO-02', difficulty: 2, variantIndex: 2, band: '標準', axis: 'monomial',
    typeKeys: ['mono.mulDiv3', 'mono.div2', 'mono.polyDiv'], weights: [0.4, 0.35, 0.25] },
  { tag: 'calc.radical', templateId: 'EXC-RAD-02', difficulty: 2, variantIndex: 2, band: '標準', axis: 'radical',
    typeKeys: ['rad.product', 'rad.quotient', 'rad.rationalize', 'rad.simplifyAdd3'], weights: [0.30, 0.25, 0.25, 0.20] }
];

/* ============================================================
 * 数値集合（SPEC 3-3 / 5-1）
 * ========================================================== */

export const RANGES = {
  'calc.signed': {
    1: { typeKey: 'signed.add2', termAbsMax: 15, terms: 2, maxAbs: 25 },
    2: { typeKey: 'signed.mix3', termAbsMax: 15, terms: 3, mulMax: 6, divMax: 5, requireExactDiv: true, maxAbs: 25 }
  },
  'calc.fraction': {
    1: { denoms: [2, 3, 4, 5, 6], numerAbsMax: 12, lcmMax: 24, intAbsMax: 12 },
    2: { denoms: [2, 3, 4, 5, 6, 9, 10], numerAbsMax: 12, intAbsMax: 12, requireNegative: true }
  },
  'calc.decimal': {
    1: {
      maxDecimalPlacesInProblem: 2,
      absMaxOperand: 40,
      addSub: { placesA: [0, 1, 2], placesB: [1, 2], allowNegative: true },
      mul: { bChoices: [0.2, 0.25, 0.4, 0.5, 0.7, 1.5, 2.5], intTimesDecimal: { intMin: 2, intMax: 12, decChoices: [1.02, 1.05, 1.08, 0.25, 0.75] }, maxProductPlaces: 3, allowNegative: true },
      div: { divisorInt: [2, 3, 4, 5, 6, 8], divisorDec: [0.2, 0.3, 0.4, 0.5, 0.6, 0.8], requireExactQuotient: true, maxQuotientPlaces: 2 },
      mix: { multipliers: [2, 3, 4, 5], maxPlaces: 2 },
      answerAbsMax: 50, answerPlacesMax: 3
    }
  },
  'calc.radical': {
    1: { radicandMax: 50, squareFactors: [4, 9, 16, 25], coefMax: 5 },
    2: {
      radicandMax: 50, squareFactors: [4, 9, 16, 25], coefMax: 5,
      productMax: 18, quotientRatios: [2, 3, 5, 6],
      rationalize: { denomRadicands: [2, 3, 5], numerAbsMax: 6 }
    }
  },
  'calc.monomial': {
    1: { coefAbsMax: 9, expInProblemMax: 3, expInAnswerMax: 4, vars: 1, factors: [1, 2], powerOuter: [2], allowDivision: false },
    2: { coefAbsMax: 9, expInProblemMax: 3, expInAnswerMax: 4, vars: 2, factors: [2, 3], powerOuter: [2, 3], requireDivision: true }
  },
  'calc.expression': {
    1: { outerCoef: [-4, -3, -2, -1, 2, 3, 4, 5], innerCoefMax: 5, constMax: 5, vars: 1 },
    2: { outerCoef: [-4, -3, -2, -1, 2, 3, 4, 5], innerCoefMax: 5, constMax: 5, vars: 2 }
  }
};

const MAX_INTERMEDIATE = 300;
const MAX_RADICAND_IN_PROBLEM = 50;

/* ============================================================
 * 乱数（共通仕様 7）
 * ========================================================== */

function utf8Length(text) {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

export function fnv1a(value) {
  const text = String(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 各要素を長さ接頭辞付きで連結してからFNV-1a（共通仕様 7）。 */
export function deriveSeed(parts) {
  return fnv1a(parts.map(p => {
    const s = typeof p === 'number' ? String(p >>> 0) : String(p);
    return `${utf8Length(s)}:${s}`;
  }).join(''));
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, list) { return list[Math.floor(rng() * list.length)]; }
function sign(rng) { return rng() < 0.5 ? -1 : 1; }
function range(from, to) { const out = []; for (let i = from; i <= to; i++) out.push(i); return out; }
function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { const t = a % b; a = b; b = t; } return a; }
function lcm(a, b) { return Math.abs(a * b) / gcd(a, b); }
function divisors(n) { const out = []; for (let i = 1; i <= Math.abs(n); i++) if (n % i === 0) out.push(i); return out; }

/** 重み付き抽選。weights が無ければ等確率。 */
function pickWeighted(rng, list, weights) {
  if (!weights || weights.length !== list.length) return pick(rng, list);
  const total = weights.reduce((s, w) => s + w, 0);
  let r = rng() * total;
  for (let i = 0; i < list.length; i++) { r -= weights[i]; if (r <= 0) return list[i]; }
  return list[list.length - 1];
}

/* ============================================================
 * LaTeX整形（表示専用。判定には使わない）
 * ========================================================== */

function varsLatex(vars) {
  return Object.keys(vars).filter(k => vars[k] > 0).sort()
    .map(k => (vars[k] === 1 ? k : `${k}^{${vars[k]}}`)).join('');
}

function monoLatex(coef, vars = {}) {
  const body = varsLatex(vars);
  if (coef === 0) return '0';
  if (!body) return String(coef);
  if (coef === 1) return body;
  if (coef === -1) return `-${body}`;
  return `${coef}${body}`;
}

/** 演算子の直後に置く負の数を括弧でくくる。 */
function wrapNegative(latex) { return String(latex).startsWith('-') ? `\\left(${latex}\\right)` : String(latex); }

function joinTerm(latex) { return String(latex).startsWith('-') ? latex : `+${latex}`; }

function signedNumber(n) { return n < 0 ? `-${Math.abs(n)}` : `+${n}`; }

function fracLatex(n, d) {
  if (d === 1) return String(n);
  return n < 0 ? `-\\frac{${Math.abs(n)}}{${d}}` : `\\frac{${n}}{${d}}`;
}

function linearLatex(a, variable, b) {
  const head = monoLatex(a, { [variable]: 1 });
  if (b === 0) return head;
  return `${head}${signedNumber(b)}`;
}

/** 係数付きの括弧。p(ax+b)。p=-1 は先頭の -( ) になる。 */
function groupLatex(p, inner) {
  const head = p === 1 ? '' : p === -1 ? '-' : String(p);
  return `${head}\\left(${inner}\\right)`;
}

function radicalLatex(coef, radicand) {
  if (radicand === 1) return String(coef);
  const head = coef === 1 ? '' : coef === -1 ? '-' : String(coef);
  return `${head}\\sqrt{${radicand}}`;
}

/* ============================================================
 * 小数のあつかい（SPEC 5章）
 * ========================================================== */

/** '1.8' / '-2.3' → 値。小数は必ず有理数として持ち、浮動小数で比較しない。 */
function decValue(text) {
  const s = String(text);
  const dot = s.indexOf('.');
  if (dot < 0) return vInt(Number(s));
  const digits = s.slice(0, dot) + s.slice(dot + 1);
  return vRat(BigInt(digits), 10n ** BigInt(s.length - dot - 1));
}

/** 有理数を小数表記の文字列にする。割り切れなければ null。 */
export function decimalString(rational) {
  if (!rational) return null;
  for (let k = 0; k <= 6; k++) {
    const scale = 10n ** BigInt(k);
    if ((rational.n * scale) % rational.d !== 0n) continue;
    const scaled = (rational.n * scale) / rational.d;
    const negative = scaled < 0n;
    const digits = (negative ? -scaled : scaled).toString().padStart(k + 1, '0');
    const body = k === 0 ? digits : `${digits.slice(0, digits.length - k)}.${digits.slice(digits.length - k)}`;
    return (negative ? '-' : '') + body;
  }
  return null;
}

function decimalPlaces(text) {
  const dot = String(text).indexOf('.');
  return dot < 0 ? 0 : String(text).length - dot - 1;
}

/** 小数文字列の桁だけを取り出す（符号と小数点を除いた整数）。 */
function decimalDigits(text) {
  return BigInt(String(text).replace('-', '').replace('.', ''));
}

/** |text| <= limit を、浮動小数を経由せずに判定する。 */
function decimalAbsAtMost(text, limit) {
  const places = decimalPlaces(text);
  return decimalDigits(text) <= BigInt(limit) * 10n ** BigInt(places);
}

function decimalIsZero(text) { return decimalDigits(text) === 0n; }

/**
 * 小数の演算数を作る（桁数を指定）。
 * 文字列は整数から組み立てる。浮動小数の割り算・toFixed を経由しない。
 */
function makeDecimal(rng, wholeMax, places) {
  const scale = 10 ** places;
  let raw = pick(rng, range(1, wholeMax * scale));
  if (places > 0 && raw % 10 === 0) raw += 1;        // 末尾0の見た目（0.30）を避ける
  if (places === 0) return String(raw);
  const digits = String(raw).padStart(places + 1, '0');
  return `${digits.slice(0, digits.length - places)}.${digits.slice(digits.length - places)}`;
}

/* ============================================================
 * 生成器
 *
 * 各生成器は成立条件を満たさなければ null を返す。呼び出し側が retryIndex を進めて再抽選する。
 * ========================================================== */

/** 誤答候補。値と、その誤りに対する生徒向けの文言を必ず対にする。 */
function mc(value, message) { return { value, message }; }

/* ---- Q1 正負の数（signed.add2） ------------------------------- */
function genSignedAdd2(rng, spec) {
  const R = RANGES['calc.signed'][1];
  const shape = pick(rng, ['minusNeg', 'plusNeg', 'negFirst']);
  const a = pick(rng, range(2, R.termAbsMax));
  const b = pick(rng, range(2, R.termAbsMax));
  if (a === b) return null;

  let prompt, firstStep, value, hint1, hint2, wrongSign;
  if (shape === 'minusNeg') {
    // a-(-b) → a+b
    value = a + b;
    prompt = `${a}-\\left(-${b}\\right)`;
    firstStep = `${a}+${b}`;
    hint1 = 'かっこの前の符号に注目しよう。「−（−■）」は「＋■」に直せる。ひくことは、反対の数をたすことと同じだよ。';
    hint2 = `ひき算は「反対の数をたす」形に直せるよ。この式では \\(-\\left(-${b}\\right)\\) の部分をたし算に直そう。`;
    wrongSign = a - b;
  } else if (shape === 'plusNeg') {
    // a+(-b) → a-b
    value = a - b;
    prompt = `${a}+\\left(-${b}\\right)`;
    firstStep = `${a}-${b}`;
    hint1 = 'かっこの前が「＋」でも、かっこの中が負ならその符号は残るよ。「＋（−■）」は「−■」に直せる。';
    hint2 = `この式では \\(+\\left(-${b}\\right)\\) の部分をどう書けるか考えよう。かっこをはずすと形が見えてくるよ。`;
    wrongSign = a + b;
  } else {
    // -a+b → b-a
    value = b - a;
    prompt = `-${a}+${b}`;
    firstStep = `${b}-${a}`;
    hint1 = '負の数から始まる式は、たし算の順番を入れかえて考えると分かりやすいよ。数直線で左からいくつ動くかを思い浮かべよう。';
    hint2 = `\\(-${a}+${b}\\) は \\(${b}-${a}\\) と同じだね。どちらの数が大きいかで答えの符号が決まるよ。`;
    wrongSign = -(a + b);
  }
  if (value === 0 || Math.abs(value) > R.maxAbs) return null;
  if (wrongSign === value) return null;

  return {
    typeKey: 'signed.add2',
    params: { shape, a, b },
    promptParts: [{ type: 'text', value: GENERIC_LEAD }, { type: 'math', value: prompt }],
    answer: vInt(value),
    kind: 'rational',
    allowedVariables: [],
    decimalAllowed: false,
    steps: [firstStep, String(value)],
    hints: [hint1, hint2],
    misconceptions: {
      'CALC-SIGN': mc(vInt(wrongSign),
        shape === 'minusNeg'
          ? `かっこの前の「−」と、かっこの中の「−」で符号が2回はたらいているよ。\\(-\\left(-${b}\\right)\\) は \\(+${b}\\) になる。`
          : shape === 'plusNeg'
            ? `かっこの前が「＋」でも、かっこの中が負なら符号は残るよ。\\(+\\left(-${b}\\right)\\) は \\(-${b}\\) になる。`
            : `\\(-${a}\\) と \\(+${b}\\) はどちらも符号がちがうよ。両方を負として足していないか確かめよう。`)
    }
  };
}

/* ---- Q7 正負の数（signed.mix3） ------------------------------- */
function genSignedMix3(rng, spec) {
  const R = RANGES['calc.signed'][2];
  const shape = pick(rng, ['addMul', 'addDiv', 'mulAdd', 'divAdd']);
  const plus = rng() < 0.5;
  const wrap = n => (n < 0 ? `\\left(${n}\\right)` : String(n));

  let prompt, mid, value, product;
  if (shape === 'addMul' || shape === 'addDiv') {
    const a = pick(rng, range(2, R.termAbsMax)) * sign(rng);
    if (shape === 'addMul') {
      const b = pick(rng, range(2, R.mulMax)) * sign(rng);
      const c = pick(rng, range(2, R.mulMax)) * sign(rng);
      product = b * c;
      prompt = `${a}${plus ? '+' : '-'}${wrap(b)}\\times ${wrap(c)}`;
    } else {
      const c = pick(rng, range(2, R.divMax)) * sign(rng);
      const q = pick(rng, range(2, R.mulMax)) * sign(rng);
      const b = q * c;                                   // 必ず割り切れる
      if (Math.abs(b) > R.termAbsMax * 2) return null;
      product = q;
      prompt = `${a}${plus ? '+' : '-'}${wrap(b)}\\div ${wrap(c)}`;
    }
    value = plus ? a + product : a - product;
    mid = `${a}${plus ? '+' : '-'}${wrap(product)}`;
  } else {
    const c = pick(rng, range(2, R.termAbsMax)) * sign(rng);
    if (shape === 'mulAdd') {
      const a = pick(rng, range(2, R.mulMax)) * sign(rng);
      const b = pick(rng, range(2, R.mulMax)) * sign(rng);
      product = a * b;
      prompt = `${a}\\times ${wrap(b)}${plus ? '+' : '-'}${wrap(c)}`;
    } else {
      const b = pick(rng, range(2, R.divMax)) * sign(rng);
      const q = pick(rng, range(2, R.mulMax)) * sign(rng);
      const a = q * b;
      if (Math.abs(a) > R.termAbsMax * 2) return null;
      product = q;
      prompt = `${a}\\div ${wrap(b)}${plus ? '+' : '-'}${wrap(c)}`;
    }
    value = plus ? product + c : product - c;
    mid = `${product}${plus ? '+' : '-'}${wrap(c)}`;
  }

  if (value === 0 || Math.abs(value) > R.maxAbs) return null;
  if (Math.abs(product) > MAX_INTERMEDIATE) return null;
  if (!/\\left\(-/.test(prompt)) return null;            // 負の数を必ず1つは含める

  const leftToRight = shape === 'addMul' || shape === 'addDiv';
  return {
    typeKey: 'signed.mix3',
    params: { shape, plus, product, value },
    promptParts: [{ type: 'text', value: GENERIC_LEAD }, { type: 'math', value: prompt }],
    answer: vInt(value),
    kind: 'rational',
    allowedVariables: [],
    decimalAllowed: false,
    steps: [mid, String(value)],
    hints: [
      'かけ算・わり算は、たし算・ひき算より先に計算するよ。まず先に計算する部分がどこかを見つけよう。',
      `先に計算する部分を求めると \\(${prompt}=${mid}\\) の形になるよ。ここから残りを計算しよう。`
    ],
    misconceptions: {
      'CALC-ORDER': mc(vInt(leftToRight ? evaluateLeftToRight(shape, prompt, value, product, plus) : value + 1),
        'かけ算・わり算はたし算・ひき算より先に計算するよ。左から順に計算していないか確かめよう。'),
      'CALC-SIGN': mc(vInt(-value),
        '負の数が何個かけられているかで、積・商の符号が決まるよ。符号を先に決めてから数を計算しよう。')
    }
  };
}

/** 「左から順に計算してしまった」値。加減が先に来る形でだけ意味を持つ。 */
function evaluateLeftToRight(shape, prompt, value, product, plus) {
  // a ± b × c を (a ± b) × c と読んだ場合の値は生成条件から一意に決まらないため、
  // ここでは「積の符号を無視して足した」典型誤りを返す（正答と一致したら matcher から外れる）
  return plus ? value - 2 * product : value + 2 * product;
}

/* ---- Q2 分数（frac.addSub / frac.withInt） --------------------- */
function genFractionAddSub(rng, spec) {
  const R = RANGES['calc.fraction'][1];
  const d1 = pick(rng, R.denoms);
  const d2 = pick(rng, R.denoms);
  if (d1 === d2) return null;
  const L = lcm(d1, d2);
  if (L > R.lcmMax) return null;

  const n1 = pick(rng, range(1, R.numerAbsMax)) * sign(rng);
  const n2 = pick(rng, range(1, R.numerAbsMax));
  if (gcd(Math.abs(n1), d1) !== 1 || gcd(n2, d2) !== 1) return null;

  const op = rng() < 0.5 ? 1 : -1;
  const num = n1 * (L / d1) + op * n2 * (L / d2);
  if (num === 0) return null;
  if (Math.abs(num) > 200) return null;
  // 手数2に収めるため、通分した時点で既約になる形だけを出す
  if (gcd(Math.abs(num), L) !== 1) return null;

  const prompt = `${fracLatex(n1, d1)}${op > 0 ? '+' : '-'}${fracLatex(n2, d2)}`;
  const common = `${fracLatex(n1 * (L / d1), L)}${op > 0 ? '+' : '-'}${fracLatex(n2 * (L / d2), L)}`;

  const misconceptions = {
    'CALC-FRACTION': mc(vRat(n1 + op * n2, d1 + d2),
      `分母どうしを足したり引いたりはしないよ。分母を ${L} にそろえて、分子だけを計算する。`)
  };
  misconceptions['CALC-COLLECT'] = mc(vRat(n1 + op * n2, Math.max(d1, d2)),
    `分子を通分できていないよ。分母を ${L} にするとき、分子にも同じ数をかける。`);

  return {
    typeKey: 'frac.addSub',
    params: { n1, d1, n2, d2, op, L },
    promptParts: [{ type: 'text', value: GENERIC_LEAD }, { type: 'math', value: prompt }],
    answer: vRat(num, L),
    kind: 'rational',
    allowedVariables: [],
    decimalAllowed: false,
    steps: [common, fracLatex(num, L)],
    hints: [
      `分母がちがうので、そのままでは足したり引いたりできない。まず分母を ${L} にそろえよう。`,
      `通分すると \\(${prompt}=${common}\\) になる。分母はそのままで、分子だけを計算しよう。`
    ],
    misconceptions
  };
}

function genFractionWithInt(rng, spec) {
  const R = RANGES['calc.fraction'][1];
  const d = pick(rng, R.denoms);
  const n = pick(rng, range(1, R.numerAbsMax));
  if (gcd(n, d) !== 1) return null;
  const k = pick(rng, range(1, R.intAbsMax));
  const op = -1;                              // SPEC 2-3節の構造は「a/b − 整数」
  const num = n + op * k * d;
  if (num === 0) return null;
  if (gcd(Math.abs(num), d) !== 1) return null;      // 約分不要（手数2）
  if (Math.abs(num) > 200) return null;

  const prompt = `\\frac{${n}}{${d}}${op > 0 ? '+' : '-'}${k}`;
  const common = `\\frac{${n}}{${d}}${op > 0 ? '+' : '-'}\\frac{${k * d}}{${d}}`;

  return {
    typeKey: 'frac.withInt',
    params: { n, d, k, op },
    promptParts: [{ type: 'text', value: GENERIC_LEAD }, { type: 'math', value: prompt }],
    answer: vRat(num, d),
    kind: 'rational',
    allowedVariables: [],
    decimalAllowed: false,
    steps: [common, fracLatex(num, d)],
    hints: [
      `整数も分母 ${d} の分数に直せるよ。同じ分母にそろえてから計算しよう。`,
      `整数を分数に直すと \\(${prompt}=${common}\\) になる。分子だけを計算しよう。`
    ],
    misconceptions: {
      'CALC-FRACTION': mc(vRat(n + op * k, d),
        `整数を分母 ${d} の分数に直すのを忘れているよ。\\(${k}=\\frac{${k * d}}{${d}}\\) として計算する。`),
      'CALC-SIGN': mc(vRat(n - op * k * d, d),
        '整数を分数に直したあと、その符号がそのまま残っているか確かめよう。')
    }
  };
}

/* ---- Q8 分数（frac.mulDiv） ----------------------------------- */
function genFractionMulDiv(rng, spec) {
  const R = RANGES['calc.fraction'][2];
  const shape = pick(rng, ['intDivFrac', 'fracMulInt', 'fracMulFrac']);

  if (shape === 'intDivFrac') {
    // 整数 ÷ (±b/c)
    const k = pick(rng, range(2, R.intAbsMax)) * sign(rng);
    const b = pick(rng, range(1, R.numerAbsMax));
    const c = pick(rng, R.denoms);
    if (gcd(b, c) !== 1) return null;
    const s = sign(rng);
    if (k > 0 && s > 0) return null;                  // 負を必ず1つ含む
    const num = k * c * s, den = b;
    const answer = vRat(num, den);
    const answerRat = asRational(answer);
    if (!answerRat || answerRat.n === 0n) return null;
    if (Math.abs(Number(answerRat.n)) > 200 || Number(answerRat.d) > 36) return null;

    const prompt = `${k}\\div${wrapNegative(fracLatex(b * s, c))}`;
    const mid = `${k}\\times${wrapNegative(fracLatex(c * s, b))}`;
    return {
      typeKey: 'frac.mulDiv',
      params: { shape, k, b, c, s },
      promptParts: [{ type: 'text', value: GENERIC_LEAD }, { type: 'math', value: prompt }],
      answer,
      kind: 'rational',
      allowedVariables: [],
      decimalAllowed: false,
      steps: [mid, canonicalLatex(answer)],
      hints: [
        '分数でわる計算は、その分数の逆数をかける計算に直せるよ。符号も忘れずに引きつごう。',
        `逆数のかけ算に直すと \\(${prompt}=${mid}\\) になる。ここから約分して計算しよう。`
      ],
      misconceptions: {
        'CALC-FRACTION': mc(vRat(k * b * s, c),
          'わり算をかけ算に直すときは、うしろの分数をひっくり返す（逆数にする）よ。そのままかけていないか確かめよう。'),
        'CALC-SIGN': mc(vRat(-num, den),
          '負の数でわると、答えの符号は変わるよ。符号を先に決めてから数を計算しよう。')
      }
    };
  }

  if (shape === 'fracMulInt') {
    const a = pick(rng, range(1, R.numerAbsMax));
    const b = pick(rng, R.denoms);
    if (gcd(a, b) !== 1) return null;
    const k = pick(rng, range(2, R.intAbsMax));
    const s1 = sign(rng), s2 = sign(rng);
    if (s1 > 0 && s2 > 0) return null;
    const num = a * k * s1 * s2, den = b;
    const answer = vRat(num, den);
    const answerRat = asRational(answer);
    if (!answerRat || answerRat.n === 0n) return null;
    if (Math.abs(Number(answerRat.n)) > 200 || Number(answerRat.d) > 36) return null;
    if (gcd(a * k, b) === 1) return null;             // 約分の練習になる形だけ

    const prompt = `${fracLatex(a * s1, b)}\\times${wrapNegative(String(k * s2))}`;
    const mid = `${fracLatex(num, b)}`;
    return {
      typeKey: 'frac.mulDiv',
      params: { shape, a, b, k, s1, s2 },
      promptParts: [{ type: 'text', value: GENERIC_LEAD }, { type: 'math', value: prompt }],
      answer,
      kind: 'rational',
      allowedVariables: [],
      decimalAllowed: false,
      steps: [`\\frac{${a} \\times ${k}}{${b}}`, canonicalLatex(answer)],
      hints: [
        '分数と整数のかけ算では、整数を分子にかけるよ。先に約分できるところを見つけると計算が軽くなる。',
        `分子にかけると \\(${prompt}\\) は分母 ${b} のままで分子が \\(${a}\\times ${k}\\) になるね。約分してから答えよう。`
      ],
      misconceptions: {
        'CALC-FRACTION': mc(vRat(a * s1 * s2, b * k),
          '整数は分子にかけるよ。分母にかけていないか確かめよう。'),
        'CALC-SIGN': mc(vRat(-num, den),
          '負の数が何個あるかで答えの符号が決まるよ。数え直してみよう。')
      }
    };
  }

  // (±a/b) × (±c/d)
  const a = pick(rng, range(1, R.numerAbsMax));
  const b = pick(rng, R.denoms);
  const c = pick(rng, range(1, R.numerAbsMax));
  const d = pick(rng, R.denoms);
  if (gcd(a, b) !== 1 || gcd(c, d) !== 1) return null;
  if (b === d) return null;
  const s1 = sign(rng), s2 = sign(rng);
  if (s1 > 0 && s2 > 0) return null;
  const num = a * c * s1 * s2, den = b * d;
  const answer = vRat(num, den);
  const answerRat = asRational(answer);
  if (!answerRat || answerRat.n === 0n) return null;
  if (Math.abs(Number(answerRat.n)) > 200 || Number(answerRat.d) > 36) return null;

  const prompt = `${fracLatex(a * s1, b)}\\times${wrapNegative(fracLatex(c * s2, d))}`;
  return {
    typeKey: 'frac.mulDiv',
    params: { shape, a, b, c, d, s1, s2 },
    promptParts: [{ type: 'text', value: GENERIC_LEAD }, { type: 'math', value: prompt }],
    answer,
    kind: 'rational',
    allowedVariables: [],
    decimalAllowed: false,
    steps: [`\\frac{${a}\\times ${c}}{${b}\\times ${d}}`, canonicalLatex(answer)],
    hints: [
      '分数どうしのかけ算は、分子は分子どうし、分母は分母どうしをかけるよ。先に約分できるところを探そう。',
      `分子と分母をそれぞれかけると、分子は \\(${a}\\times ${c}\\)、分母は \\(${b}\\times ${d}\\) になるね。約分してから答えよう。`
    ],
    misconceptions: {
      'CALC-FRACTION': mc(vRat(a * c * s1 * s2 + 0, den + 1),
        '分子は分子どうし、分母は分母どうしをかけるよ。組み合わせを確かめよう。'),
      'CALC-SIGN': mc(vRat(-num, den),
        '負の数が何個あるかで答えの符号が決まるよ。数え直してみよう。')
    }
  };
}

/* ---- Q3 小数（dec.*） ----------------------------------------- */
const DECIMAL_LEAD = '次の計算をしなさい。（小数で答えなさい。）';

function decimalQuestion({ typeKey, params, prompt, answerText, steps, hints, misconceptions }) {
  // 表示の正規形（末尾0を落とした形）でなければ不成立にする。
  // 入力側の受理範囲（1.80 も 1.8 も正解）とは別物であることに注意。
  const normalized = decimalString(asRational(decValue(answerText)));
  if (normalized === null || normalized !== answerText) return null;
  return {
    typeKey,
    params,
    promptParts: [{ type: 'text', value: DECIMAL_LEAD }, { type: 'math', value: prompt }],
    answer: decValue(answerText),
    answerLatex: answerText,
    kind: 'rational',
    allowedVariables: [],
    decimalAllowed: true,
    decimalRequired: true,
    steps,
    hints,
    misconceptions
  };
}

/**
 * 小数の答えとして成立するか（SPEC 5-1）。
 *   - 整数にならない（「小数で答えなさい」と矛盾するため）
 *   - 小数第3位まで
 *   - 絶対値 ≤ 50
 * 判定はすべて整数どうしの比較で行い、浮動小数を経由しない。
 */
function validDecimalAnswer(text) {
  const R = RANGES['calc.decimal'][1];
  if (text === null) return false;
  const places = decimalPlaces(text);
  if (places < 1 || places > R.answerPlacesMax) return false;
  if (!decimalAbsAtMost(text, R.answerAbsMax)) return false;
  if (decimalIsZero(text)) return false;
  return true;
}

function genDecimalAddSub(rng) {
  const R = RANGES['calc.decimal'][1];
  const placesA = pick(rng, R.addSub.placesA);
  const placesB = pick(rng, R.addSub.placesB);
  const a = makeDecimal(rng, 12, placesA);
  const b = makeDecimal(rng, 12, placesB);
  if (placesB > 0 && decimalPlaces(b) === 0) return null;
  const negativeFirst = rng() < 0.35;
  const op = rng() < 0.5 ? 1 : -1;

  // 値はすべて有理数（BigInt）で計算する。浮動小数を経由しない。
  const leftValue = negativeFirst ? vTerm(-decimalDigits(a), 10n ** BigInt(decimalPlaces(a))) : decValue(a);
  const rightValue = op > 0 ? decValue(b) : vTerm(-decimalDigits(b), 10n ** BigInt(decimalPlaces(b)));
  const answerText = decimalString(asRational(vAdd(leftValue, rightValue)));
  if (!validDecimalAnswer(answerText)) return null;
  if (!decimalAbsAtMost(a, R.absMaxOperand) || !decimalAbsAtMost(b, R.absMaxOperand)) return null;

  const left = negativeFirst ? `\\left(-${a}\\right)` : a;
  const prompt = `${left}${op > 0 ? '+' : '-'}${b}`;

  // 小数点をずらした典型誤り
  const shifted = decimalString(asRational(vRat(decimalDigits(answerText), 10n ** BigInt(Math.max(0, decimalPlaces(answerText) - 1)))));

  return decimalQuestion({
    typeKey: 'dec.addSub',
    params: { a, b, op, negativeFirst },
    prompt,
    answerText,
    steps: [answerText],
    hints: [
      '小数のたし算・ひき算は、小数点の位置をそろえてから計算するよ。位をそろえて筆算すると間違えにくい。',
      `\\(${prompt}\\) の2つの数を、小数点の位置をそろえて書いてみよう。位がそろえば、あとは整数と同じ計算だよ。`
    ],
    misconceptions: {
      'CALC-DECIMAL': mc(decValue(shifted || '0.1'),
        '小数点の位置がずれているよ。位をそろえて書いてから計算しよう。'),
      'CALC-SIGN': mc(decValue(answerText.startsWith('-') ? answerText.slice(1) : `-${answerText}`),
        '答えの符号を確かめよう。負の数を含む式では、どちらの数が大きいかで符号が決まるよ。')
    }
  });
}

function genDecimalMul(rng) {
  const R = RANGES['calc.decimal'][1];
  const useIntTimes = rng() < 0.4;
  let a, b, prompt, negative = false;

  if (useIntTimes) {
    const k = pick(rng, range(R.mul.intTimesDecimal.intMin, R.mul.intTimesDecimal.intMax));
    const dec = pick(rng, R.mul.intTimesDecimal.decChoices);
    a = String(k);
    b = String(dec);
    prompt = `${a}\\times ${b}`;
  } else {
    a = makeDecimal(rng, 9, 1);
    b = String(pick(rng, R.mul.bChoices));
    negative = rng() < 0.35;
    prompt = negative ? `\\left(-${a}\\right)\\times ${b}` : `${a}\\times ${b}`;
  }

  const product = vTerm(
    (negative ? -1n : 1n) * decimalDigits(a) * decimalDigits(b),
    10n ** BigInt(decimalPlaces(a) + decimalPlaces(b))
  );
  const answerText = decimalString(asRational(product));
  if (!validDecimalAnswer(answerText)) return null;
  if (decimalPlaces(answerText) > R.mul.maxProductPlaces) return null;

  const digitsOnly = `${decimalDigits(a)}\\times ${decimalDigits(b)}`;
  const shifted = decimalString(asRational(vRat(
    decimalDigits(answerText), 10n ** BigInt(Math.max(0, decimalPlaces(answerText) - 1)))));

  return decimalQuestion({
    typeKey: 'dec.mul',
    params: { a, b, negative, useIntTimes },
    prompt,
    answerText,
    steps: [answerText],
    hints: [
      '小数のかけ算は、まず小数点を無視して整数として計算し、あとで小数点を打つよ。小数点以下の桁数の合計が、答えの桁数になる。',
      `小数点を無視すると \\(${digitsOnly}\\) の計算だね。2つの数の小数点以下の桁数を合計すると、答えの小数点の位置が決まるよ。`
    ],
    misconceptions: {
      'CALC-DECIMAL': mc(decValue(shifted || '0.1'),
        '小数点の位置を確かめよう。かけ算では、2つの数の小数点以下の桁数を合計した分だけ小数点が動くよ。'),
      'CALC-SIGN': mc(decValue(answerText.startsWith('-') ? answerText.slice(1) : `-${answerText}`),
        '負の数をかけると答えの符号が変わるよ。符号を先に決めてから計算しよう。')
    }
  });
}

function genDecimalDiv(rng) {
  const R = RANGES['calc.decimal'][1];
  const useDecimalDivisor = rng() < 0.45;
  const divisor = useDecimalDivisor ? String(pick(rng, R.div.divisorDec)) : String(pick(rng, R.div.divisorInt));
  const quotientPlaces = pick(rng, [1, 2]);
  // 商は先に表示の正規形（末尾0なし）へ直してから、わられる数を組み立てる
  const quotient = decimalString(asRational(decValue(makeDecimal(rng, 9, quotientPlaces))));
  if (!validDecimalAnswer(quotient)) return null;

  const product = vTerm(
    decimalDigits(quotient) * decimalDigits(divisor),
    10n ** BigInt(decimalPlaces(quotient) + decimalPlaces(divisor))
  );
  const dividendText = decimalString(asRational(product));
  if (dividendText === null) return null;
  if (decimalPlaces(dividendText) > R.maxDecimalPlacesInProblem) return null;
  if (!decimalAbsAtMost(dividendText, R.absMaxOperand)) return null;

  const prompt = `${dividendText}\\div ${divisor}`;
  const shifted = decimalString(asRational(vRat(
    decimalDigits(quotient), 10n ** BigInt(Math.max(0, decimalPlaces(quotient) - 1)))));

  return decimalQuestion({
    typeKey: 'dec.div',
    params: { dividendText, divisor, quotient },
    prompt,
    answerText: quotient,
    steps: [quotient],
    hints: [
      useDecimalDivisor
        ? 'わる数が小数のときは、わる数とわられる数の両方を同じだけ10倍・100倍して、わる数を整数に直してから計算するよ。'
        : '小数を整数でわるときは、商の小数点はわられる数の小数点にそろえて打つよ。',
      `\\(${prompt}\\) は、まずわる数を整数に直すか、位をそろえるところから始めよう。小数点の位置に気をつけて。`
    ],
    misconceptions: {
      'CALC-DECIMAL': mc(decValue(shifted || '0.1'),
        '商の小数点の位置を確かめよう。わる数を10倍したら、わられる数も同じだけ10倍する必要があるよ。'),
      'CALC-ORDER': mc(decValue(dividendText),
        'わり算の向きを確かめよう。わられる数とわる数を取りちがえていないかな。')
    }
  });
}

function genDecimalMix(rng) {
  const R = RANGES['calc.decimal'][1];
  const a = makeDecimal(rng, 9, pick(rng, [1, 2]));
  const b = makeDecimal(rng, 5, 1);
  const n = pick(rng, R.mix.multipliers);
  const op = rng() < 0.5 ? 1 : -1;

  const productValue = vTerm(decimalDigits(b) * BigInt(n), 10n ** BigInt(decimalPlaces(b)));
  const productText = decimalString(asRational(productValue));
  const total = op > 0 ? vAdd(decValue(a), productValue) : vSub(decValue(a), productValue);
  const answerText = decimalString(asRational(total));
  if (productText === null || !validDecimalAnswer(answerText)) return null;
  if (decimalPlaces(answerText) > R.mix.maxPlaces) return null;
  if (!decimalAbsAtMost(productText, R.absMaxOperand)) return null;

  const prompt = `${a}${op > 0 ? '+' : '-'}${b}\\times ${n}`;
  const mid = `${a}${op > 0 ? '+' : '-'}${productText}`;

  return decimalQuestion({
    typeKey: 'dec.mix',
    params: { a, b, n, op },
    prompt,
    answerText,
    steps: [mid, answerText],
    hints: [
      'かけ算はたし算・ひき算より先に計算するよ。まず先に計算する部分を見つけよう。',
      `かけ算を先に計算すると \\(${prompt}=${mid}\\) になるね。ここから位をそろえて計算しよう。`
    ],
    misconceptions: {
      'CALC-ORDER': mc(
        (() => { const left = op > 0 ? vAdd(decValue(a), decValue(b)) : vSub(decValue(a), decValue(b));
          return vTerm(asRational(left).n * BigInt(n), asRational(left).d); })(),
        'かけ算を先に計算するよ。左から順に計算していないか確かめよう。'),
      'CALC-DECIMAL': mc(decValue(productText),
        'かけ算の答えだけで終わっていないかな。そのあとのたし算・ひき算まで計算しよう。')
    }
  });
}

/* ---- Q4 単項式（mono.powerOnly / mono.mulPower） --------------- */
function genMonoPowerOnly(rng, spec) {
  const R = RANGES['calc.monomial'][1];
  const k = pick(rng, range(2, 7));
  const variable = pick(rng, ['a', 'x']);
  const negative = rng() < 0.7;
  const coef = k * k;
  if (coef > 81) return null;

  const inner = monoLatex(negative ? -k : k, { [variable]: 1 });
  const prompt = `\\left(${inner}\\right)^{2}`;
  const answer = vMono(coef, 1, { [variable]: 2 });

  return {
    typeKey: 'mono.powerOnly',
    params: { k, variable, negative },
    promptParts: [{ type: 'text', value: GENERIC_LEAD }, { type: 'math', value: prompt }],
    answer,
    kind: 'expression',
    allowedVariables: [variable],
    decimalAllowed: false,
    steps: [`\\left(${inner}\\right)\\times\\left(${inner}\\right)`, canonicalLatex(answer)],
    hints: [
      'かっこの外の2乗は、かっこの中の「係数」と「文字」の両方にかかるよ。同じものを2回かけると考えよう。',
      `\\(${prompt}\\) は \\(${inner}\\) を2回かけた式だね。係数どうし、文字どうしを分けてかけよう。`
    ],
    misconceptions: {
      'CALC-POWER': mc(vMono(negative ? -k : k, 1, { [variable]: 2 }),
        `かっこの外の2乗は係数にもかかるよ。\\(${inner}\\) の係数も2乗する。`),
      'CALC-SIGN': mc(vMono(-coef, 1, { [variable]: 2 }),
        '同じ数を2回かけると、負の数どうしでも答えは正になるよ。符号を確かめよう。'),
      'CALC-COLLECT': mc(vMono(coef, 1, { [variable]: 1 }),
        '文字も2回かけるから、指数は2になるよ。文字の個数を数え直してみよう。')
    }
  };
}

function genMonoMulPower(rng, spec) {
  const R = RANGES['calc.monomial'][1];
  const variable = pick(rng, ['a', 'x']);
  const k = pick(rng, range(2, R.coefAbsMax)) * sign(rng);
  const m = pick(rng, range(2, 5));
  const negative = rng() < 0.7;
  const coef = k * m * m;
  if (Math.abs(coef) > 100) return null;      // 入試の実データ水準（R08正答 10a^4b）に合わせる
  if (m * m > 25) return null;

  const inner = monoLatex(negative ? -m : m, { [variable]: 1 });
  const first = monoLatex(k, { [variable]: 1 });
  const prompt = `${first}\\times\\left(${inner}\\right)^{2}`;
  const mid = `${first}\\times ${monoLatex(m * m, { [variable]: 2 })}`;
  const answer = vMono(coef, 1, { [variable]: 3 });
  if (3 > R.expInAnswerMax) return null;

  return {
    typeKey: 'mono.mulPower',
    params: { k, m, variable, negative },
    promptParts: [{ type: 'text', value: GENERIC_LEAD }, { type: 'math', value: prompt }],
    answer,
    kind: 'expression',
    allowedVariables: [variable],
    decimalAllowed: false,
    steps: [mid, canonicalLatex(answer)],
    hints: [
      '先に累乗の部分を計算してから、残りをかけるよ。かっこの外の2乗は係数にも文字にもかかる。',
      `累乗を先に計算すると \\(${prompt}=${mid}\\) になるね。あとは係数どうし、文字どうしをかけよう。`
    ],
    misconceptions: {
      'CALC-POWER': mc(vMono(k * m, 1, { [variable]: 3 }),
        `\\(\\left(${inner}\\right)^{2}\\) は係数も2乗するよ。\\(${monoLatex(m * m, { [variable]: 2 })}\\) になる。`),
      'CALC-SIGN': mc(vMono(-coef, 1, { [variable]: 3 }),
        '2乗すると必ず正になるよ。答えの符号は、もう一方の因数の符号だけで決まる。'),
      'CALC-COLLECT': mc(vMono(coef, 1, { [variable]: 2 }),
        '同じ文字をかけるときは指数を足すよ。文字が何個かけられているか数え直そう。')
    }
  };
}

/* ---- Q9 単項式（mono.mulDiv3 / mono.div2 / mono.polyDiv） ------ */
function genMonoDiv2(rng, spec) {
  const R = RANGES['calc.monomial'][2];
  const [v1, v2] = rng() < 0.5 ? ['a', 'b'] : ['x', 'y'];
  const ra = pick(rng, [0, 1, 2]);
  const rb = pick(rng, [0, 1]);
  if (ra + rb === 0) return null;
  const coefR = pick(rng, range(1, 6)) * sign(rng);
  const kd = pick(rng, range(2, 5));
  const da = pick(rng, [0, 1]);
  const db = pick(rng, [0, 1]);
  if (da + db === 0) return null;

  const na = ra + da, nb = rb + db;
  if (na > R.expInProblemMax || nb > R.expInProblemMax) return null;
  const coefN = coefR * kd;
  if (Math.abs(coefN) > R.coefAbsMax * 2) return null;
  if (Math.max(ra, rb) > R.expInAnswerMax) return null;

  const nLatex = monoLatex(coefN, { [v1]: na, [v2]: nb });
  const dLatex = monoLatex(kd, { [v1]: da, [v2]: db });
  const answer = vMono(coefR, 1, { [v1]: ra, [v2]: rb });
  // 表示は入試どおり「÷ のうしろの単項式はひとかたまり」の慣習に従う。
  // verifyLatex は、その意味を括弧で明示した曖昧さのない式（正答の独立再計算に使う）。
  const prompt = `${nLatex}\\div ${dLatex}`;
  const verifyLatex = `${nLatex}\\div\\left(${dLatex}\\right)`;

  return {
    typeKey: 'mono.div2',
    verifyLatex,
    params: { coefR, ra, rb, kd, da, db, v1, v2 },
    promptParts: [{ type: 'text', value: GENERIC_LEAD }, { type: 'math', value: prompt }],
    answer,
    kind: 'expression',
    allowedVariables: [v1, v2],
    decimalAllowed: false,
    steps: [`\\frac{${nLatex}}{${dLatex}}`, canonicalLatex(answer)],
    hints: [
      'わり算は分数の形に直すと、約分で処理できるよ。わる式を分母に置こう。',
      `分数の形にすると \\(${prompt}=\\frac{${nLatex}}{${dLatex}}\\) になるね。係数と文字をそれぞれ約分しよう。`
    ],
    misconceptions: {
      'CALC-POWER': mc(vMono(coefR, 1, { [v1]: Math.min(na + da, 4), [v2]: Math.min(nb + db, 4) }),
        'わり算では指数を「引く」よ。指数を足すのはかけ算のときだけ。'),
      'CALC-SIGN': mc(vMono(-coefR, 1, { [v1]: ra, [v2]: rb }),
        '負の数が何個あるかで答えの符号が決まるよ。数え直してみよう。'),
      'CALC-COLLECT': mc(vMono(coefR, 1, { [v1]: na, [v2]: nb }),
        `係数だけでなく文字も約分するよ。\\(${dLatex}\\) の文字の分だけ指数が減る。`)
    }
  };
}

function genMonoMulDiv3(rng, spec) {
  const R = RANGES['calc.monomial'][2];
  const [v1, v2] = rng() < 0.5 ? ['a', 'b'] : ['x', 'y'];
  const ra = pick(rng, [1, 2]);
  const rb = pick(rng, [0, 1]);
  const coefR = pick(rng, range(1, 6)) * sign(rng);
  const kd = pick(rng, range(2, 4));
  const kc = pick(rng, range(2, 4)) * sign(rng);
  const da = pick(rng, [0, 1]);
  const db = pick(rng, [0, 1]);
  if (da + db === 0) return null;
  const ca = pick(rng, [0, 1]);
  const cb = pick(rng, [0, 1]);

  // 元の式 A ÷ D × C = R  →  A = R × D ÷ C の形で逆算せず、A を直接組む
  const aCoef = coefR * kd / kc;
  if (!Number.isInteger(aCoef) || aCoef === 0) return null;
  const aa = ra + da - ca, ab = rb + db - cb;
  if (aa < 0 || ab < 0) return null;
  if (aa > R.expInProblemMax || ab > R.expInProblemMax) return null;
  if (Math.abs(aCoef) > R.coefAbsMax) return null;
  if (Math.max(ra, rb) > R.expInAnswerMax) return null;

  const aLatex = monoLatex(aCoef, { [v1]: aa, [v2]: ab });
  const dLatex = monoLatex(kd, { [v1]: da, [v2]: db });
  const cLatex = monoLatex(kc, { [v1]: ca, [v2]: cb });
  if (aa + ab === 0 || da + db === 0) return null;

  const answer = vMono(coefR, 1, { [v1]: ra, [v2]: rb });
  const prompt = `${aLatex}\\div ${dLatex}\\times ${wrapNegative(cLatex)}`;
  const verifyLatex = `${aLatex}\\div\\left(${dLatex}\\right)\\times ${wrapNegative(cLatex)}`;
  const mid = `\\frac{${aLatex}\\times ${wrapNegative(cLatex)}}{${dLatex}}`;

  return {
    typeKey: 'mono.mulDiv3',
    verifyLatex,
    params: { coefR, ra, rb, kd, kc, da, db, ca, cb, v1, v2 },
    promptParts: [{ type: 'text', value: GENERIC_LEAD }, { type: 'math', value: prompt }],
    answer,
    kind: 'expression',
    allowedVariables: [v1, v2],
    decimalAllowed: false,
    steps: [mid, canonicalLatex(answer)],
    hints: [
      'かけ算とわり算だけの式は、わる式を分母に、かける式を分子に置いた1つの分数にまとめられるよ。',
      `1つの分数にまとめると \\(${prompt}=${mid}\\) になるね。係数と文字をそれぞれ約分しよう。`
    ],
    misconceptions: {
      'CALC-POWER': mc(vMono(coefR, 1, { [v1]: Math.min(ra + da, 4), [v2]: Math.min(rb + db, 4) }),
        'わり算では指数を「引く」よ。かけ算とわり算で向きが逆になる。'),
      'CALC-SIGN': mc(vMono(-coefR, 1, { [v1]: ra, [v2]: rb }),
        '負の数が何個あるかで答えの符号が決まるよ。数え直してみよう。'),
      'CALC-ORDER': mc(vMono(coefR, 1, { [v1]: Math.max(0, ra - 1), [v2]: rb }),
        'かけ算とわり算は左から順に計算するよ。わる式にかける式まで含めていないか確かめよう。')
    }
  };
}

function genMonoPolyDiv(rng, spec) {
  const R = RANGES['calc.monomial'][2];
  const variable = pick(rng, ['a', 'x']);
  const n = pick(rng, range(2, 5));
  const p = pick(rng, range(1, 5));
  const q = pick(rng, range(1, 5)) * sign(rng);
  const k = n * p;                       // 第1項の係数
  const m = n * q;                       // 第2項の係数
  if (Math.abs(k) > R.coefAbsMax || Math.abs(m) > R.coefAbsMax) return null;
  if (q === 0) return null;

  const inner = `${monoLatex(k, { [variable]: 2 })}${joinTerm(monoLatex(m, { [variable]: 1 }))}`;
  const divisor = monoLatex(n, { [variable]: 1 });
  const prompt = `\\left(${inner}\\right)\\div ${divisor}`;
  const verifyLatex = `\\left(${inner}\\right)\\div\\left(${divisor}\\right)`;
  const answer = vAdd(vMono(p, 1, { [variable]: 1 }), vInt(q));

  return {
    typeKey: 'mono.polyDiv',
    verifyLatex,
    params: { n, p, q, variable },
    promptParts: [{ type: 'text', value: GENERIC_LEAD }, { type: 'math', value: prompt }],
    answer,
    kind: 'expression',
    allowedVariables: [variable],
    decimalAllowed: false,
    steps: [`\\frac{${inner}}{${divisor}}`, canonicalLatex(answer)],
    hints: [
      'かっこの中のそれぞれの項を、わる式でわるよ。分数の形にして項ごとに約分しよう。',
      `分数の形にすると \\(${prompt}=\\frac{${inner}}{${divisor}}\\) になるね。分子の2つの項を、それぞれ分母でわろう。`
    ],
    misconceptions: {
      'CALC-COLLECT': mc(vAdd(vMono(p, 1, { [variable]: 1 }), vMono(q, 1, { [variable]: 1 })),
        'それぞれの項をわると、文字が消える項が出てくるよ。第2項に文字が残っていないか確かめよう。'),
      'CALC-ORDER': mc(vMono(p, 1, { [variable]: 1 }),
        'かっこの中の「すべての項」をわるよ。1つ目の項だけで終わっていないか確かめよう。'),
      'CALC-POWER': mc(vAdd(vMono(p, 1, { [variable]: 2 }), vInt(q)),
        'わり算では指数を引くよ。文字の指数を確かめよう。')
    }
  };
}

/* ---- Q5 平方根（rad.simplifyAdd） ------------------------------ */
function genRadSimplifyAdd(rng, spec) {
  const R = RANGES['calc.radical'][1];
  const r = pick(rng, [2, 3, 5, 6, 7]);
  const shape = rng() < 0.5 ? 'oneSide' : 'bothSides';

  if (shape === 'oneSide') {
    // √A ± k√r （A = s²r）
    const s = pick(rng, [2, 3, 4, 5]);
    const A = s * s * r;
    if (A > R.radicandMax) return null;
    const k = pick(rng, range(1, 4));
    const op = rng() < 0.6 ? 1 : -1;
    const total = s + op * k;
    if (Math.abs(total) < 2 || Math.abs(total) > R.coefMax) return null;

    const prompt = `\\sqrt{${A}}${op > 0 ? '+' : '-'}${radicalLatex(k, r)}`;
    const mid = `${radicalLatex(s, r)}${op > 0 ? '+' : '-'}${radicalLatex(k, r)}`;
    const answer = vRadical(total, 1, r);
    return {
      typeKey: 'rad.simplifyAdd',
      params: { shape, r, s, k, op, A },
      promptParts: [{ type: 'text', value: GENERIC_LEAD }, { type: 'math', value: prompt }],
      answer,
      kind: 'radical',
      allowedVariables: [],
      decimalAllowed: false,
      steps: [mid, canonicalLatex(answer)],
      hints: [
        '根号の中に平方の因数（4, 9, 16, 25）がないか探そう。中を最も簡単にすると、同じ根号どうしになる。',
        `\\(\\sqrt{${A}}\\) を簡単にすると \\(${prompt}=${mid}\\) になる。同じ \\(\\sqrt{${r}}\\) の係数をまとめよう。`
      ],
      misconceptions: {
        'CALC-RADICAL': mc(vRadical(s * k, 1, r),
          '同じ根号どうしのたし算・ひき算では、係数を「足す・引く」よ。かけるのではない。'),
        'CALC-COLLECT': mc(vInt(total),
          `係数だけを計算して根号を落としてしまっているよ。\\(\\sqrt{${r}}\\) は答えに残る。`),
        'CALC-POWER': mc(vTerm(1n, 1n, A + k * k * r),
          '根号の中の数どうしは足せないよ。まず根号の中を最も簡単にする。')
      }
    };
  }

  // √A ± √B （どちらも簡単化して同類根号にする）
  const s1 = pick(rng, [2, 3, 4, 5]);
  const s2 = pick(rng, [2, 3, 4, 5].filter(v => v !== s1));
  if (s2 === undefined) return null;
  const A = s1 * s1 * r, B = s2 * s2 * r;
  if (A > R.radicandMax || B > R.radicandMax) return null;
  const op = rng() < 0.5 ? 1 : -1;
  const total = s1 + op * s2;
  if (Math.abs(total) < 2 || Math.abs(total) > R.coefMax) return null;

  const prompt = `\\sqrt{${A}}${op > 0 ? '+' : '-'}\\sqrt{${B}}`;
  const mid = `${radicalLatex(s1, r)}${op > 0 ? '+' : '-'}${radicalLatex(s2, r)}`;
  const answer = vRadical(total, 1, r);
  return {
    typeKey: 'rad.simplifyAdd',
    params: { shape, r, s1, s2, op, A, B },
    promptParts: [{ type: 'text', value: GENERIC_LEAD }, { type: 'math', value: prompt }],
    answer,
    kind: 'radical',
    allowedVariables: [],
    decimalAllowed: false,
    steps: [mid, canonicalLatex(answer)],
    hints: [
      '根号の中を最も簡単にしてから、同じ根号どうしの係数を計算するよ。平方の因数を探そう。',
      `どちらも簡単にすると \\(${prompt}=${mid}\\) になる。\\(\\sqrt{${r}}\\) の係数だけを計算しよう。`
    ],
    misconceptions: {
      'CALC-RADICAL': mc(vTerm(1n, 1n, op > 0 ? A + B : Math.max(1, A - B)),
        '根号の中の数どうしは足したり引いたりできないよ。中を簡単にしてから係数を計算する。'),
      'CALC-COLLECT': mc(vInt(total),
        `係数だけを計算して根号を落としてしまっているよ。\\(\\sqrt{${r}}\\) は答えに残る。`)
    }
  };
}

/* ---- Q10 平方根（積・商・有理化・3項） ------------------------- */
function genRadProduct(rng, spec) {
  const R = RANGES['calc.radical'][2];
  const a = pick(rng, [2, 3, 5, 6, 7]);
  const b = pick(rng, [2, 3, 5, 6].filter(v => v !== a));
  if (b === undefined) return null;
  if (a * b > R.productMax) return null;
  const k = pick(rng, range(1, 3));
  const { square, rest } = extractSquare(a * b);
  if (square === 1) return null;                    // 簡単化の練習になる形だけ
  if (k * square > R.coefMax) return null;

  const prompt = `\\sqrt{${a}}\\times ${radicalLatex(k, b)}`;
  const mid = `${radicalLatex(k, a * b)}`;
  const answer = vRadical(k * square, 1, rest);

  return {
    typeKey: 'rad.product',
    params: { a, b, k },
    promptParts: [{ type: 'text', value: GENERIC_LEAD }, { type: 'math', value: prompt }],
    answer,
    kind: 'radical',
    allowedVariables: [],
    decimalAllowed: false,
    steps: [mid, canonicalLatex(answer)],
    hints: [
      '根号どうしのかけ算は、中の数どうしをかけて1つの根号にまとめられるよ。まとめたあと平方の因数を外に出そう。',
      `1つにまとめると \\(${prompt}=${mid}\\) になる。中の数を「平方の数 × 残り」に分けよう。`
    ],
    misconceptions: {
      'CALC-RADICAL': mc(vRadical(k, 1, a + b),
        '根号どうしのかけ算では、中の数を「かける」よ。足すのではない。'),
      'CALC-POWER': mc(vInt(k * a * b),
        `根号は消えないよ。\\(\\sqrt{${a * b}}\\) を「平方の数 × 残り」に分けて、平方の数だけを外に出す。`),
      'CALC-COLLECT': mc(vRadical(k, 1, rest),
        '平方の数を外に出したら、その平方根を係数としてかけるよ。外に出した数を落としていないか確かめよう。')
    }
  };
}

function genRadQuotient(rng, spec) {
  const R = RANGES['calc.radical'][2];
  const ratio = pick(rng, R.quotientRatios);
  const b = pick(rng, [2, 3, 5]);
  const a = ratio * b;
  if (a > R.radicandMax) return null;
  const k = pick(rng, range(2, R.coefMax));
  const { square, rest } = extractSquare(ratio);
  if (square !== 1) return null;                    // 商が最簡根号になる形だけ

  const prompt = `${radicalLatex(k, a)}\\div\\sqrt{${b}}`;
  const mid = `${k}\\sqrt{\\frac{${a}}{${b}}}`;
  const answer = vRadical(k, 1, ratio);

  return {
    typeKey: 'rad.quotient',
    params: { a, b, k, ratio },
    promptParts: [{ type: 'text', value: GENERIC_LEAD }, { type: 'math', value: prompt }],
    answer,
    kind: 'radical',
    allowedVariables: [],
    decimalAllowed: false,
    steps: [mid, `${radicalLatex(k, ratio)}`],
    hints: [
      '根号どうしのわり算は、中の数どうしをわって1つの根号にまとめられるよ。係数はそのまま残る。',
      `1つの根号にまとめると \\(${prompt}=${mid}\\) になる。根号の中のわり算を計算しよう。`
    ],
    misconceptions: {
      'CALC-RADICAL': mc(vRadical(k, 1, a - b > 0 ? a - b : a + b),
        '根号どうしのわり算では、中の数を「わる」よ。引くのではない。'),
      'CALC-POWER': mc(vInt(k * ratio),
        '根号は消えないよ。わり算の結果は根号の中に残る。'),
      'CALC-COLLECT': mc(vRadical(1, 1, ratio),
        '外の係数はそのまま残るよ。落としていないか確かめよう。')
    }
  };
}

function genRadRationalize(rng, spec) {
  const R = RANGES['calc.radical'][2];
  const d = pick(rng, R.rationalize.denomRadicands);
  // 有理化した項が整数係数になる形だけを出す（分母の d で割り切れる分子）
  const multiples = [];
  for (let c = d; c <= R.rationalize.numerAbsMax; c += d) multiples.push(c);
  if (!multiples.length) return null;
  const c = pick(rng, multiples);
  const rationalized = c / d;

  const s = pick(rng, [2, 3, 4, 5]);
  const A = s * s * d;
  if (A > R.radicandMax) return null;
  const op = rng() < 0.65 ? 1 : -1;
  const total = s + op * rationalized;
  if (Math.abs(total) < 2 || Math.abs(total) > R.coefMax) return null;

  const prompt = `\\sqrt{${A}}${op > 0 ? '+' : '-'}\\frac{${c}}{\\sqrt{${d}}}`;
  const mid = `${radicalLatex(s, d)}${op > 0 ? '+' : '-'}\\frac{${c}\\sqrt{${d}}}{${d}}`;
  const mid2 = `${radicalLatex(s, d)}${op > 0 ? '+' : '-'}${radicalLatex(rationalized, d)}`;
  const answer = vRadical(total, 1, d);

  return {
    typeKey: 'rad.rationalize',
    params: { d, c, s, op, A, rationalized },
    promptParts: [{ type: 'text', value: GENERIC_LEAD }, { type: 'math', value: prompt }],
    answer,
    kind: 'radical',
    allowedVariables: [],
    decimalAllowed: false,
    steps: [mid, mid2, canonicalLatex(answer)],
    hints: [
      '分母に根号があるままでは、同じ根号どうしをまとめられないよ。分母と分子に同じ数をかけて、分母の根号を消そう。',
      `分母と分子に \\(\\sqrt{${d}}\\) をかけると \\(${prompt}=${mid}\\) になる。約分してから、もう一方の項と係数をまとめよう。`
    ],
    misconceptions: {
      'CALC-RADICAL': mc(vAdd(vRadical(s, 1, d), vRat(op * c, d)),
        `分母だけに \\(\\sqrt{${d}}\\) をかけると、分数の大きさが変わってしまうよ。分子にも同じだけかける。`),
      'CALC-COLLECT': mc(vRadical(s, 1, d),
        '2つ目の項を計算し終えていないよ。有理化したあと、係数どうしをまとめよう。'),
      'CALC-SIGN': mc(vRadical(s - op * rationalized, 1, d),
        '2つ目の項の符号を確かめよう。有理化しても符号は変わらないよ。')
    }
  };
}

function genRadSimplifyAdd3(rng, spec) {
  const R = RANGES['calc.radical'][2];
  const r = pick(rng, [2, 3, 5]);
  const s2 = pick(rng, [2, 3, 4]);
  const s3 = pick(rng, [2, 3, 4].filter(v => v !== s2));
  if (s3 === undefined) return null;
  const B = s2 * s2 * r, C = s3 * s3 * r;
  if (B > R.radicandMax || C > R.radicandMax) return null;
  const total = 1 + s2 - s3;
  if (Math.abs(total) < 2 || Math.abs(total) > R.coefMax) return null;

  const prompt = `\\sqrt{${r}}+\\sqrt{${B}}-\\sqrt{${C}}`;
  const mid = `\\sqrt{${r}}+${radicalLatex(s2, r)}-${radicalLatex(s3, r)}`;
  const answer = vRadical(total, 1, r);

  return {
    typeKey: 'rad.simplifyAdd3',
    params: { r, s2, s3, B, C },
    promptParts: [{ type: 'text', value: GENERIC_LEAD }, { type: 'math', value: prompt }],
    answer,
    kind: 'radical',
    allowedVariables: [],
    decimalAllowed: false,
    steps: [mid, canonicalLatex(answer)],
    hints: [
      '3つの項でも考え方は同じだよ。まず全部の根号の中を最も簡単にして、同じ根号にそろえよう。',
      `それぞれ簡単にすると \\(${prompt}=${mid}\\) になる。\\(\\sqrt{${r}}\\) の係数だけを左から計算しよう。`
    ],
    misconceptions: {
      'CALC-RADICAL': mc(vTerm(1n, 1n, Math.max(1, r + B - C)),
        '根号の中の数どうしは足したり引いたりできないよ。中を簡単にしてから係数を計算する。'),
      'CALC-COLLECT': mc(vInt(total),
        `係数だけを計算して根号を落としてしまっているよ。\\(\\sqrt{${r}}\\) は答えに残る。`),
      'CALC-SIGN': mc(vRadical(1 + s2 + s3, 1, r),
        '3つ目の項は引くよ。符号を確かめよう。')
    }
  };
}

/* ---- Q6 一次式（expr.two2var / expr.two1var） ------------------ */
function genExpressionTwoVar(rng, spec) {
  const R = RANGES['calc.expression'][2];
  const p = rng() < 0.34 ? -1 : pick(rng, R.outerCoef.filter(v => v !== -1));
  const q = pick(rng, R.outerCoef.filter(v => v !== -1 || rng() < 0.2));
  const a = pick(rng, range(1, R.innerCoefMax));
  const b = pick(rng, range(1, R.innerCoefMax)) * sign(rng);
  const c = pick(rng, range(1, R.innerCoefMax));
  const d = pick(rng, range(1, R.innerCoefMax)) * sign(rng);

  const cx = p * a + q * c;
  const cy = p * b + q * d;
  if (cx === 0 && cy === 0) return null;
  // 片方の文字が消えるのは可（R08正答 7x）。ただし答えが係数1の裸の文字になる形は避ける
  if (cx === 0 && Math.abs(cy) < 2) return null;
  if (cy === 0 && Math.abs(cx) < 2) return null;
  if (Math.abs(cx) > 40 || Math.abs(cy) > 40) return null;

  if (a === c && b === d) return null;         // 2つの括弧の中身が同じ形は避ける
  const inner1 = `${monoLatex(a, { x: 1 })}${joinTerm(monoLatex(b, { y: 1 }))}`;
  const inner2 = `${monoLatex(c, { x: 1 })}${joinTerm(monoLatex(d, { y: 1 }))}`;
  const prompt = `${groupLatex(p, inner1)}${q < 0 ? '-' : '+'}${groupLatex(Math.abs(q), inner2)}`;
  const expanded = `${monoLatex(p * a, { x: 1 })}${joinTerm(monoLatex(p * b, { y: 1 }))}${joinTerm(monoLatex(q * c, { x: 1 }))}${joinTerm(monoLatex(q * d, { y: 1 }))}`;
  const answer = vAdd(vMono(cx, 1, { x: 1 }), vMono(cy, 1, { y: 1 }));

  return {
    typeKey: 'expr.two2var',
    params: { p, q, a, b, c, d },
    promptParts: [{ type: 'text', value: GENERIC_LEAD }, { type: 'math', value: prompt }],
    answer,
    kind: 'expression',
    allowedVariables: ['x', 'y'],
    decimalAllowed: false,
    steps: [expanded, canonicalLatex(answer)],
    hints: [
      'かっこの外の数は、かっこの中の「すべての項」にかけるよ。とくにうしろのかっこの前の符号に注意しよう。',
      `分配すると \\(${prompt}=${expanded}\\) になる。ここから \\(x\\) の項どうし、\\(y\\) の項どうしをまとめよう。`
    ],
    misconceptions: {
      'CALC-COLLECT': mc(vAdd(vMono(cx, 1, { x: 1 }), vMono(p * b + d, 1, { y: 1 })),
        `うしろのかっこの「すべての項」にかけているか確かめよう。\\(${monoLatex(d, { y: 1 })}\\) にかけ忘れているよ。`),
      'CALC-SIGN': mc(vAdd(vMono(p * a - q * c, 1, { x: 1 }), vMono(p * b - q * d, 1, { y: 1 })),
        'うしろのかっこの前の符号は、かっこの中のすべての項に配るよ。'),
      'CALC-POWER': mc(vMono(cx + cy, 1, { x: 1, y: 1 }),
        '\\(x\\) の項と \\(y\\) の項は足せないよ。別のものとして並べて書く。')
    }
  };
}

function genExpressionOneVar(rng, spec) {
  const R = RANGES['calc.expression'][1];
  const p = rng() < 0.34 ? -1 : pick(rng, R.outerCoef.filter(v => v !== -1));
  const q = pick(rng, R.outerCoef.filter(v => v !== -1));
  const a = pick(rng, range(1, R.innerCoefMax));
  const b = pick(rng, range(1, R.constMax)) * sign(rng);
  const c = pick(rng, range(1, R.innerCoefMax));
  const d = pick(rng, range(1, R.constMax)) * sign(rng);

  const cx = p * a + q * c;
  const k0 = p * b + q * d;
  if (cx === 0 && k0 === 0) return null;
  // 答えが係数1の裸の文字（x）になる形は避ける
  if (k0 === 0 && Math.abs(cx) < 2) return null;
  if (Math.abs(cx) > 40 || Math.abs(k0) > 40) return null;

  if (a === c && b === d) return null;         // 2つの括弧の中身が同じ形は避ける
  const inner1 = linearLatex(a, 'x', b);
  const inner2 = linearLatex(c, 'x', d);
  const prompt = `${groupLatex(p, inner1)}${q < 0 ? '-' : '+'}${groupLatex(Math.abs(q), inner2)}`;
  const expanded = `${monoLatex(p * a, { x: 1 })}${signedNumber(p * b)}${joinTerm(monoLatex(q * c, { x: 1 }))}${signedNumber(q * d)}`;
  const answer = vAdd(vMono(cx, 1, { x: 1 }), vInt(k0));

  return {
    typeKey: 'expr.two1var',
    params: { p, q, a, b, c, d },
    promptParts: [{ type: 'text', value: GENERIC_LEAD }, { type: 'math', value: prompt }],
    answer,
    kind: 'expression',
    allowedVariables: ['x'],
    decimalAllowed: false,
    steps: [expanded, canonicalLatex(answer)],
    hints: [
      'かっこの外の数は、かっこの中の「すべての項」にかけるよ。うしろのかっこの前が「−」のときは、中の符号がすべて変わる。',
      `分配すると \\(${prompt}=${expanded}\\) になる。ここから \\(x\\) の項どうし、数の項どうしをまとめよう。`
    ],
    misconceptions: {
      'CALC-COLLECT': mc(vAdd(vMono(cx, 1, { x: 1 }), vInt(p * b + d)),
        `うしろのかっこの数の項にも \\(${Math.abs(q)}\\) をかけているか確かめよう。`),
      'CALC-SIGN': mc(vAdd(vMono(p * a - q * c, 1, { x: 1 }), vInt(p * b - q * d)),
        'うしろのかっこの前の符号は、かっこの中のすべての項に配るよ。'),
      'CALC-POWER': mc(vMono(cx + k0, 1, { x: 1 }),
        '\\(x\\) の項と数だけの項は足せないよ。別のものとして並べて書く。')
    }
  };
}

/* ============================================================
 * 型キー → 生成器
 * ========================================================== */

export const GENERIC_LEAD = '次の計算をしなさい。';

const GENERATORS = {
  'signed.add2': genSignedAdd2,
  'signed.mix3': genSignedMix3,
  'frac.addSub': genFractionAddSub,
  'frac.withInt': genFractionWithInt,
  'frac.mulDiv': genFractionMulDiv,
  'dec.addSub': genDecimalAddSub,
  'dec.mul': genDecimalMul,
  'dec.div': genDecimalDiv,
  'dec.mix': genDecimalMix,
  'mono.powerOnly': genMonoPowerOnly,
  'mono.mulPower': genMonoMulPower,
  'mono.div2': genMonoDiv2,
  'mono.mulDiv3': genMonoMulDiv3,
  'mono.polyDiv': genMonoPolyDiv,
  'rad.simplifyAdd': genRadSimplifyAdd,
  'rad.product': genRadProduct,
  'rad.quotient': genRadQuotient,
  'rad.rationalize': genRadRationalize,
  'rad.simplifyAdd3': genRadSimplifyAdd3,
  'expr.two2var': genExpressionTwoVar,
  'expr.two1var': genExpressionOneVar
};

/* ============================================================
 * 問題オブジェクトの組み立て
 * ========================================================== */

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function buildWorkedSolution(promptMath, steps) {
  const lines = steps.map((s, i) => (!promptMath && i === 0 ? `&${s}` : `&=${s}`)).join('\\\\');
  return `\\[\\begin{aligned}${promptMath || ''}${lines}\\end{aligned}\\]`;
}

/** 結果画面などで問題を1行に示す文字列。文字数で切らないので数式デリミタが壊れない。 */
export function promptSummary(question) {
  const hasMath = question.promptParts.some(part => part.type === 'math' && part.value);
  return question.promptParts
    .filter(part => part && part.value && String(part.value).trim())
    .filter(part => !(hasMath && part.type === 'text' && part.value === GENERIC_LEAD))
    .map(part => (part.type === 'math' ? `\\(${part.value}\\)` : part.value))
    .join(' ');
}

function buildQuestion(built, spec, slotIndex, questionSeed, retryIndex) {
  const answerLatex = built.answerLatex || canonicalLatex(built.answer);
  const answerKey = valueKey(built.answer);
  const answerRational = asRational(built.answer);
  const answerIsInteger = Boolean(answerRational && answerRational.d === 1n);

  const matchers = {};
  const usedKeys = new Set([answerKey]);
  for (const [code, entry] of Object.entries(built.misconceptions || {})) {
    const value = entry && entry.value !== undefined ? entry.value : entry;
    const message = (entry && entry.message) || null;
    let key;
    try { key = valueKey(value); } catch { continue; }
    if (usedKeys.has(key)) continue;
    usedKeys.add(key);
    matchers[code] = { key, message };
  }

  const promptMath = (built.promptParts.find(p => p.type === 'math') || {}).value || '';
  const generatedParams = built.params;

  const fingerprintSource = canonicalJson({
    courseId: COURSE_ID,
    templateId: spec.templateId,
    typeKey: built.typeKey,
    questionSeed,
    generatedParams,
    answer: answerKey
  });

  return {
    templateId: spec.templateId,
    courseId: COURSE_ID,
    trackId: null,
    slotIndex,
    subskillTag: spec.tag,
    coverageGroup: spec.tag,
    responseMode: 'short',
    difficulty: spec.difficulty,
    band: spec.band,
    templateSeed: null,
    questionSeed,
    retryIndex,
    fingerprint: String(fnv1a(fingerprintSource)),
    generatedParams,
    promptParts: built.promptParts.filter(p => p.value !== ''),
    diagramModel: null,
    answerSpec: {
      kind: built.kind,
      canonicalValue: built.answer,
      canonicalLatex: answerLatex,
      formPolicy: {
        decimalAllowed: Boolean(built.decimalAllowed) || answerIsInteger,
        decimalRequired: Boolean(built.decimalRequired),
        requireReducedFraction: true,
        requirePositiveDenominator: true,
        requireSimplestRadical: true,
        requireCollected: true,
        requireExpanded: true
      },
      allowedVariables: built.allowedVariables,
      acceptedForms: [],
      unit: built.unit || null
    },
    rubric: {
      criteria: [{ criterionId: 'value', description: '値が正しい', evidencePredicate: 'valueEquals' },
                 { criterionId: 'form', description: '答案の形が最も簡単', evidencePredicate: 'formClean' }],
      dependencies: [{ before: 'value', after: 'form' }],
      requiredCriteria: ['value', 'form'],
      scoringUnits: [{ scoringUnitId: `Q${slotIndex + 1}`, criterionIds: ['value', 'form'], maxScore: 1 }]
    },
    misconceptionCodes: Object.keys(matchers),
    diagnosticMatchers: matchers,
    hints: [built.hints[0], built.hints[1], '答えと全部の手順を確認します。'],
    hintScope: { level3Locks: 'question' },
    workedSolution: buildWorkedSolution(promptMath, built.steps),
    stepCount: built.steps.length,
    answerLatex,
    // 正答の独立再計算に使う、曖昧さのない形の問題文（表示には使わない）
    verifyLatex: built.verifyLatex || promptMath,
    generatorConstraints: {
      variantIndex: spec.variantIndex,
      typeKey: built.typeKey,
      axis: spec.axis,
      maxIntermediate: MAX_INTERMEDIATE,
      maxRadicand: MAX_RADICAND_IN_PROBLEM,
      maxSteps: spec.difficulty === 1 ? 2 : 3,
      requiresSignConversion: /\\left\(\s*-/.test(promptMath)
    },
    eligibleBlueprintYears: ['H21-R08'],
    provenance: '独自生成。過去問の本文・図・固有の数値は使用しない。型と数値の範囲だけを参照した。',
    rngVersion: RNG_VERSION,
    seed: questionSeed
  };
}

/* ============================================================
 * 公開API
 * ========================================================== */

/** スロット1問を決定的に生成する。成立しなければ retryIndex を進めて再抽選する。 */
export function generateQuestion(sessionSeed, mode, slotIndex, retryIndex = 0, context = {}) {
  const spec = SLOTS[slotIndex % SLOTS.length];
  const templateSeed = deriveSeed([sessionSeed, mode, slotIndex, COURSE_ID]);
  const avoid = Array.isArray(context.avoidTypeKeys) ? context.avoidTypeKeys : [];

  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    const tryIndex = retryIndex + attempt;
    const questionSeed = deriveSeed([templateSeed, spec.templateId, tryIndex]);
    const rng = mulberry32(questionSeed);

    // 直前セットと同じ型が続かないように、候補が残る場合だけ除外する
    let pool = spec.typeKeys.filter(key => !avoid.includes(key));
    let weights = null;
    if (!pool.length) { pool = spec.typeKeys; weights = spec.weights; }
    else if (spec.weights && pool.length === spec.typeKeys.length) weights = spec.weights;

    const typeKey = pickWeighted(rng, pool, weights);
    let built = null;
    try {
      built = GENERATORS[typeKey](rng, spec);
    } catch {
      built = null;                       // 上限違反などは不成立として扱い、再抽選する
    }
    if (built && built.typeKey === typeKey && ALLOWED_TYPE_KEYS.includes(built.typeKey)) {
      const question = buildQuestion(built, spec, slotIndex % SLOTS.length, questionSeed, tryIndex);
      question.templateSeed = templateSeed;
      return question;
    }
  }
  throw new Error(`generateQuestion failed: slot=${slotIndex} template=${spec.templateId} seed=${sessionSeed}`);
}

/** セットが満たしていない条件を1つ返す。すべて満たしていれば null。 */
function setBalanceProblem(questions) {
  const keys = questions.map(q => q.generatorConstraints.typeKey);
  const duplicatedAt = keys.findIndex((key, i) => keys.indexOf(key) !== i);
  if (duplicatedAt >= 0) return { reason: 'typeKey', detail: keys[duplicatedAt], slot: duplicatedAt };

  const counts = {};
  for (const q of questions) {
    const axis = q.generatorConstraints.axis;
    if (!axis) continue;
    counts[axis] = (counts[axis] || 0) + 1;
    if (counts[axis] > MAX_SAME_AXIS) return { reason: 'axis', detail: axis, slot: q.slotIndex };
  }

  const groups = new Set(questions.map(q => q.coverageGroup));
  const missing = COVERAGE_REQUIRED_GROUPS.find(group => !groups.has(group));
  if (missing) return { reason: 'coverage', detail: missing, slot: 0 };

  if (!questions.some(q => q.generatorConstraints.requiresSignConversion)) {
    return { reason: 'signConversion', detail: null, slot: 0 };
  }
  return null;
}

/**
 * 1セット（10問）を生成する。
 *   - fingerprint と typeKey の重複を避ける
 *   - 同一 axis は MAX_SAME_AXIS 回まで
 *   - セット合計手数 ≤ MAX_SET_STEPS
 */
export function generateSet(sessionSeed, mode = 'normal', options = {}) {
  const context = { avoidTypeKeys: options.avoidTypeKeys || [] };
  const used = new Set();
  const questions = [];

  for (let i = 0; i < SET_SIZE; i++) {
    let question = null;
    for (let retry = 0; retry < MAX_RETRY; retry++) {
      question = generateQuestion(sessionSeed, mode, i, retry, context);
      if (!used.has(question.fingerprint)) break;
    }
    used.add(question.fingerprint);
    questions.push(question);
  }

  // セット合計手数の調整
  let guard = 0;
  while (questions.reduce((sum, q) => sum + q.stepCount, 0) > MAX_SET_STEPS && guard < MAX_RETRY) {
    guard++;
    let target = -1, worst = -1;
    for (let i = 0; i < questions.length; i++) {
      if (questions[i].difficulty === 2 && questions[i].stepCount > worst) { worst = questions[i].stepCount; target = i; }
    }
    if (target < 0) break;
    const replacement = generateQuestion(sessionSeed, mode, target, questions[target].retryIndex + guard, context);
    if (used.has(replacement.fingerprint)) continue;
    used.delete(questions[target].fingerprint);
    used.add(replacement.fingerprint);
    questions[target] = replacement;
  }

  // 型の重複・軸の偏り・網羅群・符号変換の有無を直す
  guard = 0;
  for (;;) {
    const problem = setBalanceProblem(questions);
    if (!problem || guard >= MAX_RETRY) break;
    guard++;
    const slot = problem.slot;
    const replacement = generateQuestion(sessionSeed, mode, slot, questions[slot].retryIndex + guard, context);
    if (used.has(replacement.fingerprint)) continue;
    used.delete(questions[slot].fingerprint);
    used.add(replacement.fingerprint);
    questions[slot] = replacement;
  }

  return questions;
}

/** 復習用。元の問題と同じ型・同じスロットで、数値だけを変えた問題を作る。 */
export function generateReviewQuestion(entry, round) {
  const seed = deriveSeed([entry.seed, 'review', round]);
  return generateQuestion(seed, 'review', entry.slotIndex, 0, {});
}

export function totalSteps(questions) {
  return questions.reduce((sum, q) => sum + q.stepCount, 0);
}
