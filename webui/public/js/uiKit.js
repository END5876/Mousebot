'use strict';
// 共用 UI 元件：toast 提示、modal 對話框（含清單挑選）、withLoading 按鈕忙碌狀態。
/* =====================================================================
   Toast 系統 — 取代所有原本分散在各分頁的 msg 區塊。
   固定顯示在畫面底部（桌面在右下），不管使用者在哪個分頁操作都看得到。
===================================================================== */
function toast(message, type, opts){
  type = type || 'info';
  opts = opts || {};
  const stack = document.getElementById('toastStack');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  const icon = type === 'success' ? '✅' : (type === 'error' ? '⚠️' : 'ℹ️');
  el.innerHTML = `<span class="ic">${icon}</span><span class="msg-text"></span>`;
  el.querySelector('.msg-text').textContent = message;
  if (opts.undo){
    const btn = document.createElement('button');
    btn.className = 'undo-btn';
    btn.type = 'button';
    btn.textContent = '復原';
    btn.onclick = ()=>{ opts.undo(); dismissToast(el); };
    el.appendChild(btn);
  }
  stack.appendChild(el);
  const duration = opts.duration || (type === 'error' ? 6000 : (opts.undo ? 6000 : 3200));
  el._t = setTimeout(()=>dismissToast(el), duration);
  return el;
}
function dismissToast(el){
  if (!el || !el.parentNode) return;
  clearTimeout(el._t);
  el.classList.add('closing');
  setTimeout(()=>el.remove(), 180);
}
// 復原式刪除：資料立即移除，但跳一個帶「復原」按鈕的 toast，
// 幾秒內按下就還原，取代原本「刪除前跳原生確認框」的模式。
function toastUndo(message, restoreFn){
  toast(message, 'success', { undo: restoreFn });
}

/* =====================================================================
   Modal 系統 — 取代原生 confirm() / prompt()，統一站內樣式與行動裝置體驗。
===================================================================== */
function closeModal(){
  const root = document.getElementById('modalRoot');
  root.innerHTML = '';
}
function confirmModal(message, opts){
  opts = opts || {};
  return new Promise(resolve=>{
    const root = document.getElementById('modalRoot');
    root.innerHTML = `
      <div class="modal-overlay" id="modalOverlay">
        <div class="modal-box" role="dialog" aria-modal="true">
          ${opts.title ? `<div class="modal-title">${escapeHtml(opts.title)}</div>` : ''}
          <div class="modal-body">${escapeHtml(message)}</div>
          <div class="modal-actions">
            <button class="btn btn-ghost" id="modalCancelBtn">${escapeHtml(opts.cancelText || '取消')}</button>
            <button class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'}" id="modalConfirmBtn" style="${opts.danger ? 'background:var(--debt-solid);color:#fff;border:none;' : ''}">${escapeHtml(opts.confirmText || '確定')}</button>
          </div>
        </div>
      </div>`;
    const overlay = document.getElementById('modalOverlay');
    const finish = (val)=>{ closeModal(); resolve(val); };
    document.getElementById('modalCancelBtn').onclick = ()=>finish(false);
    document.getElementById('modalConfirmBtn').onclick = ()=>finish(true);
    overlay.addEventListener('click', (e)=>{ if (e.target === overlay) finish(false); });
    document.getElementById('modalConfirmBtn').focus();
  });
}
// 🆕 純告知型 modal（取代原生 alert()）：只有一顆「知道了」按鈕，沒有
// 取消/確定的選擇，用在只是要提醒使用者「這件事做不到」的場合（例如拖曳
// 了一個非圖片格式的檔案）。跟 confirmModal() 共用同一套外觀與遮罩，
// 差別只在按鈕數量與語意（alertdialog 而非 dialog）。resolve 永遠是
// true，回傳 Promise 純粹是為了讓呼叫端能用 await 等使用者按下去再繼續。
function alertModal(message, opts){
  opts = opts || {};
  return new Promise(resolve=>{
    const root = document.getElementById('modalRoot');
    root.innerHTML = `
      <div class="modal-overlay" id="modalOverlay">
        <div class="modal-box" role="alertdialog" aria-modal="true">
          ${opts.title ? `<div class="modal-title">${escapeHtml(opts.title)}</div>` : ''}
          <div class="modal-body">${escapeHtml(message)}</div>
          <div class="modal-actions">
            <button class="btn btn-primary" id="modalOkBtn">${escapeHtml(opts.okText || '知道了')}</button>
          </div>
        </div>
      </div>`;
    const overlay = document.getElementById('modalOverlay');
    const finish = ()=>{ closeModal(); resolve(true); };
    document.getElementById('modalOkBtn').onclick = finish;
    overlay.addEventListener('click', (e)=>{ if (e.target === overlay) finish(); });
    document.getElementById('modalOkBtn').focus();
  });
}
// 清單挑選 modal（取代原本 prompt() 手動打行程 ID 的做法）
function pickModal(title, items){
  // items: [{ value, title, sub }]
  return new Promise(resolve=>{
    const root = document.getElementById('modalRoot');
    root.innerHTML = `
      <div class="modal-overlay" id="modalOverlay">
        <div class="modal-box" role="dialog" aria-modal="true">
          <div class="modal-title">${escapeHtml(title)}</div>
          <div class="modal-list" id="modalList"></div>
          <div class="modal-actions">
            <button class="btn btn-ghost" id="modalCancelBtn">取消</button>
          </div>
        </div>
      </div>`;
    const list = document.getElementById('modalList');
    items.forEach(item=>{
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'modal-list-item';
      btn.innerHTML = `<div class="mli-title"></div>${item.sub ? '<div class="mli-sub"></div>' : ''}`;
      btn.querySelector('.mli-title').textContent = item.title;
      if (item.sub) btn.querySelector('.mli-sub').textContent = item.sub;
      btn.onclick = ()=>{ closeModal(); resolve(item.value); };
      list.appendChild(btn);
    });
    const overlay = document.getElementById('modalOverlay');
    document.getElementById('modalCancelBtn').onclick = ()=>{ closeModal(); resolve(null); };
    overlay.addEventListener('click', (e)=>{ if (e.target === overlay){ closeModal(); resolve(null); } });
  });
}

/* =====================================================================
   Loading 狀態 — 包住任何非同步按鈕動作：停用按鈕、換成 spinner 文字，
   結束後（不論成功失敗）自動還原，並防止使用者連點造成重複請求。
===================================================================== */
async function withLoading(btnEl, loadingText, fn){
  if (btnEl.disabled) return; // 已經在跑，忽略重複點擊
  const original = btnEl.innerHTML;
  btnEl.disabled = true;
  btnEl.innerHTML = `<span class="spinner"></span>${escapeHtml(loadingText)}`;
  try{
    await fn();
  } finally {
    btnEl.disabled = false;
    btnEl.innerHTML = original;
  }
}

