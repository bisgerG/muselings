/**
 * ar-game.js — MVP 核心迴圈狀態機
 * scanning → intro（登場對話）→ pet（撫摸互動）→ knowledge（科普對話）
 * → quiz（收服考驗）→ captured（收錄圖鑑）
 *
 * 精靈與文案由 data/muselings.json 總表驅動：
 * ar.html?spirit=<id>（預設 defaultSpirit），劇情內容在各精靈的 script JSON。
 */
(async function () {
  const THREE = window.AFRAME.THREE;

  // ===== 自訂 A-Frame 元件（須在掛載到實體前註冊） =====

  // 完整直立 billboard：以「螢幕上方」為上、面向相機（帶少許側身角度）。
  // 不管 Marker 平放、貼牆或旋轉，狐狸在畫面裡永遠站正。
  // 收到 'snapface' 事件時瞬間對正（初次登場用）。
  AFRAME.registerComponent('face-camera', {
    schema: { offsetDeg: { default: -20 }, lerp: { default: 0.08 } },
    init: function () {
      this.camPos = new THREE.Vector3();
      this.selfPos = new THREE.Vector3();
      this.camQuat = new THREE.Quaternion();
      this.parentQuat = new THREE.Quaternion();
      this.up = new THREE.Vector3();
      this.fwd = new THREE.Vector3();
      this.right = new THREE.Vector3();
      this.basis = new THREE.Matrix4();
      this.desired = new THREE.Quaternion();
      this.offsetQuat = new THREE.Quaternion();
      this.snap = false;
      this.el.addEventListener('snapface', () => { this.snap = true; });
    },
    tick: function () {
      const cam = this.el.sceneEl.camera;
      if (!cam) return;
      const obj = this.el.object3D;
      cam.getWorldPosition(this.camPos);
      cam.getWorldQuaternion(this.camQuat);
      obj.getWorldPosition(this.selfPos);
      this.up.set(0, 1, 0).applyQuaternion(this.camQuat);          // 螢幕的上方向
      this.fwd.copy(this.camPos).sub(this.selfPos);                // 指向相機
      this.fwd.addScaledVector(this.up, -this.fwd.dot(this.up));   // 投影到水平面（保持站直）
      if (this.fwd.lengthSq() < 1e-6) return;
      this.fwd.normalize();
      this.right.crossVectors(this.up, this.fwd).normalize();
      this.basis.makeBasis(this.right, this.up, this.fwd);         // +Z 朝相機
      this.desired.setFromRotationMatrix(this.basis);
      this.offsetQuat.setFromAxisAngle(this.up, THREE.MathUtils.degToRad(this.data.offsetDeg));
      this.desired.premultiply(this.offsetQuat);                   // 繞直立軸加側身角
      obj.parent.getWorldQuaternion(this.parentQuat).invert();
      this.desired.premultiply(this.parentQuat);                   // 世界 → 父層局部
      obj.quaternion.slerp(this.desired, this.snap ? 1 : this.data.lerp);
      this.snap = false;
    }
  });

  // 跟丟 Marker 後的漂移：兩種模式
  //  'camera' — 精靈掛到相機下，維持「跟丟當下的距離」（夾在安全範圍內）只把構圖
  //             移回畫面中下方；距離不變就不會有 zoom-in 感。scale 同步收斂回 1，
  //             洗掉 attach 時從 Marker 端帶過來的世界縮放。
  //  'anchor' — 重新掃到 Marker 後掛回錨點，local transform 平滑歸位後自動停用。
  AFRAME.registerComponent('float-drift', {
    init: function () {
      this.mode = null;
      this.targetPos = new THREE.Vector3();
      this.targetQuat = new THREE.Quaternion();
      this.targetScale = new THREE.Vector3(1, 1, 1);
    },
    startCameraFloat: function () {
      const d = THREE.MathUtils.clamp(this.el.object3D.position.length(), 2.0, 5.0);
      this.targetPos.set(0, -0.18 * d, -d); // 略低於畫面中心，距離維持 d
      this.targetQuat.identity();
      this.mode = 'camera';
    },
    startAnchorReturn: function () {
      this.targetPos.set(0, 0, 0);
      this.targetQuat.identity();
      this.mode = 'anchor';
    },
    tick: function () {
      if (!this.mode) return;
      const o = this.el.object3D;
      o.position.lerp(this.targetPos, 0.06);
      o.quaternion.slerp(this.targetQuat, 0.06);
      o.scale.lerp(this.targetScale, 0.06);
      // 位置/縮放/旋轉全部到位才算收斂；收斂即停用，
      // 不再每幀 lerp，也不會跟其他 scale 動畫（登場、收服縮小）互搶
      const settled =
        o.position.distanceToSquared(this.targetPos) < 1e-4 &&
        o.scale.distanceToSquared(this.targetScale) < 1e-4 &&
        Math.abs(o.quaternion.dot(this.targetQuat)) > 0.99995;
      if (!settled) return;
      o.position.copy(this.targetPos);
      o.quaternion.copy(this.targetQuat);
      o.scale.copy(this.targetScale);
      this.mode = null;
    }
  });

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
  const spiritYaw = document.getElementById('spirit-yaw');
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

  // 掛載自訂元件（元件已於上方註冊）
  spiritYaw.setAttribute('face-camera', '');
  spirit.setAttribute('float-drift', '');

  // --- 脫錨漂浮 / 回錨 ---
  // attach() 保留世界座標的代價是矩陣分解：子物件 scale≈0（登場縮放動畫尚未完成
  // 就跟丟）或新父層矩陣退化（MindAR 未追蹤時 anchor 是零矩陣）都會除以零產生
  // NaN，精靈會永久消失 → attach 後驗證數值，異常就直接歸位到安全起點，
  // 再由 float-drift 平滑長回原尺寸。
  const SCALE_EPS = 1e-3;
  function safeReparent(parentObj, obj, fallbackX, fallbackY, fallbackZ) {
    parentObj.attach(obj); // 嘗試保留當下世界座標
    const p = obj.position, q = obj.quaternion, s = obj.scale;
    const bad = ![p.x, p.y, p.z, q.x, q.y, q.z, q.w, s.x, s.y, s.z].every(isFinite) ||
      Math.min(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z)) < SCALE_EPS;
    if (bad) {
      obj.position.set(fallbackX, fallbackY, fallbackZ);
      obj.quaternion.identity();
      obj.scale.set(SCALE_EPS, SCALE_EPS, SCALE_EPS);
    }
  }

  function floatToCamera() {
    if (state === 'scanning' || state === 'captured') return;
    const drift = spirit.components['float-drift'];
    if (spirit.object3D.parent === cameraEl.object3D && drift.mode !== 'anchor') return;
    safeReparent(cameraEl.object3D, spirit.object3D, 0, -0.36, -2); // 再由 float-drift 平滑漂到定位
    drift.startCameraFloat();
  }

  function reanchorToMarker() {
    if (spirit.object3D.parent === anchor.object3D) return;
    safeReparent(anchor.object3D, spirit.object3D, 0, 0, 0);
    spirit.components['float-drift'].startAnchorReturn();
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
    spiritYaw.emit('snapface'); // 初次登場必定正面（帶側身角度）
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
    spirit.components['float-drift'].mode = null; // 凍結漂移，別跟收服縮小動畫互搶
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
  function onTargetFound() {
    scanLayerEl.classList.add('off');
    if (state === 'captured') return; // 已收服的精靈保持消失，不再回錨復活
    reanchorToMarker(); // 曾跟丟漂浮 → 平滑回錨歸位
    if (state === 'scanning') {
      startIntro();
    } else if (state === 'pet') {
      setHint(data.petPrompt);
    }
  }

  function onTargetLost() {
    if (state === 'scanning') {
      scanLayerEl.classList.remove('off');
    } else if (state !== 'captured') {
      // 觸發後跟丟 Marker：精靈漂到鏡頭前，任務繼續，不逼玩家停在原地
      floatToCamera();
    }
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
