export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ===== 1. 提取 /api/ 后面的路径 =====
    const path = url.pathname.replace(/^\/api\//, "");
    const method = request.method;

    // ===== 2. CORS =====
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // ===== 3. 路由分发 =====
    try {

      // =========================
      // 📘 查词接口 /api/dict?word=xxx
      // =========================
      if (path === "dict") {
        const word = url.searchParams.get("word");

        if (!word) {
          return json({ error: "missing word" }, corsHeaders, 400);
        }

        const result = await fetchYoudao(word);

        return json({ word, result }, corsHeaders);
      }

      // =========================
      // 📁 GitHub 单词本接口
      // /api/github?action=list
      // /api/github?action=save
      // =========================
      if (path === "github") {
        const action = url.searchParams.get("action");

        if (action === "list") {
          const data = await githubList(env);
          return json(data, corsHeaders);
        }

        if (action === "save") {
          const body = await request.json();
          const data = await githubSave(body, env);
          return json(data, corsHeaders);
        }

        return json({ error: "unknown github action" }, corsHeaders, 400);
      }

      // =========================
      // 🌐 默认兜底路由
      // =========================
      return json({
        error: "API not found",
        path
      }, corsHeaders, 404);

    } catch (err) {
      return json({
        error: "server error",
        detail: err.message
      }, corsHeaders, 500);
    }
  }
};

// ===============================
// 🧠 有道词典（替代 API：Free Dictionary API）
// ===============================
async function fetchYoudao(word) {
  const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${word}`);
  if (!res.ok) return null;
  return await res.json();
}

// ===============================
// 📁 GitHub：获取单词本
// ===============================
async function githubList(env) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const token = env.GITHUB_TOKEN;

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Accept": "application/vnd.github+json"
    }
  });

  return await res.json();
}

// ===============================
// 💾 GitHub：保存文件
// ===============================
async function githubSave(body, env) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const token = env.GITHUB_TOKEN;

  const { path, content, message } = body;

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: message || "update wordbook",
        content: btoa(unescape(encodeURIComponent(content)))
      })
    }
  );

  return await res.json();
}

// ===============================
// 📦 JSON 返回工具
// ===============================
function json(data, headers = {}, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers
    }
  });
}
