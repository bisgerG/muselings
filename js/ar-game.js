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
    const res = await fetch(url);
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
  // 掃描到的瞬間把精靈改掛到相機下的固定位置：完全螢幕空間穩定、
  // 正面朝向玩家（identity 旋轉 = 無俯仰角），marker 之後的去留都不影響。
  const PIN_POS = { x: 0, y: -0.45, z: -1.6 };
  function pinToCamera() {
    const o = spirit.object3D;
    cameraEl.object3D.add(o);
    o.position.set(PIN_POS.x, PIN_POS.y, PIN_POS.z);
    o.quaternion.identity();
    o.scale.set(0.001, 0.001, 0.001); // 由登場動畫（animation__in）放大到 1
  }

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
    spirit.setAttribute('animation__in', 'property: scale; to: 1 1 1; dur: 700; easing: easeOutBack');
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
