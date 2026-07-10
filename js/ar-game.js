/**
 * ar-game.js — MVP 核心迴圈狀態機
 * scanning → intro（登場對話）→ pet（撫摸互動）→ knowledge（科普對話）
 * → quiz（收服考驗）→ captured（收錄圖鑑）
 */
(async function () {
  const THREE = window.AFRAME.THREE;

  // ===== 自訂 A-Frame 元件（須在掛載到實體前註冊） =====

  // 只繞自身直立軸緩慢面向相機，帶少許側身角度；收到 'snapface' 事件時瞬間對正（初次登場用）
  AFRAME.registerComponent('face-camera', {
    schema: { offsetDeg: { default: -20 }, lerp: { default: 0.07 } },
    init: function () {
      this.camPos = new THREE.Vector3();
      this.selfPos = new THREE.Vector3();
      this.parentQuat = new THREE.Quaternion();
      this.snap = false;
      this.el.addEventListener('snapface', () => { this.snap = true; });
    },
    tick: function () {
      const cam = this.el.sceneEl.camera;
      if (!cam) return;
      const obj = this.el.object3D;
      cam.getWorldPosition(this.camPos);
      obj.getWorldPosition(this.selfPos);
      const dir = this.camPos.sub(this.selfPos);
      obj.parent.getWorldQuaternion(this.parentQuat).invert();
      dir.applyQuaternion(this.parentQuat);
      const target = Math.atan2(dir.x, dir.z) + THREE.MathUtils.degToRad(this.data.offsetDeg);
      let delta = target - obj.rotation.y;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      obj.rotation.y += delta * (this.snap ? 1 : this.data.lerp);
      this.snap = false;
    }
  });

  // Marker 跟丟後，精靈平滑漂到相機前方的固定位置，任務流程不中斷
  AFRAME.registerComponent('float-drift', {
    init: function () {
      this.active = false;
      this.targetPos = new THREE.Vector3(0, -0.35, -1.4);
      // Rz(-90) 抵銷 spirit-orient 的 Rz(90)，讓狐狸在相機座標中站直
      this.targetQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -Math.PI / 2));
    },
    tick: function () {
      if (!this.active) return;
      const o = this.el.object3D;
      o.position.lerp(this.targetPos, 0.06);
      o.quaternion.slerp(this.targetQuat, 0.06);
    }
  });

  const data = await fetch('data/scripts/red_fox.json').then(r => r.json());

  // --- DOM ---
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

  const anchor = document.getElementById('anchor');
  const spirit = document.getElementById('spirit');
  const spiritModel = document.getElementById('spirit-model');
  const spiritYaw = document.getElementById('spirit-yaw');
  const sceneEl = document.querySelector('a-scene');

  // 掛載自訂元件（元件已於上方註冊）
  spiritYaw.setAttribute('face-camera', '');
  spirit.setAttribute('float-drift', '');

  // --- 脫錨漂浮：觸發後跟丟 Marker，精靈改掛到相機下，留在畫面上 ---
  let floating = false;
  function floatToCamera() {
    if (floating || state === 'scanning' || state === 'captured') return;
    floating = true;
    const camObj = document.querySelector('a-camera').object3D;
    camObj.attach(spirit.object3D); // 保留當下世界座標，再由 float-drift 平滑漂到定位
    spirit.components['float-drift'].active = true;
  }
  const loadingLayerEl = document.getElementById('loading-layer');
  const scanLayerEl = document.getElementById('scan-layer');

  // --- 自製時光羅盤 UI：AR 引擎就緒後收起載入層、亮起尋標環 ---
  sceneEl.addEventListener('arReady', () => {
    loadingLayerEl.classList.add('off');
    scanLayerEl.classList.remove('off');
  });
  sceneEl.addEventListener('arError', () => {
    loadingLayerEl.querySelector('.loading-text').textContent = '羅盤失靈了……請確認相機權限後重新整理';
  });

  // ?uidebug：不開相機也能檢視掃描層視覺（開發用）
  if (location.search.indexOf('uidebug') !== -1) {
    loadingLayerEl.classList.add('off');
    scanLayerEl.classList.remove('off');
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

  function startQuiz() {
    state = 'quiz';
    quizQuestionEl.textContent = data.quiz.question;
    quizOptionsEl.innerHTML = '';
    data.quiz.options.forEach((opt, idx) => {
      const btn = document.createElement('button');
      btn.className = 'quiz-btn';
      btn.textContent = opt;
      btn.addEventListener('click', () => answer(idx));
      quizOptionsEl.appendChild(btn);
    });
    quizEl.classList.remove('hidden');
  }

  function answer(idx) {
    quizEl.classList.add('hidden');
    if (idx === data.quiz.answer) {
      capture();
    } else {
      showDialog([data.quiz.wrongHint], startQuiz, '艾可');
    }
  }

  function capture() {
    state = 'captured';
    flashEl.classList.add('flash-on');
    playClipOnce(CLIP_CAPTURE);
    spirit.emit('capture');
    MuselingSave.unlock(data.id, { affinity: affinity, name: data.name, species: data.species, zone: data.zone });

    setTimeout(() => {
      flashEl.classList.remove('flash-on');
      showDialog([data.quiz.correct, data.captured, data.nextHint], () => {
        capturedTextEl.textContent = data.name + '（' + data.species + '）已收錄！';
        capturedPanelEl.classList.remove('hidden');
      });
    }, 1000);
  }

  // --- MindAR 追蹤事件 ---
  anchor.addEventListener('targetFound', () => {
    scanLayerEl.classList.add('off');
    if (state === 'scanning') {
      startIntro();
    } else if (state === 'pet') {
      setHint(data.petPrompt);
    }
  });

  anchor.addEventListener('targetLost', () => {
    if (state === 'scanning') {
      scanLayerEl.classList.remove('off');
    } else if (state !== 'captured') {
      // 觸發後跟丟 Marker：精靈漂到鏡頭前，任務繼續，不逼玩家停在原地
      floatToCamera();
    }
  });

  // 已收服過 → 直接提示（重複遊玩仍可再互動，僅提示已收錄）
  if (MuselingSave.isUnlocked(data.id)) {
    setHint('你已收服過' + data.name + '囉！對準圖騰可以再找牠玩。');
  }
})();
