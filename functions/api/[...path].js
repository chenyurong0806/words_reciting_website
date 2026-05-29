export async function onRequest(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const path = '/' + (params.path || '').toString().replace(/^\/+/, '');
  const method = request.method.toUpperCase();

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
  };
  if (method === 'OPTIONS') return new Response('', { headers: cors });

  try {
    if (path === '/books' && method === 'GET') {
      return json(await listBooks(env), cors);
    }

    if (path === '/books' && method === 'POST') {
      const body = await request.json();
      const created = await createBook(env, body);
      return json(created, cors);
    }

    if (path.startsWith('/books/') && method === 'GET') {
      const id = decodeURIComponent(path.slice('/books/'.length));
      const book = await getBook(env, id);
      if (!book) return json({ error: '单词本不存在' }, cors, 404);
      return json(book, cors);
    }

    if (path.startsWith('/books/') && method === 'PUT' && path.endsWith('/progress')) {
      const id = decodeURIComponent(path.slice('/books/'.length, -'/progress'.length));
      const body = await request.json();
      const saved = await saveProgress(env, id, body.progress || {});
      return json(saved, cors);
    }

    if (path.startsWith('/books/') && method === 'PUT') {
      const id = decodeURIComponent(path.slice('/books/'.length));
      const body = await request.json();
      const updated = await updateBook(env, id, body);
      return json(updated, cors);
    }

    if (path.startsWith('/books/') && method === 'DELETE') {
      const id = decodeURIComponent(path.slice('/books/'.length));
      await deleteBook(env, id);
      return json({ ok: true }, cors);
    }

    if (path === '/search' && method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return json({ error: '缺少 q' }, cors, 400);
      const dict = await fetchDict(q);
      const matches = await findAdvancedMatches(env, q);
      return json({ query: q, dict, matches }, cors);
    }

    if (path === '/dict' && method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return json({ error: '缺少 q' }, cors, 400);
      const dict = await fetchDict(q);
      return json(dict, cors);
    }

    return json({ error: 'Not found' }, cors, 404);
  } catch (err) {
    return json({ error: err?.message || String(err) }, cors, 500);
  }
}

const GH = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const BASE = 'wordvault';
const INDEX_PATH = `${BASE}/index.json`;
const PROGRESS_DIR = `${BASE}/progress`;

function json(data, headers = {}, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...headers },
  });
}

function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

async function githubRequest(env, method, path, body) {
  const token = env.GITHUB_TOKEN;
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || 'main';
  if (!token || !owner || !repo) {
    throw new Error('请先在 Cloudflare Secrets/Variables 中设置 GITHUB_TOKEN、GITHUB_OWNER、GITHUB_REPO、GITHUB_BRANCH');
  }

  const url = `${GH}/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`;
  const headers = {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${token}`,
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'WordVault-Cloudflare',
  };
  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = data?.message || text || `GitHub API error ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function b64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function fromB64(str) {
  return decodeURIComponent(escape(atob(str)));
}

async function readTextFile(env, path) {
  try {
    const data = await githubRequest(env, 'GET', path);
    if (Array.isArray(data)) return { exists: true, isDir: true, data };
    return {
      exists: true,
      sha: data.sha,
      text: data.content ? fromB64(data.content.replace(/\n/g, '')) : '',
      raw: data,
    };
  } catch (err) {
    if (err.status === 404) return { exists: false, text: '' };
    throw err;
  }
}

async function writeTextFile(env, path, text, message) {
  let sha = null;
  try {
    const current = await githubRequest(env, 'GET', path);
    sha = current.sha;
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  const body = {
    message,
    content: b64(text),
  };
  if (sha) body.sha = sha;
  return await githubRequest(env, 'PUT', path, body);
}

async function deleteTextFile(env, path, message) {
  const current = await githubRequest(env, 'GET', path);
  return await githubRequest(env, 'DELETE', path, {
    message,
    sha: current.sha,
  });
}

async function getIndex(env) {
  const file = await readTextFile(env, INDEX_PATH);
  if (!file.exists || !file.text) return { version: 1, books: [] };
  try {
    const parsed = JSON.parse(file.text);
    if (!parsed.books) parsed.books = [];
    return parsed;
  } catch {
    return { version: 1, books: [] };
  }
}

async function saveIndex(env, index) {
  return await writeTextFile(env, INDEX_PATH, JSON.stringify(index, null, 2), 'Update wordvault index');
}

function slugify(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[\s]+/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fa5\-_]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'book';
}

function uniqueId(base, existing) {
  let id = base;
  let n = 1;
  const set = new Set(existing);
  while (set.has(id)) id = `${base}-${n++}`;
  return id;
}

function normalizeWords(text) {
  return [...new Set(
    String(text || '')
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean)
  )];
}

function normalizeAdvanced(items) {
  const list = Array.isArray(items) ? items : [];
  return list
    .map((x) => ({
      term: String(x?.term || x?.word || '').trim(),
      definitions: Array.isArray(x?.definitions)
        ? x.definitions.map(v => String(v).trim()).filter(Boolean)
        : String(x?.definition || '').trim() ? [String(x.definition).trim()] : [],
      note: String(x?.note || '').trim(),
      addedAt: x?.addedAt || new Date().toISOString(),
    }))
    .filter(x => x.term);
}

async function createBook(env, body) {
  const name = String(body?.name || '').trim();
  const type = body?.type === 'advanced' ? 'advanced' : 'normal';
  if (!name) throw new Error('单词本名称不能为空');

  const index = await getIndex(env);
  const existingIds = index.books.map(b => b.id);
  const id = uniqueId(slugify(name), existingIds);

  let filePath;
  let content;
  let count = 0;
  if (type === 'normal') {
    const words = normalizeWords(body?.text || body?.words || '');
    filePath = `${BASE}/normal/${id}.txt`;
    content = words.join('\n');
    count = words.length;
    await writeTextFile(env, filePath, content, `Create normal book ${name}`);
  } else {
    const items = normalizeAdvanced(body?.items || []);
    filePath = `${BASE}/advanced/${id}.json`;
    content = JSON.stringify({
      id,
      name,
      type,
      items,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, null, 2);
    count = items.length;
    await writeTextFile(env, filePath, content, `Create advanced book ${name}`);
  }

  const meta = {
    id,
    name,
    type,
    path: filePath,
    progressPath: `${PROGRESS_DIR}/${id}.json`,
    count,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  index.books.unshift(meta);
  await saveIndex(env, index);
  await writeTextFile(env, meta.progressPath, JSON.stringify({}, null, 2), `Init progress for ${name}`);
  return await getBook(env, id);
}

async function updateBook(env, id, body) {
  const index = await getIndex(env);
  const meta = index.books.find(b => b.id === id);
  if (!meta) throw new Error('单词本不存在');

  let filePath = meta.path;
  let count = meta.count || 0;

  if (meta.type === 'normal' && body?.action === 'add-word') {
    const current = await getBook(env, id);
    const words = new Set(current.words || []);
    const word = String(body.word || '').trim();
    if (!word) throw new Error('单词不能为空');
    words.add(word);
    const arr = [...words];
    await writeTextFile(env, filePath, arr.join('\n'), `Add word to ${meta.name}`);
    count = arr.length;
  } else if (meta.type === 'advanced' && body?.action === 'add-advanced') {
    const current = await getBook(env, id);
    const items = normalizeAdvanced(current.items || []);
    const item = normalizeAdvanced([body.item || {}])[0];
    if (!item?.term) throw new Error('条目不能为空');
    const exists = items.findIndex(x => x.term.toLowerCase() === item.term.toLowerCase());
    if (exists >= 0) {
      items[exists] = item;
    } else {
      items.push(item);
    }
    await writeTextFile(env, filePath, JSON.stringify({
      id,
      name: meta.name,
      type: 'advanced',
      items,
      updatedAt: new Date().toISOString(),
    }, null, 2), `Add advanced item to ${meta.name}`);
    count = items.length;
  } else if (meta.type === 'normal' && body?.action === 'save-normal') {
    const words = normalizeWords(body.words || []);
    await writeTextFile(env, filePath, words.join('\n'), `Save normal book ${meta.name}`);
    count = words.length;
  } else if (meta.type === 'advanced' && body?.action === 'save-advanced') {
    const items = normalizeAdvanced(body.items || []);
    await writeTextFile(env, filePath, JSON.stringify({
      id,
      name: meta.name,
      type: 'advanced',
      items,
      updatedAt: new Date().toISOString(),
    }, null, 2), `Save advanced book ${meta.name}`);
    count = items.length;
  } else if (body?.action === 'rename') {
    meta.name = String(body.name || '').trim() || meta.name;
  } else {
    throw new Error('不支持的更新操作');
  }

  meta.count = count;
  meta.updatedAt = new Date().toISOString();
  await saveIndex(env, index);
  return await getBook(env, id);
}

async function deleteBook(env, id) {
  const index = await getIndex(env);
  const idx = index.books.findIndex(b => b.id === id);
  if (idx < 0) throw new Error('单词本不存在');
  const meta = index.books[idx];

  try { await deleteTextFile(env, meta.path, `Delete book ${meta.name}`); } catch {}
  try { await deleteTextFile(env, meta.progressPath, `Delete progress ${meta.name}`); } catch {}
  index.books.splice(idx, 1);
  await saveIndex(env, index);
}

async function saveProgress(env, id, progress) {
  const index = await getIndex(env);
  const meta = index.books.find(b => b.id === id);
  if (!meta) throw new Error('单词本不存在');
  await writeTextFile(env, meta.progressPath, JSON.stringify(progress || {}, null, 2), `Update progress ${meta.name}`);
  return { ok: true };
}

async function getBook(env, id) {
  const index = await getIndex(env);
  const meta = index.books.find(b => b.id === id);
  if (!meta) return null;
  const file = await readTextFile(env, meta.path);
  const progressFile = await readTextFile(env, meta.progressPath);
  const progress = progressFile.exists && progressFile.text ? JSON.parse(progressFile.text) : {};
  if (meta.type === 'normal') {
    const words = file.exists && file.text ? normalizeWords(file.text) : [];
    return {
      book: meta,
      words,
      previewWords: words.slice(0, 50),
      progress,
    };
  }
  let items = [];
  if (file.exists && file.text) {
    try {
      const parsed = JSON.parse(file.text);
      items = Array.isArray(parsed.items) ? parsed.items : [];
    } catch {
      items = [];
    }
  }
  const normalized = normalizeAdvanced(items);
  return {
    book: meta,
    items: normalized,
    previewItems: normalized.slice(0, 50),
    progress,
  };
}

async function listBooks(env) {
  const index = await getIndex(env);
  const books = index.books.slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return { books };
}

async function fetchDict(word) {
  const w = String(word || '').trim();
  const urls = [
    `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(w)}`
  ];
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) {
        lastErr = new Error(`词典接口返回 ${res.status}`);
        continue;
      }
      const data = await res.json();
      const entry = Array.isArray(data) ? data[0] : data;
      const phonetics = Array.isArray(entry?.phonetics) ? entry.phonetics : [];
      const audio = phonetics.find(x => x?.audio)?.audio || '';
      const phonetic = entry?.phonetic || phonetics.find(x => x?.text)?.text || '';
      const meanings = [];
      (entry?.meanings || []).forEach(m => {
        const def = m?.definitions?.[0];
        if (def?.definition) {
          meanings.push({
            partOfSpeech: m?.partOfSpeech || '',
            definition: def.definition,
            example: def.example || '',
          });
        }
      });
      return {
        word: entry?.word || w,
        phonetic,
        audio,
        meanings: meanings.slice(0, 8),
        raw: entry,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(lastErr?.message || '词典查询失败');
}

async function findAdvancedMatches(env, q) {
  const index = await getIndex(env);
  const target = String(q || '').trim().toLowerCase();
  const out = [];
  for (const book of index.books.filter(b => b.type === 'advanced')) {
    try {
      const file = await readTextFile(env, book.path);
      if (!file.exists || !file.text) continue;
      const parsed = JSON.parse(file.text);
      const items = normalizeAdvanced(parsed.items || []);
      items.filter(x => x.term.toLowerCase().includes(target) || target.includes(x.term.toLowerCase()))
        .forEach(x => {
          out.push({
            bookId: book.id,
            bookName: book.name,
            term: x.term,
            definitions: x.definitions || [],
            note: x.note || '',
          });
        });
    } catch {}
  }
  return out;
}
