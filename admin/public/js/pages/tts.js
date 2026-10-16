// TTS 語音：各伺服器的 SoVITS 模型、edge-tts 聲音、AI 回覆朗讀開關、試聽
// 與 /tts model、/tts edgevoice、/ai tts 共用同一份設定（存在 data/，重新啟動後保留）

import { h, icon } from '../dom.js';
import { api, seg } from '../api.js';
import {
  avatar, card, emptyState, errorState, loadingState, selectEl, statusBadge, switchControl, toast, toastError, withBusy,
} from '../ui.js';

export default function mountTts(root, ctx) {
  let data = null;

  const refreshBtn = h('button', { type: 'button', class: 'btn btn-sm', onclick: () => load() }, icon('refresh', 'ic-sm'), '重新整理');
  ctx.setActions(refreshBtn);
  root.append(loadingState());

  async function load() {
    try {
      data = await api.get('/api/tts');
      if (!ctx.disposed) render();
    } catch (err) {
      if (!ctx.disposed) root.replaceChildren(errorState(err, load));
    }
  }

  function render() {
    root.replaceChildren(engineCard(), guildsCard());
  }

  function engineCard() {
    const { sovits, edge } = data;
    return card({
      title: '語音引擎',
      iconName: 'mic',
      body: h('dl', { class: 'kv' },
        h('dt', null, 'GPT-SoVITS'),
        h('dd', null, h('div', { class: 'toolbar' },
          statusBadge(sovits.online ? 'good' : 'bad', sovits.online ? '在線' : '離線'),
          h('span', { class: 'mono hint' }, sovits.host),
        )),
        h('dt', null, '可用模型'),
        h('dd', null, sovits.models.length
          ? sovits.models.map((m) => `${m.name}（${m.key}）`).join('、')
          : '沒有設定（.env 的 SOVITS_MODEL_*）'),
        h('dt', null, '預設模型'),
        h('dd', { class: 'mono' }, sovits.defaultModel || '（第一個模型）'),
        h('dt', null, 'edge-tts'),
        h('dd', null, statusBadge(edge.available ? 'good' : 'neutral', edge.available ? '可用（SoVITS 離線時的備援）' : '未安裝')),
      ),
      note: 'SoVITS 伺服器一次只能載入一組權重：在任何一個伺服器切換模型，其他伺服器也會用到新的權重（與 /tts model 相同）。',
    });
  }

  function guildsCard() {
    const { sovits, edge } = data;
    const blocks = data.guilds.map((g) => {
      // SoVITS 模型（切換要讓 SoVITS 載入權重，可能要十幾秒）
      const modelSel = selectEl({
        options: sovits.models.map((m) => ({ value: m.key, label: `${m.name}（${m.key}）` })),
        value: g.model ?? '',
        placeholder: g.model ? null : `預設：${g.effectiveModel ?? '無'}`,
        ariaLabel: `${g.name} 的 SoVITS 模型`,
      });
      modelSel.disabled = !sovits.models.length;
      const modelHint = h('div', { class: 'hint' }, sovits.online ? '' : 'SoVITS 離線中，暫時無法切換');
      modelSel.addEventListener('change', async () => {
        const key = modelSel.value;
        if (!key) return;
        const prev = g.model ?? '';
        modelSel.disabled = true;
        modelHint.textContent = '切換中…（SoVITS 載入權重需要一點時間）';
        try {
          await api.put(`/api/tts/${seg(g.id)}/model`, { key });
          g.model = key;
          toast(`${g.name} 已切換為「${sovits.models.find((m) => m.key === key)?.name ?? key}」`);
          modelHint.textContent = '';
        } catch (err) {
          modelSel.value = prev;
          modelHint.textContent = '';
          toastError(err);
        } finally {
          modelSel.disabled = false;
        }
      });

      // edge-tts 聲音（SoVITS 離線時的備援）
      const voiceSel = selectEl({
        options: [{ value: '', label: '依文字語言自動選擇' }, ...edge.voices.map((v) => ({ value: v.value, label: v.name }))],
        value: g.edgeVoice ?? '',
        ariaLabel: `${g.name} 的 edge-tts 聲音`,
      });
      voiceSel.disabled = !edge.available;
      voiceSel.addEventListener('change', async () => {
        const prev = g.edgeVoice ?? '';
        voiceSel.disabled = true;
        try {
          await api.put(`/api/tts/${seg(g.id)}/edge-voice`, { voice: voiceSel.value || null });
          g.edgeVoice = voiceSel.value || null;
          toast(`${g.name} 的 edge-tts 聲音已更新`);
        } catch (err) {
          voiceSel.value = prev;
          toastError(err);
        } finally {
          voiceSel.disabled = false;
        }
      });

      const aiSwitch = switchControl({
        checked: g.aiTTS,
        label: 'AI 回覆自動朗讀',
        onChange: async (on) => {
          await api.put(`/api/tts/${seg(g.id)}/ai-tts`, { enabled: on });
          g.aiTTS = on;
          toast(`${g.name}：AI 回覆朗讀已${on ? '開啟' : '關閉'}`);
        },
      });

      // 試聽
      const sayInput = h('input', { class: 'input', maxlength: 200, placeholder: g.inVoice ? '輸入一句話，讓 Bot 在語音頻道念出來' : 'Bot 不在這個伺服器的語音頻道', disabled: !g.inVoice, 'aria-label': `${g.name} 試聽文字` });
      const sayBtn = h('button', { type: 'button', class: 'btn', disabled: !g.inVoice }, icon('play', 'ic-sm'), '試聽');
      const say = async () => {
        const text = sayInput.value.trim();
        if (!text) { sayInput.focus(); return; }
        let res = null;
        const ok = await withBusy(sayBtn, async () => { res = await api.post(`/api/tts/${seg(g.id)}/say`, { text }); });
        if (ok) toast(`已送出朗讀${res?.engine ? `（${res.engine === 'sovits' ? 'SoVITS' : 'edge-tts'}）` : ''}`);
      };
      sayBtn.addEventListener('click', say);
      sayInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); say(); } });

      return h('div', { class: 'guild-block' },
        h('div', { class: 'guild-title' },
          avatar({ url: g.iconUrl, name: g.name, size: 'sm', square: true }),
          h('span', { class: 'truncate' }, g.name),
          g.inVoice ? statusBadge('good', '在語音頻道') : null,
        ),
        h('div', { class: 'form-row' },
          h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'SoVITS 模型'), modelSel, modelHint),
          h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'edge-tts 聲音（SoVITS 離線時）'), voiceSel),
        ),
        h('div', { class: 'tts-row' }, aiSwitch, h('div', { class: 'add-inline tts-say' }, sayInput, sayBtn)),
      );
    });

    return card({
      title: '各伺服器設定',
      iconName: 'server',
      tight: true,
      body: blocks.length ? blocks : emptyState('Bot 還沒加入任何伺服器'),
      note: '「AI 回覆自動朗讀」：Bot 在語音頻道時，把 AI 的文字回覆也念出來（等同 /ai tts）。試聽會照正常的 TTS 排隊，正在放的音樂會暫停。',
    });
  }

  load();
}
