/* ウーパールーパーの餌診断 — all processing stays on-device */
(() => {
  "use strict";

  // ---- screen switching ----
  const screens = {
    intro:   document.getElementById("screen-intro"),
    camera:  document.getElementById("screen-camera"),
    loading: document.getElementById("screen-loading"),
    result:  document.getElementById("screen-result"),
  };
  function show(name) {
    Object.values(screens).forEach(s => s.classList.remove("is-active"));
    screens[name].classList.add("is-active");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ---- elements ----
  const video    = document.getElementById("video");
  const canvas   = document.getElementById("canvas");
  const preview  = document.getElementById("preview");
  const camMsg   = document.getElementById("camMsg");
  const shutter  = document.getElementById("shutterBtn");
  const fileInput= document.getElementById("fileInput");
  const baitFace = document.getElementById("baitFace");

  let stream = null;
  let facingMode = "user";
  let lastShot = null; // dataURL of captured frame

  // =========================================================
  //  FACE DETECTION (MediaPipe Tasks Vision, lazy-loaded)
  // =========================================================
  const TV_VER   = "0.10.18";
  const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TV_VER}/wasm`;
  const MJS_URL  = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TV_VER}/vision_bundle.mjs`;
  // Face Landmarker gives both face presence AND expression blendshapes (smile)
  const MODEL_URL= "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

  let detector = null;
  let detectorState = "idle"; // idle | loading | ready | failed
  let detectorPromise = null;

  function ensureDetector() {
    if (detectorState === "ready" || detectorState === "failed") return detectorPromise || Promise.resolve();
    if (detectorPromise) return detectorPromise;
    detectorState = "loading";
    detectorPromise = (async () => {
      // dynamic import so a CDN failure never breaks the rest of the app
      const vision = await import(/* webpackIgnore: true */ MJS_URL);
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_URL);
      detector = await vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL },
        runningMode: "IMAGE",
        numFaces: 1,
        outputFaceBlendshapes: true,
      });
      detectorState = "ready";
    })().catch((e) => {
      console.warn("[face] detector unavailable:", e);
      detectorState = "failed";
    });
    return detectorPromise;
  }

  function loadImage(src) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = src;
    });
  }

  // 0 (neutral) … 1 (broad smile), from the mouthSmile blendshapes
  function smileScore(out) {
    const bs = out && out.faceBlendshapes && out.faceBlendshapes[0];
    if (!bs || !bs.categories) return 0;
    let l = 0, r = 0;
    for (const c of bs.categories) {
      if (c.categoryName === "mouthSmileLeft")  l = c.score;
      if (c.categoryName === "mouthSmileRight") r = c.score;
    }
    return (l + r) / 2;
  }

  // → { ok, smile, skipped }  (skipped = detector couldn't load → don't block)
  async function detectFace(dataUrl) {
    await ensureDetector();
    if (detectorState !== "ready") return { ok: true, smile: 0, skipped: true };
    try {
      const img = await loadImage(dataUrl);
      const out = detector.detect(img);
      const n = (out && out.faceLandmarks) ? out.faceLandmarks.length : 0;
      return { ok: n > 0, smile: smileScore(out), skipped: false };
    } catch (e) {
      console.warn("[face] detect failed:", e);
      return { ok: true, smile: 0, skipped: true };
    }
  }

  // =========================================================
  //  CAMERA
  // =========================================================
  let msgTimer = null;
  function setCamMsg(text, opts = {}) {
    if (msgTimer) { clearTimeout(msgTimer); msgTimer = null; }
    camMsg.innerHTML = text;
    camMsg.classList.remove("hide");
    if (opts.auto) msgTimer = setTimeout(() => camMsg.classList.add("hide"), opts.auto);
  }
  function hideCamMsg() {
    if (msgTimer) { clearTimeout(msgTimer); msgTimer = null; }
    camMsg.classList.add("hide");
  }

  async function startCamera() {
    stopCamera();
    setCamMsg("カメラを起動しています…");
    video.hidden = false;
    preview.hidden = true;
    shutter.disabled = true;
    ensureDetector(); // warm up the model while the user frames their face
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 1280 }, height: { ideal: 1280 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play().catch(() => {});
      hideCamMsg();
      shutter.disabled = false;
    } catch (err) {
      setCamMsg("カメラを利用できませんでした。<br>🖼️ から画像を選んでください。");
      shutter.disabled = true;
    }
  }
  function stopCamera() {
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  }

  // capture current video frame -> dataURL (mirrored to match preview)
  function captureFrame() {
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return null;
    const side = Math.min(w, h);
    canvas.width = side; canvas.height = side;
    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.translate(side, 0); ctx.scale(-1, 1); // mirror like the live view
    ctx.drawImage(video, (w - side) / 2, (h - side) / 2, side, side, 0, 0, side, side);
    ctx.restore();
    return canvas.toDataURL("image/jpeg", 0.85);
  }

  // gatekeeper: must find a face before diagnosing
  async function handleCapture(dataUrl) {
    if (!dataUrl) { setCamMsg("画像を取得できませんでした。", { auto: 3000 }); return; }
    shutter.disabled = true;
    setCamMsg("顔を確認しています…");
    const r = await detectFace(dataUrl);
    shutter.disabled = false;
    if (!r.ok) {
      setCamMsg("顔が検出できませんでした。<br>顔がはっきり写るように撮影してください。", { auto: 4000 });
      return;
    }
    if (r.skipped) console.info("[face] detection skipped (offline?) — diagnosing anyway");
    hideCamMsg();
    runDiagnosis(dataUrl, r.smile);
  }

  // =========================================================
  //  DIAGNOSIS (random, never reproducible)
  // =========================================================
  const METRICS = [
    { key: "栄養価",          cls: "c" },
    { key: "捕食成功率",      cls: "c" },
    { key: "食べやすさ",      cls: "c" },
    { key: "好感度",          cls: "a" },
    { key: "本日のおすすめ度", cls: "g" },
  ];
  const VERDICTS = [
    { sub: "なかなか良さそうです。",       lo: 55 },
    { sub: "ぎりぎり許容範囲です。",       lo: 35, hi: 55 },
    { sub: "今日はやめておきましょう。",   hi: 35 },
    { sub: "とても優秀な餌です。",         lo: 75 },
    { sub: "気分次第といったところです。", lo: 30, hi: 70 },
  ];
  const rnd = (lo, hi) => Math.floor(lo + Math.random() * (hi - lo + 1));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Rare easter egg: the axolotl loses its temper and trash-talks you (food-themed teasing).
  const RANT_CHANCE = 0.013; // ≈ 1 / 77
  const RANTS = [
    "は？こんなのが餌？ナメてんのか。",
    "うわ……まっず。持って帰ってくれ。",
    "餌のくせに、こっちを観察してくるな。",
    "こんなの食えるか。出直してこい。",
    "正直、見た目で食欲が失せたわ。",
    "二度と水槽の前に立つな。",
    "お前、餌としても三流だな。",
  ];

  // Hidden rule: the more you smile, the worse a meal you make.
  // Neutral faces score high, broad smiles score low — with per-take jitter kept.
  function makeResult(smile = 0) {
    const s = clamp(smile, 0, 1);
    const shift = Math.round((0.22 - s) * 110); // neutral ≈ +24, broad smile ≈ -85
    const scores = METRICS.map(m => ({ ...m, val: clamp(rnd(28, 76) + shift + rnd(-7, 7), 4, 98) }));
    const avg = Math.round(scores.reduce((a, s2) => a + s2.val, 0) / scores.length);
    const fit = VERDICTS.filter(v => avg >= (v.lo ?? 0) && avg <= (v.hi ?? 100));
    const pool = fit.length ? fit : VERDICTS;
    const verdict = pool[rnd(0, pool.length - 1)];
    const rant = Math.random() < RANT_CHANCE ? RANTS[rnd(0, RANTS.length - 1)] : null;
    return { scores, avg, verdict, rant };
  }

  function renderResult(r) {
    const vMain = document.getElementById("verdictMain");
    const vSub = document.getElementById("verdictSub");
    if (r.rant) {
      vMain.textContent = "ウーパールーパーが吐き捨てた…";
      vSub.textContent = r.rant;
      vSub.classList.add("rant");
    } else {
      vMain.textContent = "今日の餌として…";
      vSub.textContent = r.verdict.sub;
      vSub.classList.remove("rant");
    }

    const bars = document.getElementById("bars");
    bars.innerHTML = "";
    r.scores.forEach((s, i) => {
      const row = document.createElement("div");
      row.className = "bar-row";
      row.innerHTML =
        `<span class="lbl">${s.key}</span>` +
        `<div class="track"><div class="fill ${s.cls}"></div></div>` +
        `<span class="pct">${s.val}%</span>`;
      bars.appendChild(row);
      requestAnimationFrame(() => {
        setTimeout(() => { row.querySelector(".fill").style.width = s.val + "%"; }, 120 + i * 120);
      });
    });

    const scene = document.getElementById("baitScene");
    if (lastShot) { baitFace.src = lastShot; scene.style.display = ""; }
    else { scene.style.display = "none"; }

    renderComparison(r);

    window._lastResult = r;
  }

  // =========================================================
  //  赤虫との栄養比較 — you always fall short of a bloodworm
  // =========================================================
  const COMPARE = ["たんぱく質", "消化のよさ", "手軽さ", "コスパ", "食いつき"];
  // closing lines, grouped by how badly you lost — one is picked at random
  const CMP_MSGS = {
    high: [
      "完敗。あなたは餌としても、赤虫の足元にも及びません。",
      "全項目で惨敗。ウーパールーパーは見向きもしないでしょう。",
      "赤虫の圧勝。あなたは水槽に落ちても無視される存在です。",
      "話になりません。赤虫を見習ってから出直してください。",
      "栄養も食いつきも完敗。あなたの価値は赤虫一匹以下でした。",
      "ぐうの音も出ない大敗。餌を名乗るのはおこがましいレベルです。",
    ],
    mid: [
      "赤虫に遠く及ばず。ウーパールーパーが選ぶのは、やっぱり赤虫です。",
      "健闘むなしく敗北。あと一歩どころか、まだまだ赤虫には遠いです。",
      "赤虫のほうが優秀でした。あなたが主食になる未来は見えません。",
      "残念、赤虫の勝ち。冷凍庫の赤虫にすら勝てませんでした。",
      "赤虫に軍配。あなたは非常用のさらに予備、といったところです。",
      "力及ばず。ウーパールーパーの前では、赤虫の引き立て役です。",
    ],
    low: [
      "赤虫の勝ち。あなたが選ばれる日は、当分来なさそうです。",
      "惜しくも赤虫に届かず。選ばれるにはまだ何かが足りません。",
      "接戦ながら赤虫の勝ち。あと少しの努力が、餌としては致命的でした。",
      "僅差で敗北。それでも、赤虫が選ばれることに変わりはありません。",
      "赤虫にリード許す。あなたの出番は、赤虫が売り切れた日だけかも。",
      "赤虫優勢。今日のところは、おかず未満で終わりました。",
    ],
  };
  function renderComparison(r) {
    const rows = COMPARE.map(name => {
      const worm = rnd(80, 96);
      // your value is tied to the diagnosis, but capped safely below the bloodworm
      const you = clamp(rnd(10, Math.max(16, Math.round(r.avg * 0.7))), 4, worm - 6);
      return { name, you, worm };
    });
    const wins = rows.filter(c => c.you > c.worm).length;   // ≈ 0, on purpose
    const losses = rows.length - wins;
    const gap = Math.round(rows.reduce((a, c) => a + (c.worm - c.you), 0) / rows.length);
    const shame = clamp(gap + rnd(-3, 3), 40, 99);
    const pool = shame >= 80 ? CMP_MSGS.high : shame >= 60 ? CMP_MSGS.mid : CMP_MSGS.low;
    const msg = pool[rnd(0, pool.length - 1)];

    const box = document.getElementById("cmpRows");
    box.innerHTML = "";
    rows.forEach((c, i) => {
      const row = document.createElement("div");
      row.className = "cmp-row";
      row.innerHTML =
        `<div class="cmp-name">${c.name}</div>` +
        `<div class="cmp-line"><span class="cmp-who">あなた</span>` +
          `<div class="cmp-track"><div class="cmp-fill you"></div></div><span class="cmp-val">${c.you}%</span></div>` +
        `<div class="cmp-line"><span class="cmp-who">赤虫</span>` +
          `<div class="cmp-track"><div class="cmp-fill worm"></div></div><span class="cmp-val">${c.worm}%</span></div>`;
      box.appendChild(row);
      const [youFill, wormFill] = row.querySelectorAll(".cmp-fill");
      requestAnimationFrame(() => setTimeout(() => {
        youFill.style.width = c.you + "%";
        wormFill.style.width = c.worm + "%";
      }, 200 + i * 130));
    });

    document.getElementById("cmpScore").textContent = `赤虫 ${losses}勝 ${wins}敗`;
    document.getElementById("cmpShame").textContent = `ふがいなさ ${shame}%`;
    document.getElementById("cmpMsg").textContent = msg;

    r.compare = { rows, wins, losses, shame, msg };
  }

  // =========================================================
  //  SHARE IMAGE (drawn on a canvas, saved/shared on-device)
  // =========================================================
  const COLORS = {
    c: ["#ec8090", "#e36f80"],
    a: ["#f0cd84", "#e6b85c"],
    g: ["#9fd0ad", "#7fb98f"],
  };
  function roundRect(ctx, x, y, w, h, r) {
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // the axolotl artwork (u-pa.png), faces right — same asset used across the page
  let _axoImg = null;
  function axolotlImage() {
    if (!_axoImg) _axoImg = loadImage("u-pa.png");
    return _axoImg;
  }

  async function buildShareCanvas(r, photo) {
    const W = 720, H = 1080, S = 2;
    const cv = document.createElement("canvas");
    cv.width = W * S; cv.height = H * S;
    const ctx = cv.getContext("2d");
    ctx.scale(S, S);

    // background
    ctx.fillStyle = "#eef0fb"; ctx.fillRect(0, 0, W, H);
    roundRect(ctx, 24, 24, W - 48, H - 48, 28); ctx.fillStyle = "#ffffff"; ctx.fill();

    // header band
    const band = ctx.createLinearGradient(0, 0, W, 0);
    band.addColorStop(0, "#6a67d6"); band.addColorStop(1, "#8f6fd0");
    roundRect(ctx, 24, 24, W - 48, 96, 28); ctx.fillStyle = band; ctx.fill();
    ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = "bold 30px 'Hiragino Kaku Gothic ProN','Yu Gothic UI',sans-serif";
    ctx.fillText("ウーパールーパーの餌診断", W / 2, 24 + 52);

    // bait scene: your face turned into food, with the axolotl approaching
    let photoBottom = 150;
    {
      const sx = 56, sy = 140, sw = W - 112, sh = 220;
      // water
      const water = ctx.createLinearGradient(0, sy, 0, sy + sh);
      water.addColorStop(0, "#bfe9f3"); water.addColorStop(.55, "#8fcfe1"); water.addColorStop(1, "#5fb0cb");
      ctx.save();
      roundRect(ctx, sx, sy, sw, sh, 20); ctx.clip();
      ctx.fillStyle = water; ctx.fillRect(sx, sy, sw, sh);
      ctx.fillStyle = "rgba(233,217,176,.9)"; ctx.fillRect(sx, sy + sh - 22, sw, 22); // sand
      // bubbles
      ctx.fillStyle = "rgba(255,255,255,.5)";
      [[120,70,7],[170,130,5],[110,150,4],[300,100,6]].forEach(([bx,by,br]) =>
        { ctx.beginPath(); ctx.arc(sx + bx, sy + by, br, 0, Math.PI * 2); ctx.fill(); });
      // axolotl on the left, facing the pellet
      try {
        const axo = await axolotlImage();
        const aw = 150, ah = aw * 190 / 300;
        ctx.drawImage(axo, sx + 14, sy + (sh - ah) / 2, aw, ah);
      } catch { /* ignore */ }
      // pellet (your face) on the right
      const ps = 132, px = sx + sw - ps - 26, py = sy + (sh - ps) / 2;
      if (photo) {
        try {
          const img = await loadImage(photo);
          ctx.save();
          ctx.beginPath(); ctx.arc(px + ps / 2, py + ps / 2, ps / 2, 0, Math.PI * 2); ctx.clip();
          const s = Math.min(img.width, img.height);
          ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, px, py, ps, ps);
          ctx.restore();
        } catch { /* ignore */ }
      }
      ctx.lineWidth = 6; ctx.strokeStyle = "#c98a4a";
      ctx.beginPath(); ctx.arc(px + ps / 2, py + ps / 2, ps / 2, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,255,255,.7)";
      ctx.beginPath(); ctx.arc(px + ps / 2, py + ps / 2, ps / 2 + 4, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      // "今日の餌" tag
      ctx.fillStyle = "rgba(255,255,255,.92)";
      roundRect(ctx, sx + sw - 96, sy + 12, 84, 26, 13); ctx.fill();
      ctx.fillStyle = "#c2563f"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.font = "bold 15px 'Hiragino Kaku Gothic ProN',sans-serif";
      ctx.fillText("今日の餌", sx + sw - 54, sy + 25);
      photoBottom = sy + sh;
    }

    // verdict (rare rant overrides the normal line)
    ctx.textAlign = "center";
    ctx.fillStyle = "#5a5a68";
    ctx.font = "16px 'Hiragino Kaku Gothic ProN',sans-serif";
    ctx.fillText(r.rant ? "ウーパールーパーの本音…" : "あなたは… 今日の餌として…", W / 2, photoBottom + 40);
    ctx.fillStyle = r.rant ? "#c0392b" : "#e36f80";
    ctx.font = "bold 26px 'Hiragino Kaku Gothic ProN',sans-serif";
    ctx.fillText(r.rant || r.verdict.sub, W / 2, photoBottom + 78);

    // bars
    const bx = 80, bw = W - 160, trackX = bx + 150, trackW = bw - 150;
    let by = photoBottom + 140;
    ctx.textBaseline = "middle";
    r.scores.forEach((sc) => {
      ctx.textAlign = "left";
      ctx.fillStyle = "#2b2b33";
      ctx.font = "17px 'Hiragino Kaku Gothic ProN',sans-serif";
      ctx.fillText(sc.key, bx, by);
      // track
      roundRect(ctx, trackX, by - 7, trackW, 14, 7); ctx.fillStyle = "#ececf2"; ctx.fill();
      // fill
      const cc = COLORS[sc.cls] || COLORS.c;
      const g = ctx.createLinearGradient(trackX, 0, trackX + trackW, 0);
      g.addColorStop(0, cc[0]); g.addColorStop(1, cc[1]);
      roundRect(ctx, trackX, by - 7, Math.max(14, trackW * sc.val / 100), 14, 7);
      ctx.fillStyle = g; ctx.fill();
      // pct
      ctx.textAlign = "right";
      ctx.fillStyle = "#2b2b33";
      ctx.font = "bold 17px 'Hiragino Kaku Gothic ProN',sans-serif";
      ctx.fillText(sc.val + "%", W - 80, by);
      by += 56;
    });

    // 赤虫との比較（ふがいなさ）
    if (r.compare) {
      ctx.textAlign = "center";
      ctx.fillStyle = "#a01f2e";
      ctx.font = "bold 20px 'Hiragino Kaku Gothic ProN',sans-serif";
      ctx.fillText(`赤虫に ${r.compare.losses}敗 ／ ふがいなさ ${r.compare.shame}%`, W / 2, by + 8);
    }

    // footer
    ctx.textAlign = "center";
    ctx.fillStyle = "#9a9aae";
    ctx.font = "13px 'Hiragino Kaku Gothic ProN',sans-serif";
    ctx.fillText("※評価基準は一切不明で、結果も毎回変化します。", W / 2, H - 78);
    ctx.fillText("ウーパールーパーの餌になるWebサイト —「役に立たない機械」", W / 2, H - 54);

    return cv;
  }

  function canvasToBlob(cv) {
    return new Promise((res) => cv.toBlob(res, "image/png"));
  }
  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  async function shareImage() {
    const r = window._lastResult;
    if (!r) return;
    const btn = document.getElementById("shareBtn");
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = "画像を作成中…";
    try {
      const cv = await buildShareCanvas(r, lastShot);
      const blob = await canvasToBlob(cv);
      const file = new File([blob], "upa-esa-shindan.png", { type: "image/png" });
      const text = r.rant
        ? `ウーパールーパーに暴言を吐かれた：「${r.rant}」 #ウーパールーパーの餌診断`
        : `今日の餌として${r.verdict.sub}（総合${r.avg}%）#ウーパールーパーの餌診断`;
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text });
        btn.textContent = old;
      } else {
        downloadBlob(blob, "upa-esa-shindan.png");
        btn.textContent = "画像を保存しました";
        setTimeout(() => (btn.textContent = old), 1800);
      }
    } catch (e) {
      console.warn(e);
      btn.textContent = old;
    } finally {
      btn.disabled = false;
    }
  }

  // =========================================================
  //  FLOW
  // =========================================================
  // ドキドキタイム: building-tension messages shown between the shot and the result
  const SUSPENSE_LINES = [
    "ウーパールーパーが気づいた…",
    "そろそろと近づいてくる…",
    "じーっと観察している…",
    "餌として品定め中…",
    "まもなく判定が出ます…！",
  ];
  function runDiagnosis(dataUrl, smile = 0) {
    lastShot = dataUrl || null;
    stopCamera();

    // show the captured face as the pellet being inspected
    const loadFace = document.getElementById("loadFace");
    if (lastShot) loadFace.src = lastShot;
    const heart = document.getElementById("heart");
    heart.classList.remove("fast");

    show("loading");

    const loadText = document.getElementById("loadText");
    let i = 0;
    loadText.textContent = SUSPENSE_LINES[0];
    const timer = setInterval(() => {
      i = Math.min(i + 1, SUSPENSE_LINES.length - 1);
      loadText.textContent = SUSPENSE_LINES[i];
      loadText.style.animation = "none"; void loadText.offsetWidth; loadText.style.animation = ""; // re-trigger pop
    }, 780);

    // climax: heartbeat races near the end
    const climax = setTimeout(() => heart.classList.add("fast"), 2600);

    setTimeout(() => {
      clearInterval(timer);
      clearTimeout(climax);
      renderResult(makeResult(smile));
      show("result");
    }, 4000);
  }

  // =========================================================
  //  EVENTS
  // =========================================================
  document.getElementById("startBtn").addEventListener("click", () => { show("camera"); startCamera(); });
  document.getElementById("closeCam").addEventListener("click", () => { stopCamera(); show("intro"); });
  document.getElementById("switchBtn").addEventListener("click", () => {
    facingMode = facingMode === "user" ? "environment" : "user";
    startCamera();
  });
  shutter.addEventListener("click", () => handleCapture(captureFrame()));
  fileInput.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => handleCapture(reader.result);
    reader.readAsDataURL(file);
    fileInput.value = "";
  });
  document.getElementById("retryBtn").addEventListener("click", () => { show("camera"); startCamera(); });
  document.getElementById("closeResult").addEventListener("click", () => show("intro"));
  document.getElementById("shareBtn").addEventListener("click", shareImage);

  // about modal
  const modal = document.getElementById("aboutModal");
  document.getElementById("aboutBtn").addEventListener("click", () => (modal.hidden = false));
  document.getElementById("closeAbout").addEventListener("click", () => (modal.hidden = true));
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.hidden = true; });

  window.addEventListener("pagehide", stopCamera);
})();
