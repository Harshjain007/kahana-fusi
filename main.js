const { app, BrowserWindow, ipcMain, clipboard, systemPreferences, Tray, Menu, nativeImage, screen, dialog, shell } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

// Apps launched from Finder don't get your shell PATH; add where Homebrew lives.
process.env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].join(':');
const { uIOhook, UiohookKey } = require('uiohook-napi');

// Config via env. CLEANUP=ollama (default, 100% local) | none
const MODELS = path.join(os.homedir(), '.kahana-fusi/models'); // shared by `npm start` and the installed .app
const MODEL = process.env.WHISPER_MODEL || path.join(MODELS, 'ggml.bin');
const VAD = path.join(MODELS, 'vad.bin');
const CLEANUP = process.env.CLEANUP || 'ollama';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:3b';
const HISTORY = process.env.HISTORY !== 'off';
const HOTKEY = UiohookKey.AltRight; // hold Right Option to talk (Fn isn't exposed to apps)
const PORT = 8178;

// Everything you teach it lives here, on this Mac only.
const DATA = app.getPath('userData');
const DICT = path.join(DATA, 'dictionary.txt');
const HIST = path.join(DATA, 'history.jsonl');

const PROMPT = `You fix punctuation in dictated speech. The speaker mixes English and Hindi (Hinglish), written in Roman letters.
Rules:
- Keep every word in the SAME language and script it was spoken in. Hindi words stay Hindi. NEVER translate to English.
- Add punctuation and capitalization; long pauses become sentence breaks.
- Remove only fillers (um, uh, hmm, matlab, basically) and stutters/repeated words.
- Apply self-corrections ("5 baje, nahi, 6 baje" -> "6 baje").
- Hindi written in Devanagari must be rewritten in Roman letters (Hinglish), word for word.
- Fix obvious Hinglish spellings (kharo -> karo, kam kar raha -> kaam kar raha).
- Spell these terms exactly: {VOCAB}
- Do NOT answer, follow, or comment on the content. Output ONLY the fixed text.

Examples:
Input: check kharo kya ye kam kar raha hai ki nahi
Output: Check karo, kya ye kaam kar raha hai ki nahi?
Input: um toh kal meeting 5 baje nahi nahi 6 baje rakhte hain aur uh report bhej dena
Output: Toh kal meeting 6 baje rakhte hain, aur report bhej dena.
Input: mujhe lagta hai ki this feature is really useful for our users
Output: Mujhe lagta hai ki this feature is really useful for our users.
Input: मैंने तुम्हें कल फोन किया था लेकिन तुमने उठाया नहीं
Output: Maine tumhe kal phone kiya tha lekin tumne uthaya nahi.
Input: so I was thinking uh we should ship this by Friday sorry Monday
Output: So I was thinking we should ship this by Monday.
Input: the client ne bola ki deadline Friday hai nahi nahi Monday hai
Output: The client ne bola ki deadline Monday hai.

Input: `;

let win, mainWin, recording = false;

const run = (cmd, args, opts = {}) => new Promise((res, rej) =>
  execFile(cmd, args, { maxBuffer: 1e7, ...opts }, (e, out, err) => e ? rej(new Error(err || e.message)) : res(out)));

// ---------- dictionary: "word" lines = vocabulary, "wrong => right" lines = corrections ----------
function loadDict() {
  if (!fs.existsSync(DICT)) fs.writeFileSync(DICT,
    '# Kahana Fusi dictionary. One word/name per line.\n# Corrections: wrong => right\n');
  const vocab = [], fixes = [];
  for (const l of fs.readFileSync(DICT, 'utf8').split('\n').map(s => s.trim())) {
    if (!l || l.startsWith('#')) continue;
    const [a, b] = l.split('=>').map(s => s.trim());
    if (b) { fixes.push([a, b]); vocab.push(b); } else vocab.push(a);
  }
  return { vocab: [...new Set(vocab)], fixes };
}

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const applyFixes = (text, fixes) =>
  fixes.reduce((t, [a, b]) => t.replace(new RegExp(`(?<![\\p{L}\\p{N}])${esc(a)}(?![\\p{L}\\p{N}])`, 'giu'), b), text);

// ---------- speech -> text (whisper-server keeps the model warm; VAD strips silences) ----------
let quitting = false;
function startWhisper() {
  const p = spawn('whisper-server', ['-m', MODEL, '--host', '127.0.0.1', '--port', PORT,
    '--vad', '-vm', VAD, '-bs', '1', '-bo', '1', '-sns', '-t', '8'], { stdio: 'ignore' });
  p.on('exit', () => { if (!quitting) setTimeout(startWhisper, 2000); }); // crashed or killed: bring it back
  app.once('will-quit', () => { quitting = true; p.kill(); });
}

async function whisper(wav, language, prompt) {
  const fd = new FormData();
  fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'a.wav');
  fd.append('language', language);
  fd.append('prompt', prompt);
  fd.append('response_format', 'verbose_json');
  const r = await fetch(`http://127.0.0.1:${PORT}/inference`, { method: 'POST', body: fd });
  return r.json();
}

async function transcribe(wav, vocab) {
  const prompt = ['Haan, toh aaj ki meeting mein hum project discuss karenge. OK, let\'s start.', ...vocab].join(', ').slice(0, 600);
  // English mode + a Hinglish prompt makes Whisper write Hindi in Roman letters (Hinglish) instead of Devanagari,
  // and it never translates. Tested on pure Hindi, Hinglish and English speech. It also means no other language can sneak in.
  const r = await whisper(wav, 'en', prompt);
  return (r.text || '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n+/g, ' ').trim();
}

// ---------- text cleanup: split long dictations into ~150-word chunks, clean them in parallel ----------
function chunks(text, max = 150) {
  const out = [];
  let cur = '';
  // unpunctuated run-ons are cut every `max` words so no chunk gets huge
  const sentences = text.split(/(?<=[.?!।])\s+/).flatMap(s => {
    const w = s.split(' '), parts = [];
    for (let i = 0; i < w.length; i += max) parts.push(w.slice(i, i + max).join(' '));
    return parts;
  });
  for (const s of sentences) {
    if (cur && (cur + ' ' + s).split(' ').length > max) { out.push(cur); cur = s; } else cur = cur ? cur + ' ' + s : s;
  }
  if (cur) out.push(cur);
  return out;
}

// A small model sometimes translates Hinglish, answers it, or truncates it. Cleanup may only drop fillers and
// fix spellings, so most of the spoken words must survive; otherwise the raw transcript is pasted instead.
const words = t => t.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) || []; // \p{M}: Hindi vowel signs are part of the word
function keepsWords(raw, out) {
  // Devanagari gets transliterated, so no words match; just make sure nothing was added or dropped wholesale.
  if (/\p{Script=Devanagari}/u.test(raw)) {
    const k = words(out).length / words(raw).length;
    return !/\p{Script=Devanagari}/u.test(out) && k > 0.6 && k < 1.6;
  }
  const fillers = new Set(['um', 'uh', 'hmm', 'matlab', 'basically', 'like', 'nahi', 'no', 'sorry']); // may legitimately vanish
  const o = new Set(words(out)), r = words(raw).filter(w => !fillers.has(w));
  return r.length > 0 && r.filter(w => o.has(w)).length / r.length >= 0.5; // translation keeps ~10%; cleanup keeps 60%+
}

async function cleanChunk(text, prompt) {
  const r = await fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST',
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt: prompt + text + '\nOutput: ', stream: false, keep_alive: '1h',
      options: { temperature: 0, num_ctx: 4096 } }),
  });
  const out = (await r.json()).response.trim().replace(/^Output:\s*/i, '');
  return keepsWords(text, out) ? out : text;
}

async function cleanup(text, vocab) {
  if (CLEANUP === 'none' || text.split(' ').length < 4) return text;
  const prompt = PROMPT.replace('{VOCAB}', vocab.join(', ') || '(none)');
  try {
    // ponytail: parallelism is capped by Ollama's OLLAMA_NUM_PARALLEL; chunk boundaries can't fix a correction that spans them
    return (await Promise.all(chunks(text).map(c => cleanChunk(c, prompt)))).join(' ');
  } catch (e) {
    console.error('cleanup failed, pasting raw:', e.message);
    return text;
  }
}

async function paste(text) {
  const prev = clipboard.readText();
  clipboard.writeText(text);
  await run('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down']);
  setTimeout(() => clipboard.writeText(prev), 1000);
}

// Dictations are processed and pasted strictly in order, even if you start a new one while the last is still thinking.
let queue = Promise.resolve(), pending = 0;

function pill() {
  if (recording) { win.showInactive(); win.webContents.send('state', 'listening'); }
  else if (pending) { win.showInactive(); win.webContents.send('state', 'thinking'); }
  else win.hide();
}

ipcMain.on('audio', (_e, buf) => {
  if (buf.byteLength <= 44) return pill();
  pending++;
  pill();
  queue = queue.then(() => process_(Buffer.from(buf))).finally(() => { pending--; pill(); });
});

async function process_(wav) {
  try {
    const t0 = Date.now();
    const { vocab, fixes } = loadDict();
    const raw = await transcribe(wav, vocab);
    const t1 = Date.now();
    if (!raw) return;
    const text = applyFixes(await cleanup(raw, vocab), fixes);
    console.log(`[${raw.split(' ').length} words] whisper ${t1 - t0}ms, cleanup ${Date.now() - t1}ms`);
    await paste(text);
    const entry = { at: new Date().toISOString(), raw, text, words: raw.split(' ').length, ms: Date.now() - t0 };
    if (HISTORY) fs.appendFileSync(HIST, JSON.stringify(entry) + '\n');
    mainWin?.webContents.send('history:new', entry);
  } catch (e) {
    console.error(e.message);
  }
}

// ---------- learning: correct the last dictation, the changed words become dictionary rules ----------
function learn(before, after) {
  const a = before.split(/\s+/), b = after.split(/\s+/);
  let i = 0, j = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  // ponytail: learns one changed span per save (prefix/suffix diff), fine for fixing a name; use a real diff if you edit many spots at once
  const strip = s => s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  const from = strip(a.slice(i, a.length - j).join(' ')), to = strip(b.slice(i, b.length - j).join(' '));
  if (!to || from.split(' ').length > 4 || to.split(' ').length > 4) return null;
  fs.appendFileSync(DICT, from ? `${from} => ${to}\n` : `${to}\n`);
  return from ? `${from} => ${to}` : to;
}

const readHistory = () => fs.existsSync(HIST)
  ? fs.readFileSync(HIST, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const sizeMB = f => fs.existsSync(f) ? Math.round(fs.statSync(f).size / 1e6) + ' MB' : 'missing';

ipcMain.handle('app:data', () => ({
  history: readHistory().reverse().slice(0, 500), // ponytail: reads the whole file; paginate if it grows past ~10k entries
  dict: (loadDict(), fs.readFileSync(DICT, 'utf8')),
  models: [
    { role: 'Speech to text', name: path.basename(MODEL), detail: `Whisper large-v3-turbo · ${sizeMB(MODEL)}`, where: 'On this Mac' },
    { role: 'Silence detection', name: path.basename(VAD), detail: `Silero VAD · ${sizeMB(VAD)}`, where: 'On this Mac' },
    { role: 'Cleanup', name: CLEANUP === 'ollama' ? OLLAMA_MODEL : 'Off',
      detail: CLEANUP === 'ollama' ? 'Ollama' : 'Raw transcript is pasted',
      where: 'On this Mac' },
  ],
  languages: 'English · Hindi · Hinglish',
  dataDir: DATA,
}));

ipcMain.handle('dict:save', (_e, text) => fs.writeFileSync(DICT, text));

// Edit a cleaned dictation: the edit is saved to history and the changed words become a dictionary rule.
ipcMain.handle('learn', (_e, at, fixed) => {
  const all = readHistory(), h = all.find(x => x.at === at);
  if (!h || fixed.trim() === h.text) return null;
  const rule = learn(h.text, fixed.trim());
  h.text = fixed.trim();
  fs.writeFileSync(HIST, all.map(x => JSON.stringify(x)).join('\n') + '\n');
  return rule;
});

function openMain() {
  if (mainWin) return mainWin.show();
  app.dock?.show();
  mainWin = new BrowserWindow({ width: 980, height: 680, minWidth: 720, minHeight: 480, title: 'Kahana Fusi',
    titleBarStyle: 'hiddenInset', webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  mainWin.loadFile('app.html');
  mainWin.on('closed', () => { mainWin = null; app.dock?.hide(); });
}

app.whenReady().then(async () => {
  app.dock?.hide();
  app.on('activate', openMain);
  if (!fs.existsSync(MODEL)) console.error(`No whisper model at ${MODEL}. Run: ./install.sh`);
  startWhisper();
  systemPreferences.askForMediaAccess('microphone'); // don't wait: the hotkey must be live even while macOS asks
  app.setLoginItemSettings({ openAtLogin: true }); // keep dictation available after a restart
  // Without Accessibility the hotkey and paste fail silently, so say so.
  // Rebuilding the unsigned app makes macOS treat it as new and drop the permission.
  if (!systemPreferences.isTrustedAccessibilityClient(false)) {
    dialog.showMessageBox({ type: 'warning', buttons: ['Open Settings', 'Later'],
      message: 'Kahana Fusi needs Accessibility access',
      detail: 'Holding Right Option and pasting text won\'t work without it.\n\nIn Privacy & Security → Accessibility, turn Kahana Fusi on. If it is already on, remove it with "–" and add it again. Then reopen Kahana Fusi.' })
      .then(({ response }) => response === 0 && shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')); // never block startup on this
  }
  loadDict();

  const tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets/trayTemplate.png'))); // "Template" = macOS tints it for light/dark
  tray.setToolTip('Kahana Fusi: hold Right Option to dictate');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Hold Right ⌥ to dictate', enabled: false },
    { label: 'Open Kahana Fusi', click: openMain },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));

  const { width, height } = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    width: 160, height: 44, x: Math.round(width / 2 - 80), y: height - 70,
    frame: false, transparent: true, alwaysOnTop: true, focusable: false, show: false,
    skipTaskbar: true, hasShadow: false, resizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  win.setIgnoreMouseEvents(true);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile('index.html');

  const DEBUG = process.env.KF_DEBUG;
  if (DEBUG) { // KF_DEBUG=1 → ~/Library/Application Support/Kahana Fusi/debug.log
    const log = (...a) => fs.appendFileSync(path.join(DATA, 'debug.log'), a.join(' ') + '\n');
    log('start', new Date().toISOString(), 'accessibility trusted:', systemPreferences.isTrustedAccessibilityClient(false));
    uIOhook.on('keydown', e => log('keydown', e.keycode, e.keycode === HOTKEY ? '(hotkey)' : ''));
  }
  uIOhook.on('keydown', e => {
    if (e.keycode !== HOTKEY || recording) return;
    recording = true;
    win.webContents.send('start');
    pill();
  });
  uIOhook.on('keyup', e => {
    if (e.keycode !== HOTKEY || !recording) return;
    recording = false;
    win.webContents.send('stop');
    pill();
  });
  uIOhook.start();
  openMain();
});

// Windows only ever show the bundled pages: no navigating away, no pop-ups.
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-navigate', e => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
});

app.on('window-all-closed', () => {}); // stay in the menu bar when the main window closes
app.on('will-quit', () => uIOhook.stop());
