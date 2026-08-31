/*!
 * handwriting-overlay.js — クイズ画面全体の手書きレイヤー
 *
 * 出典: システム開発部/drill-apps/中学２年生/第３章/鬼リピ/oniripi-kouten/main.js の
 *       initWriting()（「クイズ画面全体の手書き（Canvas 2D + Pointer Events）」）を部品化したもの。
 *       高校入試対策シリーズ simultaneous-equations-master への移植で得た知見を反映済み。
 *
 * 仕組みの要点（触る前に読むこと）:
 *   1. canvas は pointer-events:none の全画面固定。当たり判定を持たせない。
 *   2. document の capture フェーズで pointer イベントを拾って自分で描く。
 *      → 書き込みモード中でも、下のボタン・入力欄はネイティブのまま反応する。
 *   3. isControl() に当たった操作は描かずに素通しする。
 *   ここを崩すと「書けるが何も押せない」アプリになる。
 *
 * 使い方:
 *   <script src="handwriting-overlay.js"></script>
 *   const hw = initHandwriting({ mount: '#draw-bar' });
 *   hw.setAvailable(true);   // 問題画面に入ったら
 *   hw.clearInk();           // 次の問題へ進むとき
 *   hw.reset(false);         // ホーム・結果画面へ移るとき
 *
 * ES module として使う場合はファイル末尾の export を有効にする。
 *
 * 手書き文字の認識はしない。書いた内容は採点に一切使わない。
 * 認識を足すには外部サービスへの通信が要り、生徒の入力を外部送信することになるため、
 * 全社ルール上の承認とリーガル確認が別途必要。
 */
(function (global) {
  'use strict';

  var DEFAULTS = {
    // 描かずに素通しする要素。アプリ固有のクリック可能要素があれば足す。
    // MathLive を使うなら math-field は必須。
    controlSelector: 'button,math-field,input,textarea,select,a,[role="button"],label',
    penColor: '#0a4f4b',      // 白地でコントラスト比4.5:1以上を確保できる濃色にする
    penWidth: 3,
    eraserWidth: 24,
    canvasId: 'write-canvas',
    zIndex: 10,               // 操作要素はこれより前面（zIndex+10）へ持ち上げる
    mount: null,              // 操作ボタンを入れる要素かセレクタ。null なら body 末尾
    labels: {
      penOff: '✏️ 書く',
      penOn: '✍️ 書き終わる',
      eraserOff: '🧽 消しゴム',
      eraserOn: '🧽 鉛筆に戻る',
      clear: '全消し',
      statusPen: '✍️ 書き込み中：入力欄・ボタンはそのまま押せます',
      statusEraser: '🧽 消しゴム中：なぞった部分だけ消せます'
    },
    // 全消しは取り返しがつかないので、危険操作の赤系を既定にしている（全社の共通ルール）。
    // アプリ側に .btn.danger 等があれば classNames で寄せる。
    classNames: { bar: '', button: '' }
  };

  function assign(base, extra) {
    var out = {}, k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    for (k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) {
      if (k === 'labels' || k === 'classNames') out[k] = assign(base[k] || {}, extra[k] || {});
      else out[k] = extra[k];
    }
    return out;
  }

  function injectStyle(opt) {
    if (document.getElementById('handwriting-overlay-style')) return;
    var css = ''
      + '.hw-canvas{position:fixed;inset:0;width:100vw;height:100vh;z-index:' + opt.zIndex + ';'
      +   'display:none;pointer-events:none;touch-action:none}'
      + '.hw-canvas.is-visible{display:block}'
      // canvas より前面に出して、書き込み中でも確実に押せるようにする
      + 'button,math-field,input,textarea,select,a,[role="button"]{position:relative;z-index:' + (opt.zIndex + 10) + '}'
      + '.hw-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:8px 0}'
      + '.hw-btn{min-height:44px;padding:0 14px;border-radius:12px;border:2px solid currentColor;'
      +   'background:#fff;font-weight:700;font-size:.9rem;cursor:pointer;flex:1 1 0;min-width:0}'
      + '.hw-btn:disabled{opacity:.45;cursor:not-allowed}'
      + '.hw-pen{color:' + opt.penColor + '}'
      + '.hw-pen.is-active{background:' + opt.penColor + ';color:#fff;border-color:transparent}'
      + '.hw-eraser{color:' + opt.penColor + '}'
      + '.hw-eraser.is-active{background:' + opt.penColor + ';color:#fff;border-color:transparent}'
      + '.hw-clear{color:#b3261e}'          // 危険操作は赤系を維持する
      + '.hw-status{flex-basis:100%;text-align:center;font-size:.8rem;font-weight:700;'
      +   'color:#fff;background:' + opt.penColor + ';border-radius:999px;padding:6px 12px}'
      + '.hw-status.hw-hidden{display:none}'
      + '@media (prefers-reduced-motion:reduce){.hw-btn{transition:none}}';
    var el = document.createElement('style');
    el.id = 'handwriting-overlay-style';
    el.textContent = css;
    document.head.appendChild(el);
  }

  function initHandwriting(options) {
    var opt = assign(DEFAULTS, options || {});
    injectStyle(opt);

    /* ---- canvas ----
       描き直される親要素の中に置くと、書いた内容ごと消える。必ず body 直下に置く。 */
    var canvas = document.getElementById(opt.canvasId);
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = opt.canvasId;
      canvas.setAttribute('aria-hidden', 'true');
      document.body.appendChild(canvas);
    }
    canvas.classList.add('hw-canvas');

    var ctx = null;
    try { ctx = canvas.getContext('2d'); } catch (e) { ctx = null; }
    if (!ctx) return null;   // canvas が使えない環境でもアプリ本体は動かす

    /* ---- 操作バー ---- */
    var mount = typeof opt.mount === 'string' ? document.querySelector(opt.mount) : opt.mount;
    var bar = document.createElement('div');
    bar.className = 'hw-bar ' + (opt.classNames.bar || '');
    bar.setAttribute('aria-label', '手書き操作');
    var btnCls = 'hw-btn ' + (opt.classNames.button || '');
    bar.innerHTML = ''
      + '<button type="button" class="' + btnCls + ' hw-pen" aria-pressed="false"></button>'
      + '<button type="button" class="' + btnCls + ' hw-eraser" aria-pressed="false" disabled></button>'
      + '<button type="button" class="' + btnCls + ' hw-clear" disabled></button>'
      + '<p class="hw-status hw-hidden" aria-live="polite"></p>';
    (mount || document.body).appendChild(bar);

    var btnPen = bar.querySelector('.hw-pen');
    var btnEraser = bar.querySelector('.hw-eraser');
    var btnClear = bar.querySelector('.hw-clear');
    var status = bar.querySelector('.hw-status');

    var available = false;   // 問題画面だけ true。ホーム・結果では書かせない
    var on = false, tool = 'pen', hasInk = false;
    var drawing = false, last = null, pointerId = null;

    function isControl(target) {
      return !!(target && target.closest && target.closest(opt.controlSelector));
    }

    function applyTool() {
      var erasing = tool === 'eraser';
      ctx.globalCompositeOperation = erasing ? 'destination-out' : 'source-over';
      ctx.lineWidth = erasing ? opt.eraserWidth : opt.penWidth;
      ctx.strokeStyle = opt.penColor;
      ctx.fillStyle = opt.penColor;   // 点打ちの fill() 用。未設定だと既定の黒が出る
    }

    function resize() {
      var dpr = global.devicePixelRatio || 1;
      var w = Math.max(1, Math.round(global.innerWidth * dpr));
      var h = Math.max(1, Math.round(global.innerHeight * dpr));
      if (canvas.width === w && canvas.height === h) return;   // 同サイズで再代入するとインクが消える

      var old = null;   // サイズ変更で canvas は白紙に戻るので退避する
      if (hasInk && canvas.width > 0 && canvas.height > 0) {
        try {
          old = document.createElement('canvas');
          old.width = canvas.width; old.height = canvas.height;
          old.getContext('2d').drawImage(canvas, 0, 0);
        } catch (e) { old = null; }
      }
      canvas.width = w; canvas.height = h;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      if (old) { try { ctx.drawImage(old, 0, 0, old.width, old.height, 0, 0, w, h); } catch (e) { /* 続行 */ } }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // 以後 CSS ピクセルで描ける
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      applyTool();
    }

    function stopStroke() { drawing = false; last = null; pointerId = null; }

    function updateUI() {
      var erasing = tool === 'eraser';
      btnPen.classList.toggle('is-active', on);
      btnPen.setAttribute('aria-pressed', String(on));
      btnPen.textContent = on ? opt.labels.penOn : opt.labels.penOff;

      btnEraser.disabled = !hasInk;
      btnEraser.classList.toggle('is-active', erasing);
      btnEraser.setAttribute('aria-pressed', String(erasing));
      btnEraser.textContent = erasing ? opt.labels.eraserOn : opt.labels.eraserOff;

      btnClear.disabled = !hasInk;   // 押しても何も起きないボタンは生徒を迷わせる
      btnClear.textContent = opt.labels.clear;

      status.textContent = erasing ? opt.labels.statusEraser : opt.labels.statusPen;
      status.classList.toggle('hw-hidden', !on);
      bar.classList.toggle('hw-hidden', !available);
      bar.style.display = available ? '' : 'none';
    }

    function setTool(next) { tool = next === 'eraser' ? 'eraser' : 'pen'; applyTool(); updateUI(); }

    function setMode(next) {
      on = !!next && available;
      canvas.classList.toggle('is-visible', on);
      if (!on) stopStroke(); else applyTool();
      updateUI();
    }

    // インクだけ消す。モードは維持し、消しゴム中なら鉛筆へ戻す。
    function clearInk() {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);   // 変形を壊さず全面消去
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
      hasInk = false;
      stopStroke();
      setTool('pen');
    }

    // 画面遷移用。インクを消してモードも閉じる。
    function reset(nextAvailable) { available = !!nextAvailable; clearInk(); setMode(false); }

    function onDown(e) {
      if (!on || e.button !== 0 || isControl(e.target)) return;
      drawing = true; pointerId = e.pointerId;
      last = { x: e.clientX, y: e.clientY };
      ctx.beginPath();
      ctx.arc(last.x, last.y, (tool === 'eraser' ? opt.eraserWidth : opt.penWidth) / 2, 0, Math.PI * 2);
      ctx.fill();
      hasInk = true; updateUI();
      e.preventDefault();
    }

    function onMove(e) {
      if (!drawing || e.pointerId !== pointerId) return;
      if (isControl(e.target)) { stopStroke(); return; }   // 途中で操作対象に入ったらやめる
      var p = { x: e.clientX, y: e.clientY };
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      last = p;
      hasInk = true; updateUI();
      e.preventDefault();
    }

    function onEnd(e) { if (e.pointerId === pointerId) stopStroke(); }

    btnPen.addEventListener('click', function () { setMode(!on); });
    btnEraser.addEventListener('click', function () {
      if (!hasInk) return;
      setMode(true);
      setTool(tool === 'eraser' ? 'pen' : 'eraser');
    });
    btnClear.addEventListener('click', clearInk);

    // capture フェーズで拾うのが肝。canvas は当たり判定を持たない。
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onEnd, true);
    document.addEventListener('pointercancel', onEnd, true);
    global.addEventListener('resize', resize);

    resize();
    updateUI();

    return {
      setAvailable: function (v) { available = !!v; if (!available) setMode(false); updateUI(); },
      setMode: setMode,
      setTool: setTool,
      clearInk: clearInk,
      reset: reset,
      isOn: function () { return on; },
      hasInk: function () { return hasInk; },
      // 検証用。不透明ピクセル数を返す。目視に頼らず「描けた／消えた」を確認できる。
      inkPixels: function () {
        var c = canvas.getContext('2d', { willReadFrequently: true });
        var d = c.getImageData(0, 0, canvas.width, canvas.height).data;
        var n = 0;
        for (var i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
        return n;
      },
      canvas: canvas,
      bar: bar
    };
  }

  global.initHandwriting = initHandwriting;
})(typeof window !== 'undefined' ? window : this);

// ES module で使う場合はこの行を有効にする:
// export const initHandwriting = window.initHandwriting;
