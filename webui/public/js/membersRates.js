'use strict';
// 成員與匯率設定分頁：新增/改名/刪除成員、新增/修改/刪除匯率。
/* ===================== members ===================== */
function addMember(){
  const input = document.getElementById('newMemberName');
  const name = input.value.trim();
  if (!name){ toast('請輸入成員名稱', 'error'); return; }
  trip.members.push({ id: genId('mem'), name });
  input.value = '';
  toast(`已新增成員「${name}」`, 'success');
  renderAll();
}
function renameMember(id, value){
  const m = trip.members.find(x=>x.id===id);
  if (m) m.name = value;
}
function removeMember(id){
  const idx = trip.members.findIndex(x=>x.id===id);
  if (idx === -1) return;
  const used = trip.expenses.some(e=>e.payers.some(p=>p.userId===id)||e.participants.some(s=>s.userId===id))
            || trip.deposits.some(d=>d.payerId===id||d.collectorId===id);
  const [removed] = trip.members.splice(idx,1);
  renderAll();
  toastUndo(
    used ? `已刪除成員「${removed.name}」（他仍出現在部分支出／轉帳紀錄中）` : `已刪除成員「${removed.name}」`,
    ()=>{ trip.members.splice(idx,0,removed); renderAll(); }
  );
}

/* ===================== rates ===================== */
function addRate(){
  const codeInput = document.getElementById('newRateCurrency');
  const valInput = document.getElementById('newRateValue');
  const code = codeInput.value.trim().toUpperCase();
  const val = parseFloat(valInput.value);
  if (!code){ toast('請輸入幣別代碼', 'error'); return; }
  if (!(val>0)){ toast('匯率需為大於 0 的數字', 'error'); return; }
  trip.rates[code] = val;
  codeInput.value=''; valInput.value='';
  toast(`已設定 ${code} = ${val}`, 'success');
  renderAll();
}
function updateRate(code, value){
  const v = parseFloat(value);
  if (v>0) trip.rates[code] = v;
  renderAll();
}
function removeRate(code){
  if (code === trip.baseCurrency){ toast('不能刪除目前的基準幣別', 'error'); return; }
  const usedValue = trip.rates[code];
  const used = trip.expenses.some(e=>e.currency===code) || trip.deposits.some(d=>d.currency===code);
  delete trip.rates[code];
  renderAll();
  toastUndo(
    used ? `已刪除 ${code} 匯率（有支出／轉帳正在使用這個幣別）` : `已刪除 ${code} 匯率`,
    ()=>{ trip.rates[code] = usedValue; renderAll(); }
  );
}

