const { app, BrowserWindow, ipcMain, shell, safeStorage, globalShortcut, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const MAX_STEPS = 8;

let win = null;
let tray = null;
let history = [];

/* ---------- config (API key шифруется через safeStorage / Windows DPAPI) ---------- */
const cfgPath = () => path.join(app.getPath('userData'), 'config.json');
function loadCfg() { try { return JSON.parse(fs.readFileSync(cfgPath(), 'utf8')); } catch { return {}; } }
function saveCfg(c) { fs.mkdirSync(path.dirname(cfgPath()), { recursive: true }); fs.writeFileSync(cfgPath(), JSON.stringify(c, null, 2)); }
function getKey() {
  const c = loadCfg();
  if (!c.keyEnc) return null;
  try { return safeStorage.decryptString(Buffer.from(c.keyEnc, 'base64')); } catch { return null; }
}
function setKey(k) {
  const c = loadCfg();
  c.keyEnc = safeStorage.encryptString(k.trim()).toString('base64');
  saveCfg(c);
}

/* ---------- инструменты ---------- */
const BUILTIN_APPS = {
  'блокнот': 'notepad.exe', notepad: 'notepad.exe',
  'калькулятор': 'calc.exe', calculator: 'calc.exe',
  paint: 'mspaint.exe', 'пейнт': 'mspaint.exe',
  'проводник': 'explorer.exe', explorer: 'explorer.exe',
  'диспетчер задач': 'taskmgr.exe', 'task manager': 'taskmgr.exe',
};
const SEARCH_ENGINES = {
  google: q => 'https://www.google.com/search?q=' + encodeURIComponent(q),
  yandex: q => 'https://yandex.ru/search/?text=' + encodeURIComponent(q),
  duckduckgo: q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
  youtube: q => 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q),
  maps: q => 'https://www.google.com/maps/search/' + encodeURIComponent(q),
};
const FOLDERS = {
  downloads: () => app.getPath('downloads'),
  documents: () => app.getPath('documents'),
  desktop: () => app.getPath('desktop'),
  pictures: () => app.getPath('pictures'),
  music: () => app.getPath('music'),
  videos: () => app.getPath('videos'),
};

const TOOLS = [
  {
    name: 'open_url',
    description: 'Открыть сайт (http/https) во вкладке браузера по умолчанию.',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'open_tabs',
    description: 'Открыть несколько вкладок сразу (до 10 ссылок).',
    input_schema: { type: 'object', properties: { urls: { type: 'array', items: { type: 'string' } } }, required: ['urls'] },
  },
  {
    name: 'web_search',
    description: 'Открыть поиск в браузере. engine: google, yandex, duckduckgo, youtube, maps.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' }, engine: { type: 'string', enum: Object.keys(SEARCH_ENGINES) } },
      required: ['query'],
    },
  },
  {
    name: 'launch_app',
    description: 'Запустить приложение по имени: блокнот, калькулятор, paint, проводник, диспетчер задач или добавленное пользователем.',
    input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'open_folder',
    description: 'Открыть папку: downloads, documents, desktop, pictures, music, videos.',
    input_schema: { type: 'object', properties: { name: { type: 'string', enum: Object.keys(FOLDERS) } }, required: ['name'] },
  },
  {
    name: 'get_system_info',
    description: 'Текущее время, ОС, процессор, память, имя компьютера.',
    input_schema: { type: 'object', properties: {} },
  },
];

function safeUrl(u) {
  let url;
  try { url = new URL(/^[a-z]+:\/\//i.test(u) ? u : 'https://' + u); } catch { return null; }
  return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
}

async function confirm(message) {
  const r = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Да', 'Нет'], defaultId: 1, cancelId: 1, title: 'JARVIS', message,
  });
  return r.response === 0;
}

async function runTool(name, input) {
  switch (name) {
    case 'open_url': {
      const u = safeUrl(input.url);
      if (!u) return 'Ошибка: допустимы только http/https ссылки.';
      await shell.openExternal(u);
      return 'Открыто: ' + u;
    }
    case 'open_tabs': {
      const urls = (input.urls || []).slice(0, 10).map(safeUrl).filter(Boolean);
      if (!urls.length) return 'Ошибка: нет корректных ссылок.';
      if (urls.length > 3 && !(await confirm(`Открыть ${urls.length} вкладок?`))) return 'Пользователь отказался.';
      for (const u of urls) { await shell.openExternal(u); await new Promise(r => setTimeout(r, 250)); }
      return 'Открыто вкладок: ' + urls.length;
    }
    case 'web_search': {
      const make = SEARCH_ENGINES[input.engine] || SEARCH_ENGINES.google;
      const u = make(String(input.query || ''));
      await shell.openExternal(u);
      return 'Поиск открыт: ' + u;
    }
    case 'launch_app': {
      const key = String(input.name || '').toLowerCase().trim();
      const custom = loadCfg().apps || {};
      let exe = BUILTIN_APPS[key];
      if (!exe && custom[key]) {
        if (!(await confirm(`Запустить «${key}»?\n${custom[key]}`))) return 'Пользователь отказался.';
        exe = custom[key];
      }
      if (!exe) return 'Приложение не найдено. Пользователь может добавить его кнопкой «+ Приложение».';
      try {
        const child = spawn(exe, [], { detached: true, stdio: 'ignore', shell: false });
        child.on('error', () => {});
        child.unref();
        return 'Запущено: ' + key;
      } catch (e) { return 'Ошибка запуска: ' + e.message; }
    }
    case 'open_folder': {
      const f = FOLDERS[input.name];
      if (!f) return 'Неизвестная папка.';
      const err = await shell.openPath(f());
      return err ? 'Ошибка: ' + err : 'Папка открыта: ' + input.name;
    }
    case 'get_system_info':
      return JSON.stringify({
        time: new Date().toLocaleString('ru-RU'),
        os: `${os.type()} ${os.release()}`,
        cpu: os.cpus()[0]?.model,
        cores: os.cpus().length,
        ramFreeGB: (os.freemem() / 2 ** 30).toFixed(1),
        ramTotalGB: (os.totalmem() / 2 ** 30).toFixed(1),
        host: os.hostname(),
      });
    default:
      return 'Неизвестный инструмент: ' + name;
  }
}

/* ---------- агентный цикл ---------- */
const SYSTEM = `Ты JARVIS — голосовой ИИ-ассистент на компьютере пользователя (Windows).
Отвечай на языке пользователя, коротко и по делу — ответы будут озвучены.
Когда просят открыть сайт, найти что-то, запустить программу или папку — используй инструменты, а не объясняй как это сделать.
Для неизвестных сайтов используй web_search. Не выдумывай ссылки, если не уверен в адресе.`;

function trimHistory() {
  while (history.length > 40) history.shift();
  // история должна начинаться с обычного сообщения пользователя (без tool_result)
  while (history.length && !(history[0].role === 'user' && typeof history[0].content === 'string')) history.shift();
}

async function callApi(key, model) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 1024, system: SYSTEM, tools: TOOLS, messages: history }),
  });
  if (!res.ok) {
    let msg = res.status + '';
    try { msg += ' ' + (await res.json()).error.message; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

async function ask(text) {
  const key = getKey();
  if (!key) return { error: 'Сначала введите API-ключ Anthropic (кнопка ⚙).' };
  const model = loadCfg().model || DEFAULT_MODEL;
  history.push({ role: 'user', content: text });
  trimHistory();
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const data = await callApi(key, model);
      history.push({ role: 'assistant', content: data.content });
      const calls = data.content.filter(b => b.type === 'tool_use');
      if (!calls.length) {
        return { text: data.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim() };
      }
      const results = [];
      for (const c of calls) {
        win?.webContents.send('jarvis:event', { type: 'tool', name: c.name, input: c.input });
        let out;
        try { out = await runTool(c.name, c.input || {}); } catch (e) { out = 'Ошибка: ' + e.message; }
        results.push({ type: 'tool_result', tool_use_id: c.id, content: String(out) });
      }
      history.push({ role: 'user', content: results });
    }
    return { text: 'Слишком много шагов подряд, остановился.' };
  } catch (e) {
    history.pop(); // откатываем неудачный запрос
    return { error: 'Ошибка API: ' + e.message };
  }
}

/* ---------- окно, трей, горячая клавиша ---------- */
function createWindow() {
  win = new BrowserWindow({
    width: 460, height: 700, minWidth: 380, minHeight: 500,
    backgroundColor: '#070b14', title: 'JARVIS', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { const u = safeUrl(url); if (u) shell.openExternal(u); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_, permission, cb) => cb(permission === 'media'));
  win.on('close', e => { if (!app.isQuitting) { e.preventDefault(); win.hide(); } });
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible() && win.isFocused()) win.hide(); else { win.show(); win.focus(); win.webContents.send('jarvis:event', { type: 'focus' }); }
}

app.whenReady().then(() => {
  createWindow();
  tray = new Tray(nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='));
  tray.setToolTip('JARVIS (Ctrl+Alt+J)');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Показать / скрыть', click: toggleWindow },
    { label: 'Выход', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', toggleWindow);
  globalShortcut.register('Control+Alt+J', toggleWindow);

  ipcMain.handle('jarvis:ask', (_, text) => ask(String(text).slice(0, 4000)));
  ipcMain.handle('jarvis:hasKey', () => !!getKey());
  ipcMain.handle('jarvis:setKey', (_, k) => { setKey(String(k)); return true; });
  ipcMain.handle('jarvis:reset', () => { history = []; return true; });
  ipcMain.handle('jarvis:addApp', async (_, name) => {
    const r = await dialog.showOpenDialog(win, { filters: [{ name: 'Программы', extensions: ['exe', 'lnk', 'bat'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return false;
    const c = loadCfg();
    c.apps = c.apps || {};
    c.apps[String(name).toLowerCase().trim()] = r.filePaths[0];
    saveCfg(c);
    return true;
  });
});

app.on('window-all-closed', () => {});
app.on('will-quit', () => globalShortcut.unregisterAll());
