/**
 * ar-game.js — MVP 核心迴圈狀態機
 * scanning → intro（登場對話）→ pet（撫摸互動）→ knowledge（科普對話）
 * → quiz（收服考驗）→ captured（收錄圖鑑）
 *
 * 精靈與文案由 data/muselings.json 總表驅動：
 * ar.html?spirit=<id>（預設 defaultSpirit），劇情內容在各精靈的 script JSON。
 *
 * 呈現方式：Marker 只當「觸發器」——掃描到的瞬間，精靈就從 marker 錨點
 * 改掛到相機下、釘在畫面中央正面朝向玩家（無俯仰角）。之後不管 marker
 * 是否還在畫面裡、相機怎麼移動，精靈都穩定置中，直到收服縮小消失。
 */
(async function () {

  // --- DOM（資料載入前就緒，錯誤 UI 與 AR 事件監聽都依賴這些） ---
  const hintEl = document.getElementById('hint');
  const dialogEl = document.getElementById('dialog');
  const dialogNameEl = document.getElementById('dialog-name');
  const dialogTextEl = document.getElementById('dialog-text');
  const dialogNextEl = document.getElementById('dialog-next');
  const quizEl = document.getElementById('quiz');
  const quizQuestionEl = document.getElementById('quiz-question');
  const quizOptionsEl = document.getElementById('quiz-options');
  const heartsEl = document.getElementById('hearts');
  const capturedPanelEl = document.getElementById('captured-panel');
  const capturedTextEl = document.getElementById('captured-text');
  const flashEl = document.getElementById('flash');
  const loadingLayerEl = document.getElementById('loading-layer');
  const loadingTextEl = loadingLayerEl.querySelector('.loading-text');
  const retryBtnEl = document.getElementById('retry-btn');
  const scanLayerEl = document.getElementById('scan-layer');

  const anchor = document.getElementById('anchor');
  const spirit = document.getElementById('spirit');
  const spiritModel = document.getElementById('spirit-model');
  const sceneEl = document.querySelector('a-scene');
  const cameraEl = document.querySelector('a-camera');

  let UI = {}; // muselings.json 的 ui 字串表（載入前先空物件，錯誤路徑有 fallback）

  function fmt(tpl, vars) {
    return (tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null) ? vars[k] : m);
  }

  // --- 自製時光羅盤 UI：AR 引擎就緒後收起載入層、亮起尋標環 ---
  // 監聽必須在任何 await 之前註冊，避免錯過 MindAR 的事件
  let fatalLoadError = false;
  sceneEl.addEventListener('arReady', () => {
    if (fatalLoadError) return; // 資料載入失敗時錯誤畫面優先，不被相機就緒淡出
    loadingLayerEl.classList.add('off');
    scanLayerEl.classList.remove('off');
  });
  sceneEl.addEventListener('arError', () => {
    if (fatalLoadError) return; // 同上：載入失敗的訊息優先
    loadingTextEl.textContent = UI.arError || '羅盤失靈了……請確認相機權限後重新整理';
  });

  // Marker 追蹤事件可能發生在資料載入完成前（玩家已先對準圖騰）——
  // 先用旗標記錄目前是否對到 marker，資料就緒後回放；正式邏輯在 onTargetFound/Lost。
  let targetVisible = false;
  let gameReady = false;
  anchor.addEventListener('targetFound', () => {
    targetVisible = true;
    if (gameReady) onTargetFound();
  });
  anchor.addEventListener('targetLost', () => {
    targetVisible = false;
    if (gameReady) onTargetLost();
  });

  // ?uidebug：不開相機也能檢視掃描層視覺（開發用）
  if (location.search.indexOf('uidebug') !== -1) {
    loadingLayerEl.classList.add('off');
    scanLayerEl.classList.remove('off');
  }

  // --- 載入總表與精靈劇本 ---
  async function fetchJson(url) {
    // no-cache：強制向伺服器驗證，策展人改完 JSON 不用等瀏覽器快取過期
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(url + ' → HTTP ' + res.status);
    return res.json();
  }

  let entry, data;
  try {
    const registry = await fetchJson('data/muselings.json');
    UI = registry.ui || {};
    const spiritId = new URLSearchParams(location.search).get('spirit') || registry.defaultSpirit;
    entry = registry.muselings.find(m => m.id === spiritId);
    if (!entry) throw new Error('unknown spirit: ' + spiritId);
    if (entry.comingSoon) {
      // 尚未開放的精靈：擋掉分享網址直開，避免對著空氣玩完還解鎖圖鑑
      fatalLoadError = true;
      loadingTextEl.textContent = UI.comingSoonError || '這隻博物之靈還在沉睡，展區尚未開放……';
      return;
    }
    document.title = 'AR 任務｜' + entry.zone;
    // 先掛模型 src，讓 834KB 的 GLB 與後續劇本下載並行，縮短登場時的隱形空窗
    if (entry.model) spiritModel.setAttribute('src', entry.model);
    data = await fetchJson(entry.script);
  } catch (e) {
    console.error('[ar-game] 資料載入失敗', e);
    fatalLoadError = true;
    loadingLayerEl.classList.remove('off');
    loadingTextEl.textContent = UI.loadError || '資料載入失敗了……請檢查網路連線後再試一次';
    retryBtnEl.classList.remove('hidden');
    return;
  }

  // --- 釘到畫面中央 ---
  // 掃描到的瞬間把精靈改掛到相機下：完全螢幕空間穩定、正面朝向玩家（無俯仰角）。
  //
  // 重要：MindAR 的世界單位是「marker 影像的像素尺度」——錨點矩陣帶著數百倍的
  // 縮放、投影矩陣的近裁剪面也在那個尺度。所以釘選的距離/大小不能寫死，
  // 必須在掃到當下從錨點矩陣取縮放（S）、從投影矩陣取 cot(fov/2)，
  // 反推出「精靈高度固定佔畫面 45%」所需的 scale——與裝置 FOV、marker 尺寸無關。
  const THREE = window.AFRAME.THREE;
  const SCREEN_HEIGHT_FRACTION = 0.45; // 精靈佔畫面高度比例
  const Y_OFFSET_FRACTION = 0.20;      // 腳掌位置：畫面中心往下 20%
  let pinScale = 1;                    // 釘選當下算出的目標縮放，動畫都以它為基準

  function pinToCamera() {
    const o = spirit.object3D;
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), sv = new THREE.Vector3();
    anchor.object3D.updateWorldMatrix(true, false);
    anchor.object3D.matrixWorld.decompose(p, q, sv);
    let S = (Math.abs(sv.x) + Math.abs(sv.y) + Math.abs(sv.z)) / 3; // MindAR 錨點縮放
    if (!isFinite(S) || S < 1e-6) S = 1;                            // 無 MindAR（測試）時退回 1
    const d = 3 * S; // 固定放在「3 個 marker 寬」的距離，透視感自然且遠離近裁剪面

    const cam3 = sceneEl.camera;
    let invTan = (cam3 && cam3.projectionMatrix) ? cam3.projectionMatrix.elements[5] : 0;
    if (!isFinite(invTan) || invTan <= 0) invTan = 1.19; // cot(40°)＝FOV 80 的預設值

    const modelHeight = entry.arHeight || 0.5; // 模型在 spirit 座標系的身高（總表可調）
    pinScale = (SCREEN_HEIGHT_FRACTION * 2 * d) / (invTan * modelHeight);

    cameraEl.object3D.add(o);
    o.position.set(0, -(Y_OFFSET_FRACTION * 2 * d) / invTan, -d);
    o.quaternion.identity();

    // scale 動畫走 A-Frame 屬性系統，全部以 pinScale 為基準重設
    spirit.setAttribute('scale', '0 0 0'); // 從 0 長出（animation__in 在 startIntro 觸發）
    spirit.setAttribute('animation__pet',
      'property: scale; from: ' + v3(pinScale) + '; to: ' + v3(pinScale * 1.12) +
      '; dir: alternate; loop: 2; dur: 120; easing: easeOutQuad; startEvents: petted');
    spirit.setAttribute('animation__capture',
      'property: scale; to: ' + v3(pinScale * 0.01) +
      '; dur: 900; easing: easeInBack; startEvents: capture');
  }

  function v3(s) { return s + ' ' + s + ' ' + s; }

  // --- 模型動畫剪輯（名稱用萬用字元比對 GLB 內的 clip） ---
  const CLIP_IDLE = '*smell*';
  const CLIP_PET = '*shake*';
  const CLIP_CAPTURE = '*jump*';

  function playClipOnce(clip) {
    spiritModel.setAttribute('animation-mixer',
      'clip: ' + clip + '; loop: once; clampWhenFinished: true; crossFadeDuration: 0.25');
  }

  function playIdle() {
    spiritModel.setAttribute('animation-mixer',
      'clip: ' + CLIP_IDLE + '; crossFadeDuration: 0.25');
  }

  // 單次動畫播完自動回 idle（收服後除外）
  spiritModel.addEventListener('animation-finished', () => {
    if (state !== 'captured') playIdle();
  });

  // --- 狀態 ---
  let state = 'scanning';
  let affinity = 0;
  let lines = [];          // 待播對話
  let onDialogDone = null; // 對話播完的 callback
  let typing = null;       // 打字機計時器
  let fullLine = '';

  function setHint(text) {
    hintEl.textContent = text || '';
    hintEl.classList.toggle('hidden', !text);
  }

  // --- 對話框（打字機效果） ---
  function showDialog(newLines, done, speaker) {
    lines = newLines.slice();
    onDialogDone = done || null;
    dialogNameEl.textContent = speaker || data.name;
    dialogEl.classList.remove('hidden');
    nextLine();
  }

  function nextLine() {
    if (typing) { // 正在打字 → 先直接顯示整行
      clearInterval(typing);
      typing = null;
      dialogTextEl.textContent = fullLine;
      dialogNextEl.classList.remove('hidden');
      return;
    }
    if (lines.length === 0) {
      dialogEl.classList.add('hidden');
      const done = onDialogDone;
      onDialogDone = null;
      if (done) done();
      return;
    }
    fullLine = lines.shift();
    dialogTextEl.textContent = '';
    dialogNextEl.classList.add('hidden');
    let i = 0;
    typing = setInterval(() => {
      dialogTextEl.textContent = fullLine.slice(0, ++i);
      if (i >= fullLine.length) {
        clearInterval(typing);
        typing = null;
        dialogNextEl.classList.remove('hidden');
      }
    }, 45);
  }

  dialogEl.addEventListener('click', nextLine);

  // --- 撫摸好感度 ---
  function renderHearts() {
    heartsEl.textContent = '❤️'.repeat(affinity) + '🤍'.repeat(Math.max(0, data.petCount - affinity));
  }

  // --- 階段流程 ---
  function startIntro() {
    state = 'intro';
    setHint('');
    spirit.setAttribute('animation__in',
      'property: scale; from: 0 0 0; to: ' + v3(pinScale) + '; dur: 700; easing: easeOutBack');
    showDialog(data.intro, startPetPhase);
  }

  function startPetPhase() {
    state = 'pet';
    setHint(data.petPrompt);
    heartsEl.classList.remove('hidden');
    renderHearts();
  }

  function onSpiritClicked() {
    if (state !== 'pet') return;
    spirit.emit('petted');
    playClipOnce(CLIP_PET);
    affinity++;
    renderHearts();
    const reaction = data.petReactions[Math.min(affinity, data.petReactions.length) - 1];
    if (affinity >= data.petCount) {
      setHint('');
      showDialog([reaction].concat(data.knowledge), startQuiz);
      state = 'knowledge';
    } else {
      setHint(reaction);
    }
  }

  // 點擊事件會從被點到的幾何體冒泡到 #spirit
  spirit.addEventListener('click', onSpiritClicked);

  // --- 收服考驗：選項每次洗牌，連錯兩次先重播知識點再重出題 ---
  let quizWrongCount = 0;

  function startQuiz() {
    state = 'quiz';
    quizQuestionEl.textContent = data.quiz.question;
    quizOptionsEl.innerHTML = '';
    const order = data.quiz.options.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) { // Fisher-Yates
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    order.forEach(origIdx => {
      const btn = document.createElement('button');
      btn.className = 'quiz-btn';
      btn.textContent = data.quiz.options[origIdx];
      btn.addEventListener('click', () => answer(origIdx));
      quizOptionsEl.appendChild(btn);
    });
    quizEl.classList.remove('hidden');
  }

  function answer(origIdx) {
    quizEl.classList.add('hidden');
    if (origIdx === data.quiz.answer) {
      quizWrongCount = 0;
      capture();
      return;
    }
    quizWrongCount++;
    if (quizWrongCount >= 2) {
      quizWrongCount = 0;
      showDialog([data.quiz.wrongHint],
        () => showDialog(data.knowledge, startQuiz),
        UI.guideName);
    } else {
      showDialog([data.quiz.wrongHint], startQuiz, UI.guideName);
    }
  }

  function capture() {
    state = 'captured';
    flashEl.classList.add('flash-on');
    playClipOnce(CLIP_CAPTURE);
    spirit.emit('capture');
    MuselingSave.unlock(entry.id, { affinity: affinity, name: entry.name, species: entry.species, zone: entry.zone });

    setTimeout(() => {
      flashEl.classList.remove('flash-on');
      showDialog([data.quiz.correct, data.captured, data.nextHint], () => {
        capturedTextEl.textContent = fmt(UI.capturedLabel, entry) ||
          (entry.name + '（' + entry.species + '）已收錄！');
        capturedPanelEl.classList.remove('hidden');
      });
    }, 1000);
  }

  // --- MindAR 追蹤事件（實際處理；stub 監聽已於載入前註冊並記錄狀態） ---
  // Marker 純粹是觸發器：第一次掃描到就把精靈釘到畫面中央開始劇情，
  // 之後 marker 的出現/消失一律不影響已在進行的任務。
  function onTargetFound() {
    scanLayerEl.classList.add('off');
    if (state !== 'scanning') return;
    pinToCamera();
    startIntro();
  }

  function onTargetLost() {
    if (state === 'scanning') scanLayerEl.classList.remove('off');
  }

  // 已收服過 → 直接提示（重複遊玩仍可再互動，僅提示已收錄）
  if (MuselingSave.isUnlocked(entry.id)) {
    setHint(fmt(UI.alreadyCaptured, entry) ||
      ('你已收服過' + entry.name + '囉！對準圖騰可以再找牠玩。'));
  }

  // 資料就緒：回放載入期間發生的辨識事件（玩家可能早就對準了圖騰）
  gameReady = true;
  if (targetVisible) onTargetFound();
})();
