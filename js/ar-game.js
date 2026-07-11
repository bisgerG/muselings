/**
 * ar-game.js — MVP 核心迴圈狀態機
 * scanning → intro（登場對話）→ pet（撫摸互動）→ knowledge（科普對話）
 * → quiz（默契測驗）→ captured（分身住進日誌）
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

  // --- ?debug 除錯疊層：手機上直接看關鍵數值（螢幕左上角） ---
  let debugEl = null;
  let debugLines = [];
  if (location.search.indexOf('debug') !== -1) {
    debugEl = document.createElement('pre');
    debugEl.style.cssText = 'position:fixed;top:60px;left:8px;z-index:999;margin:0;' +
      'padding:6px 8px;max-width:92vw;overflow:hidden;font-size:10px;line-height:1.5;' +
      'background:rgba(0,0,0,.7);color:#7fd1ae;pointer-events:none;white-space:pre-wrap;';
    document.body.appendChild(debugEl);
  }
  function debugLog(msg) {
    console.log('[ar-debug] ' + msg);
    if (!debugEl) return;
    debugLines.push(msg);
    if (debugLines.length > 6) debugLines.shift();
    renderDebug();
  }
  function renderDebug() {
    if (!debugEl) return;
    let status = '';
    try {
      const o = spirit.object3D;
      const mesh = spiritModel.getObject3D('mesh');
      status = 'state=' + state + ' pinned=' + pinApplied +
        ' parent=' + (o.parent === cameraEl.object3D ? 'camera' : (o.parent === anchor.object3D ? 'anchor' : 'other')) +
        '\npos=' + o.position.toArray().map(v => +v.toFixed(1)).join(',') +
        ' scale=' + (+o.scale.x.toFixed(2)) +
        '\nmesh=' + (mesh ? 'loaded' : 'NOT-LOADED') +
        ' anchorS=' + (anchorScale() ? anchorScale().toFixed(1) : 'null') +
        '\nDO=' + doStatus + '(' + doCount + ') yawΔ=' + yawDeltaDeg.toFixed(1) +
        '° spiritYaw=' + (spirit.object3D.rotation.y / (Math.PI / 180)).toFixed(1) + '°';
    } catch (e) { status = 'status err: ' + e.message; }
    debugEl.textContent = status + '\n---\n' + debugLines.join('\n');
  }
  if (debugEl) setInterval(renderDebug, 500);

  // --- 自製載入/掃描 UI：AR 引擎就緒後收起載入層、亮起尋標環 ---
  // 監聽必須在任何 await 之前註冊，避免錯過 MindAR 的事件
  let fatalLoadError = false;
  sceneEl.addEventListener('arReady', () => {
    if (fatalLoadError) return; // 資料載入失敗時錯誤畫面優先，不被相機就緒淡出
    loadingLayerEl.classList.add('off');
    scanLayerEl.classList.remove('off');
  });
  sceneEl.addEventListener('arError', () => {
    if (fatalLoadError) return; // 同上：載入失敗的訊息優先
    loadingTextEl.textContent = UI.arError || '鏡頭打不開……請確認相機權限後重新整理';
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
      loadingTextEl.textContent = UI.comingSoonError || '這隻小遇的章節還沒開放……先去找其他朋友吧！';
      return;
    }
    document.title = '奇遇中｜' + entry.zone;
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
  // 掃描到後把精靈改掛到相機下：完全螢幕空間穩定、正面朝向玩家（無俯仰角）。
  //
  // 重要：MindAR 的世界單位是「marker 影像的像素尺度」——錨點矩陣帶著數百倍的
  // 縮放、投影矩陣的近裁剪面也在那個尺度。所以釘選的距離/大小不能寫死，
  // 要從錨點矩陣取縮放（S）、從投影矩陣取 cot(fov/2)，反推「精靈高度固定佔
  // 畫面 45%」所需的 scale——與裝置 FOV、marker 尺寸無關。
  //
  // 而且 MindAR 可能在寫入錨點矩陣「之前」就發出 targetFound（首幀矩陣仍是
  // 零矩陣，同步去讀會拿到退化值）——所以用 rAF 輪詢等矩陣有效再計算；
  // 等不到就用投影矩陣的近裁剪面反推安全距離保底。
  const THREE = window.AFRAME.THREE;
  const SCREEN_HEIGHT_FRACTION = 0.45; // 精靈佔畫面高度比例
  const Y_OFFSET_FRACTION = 0.20;      // 腳掌位置：畫面中心往下 20%
  let pinScale = 1;                    // 釘選算出的目標縮放，scale 動畫都以它為基準
  let pinApplied = false;

  function v3(s) { return s + ' ' + s + ' ' + s; }

  function projInfo() {
    const cam3 = sceneEl.camera;
    const e = (cam3 && cam3.projectionMatrix) ? cam3.projectionMatrix.elements : null;
    let invTan = e ? e[5] : 0;                       // cot(fovY/2)
    if (!isFinite(invTan) || invTan <= 0) invTan = 1.19;
    let near = e ? e[14] / (e[10] - 1) : 0;          // 由透視矩陣反解 near
    if (!isFinite(near) || near <= 0) near = 0.05;
    return { invTan: invTan, near: near };
  }

  function anchorScale() {
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), sv = new THREE.Vector3();
    anchor.object3D.updateWorldMatrix(true, false);
    anchor.object3D.matrixWorld.decompose(p, q, sv);
    const S = (Math.abs(sv.x) + Math.abs(sv.y) + Math.abs(sv.z)) / 3;
    return (isFinite(S) && S > 1e-6) ? S : null;     // 零矩陣（尚未追蹤）→ null
  }

  function applyPin(d, source) {
    const proj = projInfo();
    const modelHeight = entry.arHeight || 0.5;       // 模型在 spirit 座標系的身高（總表可調）
    pinScale = (SCREEN_HEIGHT_FRACTION * 2 * d) / (proj.invTan * modelHeight);

    const o = spirit.object3D;
    cameraEl.object3D.add(o);
    o.position.set(0, -(Y_OFFSET_FRACTION * 2 * d) / proj.invTan, -d);
    o.quaternion.identity();

    // scale 動畫走 A-Frame 屬性系統，全部以 pinScale 為基準重設；
    // animation__in 立即觸發（沒有 startEvents），精靈從 0 長出
    spirit.setAttribute('scale', '0 0 0');
    spirit.setAttribute('animation__pet',
      'property: scale; from: ' + v3(pinScale) + '; to: ' + v3(pinScale * 1.12) +
      '; dir: alternate; loop: 2; dur: 120; easing: easeOutQuad; startEvents: petted');
    spirit.setAttribute('animation__capture',
      'property: scale; to: ' + v3(pinScale * 0.01) +
      '; dur: 900; easing: easeInBack; startEvents: capture');
    spirit.setAttribute('animation__in',
      'property: scale; from: 0 0 0; to: ' + v3(pinScale) + '; dur: 700; easing: easeOutBack');

    pinApplied = true;
    debugLog('pin(' + source + ') d=' + d.toFixed(1) + ' s=' + pinScale.toFixed(2) +
      ' invTan=' + proj.invTan.toFixed(3) + ' near=' + proj.near.toFixed(3));
  }

  function pinWhenReady() {
    if (pinApplied) return;
    const started = performance.now();
    (function poll() {
      if (pinApplied) return;
      const S = anchorScale();
      if (S) { applyPin(3 * S, 'anchor S=' + S.toFixed(1)); return; }
      if (performance.now() - started > 1500) { // 等不到有效矩陣 → 近裁剪面倍數保底
        const near = projInfo().near;
        applyPin(Math.max(60 * near, 3), 'fallback near=' + near.toFixed(3));
        return;
      }
      setTimeout(poll, 66); // 用時間基準而非幀數：背景/節流分頁也不會拖慢逾時
    })();
  }

  // --- 側身視差：精靈保持面向「原本的世界方向」---
  // 水平 360° 自由（繞著轉可以看到背面）；上下俯仰小角度跟隨（±15°，同圖鑑檢視器的感覺）。
  // 精靈釘在相機下，相機轉動不會改變相對角度，所以用 deviceorientation 感測
  // 手機朝向（與 MindAR 無關，marker 不在畫面也有效）。基準取釘選後第一筆讀值。
  const PITCH_LIMIT_DEG = 15;
  let yawBase = null, pitchBase = 0;
  let yawTargetRad = 0, yawCurrentRad = 0, yawDeltaDeg = 0;
  let pitchTargetRad = 0, pitchCurrentRad = 0;

  const _euler = new THREE.Euler();
  const _q = new THREE.Quaternion();
  const _qCam = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2); // 相機朝機背而非螢幕頂
  const _qScreen = new THREE.Quaternion();
  const _zee = new THREE.Vector3(0, 0, 1);
  const _dir = new THREE.Vector3();
  const D2R = Math.PI / 180;

  // 感測器自我診斷（?debug 疊層顯示）：waiting=還沒收到事件、null-data=有事件
  // 但沒資料（桌機/權限未給）、ok=正常、need-perm/perm:*=iOS 權限流程
  let doStatus = 'waiting';
  let doCount = 0;

  function onDeviceOrientation(ev) {
    doCount++;
    if (ev.alpha == null || ev.beta == null || ev.gamma == null) { doStatus = 'null-data'; return; }
    if (doStatus !== 'ok') { doStatus = 'ok'; debugLog('DO ok α=' + ev.alpha.toFixed(0)); }
    if (!pinApplied) return;
    // 標準 deviceorientation → three.js 相機四元數（含螢幕方向補償）
    const orient = ((screen.orientation && screen.orientation.angle) || window.orientation || 0) * D2R;
    _euler.set(ev.beta * D2R, ev.alpha * D2R, -ev.gamma * D2R, 'YXZ');
    _q.setFromEuler(_euler).multiply(_qCam).multiply(_qScreen.setFromAxisAngle(_zee, -orient));
    _dir.set(0, 0, -1).applyQuaternion(_q);
    const heading = Math.atan2(-_dir.x, -_dir.z); // 相機水平朝向（逆時針為正）
    const pitch = Math.asin(Math.max(-1, Math.min(1, _dir.y))); // 相機仰角（抬頭為正）
    if (yawBase === null) { yawBase = heading; pitchBase = pitch; return; }
    let delta = heading - yawBase;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta)); // 摺回 ±180°，跨 0°/360° 不跳
    // 相機右轉 → 精靈相對左轉（像牠仍面向原方向）；水平不設限，可 360° 看背面
    yawDeltaDeg = delta / D2R;
    yawTargetRad = -delta;
    // 俯仰只小角度跟隨：抬頭/低頭時精靈微微對應傾斜，超過 ±15° 就停
    const dp = pitch - pitchBase;
    pitchTargetRad = Math.max(-PITCH_LIMIT_DEG * D2R, Math.min(PITCH_LIMIT_DEG * D2R, -dp));
  }
  window.addEventListener('deviceorientation', onDeviceOrientation);

  // 平滑收斂（也吃掉感測雜訊與 clamp 撞牆的跳動）；scale 動畫不碰 rotation，不衝突。
  // yaw 走最短路徑收斂，跨 ±180° 時不會反方向繞遠路。
  setInterval(() => {
    if (!pinApplied) return;
    let dy = yawTargetRad - yawCurrentRad;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    yawCurrentRad += dy * 0.18;
    pitchCurrentRad += (pitchTargetRad - pitchCurrentRad) * 0.18;
    // Euler 預設 XYZ = 先繞 Y 轉身、再繞相機 X 俯仰 → 俯仰永遠相對玩家視角
    spirit.object3D.rotation.set(pitchCurrentRad, yawCurrentRad, 0);
  }, 33);

  // iOS 13+ 的感測權限要在「使用者手勢」中請求，而且 Safari 在不算手勢的呼叫
  // 可能同步丟例外——所以：(1) 呼叫包 try/catch；(2) 失敗「不」拆監聽，每次
  // 觸碰都重試，直到拿到 granted/denied 為止；(3) 另外放一顆看得見的按鈕，
  // 點按鈕百分之百是使用者手勢。拿不到就維持正面，其餘功能不受影響。
  if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') {
    doStatus = 'need-perm';

    const motionBtn = document.createElement('button');
    motionBtn.className = 'ui-btn motion-btn';
    motionBtn.textContent = UI.motionPermission || '🧭 點我開啟側身視角';
    document.getElementById('ui').appendChild(motionBtn);

    let settled = false;
    function stopAsking() {
      settled = true;
      motionBtn.remove();
      document.removeEventListener('click', askOrientationPermission, true);
      document.removeEventListener('touchend', askOrientationPermission, true);
    }
    function askOrientationPermission() {
      if (settled) return;
      try {
        DeviceOrientationEvent.requestPermission().then(res => {
          doStatus = 'perm:' + res;
          debugLog('DO permission: ' + res);
          if (res === 'granted' || res === 'denied') stopAsking();
        }).catch(e => {
          doStatus = 'perm-rej:' + ((e && e.name) || '?');
          debugLog('DO perm rejected: ' + e);
        });
      } catch (e) {
        doStatus = 'perm-throw:' + ((e && e.name) || '?');
        debugLog('DO perm threw: ' + e);
      }
    }
    motionBtn.addEventListener('click', askOrientationPermission);
    // capture 階段掛在 document：不管點到哪、有沒有被中途攔截都收得到
    document.addEventListener('click', askOrientationPermission, true);
    document.addEventListener('touchend', askOrientationPermission, true);
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

  spiritModel.addEventListener('model-loaded', () => debugLog('model-loaded'));
  spiritModel.addEventListener('model-error', e =>
    debugLog('MODEL-ERROR: ' + ((e.detail && e.detail.src) || '')));

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
    // 登場縮放動畫（animation__in）由 applyPin 設定——釘選定位好才長出來
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

  // --- 默契測驗：選項每次洗牌，連錯兩次先重播知識點再重出題 ---
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
    // 答錯提示由小遇本人說（默契測驗是「你們之間的事」，不假手引導者）
    if (quizWrongCount >= 2) {
      quizWrongCount = 0;
      showDialog([data.quiz.wrongHint],
        () => showDialog(data.knowledge, startQuiz),
        data.name);
    } else {
      showDialog([data.quiz.wrongHint], startQuiz, data.name);
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
          (entry.name + '（' + entry.species + '）的故事分身，住進你的日誌了！');
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
    pinWhenReady(); // 等錨點矩陣有效後把精靈釘到畫面中央（對話先開始，不互等）
    startIntro();
  }

  function onTargetLost() {
    if (state === 'scanning') scanLayerEl.classList.remove('off');
  }

  // 分身已在日誌 → 直接提示（重複遊玩仍可再互動，僅提示已收錄）
  if (MuselingSave.isUnlocked(entry.id)) {
    setHint(fmt(UI.alreadyCaptured, entry) ||
      (entry.name + '的分身已經住在你的日誌裡囉！對準圖騰，可以再找本尊玩。'));
  }

  // 資料就緒：回放載入期間發生的辨識事件（玩家可能早就對準了圖騰）
  gameReady = true;
  if (targetVisible) onTargetFound();
})();
