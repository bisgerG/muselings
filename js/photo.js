/**
 * photo.js — 放出精靈：AR 實境拍照互動頁
 *
 * 相機視訊當背景，透明 model-viewer 疊精靈。手勢依「觸點」自動判斷：
 *   按在精靈身上拖曳 → 移動位置（CSS translate 整個 pet-holder）
 *   按在空白處拖曳   → 旋轉（左右自由、上下 65°~95°，同圖鑑檢視器）
 *   雙指捏合         → 縮放（調整 orbit 距離）
 * 拍照：canvas 合成「相機當前幀（cover 裁切）＋ 精靈層」→ 分享 / 下載。
 *
 * ?spirit=<id>  指定精靈（讀 data/muselings.json 總表；須已收服）
 * ?nocam        開發／自動化測試用：跳過相機改用漸層背景
 *
 * 注意：按鈕與手勢的綁定刻意不等 model-viewer 的 CDN 模組
 * （customElements.whenDefined）——CDN 慢或被擋時，相機與返回操作仍要能用。
 */
(async function () {
  const qs = new URLSearchParams(location.search);
  const video = document.getElementById('cam');
  const holder = document.getElementById('pet-holder');
  const mv = document.getElementById('pet-viewer');
  const gestureLayer = document.getElementById('gesture-layer');
  const titleEl = document.getElementById('photo-title');
  const hintEl = document.querySelector('.photo-hint');
  const startOverlay = document.getElementById('start-overlay');
  const startOverlayText = startOverlay.querySelector('.photo-overlay-text');
  const startBtn = document.getElementById('start-btn');
  const skipCamBtn = document.getElementById('skip-cam-btn');
  const shutterBtn = document.getElementById('shutter-btn');
  const flashEl = document.getElementById('flash');
  const previewOverlay = document.getElementById('preview-overlay');
  const previewImg = document.getElementById('preview-img');
  const shareBtn = document.getElementById('share-btn');
  const downloadLink = document.getElementById('download-link');
  const previewClose = document.getElementById('preview-close');

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function fatal(message) {
    startOverlay.classList.remove('hidden');
    startOverlayText.textContent = message;
    startBtn.classList.add('hidden');
    skipCamBtn.classList.add('hidden');
  }

  // --- 載入總表 → 檢查收服狀態 → 設定模型 ---
  let entry, UI = {};
  try {
    const res = await fetch('data/muselings.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const registry = await res.json();
    UI = registry.ui || {};
    const id = qs.get('spirit') || registry.defaultSpirit;
    entry = registry.muselings.find(m => m.id === id);
    if (!entry || !entry.model) throw new Error('此精靈沒有可放出的模型：' + id);
  } catch (e) {
    console.error('[photo] 載入失敗', e);
    fatal('載入精靈資料失敗，請回圖鑑再試一次。');
    return;
  }

  // 沒收服過就不能放出來（分享網址直開也擋）
  if (!MuselingSave.isUnlocked(entry.id)) {
    fatal(UI.notCapturedError || '還沒喚醒這隻博物之靈，先去展區找到牠吧！');
    return;
  }

  mv.setAttribute('src', entry.model); // setAttribute 在元件升級前也有效
  titleEl.textContent = entry.name;
  document.title = '放出' + entry.name + '｜時空守護者';

  // 模型載入後挑 idle 動畫（clip 名稱含 smell 者優先，找不到用第一段）
  mv.addEventListener('load', () => {
    const clips = mv.availableAnimations || [];
    const idle = clips.find(n => /smell/i.test(n)) || clips[0];
    if (idle) { mv.animationName = idle; mv.play(); }
  });

  // --- 相機（不依賴 model-viewer，先綁） ---
  let camReady = false;
  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }, audio: false
      });
      video.srcObject = stream;
      await video.play();
      camReady = true;
    } catch (e) {
      console.warn('[photo] 相機不可用，改用漸層背景', e);
      document.body.classList.add('nocam');
    }
    startOverlay.classList.add('hidden');
  }
  function skipCamera() {
    document.body.classList.add('nocam');
    startOverlay.classList.add('hidden');
  }
  if (qs.has('nocam')) {
    skipCamera();
  } else {
    startBtn.addEventListener('click', startCamera);
    skipCamBtn.addEventListener('click', skipCamera);
  }

  // --- 旋轉／縮放狀態（同圖鑑規格：左右自由、上下 65~95 度） ---
  const PHI_MIN = 65, PHI_MAX = 95;
  let theta = -90, phi = 80, radius = 105; // radius 單位：%
  function applyOrbit() {
    mv.cameraOrbit = theta + 'deg ' + phi + 'deg ' + radius + '%';
  }

  // --- 手勢仲裁（先綁；hitsPet 在元件升級前一律當作未命中 → 旋轉模式） ---
  function hitsPet(x, y) {
    const r = mv.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return false;
    try { return !!mv.positionAndNormalFromPoint(x, y); } catch (e) { return false; }
  }

  const pointers = new Map();
  let mode = null; // 'move' | 'rotate' | 'pinch'
  let startX = 0, startY = 0, startTheta = 0, startPhi = 0;
  let holderX = 0, holderY = 0, startHX = 0, startHY = 0;
  let pinchStartDist = 0, pinchStartRadius = 0;

  function pinchDist() {
    let a = null, b = null;
    pointers.forEach(p => { if (!a) a = p; else if (!b) b = p; });
    return (a && b) ? (Math.hypot(a.x - b.x, a.y - b.y) || 1) : 1;
  }

  gestureLayer.addEventListener('pointerdown', (e) => {
    gestureLayer.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      pinchStartDist = pinchDist();
      pinchStartRadius = radius;
      mode = 'pinch';
    } else if (pointers.size === 1) {
      mode = hitsPet(e.clientX, e.clientY) ? 'move' : 'rotate';
      startX = e.clientX; startY = e.clientY;
      startTheta = theta; startPhi = phi;
      startHX = holderX; startHY = holderY;
    }
  });

  gestureLayer.addEventListener('pointermove', (e) => {
    const pt = pointers.get(e.pointerId);
    if (!pt) return;
    pt.x = e.clientX; pt.y = e.clientY; // 就地更新，避免熱路徑每事件配置新物件
    if (mode === 'pinch' && pointers.size === 2) {
      radius = clamp(pinchStartRadius * pinchStartDist / pinchDist(), 60, 220); // 手指張開 → 變大
      applyOrbit();
    } else if (mode === 'move') {
      holderX = startHX + (e.clientX - startX);
      holderY = startHY + (e.clientY - startY);
      holder.style.transform = 'translate(' + holderX + 'px, ' + holderY + 'px)';
    } else if (mode === 'rotate') {
      theta = startTheta - (e.clientX - startX) * 0.35;
      phi = clamp(startPhi - (e.clientY - startY) * 0.2, PHI_MIN, PHI_MAX);
      applyOrbit();
    }
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    mode = null; // 剩餘手指需重新按壓判定，避免捏合結束時畫面跳動
  }
  gestureLayer.addEventListener('pointerup', endPointer);
  gestureLayer.addEventListener('pointercancel', endPointer);

  // --- 拍照：canvas 合成（先綁，內部對 model-viewer 失效時給出回饋） ---
  const defaultHint = hintEl.textContent;
  function showHint(msg) {
    hintEl.textContent = msg;
    setTimeout(() => { hintEl.textContent = defaultHint; }, 2500);
  }

  let currentBlob = null;
  let currentUrl = null;
  if (!(navigator.canShare && navigator.share)) shareBtn.classList.add('hidden');

  shutterBtn.addEventListener('click', async () => {
    flashEl.classList.add('flash-on');
    setTimeout(() => flashEl.classList.remove('flash-on'), 250);

    try {
      const W = window.innerWidth, H = window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);

      if (camReady && video.videoWidth) {
        // cover 裁切：把視訊畫面等比放大到蓋滿螢幕
        const s = Math.max(W / video.videoWidth, H / video.videoHeight);
        const dw = video.videoWidth * s, dh = video.videoHeight * s;
        ctx.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh);
      } else {
        const g = ctx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, '#0e2a3a'); g.addColorStop(0.6, '#1c4a4a'); g.addColorStop(1, '#2c6e49');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
      }

      // 精靈層（PNG 透明背景），依 holder 目前實際位置疊上
      const petImg = new Image();
      petImg.src = mv.toDataURL('image/png');
      await new Promise((res, rej) => { petImg.onload = res; petImg.onerror = rej; });
      const r = mv.getBoundingClientRect();
      ctx.drawImage(petImg, r.left, r.top, r.width, r.height);

      canvas.toBlob(blob => {
        if (!blob) { showHint('拍照失敗，請再試一次'); return; }
        currentBlob = blob;
        if (currentUrl) URL.revokeObjectURL(currentUrl); // 回收上一張，連拍不累積記憶體
        currentUrl = URL.createObjectURL(blob);
        previewImg.src = currentUrl;
        downloadLink.href = currentUrl;
        downloadLink.download = entry.id + '_photo.jpg';
        previewOverlay.classList.remove('hidden');
      }, 'image/jpeg', 0.92);
    } catch (e) {
      console.error('[photo] 拍照合成失敗', e);
      showHint('拍照失敗，請再試一次');
    }
  });

  shareBtn.addEventListener('click', async () => {
    if (!currentBlob) return;
    const file = new File([currentBlob], entry.id + '_photo.jpg', { type: 'image/jpeg' });
    try {
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
      } else {
        downloadLink.click(); // 不支援分享檔案的瀏覽器退回下載
      }
    } catch (e) { /* 使用者取消分享 → 忽略 */ }
  });

  previewClose.addEventListener('click', () => {
    previewOverlay.classList.add('hidden');
  });

  // --- model-viewer 就緒後才需要的初始化（放最後，不擋上面的互動綁定） ---
  await customElements.whenDefined('model-viewer');
  applyOrbit();
})();
