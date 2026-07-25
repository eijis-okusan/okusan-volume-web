'use strict';

const state = { files: [], busy: false };
const $ = (id) => document.getElementById(id);
const els = {
  dropZone: $('dropZone'), fileInput: $('fileInput'), selectButton: $('selectButton'),
  filePanel: $('filePanel'), fileList: $('fileList'), clearButton: $('clearButton'),
  volumeSlider: $('volumeSlider'), volumeNumber: $('volumeNumber'), volumeDisplay: $('volumeDisplay'),
  limiterCheck: $('limiterCheck'), normalizeCheck: $('normalizeCheck'),
  convertButton: $('convertButton'), statusText: $('statusText'), progressWrap: $('progressWrap'), progressBar: $('progressBar'),
  helpButton: $('helpButton'), helpDialog: $('helpDialog'), closeHelp: $('closeHelp')
};

els.selectButton.addEventListener('click', () => els.fileInput.click());
els.dropZone.addEventListener('click', (e) => { if (e.target === els.dropZone) els.fileInput.click(); });
els.dropZone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') els.fileInput.click(); });
els.fileInput.addEventListener('change', () => addFiles([...els.fileInput.files]));
['dragenter','dragover'].forEach(type => els.dropZone.addEventListener(type, e => { e.preventDefault(); els.dropZone.classList.add('dragover'); }));
['dragleave','drop'].forEach(type => els.dropZone.addEventListener(type, e => { e.preventDefault(); els.dropZone.classList.remove('dragover'); }));
els.dropZone.addEventListener('drop', e => addFiles([...e.dataTransfer.files]));
els.clearButton.addEventListener('click', () => { state.files = []; renderFiles(); });
els.helpButton.addEventListener('click', () => els.helpDialog.showModal());
els.closeHelp.addEventListener('click', () => els.helpDialog.close());

function setVolume(value) {
  const safe = Math.max(1, Math.min(1000, Number(value) || 100));
  els.volumeNumber.value = safe;
  els.volumeSlider.value = Math.min(400, safe);
  els.volumeDisplay.textContent = safe;
  document.querySelectorAll('[data-volume]').forEach(b => b.classList.toggle('active', Number(b.dataset.volume) === safe));
}
els.volumeSlider.addEventListener('input', e => setVolume(e.target.value));
els.volumeNumber.addEventListener('input', e => setVolume(e.target.value));
document.querySelectorAll('[data-volume]').forEach(btn => btn.addEventListener('click', () => setVolume(btn.dataset.volume)));

function addFiles(files) {
  const audioFiles = files.filter(f => f.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i.test(f.name));
  for (const file of audioFiles) {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (!state.files.some(x => x.key === key)) state.files.push({ key, file });
  }
  els.fileInput.value = '';
  renderFiles();
}

function renderFiles() {
  els.filePanel.classList.toggle('hidden', state.files.length === 0);
  els.convertButton.disabled = state.files.length === 0 || state.busy;
  els.statusText.textContent = state.files.length ? `${state.files.length}件の音声ファイルを処理できます` : '音声ファイルを選択してください';
  els.fileList.replaceChildren(...state.files.map(item => {
    const row = document.createElement('div'); row.className = 'file-item';
    const name = document.createElement('div'); name.className = 'file-name'; name.textContent = item.file.name;
    const meta = document.createElement('div'); meta.className = 'file-meta'; meta.textContent = formatBytes(item.file.size);
    const remove = document.createElement('button'); remove.className = 'remove-file'; remove.type = 'button'; remove.textContent = '×'; remove.title = '外す';
    remove.addEventListener('click', () => { state.files = state.files.filter(x => x.key !== item.key); renderFiles(); });
    row.append(name, meta, remove); return row;
  }));
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

els.convertButton.addEventListener('click', async () => {
  if (!state.files.length || state.busy) return;
  state.busy = true; renderFiles();
  els.progressWrap.classList.remove('hidden');
  const volume = Number(els.volumeNumber.value) / 100;
  try {
    for (let i = 0; i < state.files.length; i++) {
      const file = state.files[i].file;
      updateProgress(i / state.files.length, `解析中：${file.name}`);
      const arrayBuffer = await file.arrayBuffer();
      const context = new AudioContext();
      let decoded;
      try { decoded = await context.decodeAudioData(arrayBuffer.slice(0)); }
      finally { await context.close(); }
      updateProgress((i + .25) / state.files.length, `音量調整中：${file.name}`);
      let rendered = await renderAudio(decoded, volume, els.limiterCheck.checked);
      if (els.normalizeCheck.checked) normalizeBuffer(rendered, 0.891250938); // -1 dB
      updateProgress((i + .75) / state.files.length, `WAV作成中：${file.name}`);
      const blob = audioBufferToWav(rendered);
      downloadBlob(blob, `${stripExtension(file.name)}_${Math.round(volume * 100)}percent.wav`);
      updateProgress((i + 1) / state.files.length, `保存しました：${file.name}`);
      await wait(300);
    }
    els.statusText.textContent = `${state.files.length}件の変換が完了しました`;
  } catch (error) {
    console.error(error);
    els.statusText.textContent = `変換できませんでした：${friendlyError(error)}`;
    alert(`変換できませんでした。\n\n${friendlyError(error)}`);
  } finally {
    state.busy = false; renderFiles();
    setTimeout(() => els.progressWrap.classList.add('hidden'), 1200);
  }
});

async function renderAudio(input, gainValue, limiter) {
  const offline = new OfflineAudioContext(input.numberOfChannels, input.length, input.sampleRate);
  const source = offline.createBufferSource(); source.buffer = input;
  const gain = offline.createGain(); gain.gain.value = gainValue;
  source.connect(gain);
  if (limiter) {
    const compressor = offline.createDynamicsCompressor();
    compressor.threshold.value = -3; compressor.knee.value = 3; compressor.ratio.value = 20;
    compressor.attack.value = 0.003; compressor.release.value = 0.15;
    gain.connect(compressor); compressor.connect(offline.destination);
  } else gain.connect(offline.destination);
  source.start(); return offline.startRendering();
}

function normalizeBuffer(buffer, target) {
  let peak = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  }
  if (!peak || peak <= target) return;
  const scale = target / peak;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) data[i] *= scale;
  }
}

function audioBufferToWav(buffer) {
  const channels = buffer.numberOfChannels, sampleRate = buffer.sampleRate, frames = buffer.length;
  const bytesPerSample = 2, blockAlign = channels * bytesPerSample;
  const out = new ArrayBuffer(44 + frames * blockAlign), view = new DataView(out);
  writeString(view, 0, 'RIFF'); view.setUint32(4, 36 + frames * blockAlign, true); writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * blockAlign, true); view.setUint16(32, blockAlign, true); view.setUint16(34, 16, true);
  writeString(view, 36, 'data'); view.setUint32(40, frames * blockAlign, true);
  const channelData = Array.from({length: channels}, (_, i) => buffer.getChannelData(i));
  let offset = 44;
  for (let i = 0; i < frames; i++) for (let ch = 0; ch < channels; ch++) {
    const sample = Math.max(-1, Math.min(1, channelData[ch][i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true); offset += 2;
  }
  return new Blob([out], { type: 'audio/wav' });
}
function writeString(view, offset, text) { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); }
function downloadBlob(blob, filename) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 3000); }
function stripExtension(name) { return name.replace(/\.[^.]+$/, ''); }
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function updateProgress(ratio, text) { els.progressBar.style.width = `${Math.round(ratio * 100)}%`; els.statusText.textContent = text; }
function friendlyError(error) {
  const text = String(error?.message || error || '不明なエラー');
  if (/decode|encoding|Unable to decode/i.test(text)) return 'この音声形式をブラウザが読み込めません。ChromeまたはEdgeで試すか、WAV・MP3へ変換してください。';
  if (/memory|allocation/i.test(text)) return 'ファイルが大きすぎてメモリが不足した可能性があります。短いファイルでお試しください。';
  return text;
}

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./service-worker.js').catch(console.warn);
