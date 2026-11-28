"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const API_URL = "https://rika-ai-api.nguyentiendungdz765hd.workers.dev";
const RIKA_MODEL = "./hiyori_pro_t11.model3.json";

const STORAGE_KEY = "rika_ai_conversations_v2";
const SETTINGS_KEY = "rika_ai_settings_v2";
const SUBJECT_KEY = "rika_subject_v2";

const MAX_HISTORY = 40;
const MAX_MESSAGES_PER_CHAT = 100;
const API_TIMEOUT_MS = 45000;
const MAX_CONTEXT_MESSAGES = 30;

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_PREVIEW_CHARS = 20000;
const TEXT_EXTS = new Set(["txt", "md", "json", "csv", "log", "xml", "html", "htm", "css", "js", "ts", "py", "java", "c", "cpp", "rs", "go", "sh", "yml", "yaml"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

const SUBJECT_NAMES = {
  toan: "Toán", ly: "Vật Lý", hoa: "Hóa Học", van: "Ngữ Văn",
  anh: "Tiếng Anh", sinh: "Sinh Học", su: "Lịch Sử", dia: "Địa Lý", tin: "Tin Học"
};

const PROVIDER_INFO = {
  openrouter: { name: "Rika 0.1", desc: "OpenRouter — tự động chọn model miễn phí tốt nhất" },
  openai: { name: "Rika 0.2", desc: "OpenAI — GPT-4o-mini, cân bằng tốc độ & trí tuệ" }
};

const COMPOSER_MODELS = [
  { id: "openrouter", name: "Rika 0.1" },
  { id: "openai", name: "Rika 0.2" }
];

const DEFAULT_SETTINGS = {
  memoryEnabled: false,
  memoryNote: "",
  darkMode: false,
  provider: "openrouter",
  shortAnswers: false,
  tone: "friendly"
};

const REDUCED_MOTION = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || false;

let chats = [];
let currentChatId = null;
let settings = { ...DEFAULT_SETTINGS };
let isSending = false;
let toastTimer = null;
let selectedSubject = "";
let pendingAttachments = [];
let currentAbortController = null;

let iruApp = null;
let iruModel = null;
let iruLoading = false;
let iruFailed = false;
let iruResizeObserver = null;
let iruZoomScale = 1;

let globeRenderer = null, globeScene = null, globeCamera = null;
let globeObject = null, globeAtmosphere = null, globeStars = null;
let globeFrame = null, globeResizeObserver = null;

let composer452 = null;
let composer452ModelIndex = 0;

try { selectedSubject = localStorage.getItem(SUBJECT_KEY) || ""; } catch {}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

function showToast(msg) {
  const toast = $("#toast");
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
    .replace(/\u0000/g, "");
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn("Không lưu được:", error);
    if (error.name === "QuotaExceededError" && key === STORAGE_KEY && chats.length > 1) {
      const currentId = currentChatId;
      let trimmed = chats.slice(0, Math.max(1, chats.length - 1));
      if (currentId && !trimmed.find((c) => c.id === currentId)) {
        const current = chats.find((c) => c.id === currentId);
        if (current) trimmed = [current, ...trimmed.filter((c) => c.id !== currentId)];
      }
      chats = trimmed;
      try { localStorage.setItem(key, JSON.stringify(chats)); } catch {}
      if (!chats.find((c) => c.id === currentChatId)) {
        currentChatId = chats[0]?.id || null;
        renderHistory();
        renderMessages();
        updateChatTitle();
      }
      showToast("Bộ nhớ đầy, đã xoá cuộc trò chuyện cũ nhất.");
    } else {
      showToast("Không thể lưu dữ liệu.");
    }
  }
}

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function makeTitle(text) {
  const clean = String(text || "Cuộc trò chuyện mới").replace(/\s+/g, " ").trim();
  if (!clean) return "Cuộc trò chuyện mới";
  if (clean.length <= 34) return clean;
  const cut = clean.slice(0, 34);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 22 ? cut.slice(0, lastSpace) : cut) + "…";
}

function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1048576) return Math.max(1, Math.round(bytes / 1024)) + "KB";
  return (bytes / 1048576).toFixed(1) + "MB";
}

function getExt(name) {
  const match = /\.([a-z0-9]+)$/i.exec(name || "");
  return match ? match[1].toLowerCase() : "";
}

function getCurrentChat() {
  return chats.find((chat) => chat.id === currentChatId) || null;
}

function saveChats() {
  chats = chats.slice(0, MAX_HISTORY);
  saveJSON(STORAGE_KEY, chats);
}

function saveSettings() {
  saveJSON(SETTINGS_KEY, settings);
}

function normalizeChats() {
  const stored = loadJSON(STORAGE_KEY, []);
  if (!Array.isArray(stored)) { chats = []; return; }
  chats = stored
    .filter((c) => c && Array.isArray(c.messages))
    .map((c) => ({
      id: String(c.id || makeId()),
      title: makeTitle(c.title),
      createdAt: Number(c.createdAt) || Date.now(),
      updatedAt: Number(c.updatedAt) || Date.now(),
      messages: c.messages
        .filter((m) => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string")
        .slice(-MAX_MESSAGES_PER_CHAT)
        .map((m) => ({
          role: m.role,
          content: m.content,
          modelName: m.modelName || null,
          attachments: Array.isArray(m.attachments)
            ? m.attachments
                .filter((a) => a && typeof a.name === "string")
                .map((a) => ({
                  name: String(a.name),
                  size: Number(a.size) || 0,
                  ext: String(a.ext || getExt(a.name))
                }))
            : []
        }))
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_HISTORY);
}

function createChat() {
  abortCurrentRequest();
  const chat = {
    id: makeId(),
    title: "Cuộc trò chuyện mới",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: []
  };
  chats.unshift(chat);
  currentChatId = chat.id;
  isSending = false;
  syncComposerGen(false);
  removeTypingIndicator();
  clearPendingAttachments();
  saveChats();
  renderHistory();
  renderMessages();
  updateChatTitle();
  closeSidebar();
  $("#userInput")?.focus();
}

function openChat(id) {
  const chat = chats.find((item) => item.id === id);
  if (!chat) return;
  removeTypingIndicator();
  clearPendingAttachments();
  currentChatId = chat.id;
  renderHistory();
  renderMessages();
  updateChatTitle();
  closeSidebar();
}

function deleteChat(id) {
  if (!chats.find((item) => item.id === id)) return;
  showDeleteDialog(
    "Xóa cuộc trò chuyện?", 
    "Cuộc trò chuyện này sẽ bị xóa vĩnh viễn và không thể khôi phục lại.",
    () => {
      chats = chats.filter((item) => item.id !== id);
      if (currentChatId === id) currentChatId = chats[0]?.id || null;
      saveChats();
      if (!currentChatId) { createChat(); showToast("Đã xóa."); return; }
      renderHistory();
      renderMessages();
      updateChatTitle();
      showToast("Đã xóa.");
    }
  );
}

function clearAllHistory() {
  if (!chats.length) { showToast("Chưa có lịch sử."); return; }
  showDeleteDialog(
    "Xóa toàn bộ lịch sử?", 
    "Tất cả các cuộc trò chuyện sẽ bị xóa vĩnh viễn.",
    () => {
      chats = [];
      currentChatId = null;
      saveChats();
      createChat();
      showToast("Đã xóa lịch sử.");
    }
  );
}

function showDeleteDialog(title, message, onConfirm) {
  const modal = $("#confirmModal");
  if (!modal) return;

  modal.innerHTML = `
    <div class="modal-backdrop" data-close="confirmModal"></div>
    <section class="ux u436" style="width: 100%; height: auto; display: flex; justify-content: center;">
      <div class="u436-d" role="alertdialog" tabindex="-1">
        <div class="u436-ic" aria-hidden="true"></div>
        <h3 id="u436-title">${escapeHTML(title)}</h3>
        <p id="u436-desc">${escapeHTML(message)}</p>
        <div class="u436-bs">
          <button type="button" class="u436-no">Hủy</button>
          <button type="button" class="u436-ok">Xóa</button>
        </div>
      </div>
      <p class="u436-live" role="status"></p>
    </section>
  `;

  modal.classList.remove("hidden");

  const root = modal.querySelector(".u436");
  const d = root.querySelector(".u436-d");
  const ic = root.querySelector(".u436-ic");
  const no = root.querySelector(".u436-no");
  const ok = root.querySelector(".u436-ok");
  const live = root.querySelector(".u436-live");
  
  d.setAttribute("aria-labelledby", "u436-title");
  d.setAttribute("aria-describedby", "u436-desc");

  const uid = "u436" + Math.random().toString(36).slice(2, 7);
  ic.innerHTML = `<svg viewBox="0 0 32 32"><defs><clipPath id="${uid}c"><rect x="-10" y="-30" width="52" height="40.5"/></clipPath></defs>
    <g clip-path="url(#${uid}c)"><g class="doc"><path d="M12.5 -1.5h5l3 3v8h-8z"/><path d="M14.5 3.5h3.5M14.5 6h3.5" stroke-width="1.2"/></g></g>
    <g class="lid"><path d="M5.5 9.5h21"/><path d="M12.5 9V7a1.5 1.5 0 0 1 1.5-1.5h4A1.5 1.5 0 0 1 19.5 7v2"/></g>
    <g class="bd"><path d="M8 10.5l1.3 14.6a2.4 2.4 0 0 0 2.4 2.2h8.6a2.4 2.4 0 0 0 2.4-2.2L24 10.5"/><path d="M13.5 15v7.5M18.5 15v7.5"/></g></svg>`;

  let busy = false, timers = [];

  function later(fn, ms) {
    timers.push(setTimeout(() => {
      if (root.isConnected) fn();
    }, ms));
  }

  function lock(v) {
    [ok, no].forEach((b) => {
      if (v) b.setAttribute("aria-disabled", "true");
      else b.removeAttribute("aria-disabled");
    });
  }

  function closeAndCleanup() {
    root.classList.add("is-gone");
    later(() => {
      modal.classList.add("hidden");
      timers.forEach(clearTimeout);
      timers = [];
    }, REDUCED_MOTION ? 300 : 400);
  }

  function cancel() {
    if (busy) return;
    busy = true;
    lock(true);
    closeAndCleanup();
  }

  no.addEventListener("click", cancel);
  
  ok.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    lock(true);
    root.classList.add("is-del");
    
    later(() => {
      live.textContent = "Đã xóa";
      closeAndCleanup();
      if (onConfirm) onConfirm();
    }, REDUCED_MOTION ? 200 : 1300);
  });

  setTimeout(() => d.focus({ preventScroll: true }), 50);
}

function renderHistory() {
  const list = $("#historyList");
  if (!list) return;
  list.replaceChildren();
  chats.forEach((chat) => {
    const row = document.createElement("div");
    row.className = "history-item";
    const open = document.createElement("button");
    open.className = "history-open" + (chat.id === currentChatId ? " selected" : "");
    open.textContent = chat.title;
    open.title = chat.title;
    open.addEventListener("click", () => openChat(chat.id));
    const remove = document.createElement("button");
    remove.className = "history-delete";
    remove.textContent = "×";
    remove.title = "Xóa";
    remove.addEventListener("click", (e) => { e.stopPropagation(); deleteChat(chat.id); });
    row.append(open, remove);
    list.appendChild(row);
  });
}

function updateChatTitle() {
  const chat = getCurrentChat();
  const title = $("#chatTitle");
  if (title) title.textContent = chat ? chat.title : "Rika AI";
}

function markdownToHTML(text) {
  let output = String(text || "");
  output = output
    .replace(/<\|ACT [^|]+\|>/g, "")
    .replace(/<\|DELAY \d+\|>/g, "")
    .replace(/<\|CALL [^|]+\|>/g, "");

  output = escapeHTML(output);

  output = output
    .replace(/\\\(/g, () => "$")
    .replace(/\\\)/g, () => "$")
    .replace(/\\\[/g, () => "$$")
    .replace(/\\\]/g, () => "$$");

  const placeholders = [];
  const stash = (html) => {
    const key = `\u0001PH${placeholders.length}\u0001`;
    placeholders.push(html);
    return key;
  };

  output = output.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_, lang, code) =>
    stash(`<pre><code class="language-${lang}">${code.trim()}</code></pre>`)
  );
  output = output.replace(/`([^`\n]+)`/g, (_, code) => stash(`<code>${code}</code>`));

  output = output.replace(/\$\$([\s\S]*?)\$\$/g, (_, formula) => {
    const clean = formula.replace(/<br\s*\/?>/gi, " ").trim();
    if (window.katex) {
      try { return stash(window.katex.renderToString(clean, { displayMode: true, throwOnError: false })); }
      catch { return stash(`$$${formula}$$`); }
    }
    return stash(`$$${formula}$$`);
  });
  output = output.replace(/\$([^$\n]+?)\$/g, (_, formula) => {
    const clean = formula.replace(/<br\s*\/?>/gi, " ").trim();
    if (window.katex) {
      try { return stash(window.katex.renderToString(clean, { displayMode: false, throwOnError: false })); }
      catch { return stash(`$${formula}$`); }
    }
    return stash(`$${formula}$`);
  });

  output = output.replace(/\*\*([\s\S]+?)\*\*/g, "<strong>$1</strong>");
  output = output.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  output = output.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  output = output.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  output = output.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  output = output.replace(/^---$/gm, "<hr>");
  output = output.replace(/^\s*[-*] (.+)$/gm, "<li>$1</li>");
  output = output.replace(/(?:<li>.*?<\/li>\n?)+/gs, (items) => "<ul>" + items + "</ul>");

  output = output.replace(/\n/g, "<br>");
  output = output
    .replace(/<br>(?=<\/?(?:h[1-3]|ul|li|pre|hr))/g, "")
    .replace(/<\/(h[1-3]|ul|pre)><br>/g, "</$1>");

  output = output.replace(/\u0001PH(\d+)\u0001/g, (_, i) => placeholders[Number(i)] || "");
  return output;
}

async function copyText(text, msg) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(msg);
  } catch {
    showToast("Không thể sao chép.");
  }
}

function makeAttachmentIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 1 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48");
  svg.appendChild(path);
  return svg;
}

function renderMessage(message, isNew = false) {
  const wrapper = document.createElement("article");
  wrapper.className = "message " + message.role + (isNew ? " is-new" : "");

  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = message.role === "user" ? "B" : "R";

  const content = document.createElement("div");
  content.className = "message-content";

  const name = document.createElement("div");
  name.className = "message-name";
  name.textContent = message.role === "user" ? "Bạn" : (message.modelName || "Rika");

  const body = document.createElement("div");
  body.className = "message-body";
  body.innerHTML = markdownToHTML(message.content);

  content.append(name, body);

  if (message.role === "user" && Array.isArray(message.attachments) && message.attachments.length) {
    const chips = document.createElement("div");
    chips.className = "message-attachments";
    message.attachments.forEach((att) => {
      const chip = document.createElement("span");
      chip.className = "message-attachment-chip";
      chip.appendChild(makeAttachmentIcon());
      const label = document.createElement("span");
      label.textContent = att.name;
      chip.appendChild(label);
      chips.appendChild(chip);
    });
    content.appendChild(chips);
  }

  if (message.role === "assistant") {
    const copy = document.createElement("button");
    copy.className = "copy-answer";
    copy.textContent = "Sao chép";
    copy.addEventListener("click", () => copyText(message.content, "Đã sao chép."));
    content.appendChild(copy);

    body.querySelectorAll("pre").forEach((pre) => {
      const btn = document.createElement("button");
      btn.className = "code-copy";
      btn.textContent = "Sao chép mã";
      btn.addEventListener("click", () => {
        const code = pre.querySelector("code")?.textContent || "";
        copyText(code, "Đã sao chép mã.");
      });
      pre.insertAdjacentElement("afterend", btn);
    });
  }

  wrapper.append(avatar, content);
  return wrapper;
}

function renderMessages() {
  const box = $("#messages");
  const welcome = $("#welcomeBox");
  if (!box || !welcome) return;
  box.replaceChildren();
  const chat = getCurrentChat();
  const messages = chat ? chat.messages : [];
  welcome.classList.toggle("hidden", messages.length > 0);
  messages.forEach((msg) => box.appendChild(renderMessage(msg)));
  scrollToBottom();
}

function scrollToBottom() {
  const box = $("#chatBox");
  if (!box) return;
  requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
}

function appendTypingIndicator() {
  const box = $("#messages");
  if (!box) return;
  removeTypingIndicator();

  const wrapper = document.createElement("article");
  wrapper.className = "message assistant";
  wrapper.id = "typingIndicator";

  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = "R";

  const content = document.createElement("div");
  content.className = "message-content";

  const name = document.createElement("div");
  name.className = "message-name";
  name.textContent = "Rika";

  const body = document.createElement("div");
  body.className = "message-body";

  const u453 = document.createElement("div");
  u453.className = "ux u453";

  const w = document.createElement("div");
  w.className = "u453-w";

  const h = document.createElement("button");
  h.type = "button";
  h.className = "u453-h";
  h.setAttribute("aria-expanded", "false");

  const ic = document.createElement("span");
  ic.className = "u453-ic";
  ic.setAttribute("aria-hidden", "true");
  ic.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 1.6c.8 5.3 5.1 9.6 10.4 10.4-5.3.8-9.6 5.1-10.4 10.4C11.2 17.1 6.9 12.8 1.6 12 6.9 11.2 11.2 6.9 12 1.6Z"/></svg>';

  const tx = document.createElement("span");
  tx.className = "u453-tx";
  const ta = document.createElement("span");
  ta.className = "u453-a";
  ta.textContent = "Đang suy nghĩ…";
  const tb = document.createElement("span");
  tb.className = "u453-b";
  tb.setAttribute("aria-hidden", "true");
  tb.textContent = "Đã suy nghĩ";
  tx.append(ta, tb);

  const cv = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  cv.setAttribute("class", "u453-cv");
  cv.setAttribute("viewBox", "0 0 24 24");
  cv.setAttribute("aria-hidden", "true");
  const cvPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  cvPath.setAttribute("d", "m9.5 6 6 6-6 6");
  cv.appendChild(cvPath);

  h.append(ic, tx, cv);

  const pn = document.createElement("div");
  pn.className = "u453-pn";
  pn.id = "u453-" + makeId();
  h.setAttribute("aria-controls", pn.id);

  const pin = document.createElement("div");
  pin.className = "u453-in";
  const ls = document.createElement("div");
  ls.className = "u453-ls";

  const STEPS = [
    "Đang phân tích câu hỏi…",
    "Đang tìm kiếm ngữ cảnh phù hợp…",
    "Đang chuẩn bị câu trả lời…"
  ];
  const lines = STEPS.map((text) => {
    const p = document.createElement("p");
    p.className = "u453-ln";
    const s1 = document.createElement("span");
    const s2 = document.createElement("span");
    s2.textContent = text;
    s1.appendChild(s2);
    p.appendChild(s1);
    ls.appendChild(p);
    return p;
  });

  pin.appendChild(ls);
  pn.appendChild(pin);

  const live = document.createElement("p");
  live.className = "u453-live";
  live.setAttribute("role", "status");

  w.append(h, pn);
  u453.append(w, live);
  body.appendChild(u453);
  content.append(name, body);
  wrapper.append(avatar, content);
  box.appendChild(wrapper);
  scrollToBottom();

  const rm = REDUCED_MOTION;
  const SPIN = 2400;
  const startTime = performance.now();
  let spin = null;

  const setOpen = (v) => {
    h.setAttribute("aria-expanded", v ? "true" : "false");
  };

  h.addEventListener("click", () => {
    setOpen(h.getAttribute("aria-expanded") !== "true");
  });
  h.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && h.getAttribute("aria-expanded") === "true") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  });

  if (!rm && ic.animate) {
    spin = ic.animate(
      [
        { transform: "rotate(0deg) scale(1)" },
        { transform: "rotate(180deg) scale(0.78)" },
        { transform: "rotate(360deg) scale(1)" }
      ],
      { duration: SPIN, iterations: Infinity }
    );
  }

  [450, 1500, 2650].forEach((t, i) => {
    setTimeout(() => {
      if (!wrapper.isConnected) return;
      lines[i]?.classList.add("is-on");
    }, rm ? 0 : t);
  });

  wrapper._u453Cancel = () => {
    if (spin) { try { spin.cancel(); } catch {} }
    return (performance.now() - startTime) / 1000;
  };

  wrapper._u453Finalize = () => {
    const elapsed = (performance.now() - startTime) / 1000;
    const secs = Math.max(1, Math.round(elapsed));
    finalizeThinking(wrapper, secs);
    return secs;
  };

  setTimeout(() => {
    if (!wrapper.isConnected) return;
    if (!wrapper.classList.contains("is-done")) {
      const elapsed = (performance.now() - startTime) / 1000;
      finalizeThinking(wrapper, Math.max(1, Math.round(elapsed)));
    }
  }, rm ? 800 : 4000);
}

function finalizeThinking(wrapper, secs) {
  const u453 = wrapper.querySelector(".u453");
  if (!u453 || u453.classList.contains("is-done")) return;
  u453.classList.add("is-done");

  const a = u453.querySelector(".u453-a");
  const b = u453.querySelector(".u453-b");
  if (a) a.setAttribute("aria-hidden", "true");
  if (b) {
    b.removeAttribute("aria-hidden");
    b.textContent = "Đã suy nghĩ " ;
  }
  const h = u453.querySelector(".u453-h");
  if (h) h.setAttribute("aria-expanded", "false");
  const live = u453.querySelector(".u453-live");
  if (live) live.textContent = "Đã suy nghĩ " + secs + " giây";

  const ic = u453.querySelector(".u453-ic svg");
  if (ic && !REDUCED_MOTION) {
    const anims = ic.getAnimations?.() || [];
    anims.forEach((anim) => {
      try {
        const ct = anim.currentTime || 0;
        const p = (ct % 2400) / 2400;
        const deg = p * 360;
        const s = p < 0.5 ? 1 - 0.44 * p : 0.78 + 0.44 * (p - 0.5);
        anim.cancel();
        ic.animate(
          [
            { transform: "rotate(" + deg + "deg) scale(" + s + ")" },
            { transform: "rotate(" + Math.ceil((deg + 25) / 90) * 90 + "deg) scale(1)" }
          ],
          { duration: 750, easing: "cubic-bezier(.3,1.45,.5,1)", fill: "forwards" }
        );
      } catch {}
    });
  }
}

function removeTypingIndicator() {
  const el = $("#typingIndicator");
  if (!el) return;
  if (typeof el._u453Cancel === "function") {
    try { el._u453Cancel(); } catch {}
  }
  el.remove();
}

function clearPendingAttachments() {
  pendingAttachments = [];
  renderAttachmentBar();
  syncComposerReady();
}

function removePendingAttachment(id) {
  pendingAttachments = pendingAttachments.filter((a) => a.id !== id);
  renderAttachmentBar();
  syncComposerReady();
}

function renderAttachmentBar() {
  const bar = $("#attachmentBar");
  if (!bar) return;
  bar.replaceChildren();
  if (!pendingAttachments.length) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  pendingAttachments.forEach((att) => {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";

    chip.appendChild(makeAttachmentIcon());

    const label = document.createElement("span");
    label.className = "attachment-chip-label";
    label.textContent = att.name + (att.kind === "error" ? " (lỗi)" : "");
    label.title = att.name;
    chip.appendChild(label);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachment-chip-remove";
    remove.setAttribute("aria-label", "Bỏ đính kèm " + att.name);
    remove.textContent = "×";
    remove.addEventListener("click", () => removePendingAttachment(att.id));
    chip.appendChild(remove);

    bar.appendChild(chip);
  });
}

async function readFileContent(file) {
  const ext = getExt(file.name);

  if (TEXT_EXTS.has(ext) || file.type.startsWith("text/")) {
    const text = await file.text();
    const truncated = text.length > MAX_TEXT_PREVIEW_CHARS
      ? text.slice(0, MAX_TEXT_PREVIEW_CHARS) + "\n\n[… nội dung đã được rút gọn]"
      : text;
    return { kind: "text", content: truncated };
  }

  if (IMAGE_EXTS.has(ext) || file.type.startsWith("image/")) {
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
      reader.onerror = () => reject(new Error("Không đọc được ảnh."));
      reader.readAsDataURL(file);
    });
    return { kind: "image", content: base64 };
  }

  return { kind: "binary", content: "" };
}

async function addAttachment(file) {
  if (!file) return;
  if (file.size > MAX_UPLOAD_BYTES) {
    showToast(`"${file.name}" vượt quá ${humanSize(MAX_UPLOAD_BYTES)}.`);
    return;
  }
  if (pendingAttachments.length >= 5) {
    showToast("Tối đa 5 tệp mỗi tin nhắn.");
    return;
  }

  const ext = getExt(file.name);
  let kind = "binary", content = "";
  try {
    const result = await readFileContent(file);
    kind = result.kind;
    content = result.content;
  } catch (err) {
    console.warn("Lỗi đọc file:", err);
    kind = "error";
  }

  pendingAttachments.push({
    id: makeId(),
    name: file.name,
    size: file.size,
    ext,
    kind,
    content
  });
  renderAttachmentBar();
  syncComposerReady();
}

function buildAttachmentsForRequest() {
  if (!pendingAttachments.length) return "";
  const parts = ["[TỆP ĐÍNH KÈM]"];
  pendingAttachments.forEach((att) => {
    parts.push(`\n--- Tệp: ${att.name} (${humanSize(att.size)}) ---`);
    if (att.kind === "text") parts.push(att.content);
    else if (att.kind === "image") parts.push(`[Ảnh base64, ${att.content.length} ký tự]`);
    else if (att.kind === "binary") parts.push(`[Tệp nhị phân, không đọc được nội dung trực tiếp]`);
    else parts.push(`[Không đọc được tệp]`);
  });
  parts.push("\n[KẾT THÚC TỆP ĐÍNH KÈM]\n");
  return parts.join("\n");
}

function bindUploadComponent() {
  const root = $("#uploadZone");
  if (!root) return;

  const q = (s) => root.querySelector(s);
  const dz = q(".u432-dz");
  const ring = q(".u432-ring .pg");
  const nm = q(".u432-nm");
  const tag = q(".u432-doc .tg");
  const tagT = q(".u432-doc text");
  const fileInput = q(".u432-file");
  const live = q(".u432-live");

  if (!dz || !ring || !nm || !tag || !tagT || !fileInput || !live) return;

  const rm = REDUCED_MOTION;
  const COL = { pdf: "#E5484D", png: "#8E4EC6", jpg: "#0090FF", jpeg: "#0090FF", doc: "#2B63D9", docx: "#2B63D9", zip: "#C27A12" };
  let busy = false, raf = 0;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"
  }[c]));

  function upload(f) {
    if (busy || !f) return;
    busy = true;

    const ext = getExt(f.name) || "file";
    tag.style.setProperty("--c", COL[ext] || "#6B7280");
    tagT.textContent = ext.slice(0, 4).toUpperCase();

    root.classList.remove("is-done", "is-out", "is-err", "is-drag");
    root.classList.add("is-up");
    ring.style.strokeDashoffset = 289;

    const tooBig = f.size > MAX_UPLOAD_BYTES;
    nm.innerHTML = esc(f.name) + ' <small>· 0%</small>';

    const t0 = performance.now() + (rm ? 0 : 450);
    const dur = rm ? 300 : 1500;

    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(function step(now) {
      if (!root.isConnected) return;
      const k = Math.max(0, Math.min(1, (now - t0) / dur));
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const shown = tooBig ? Math.min(e, 0.18) : e;
      ring.style.strokeDashoffset = (289 * (1 - shown)).toFixed(1);
      const small = nm.querySelector("small");
      if (small) small.textContent = "· " + Math.round(shown * 100) + "%";

      if (k < 1) { raf = requestAnimationFrame(step); return; }

      if (tooBig) {
        root.classList.add("is-err");
        if (small) small.textContent = "· Quá lớn";
        live.textContent = "Tệp vượt quá 10MB.";
      } else {
        root.classList.add("is-done");
        if (small) small.textContent = "· " + humanSize(f.size);
        live.textContent = f.name + " đã được thêm.";
        addAttachment(f)
          .then(() => { if (fileInput) fileInput.value = ""; })
          .catch((err) => console.warn("Lỗi xử lý file:", err));
      }

      setTimeout(() => {
        if (!root.isConnected) return;
        root.classList.add("is-out");
        setTimeout(() => {
          if (!root.isConnected) return;
          root.classList.remove("is-up", "is-done", "is-out", "is-err");
          busy = false;
          if (!tooBig) setTimeout(() => closeModal("uploadModal"), 200);
        }, 350);
      }, rm ? 900 : 1700);
    });
  }

  dz.addEventListener("click", (e) => {
    if (!busy && e.target !== fileInput) fileInput.click();
  });
  dz.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && !busy) {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener("change", () => {
    const f = fileInput.files && fileInput.files[0];
    if (f) upload(f);
    fileInput.value = "";
    dz.focus({ preventScroll: true });
  });

  let depth = 0;
  dz.addEventListener("dragenter", (e) => {
    e.preventDefault();
    depth++;
    if (!busy) root.classList.add("is-drag");
  });
  dz.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  dz.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) root.classList.remove("is-drag");
  });
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    root.classList.remove("is-drag");
    if (e.dataTransfer && e.dataTransfer.files.length) upload(e.dataTransfer.files[0]);
  });
}

function bindSwitchPressFeedback() {
  $$(".u433-sw-row").forEach((row) => {
    const input = row.querySelector("input");
    if (!input) return;

    row.addEventListener("pointerdown", (e) => {
      if (e.button === 0) row.classList.add("is-press");
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach((t) => {
      row.addEventListener(t, () => row.classList.remove("is-press"));
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === " ") row.classList.add("is-press");
    });
    input.addEventListener("keyup", () => row.classList.remove("is-press"));
  });
}

function bindComposer452() {
  const root = $("#chatForm");
  if (!root) return;

  const box = root.querySelector(".u452-box");
  const ta = $("#userInput");
  const send = $("#sendBtn");
  const md = $("#modelBtn");
  const mv = root.querySelector(".u452-mv");
  const live = root.querySelector(".u452-live");

  if (!box || !ta || !send || !md || !mv || !live) return;

  const rm = REDUCED_MOTION;
  const LH = 24, MAX = 4 * 24;

  const idx = COMPOSER_MODELS.findIndex((m) => m.id === settings.provider);
  composer452ModelIndex = idx >= 0 ? idx : 0;

  const firstB = mv.querySelector("b");
  if (firstB) firstB.textContent = COMPOSER_MODELS[composer452ModelIndex].name;
  md.setAttribute("aria-label", "Mô hình: " + COMPOSER_MODELS[composer452ModelIndex].name);

  function grow() {
    const h0 = ta.offsetHeight;
    ta.style.transition = "none";
    ta.style.height = "0px";
    const sh = ta.scrollHeight;
    const h = Math.max(LH, Math.min(MAX, sh));
    ta.style.height = h0 + "px";
    void ta.offsetHeight;
    ta.style.transition = "";
    ta.style.height = h + "px";
    ta.style.overflowY = sh > MAX ? "auto" : "hidden";
  }

  function bump(k) {
    if (rm || !send.animate) return;
    send.animate(
      [
        { transform: "scale(1)" },
        { transform: "scale(" + k + ")", offset: 0.35 },
        { transform: "scale(1.06)", offset: 0.7 },
        { transform: "scale(1)" }
      ],
      { duration: 460, easing: "ease-out" }
    );
  }

  function sync() {
    const hasText = !!ta.value.trim();
    const hasAttach = pendingAttachments.length > 0;
    const can = hasText || hasAttach;
    send.setAttribute("aria-disabled", (isSending || !can) ? "true" : "false");
    send.setAttribute("aria-label", isSending ? "Dừng tạo" : "Gửi");
  }

  function fly(text) {
    if (rm) return;
    const f = document.createElement("div");
    f.className = "u452-fly";
    f.textContent = text;
    f.style.left = (box.offsetLeft + ta.offsetLeft) + "px";
    f.style.top = (box.offsetTop + ta.offsetTop) + "px";
    f.style.width = ta.clientWidth + "px";
    root.appendChild(f);
    const a = f.animate(
      [
        { opacity: 1, transform: "none", filter: "blur(0)" },
        { opacity: 0, transform: "translateY(-22px) scale(.97)", filter: "blur(3px)" }
      ],
      { duration: 420, easing: "cubic-bezier(.3,.6,.3,1)", fill: "forwards" }
    );
    a.onfinish = function () { f.remove(); };
  }

  function submit() {
    if (isSending) {
      abortCurrentRequest();
      return;
    }
    const text = ta.value.trim();
    if (!text && !pendingAttachments.length) return;

    if (text) fly(text);
    ta.value = "";
    grow();
    sync();

    sendMessage(text);
  }

  function fitModel(b) {
    b = b || mv.querySelector("b:not(.is-out)");
    if (b && b.offsetWidth) mv.style.width = b.offsetWidth + "px";
  }

  function cycleModel() {
    composer452ModelIndex = (composer452ModelIndex + 1) % COMPOSER_MODELS.length;
    const next = COMPOSER_MODELS[composer452ModelIndex];

    settings.provider = next.id;
    saveSettings();
    updateModelInfoText();

    const old = mv.querySelector("b:not(.is-out)");
    const nb = document.createElement("b");
    nb.textContent = next.name;
    nb.className = "is-in";
    mv.appendChild(nb);
    fitModel(nb);
    void nb.offsetWidth;
    nb.className = "";
    if (old) {
      old.className = "is-out";
      setTimeout(() => { old.remove(); }, rm ? 0 : 500);
    }
    md.setAttribute("aria-label", "Mô hình: " + next.name);
    showToast("Mô hình: " + next.name);
  }

  ta.addEventListener("input", () => { grow(); sync(); });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape" && isSending) {
      e.preventDefault();
      e.stopPropagation();
      abortCurrentRequest();
    }
  });

  send.addEventListener("click", (e) => {
    e.preventDefault();
    submit();
  });

  box.addEventListener("mousedown", (e) => {
    if (e.target === box) {
      e.preventDefault();
      ta.focus({ preventScroll: true });
    }
  });

  md.addEventListener("click", (e) => {
    e.preventDefault();
    cycleModel();
  });

  root.addEventListener("submit", (e) => {
    e.preventDefault();
    submit();
  });

  fitModel();
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { if (root.isConnected) fitModel(); });
  }

  composer452 = {
    root, box, ta, send, md, mv, live,
    grow, sync, bump, fitModel
  };

  sync();
  grow();
}

function syncComposerGen(value) {
  if (!composer452) return;
  composer452.root.classList.toggle("is-gen", !!value);
  composer452.send.setAttribute(
    "aria-disabled",
    (value || !(composer452.ta.value.trim() || pendingAttachments.length)) ? "true" : "false"
  );
  composer452.send.setAttribute("aria-label", value ? "Dừng tạo" : "Gửi");
  if (composer452.live) {
    composer452.live.textContent = value ? "Đang tạo câu trả lời" : "";
  }
}

function syncComposerReady() {
  if (!composer452) return;
  composer452.sync();
}

function buildContextualPrompt() {
  let prompt = "";
  if (selectedSubject && SUBJECT_NAMES[selectedSubject]) {
    prompt += `NGƯỜI DÙNG ĐANG HỌC MÔN: ${SUBJECT_NAMES[selectedSubject]}. Trả lời CHI TIẾT, RÕ RÀNG, có cấu trúc theo các bước. Giải từng bước một, ghi rõ công thức, đơn vị, kết luận đáp án.`;
  } else {
    prompt += "Người dùng KHÔNG chọn môn. Trả lời NGẮN GỌN, đi thẳng vào đáp án chính.";
  }

  if (settings.shortAnswers) {
    prompt += "\nƯu tiên câu trả lời ngắn gọn, súc tích, không lan man.";
  }

  if (settings.tone === "formal") {
    prompt += "\nGiọng điệu trang trọng, lịch sự, xưng 'tôi' và gọi người dùng là 'bạn'.";
  } else {
    prompt += "\nGiọng điệu thân thiện, gần gũi, có thể dùng emoji nhẹ nhàng.";
  }

  const memoryNote = (settings.memoryNote || "").trim();
  if (settings.memoryEnabled && memoryNote) {
    prompt += "\n\nGhi chú người dùng:\n" + memoryNote;
  }
  return prompt;
}

function abortCurrentRequest() {
  if (currentAbortController) {
    try { currentAbortController.abort(); } catch {}
    currentAbortController = null;
  }
}

async function requestAI(conversation, contextNote) {
  abortCurrentRequest();
  const controller = new AbortController();
  currentAbortController = controller;
  const signal = controller.signal;
  const timeoutId = setTimeout(() => {
    try { controller.abort(); } catch {}
  }, API_TIMEOUT_MS);

  const messages = conversation.slice(-MAX_CONTEXT_MESSAGES);

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, provider: settings.provider, contextNote }),
      signal
    });

    let data = {};
    try { data = await response.json(); }
    catch { throw new Error("Dữ liệu trả về không hợp lệ."); }

    if (!response.ok) {
      if (response.status === 401) throw new Error("Chưa xác thực API.");
      if (response.status === 402) throw new Error("Hết hạn mức.");
      if (response.status === 403) throw new Error("Bị từ chối.");
      if (response.status === 429) throw new Error("Gửi quá nhanh, thử lại sau.");
      throw new Error(data.error || data.message || ("Lỗi HTTP " + response.status));
    }

    const content = data.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
    if (typeof data.reply === "string") return data.reply;
    if (typeof data.message === "string") return data.message;

    throw new Error("Không có câu trả lời.");
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Đã huỷ hoặc quá thời gian chờ.");
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (currentAbortController === controller) currentAbortController = null;
  }
}

async function sendMessage(text) {
  const cleanText = String(text || "").trim();
  const hasAttachments = pendingAttachments.length > 0;
  if ((!cleanText && !hasAttachments) || isSending) return;

  let chat = getCurrentChat();
  if (!chat) { createChat(); chat = getCurrentChat(); }
  if (!chat) return;
  if (chat.messages.length >= MAX_MESSAGES_PER_CHAT) {
    showToast("Đã đạt giới hạn chat.");
    return;
  }

  const attachmentBlock = buildAttachmentsForRequest();
  const fullContentForAPI = attachmentBlock
    ? attachmentBlock + "\n\n" + (cleanText || "(chỉ gửi tệp đính kèm)")
    : cleanText;

  const attachmentMeta = pendingAttachments.map((a) => ({
    name: a.name,
    size: a.size,
    ext: a.ext
  }));

  chat.messages.push({
    role: "user",
    content: cleanText || "(đã gửi tệp đính kèm)",
    attachments: attachmentMeta
  });

  if (chat.messages.filter((m) => m.role === "user").length === 1) {
    chat.title = makeTitle(cleanText || (attachmentMeta[0]?.name || "Tệp đính kèm"));
  }
  chat.updatedAt = Date.now();
  saveChats();
  renderHistory();
  renderMessages();
  updateChatTitle();

  const input = $("#userInput");
  if (input) { input.value = ""; input.style.height = "auto"; }
  clearPendingAttachments();

  isSending = true;
  syncComposerGen(true);
  appendTypingIndicator();

  const chatIdSnapshot = chat.id;
  const currentModelName = PROVIDER_INFO[settings.provider]?.name || "Rika";

  try {
    const conversation = chat.messages.map((m, i) => {
      if (i === chat.messages.length - 1 && m.role === "user") {
        return { role: m.role, content: fullContentForAPI };
      }
      return { role: m.role, content: m.content };
    });

    const contextNote = buildContextualPrompt();
    const answer = await requestAI(conversation, contextNote);

    const targetChat = chats.find((c) => c.id === chatIdSnapshot);
    if (targetChat) {
      targetChat.messages.push({
        role: "assistant",
        content: String(answer || "Chưa có câu trả lời."),
        modelName: currentModelName
      });
      targetChat.messages = targetChat.messages.slice(-MAX_MESSAGES_PER_CHAT);
      targetChat.updatedAt = Date.now();
      saveChats();
    }
  } catch (error) {
    const targetChat = chats.find((c) => c.id === chatIdSnapshot);
    if (targetChat && error.message !== "Đã huỷ hoặc quá thời gian chờ.") {
      targetChat.messages.push({
        role: "assistant",
        content: "Mình chưa thể trả lời lúc này.\n\n**Lỗi:** " + (error.message || "Lỗi kết nối."),
        modelName: currentModelName
      });
      targetChat.messages = targetChat.messages.slice(-MAX_MESSAGES_PER_CHAT);
      targetChat.updatedAt = Date.now();
      saveChats();
    } else if (error.message === "Đã huỷ hoặc quá thời gian chờ.") {
      showToast("Đã huỷ.");
    }
  } finally {
    isSending = false;
    syncComposerGen(false);

    const indicator = $("#typingIndicator");
    if (indicator && typeof indicator._u453Finalize === "function") {
      indicator._u453Finalize();
      await new Promise((r) => setTimeout(r, REDUCED_MOTION ? 200 : 900));
    }
    removeTypingIndicator();

    renderHistory();
    renderMessages();
    updateChatTitle();
  }
}

function loadSettings() {
  const saved = loadJSON(SETTINGS_KEY, {});
  settings = { ...DEFAULT_SETTINGS, ...(saved && typeof saved === "object" ? saved : {}) };
  if (!PROVIDER_INFO[settings.provider]) settings.provider = DEFAULT_SETTINGS.provider;
  if (typeof settings.memoryNote !== "string") settings.memoryNote = "";
  if (!["friendly", "formal"].includes(settings.tone)) settings.tone = "friendly";

  const providerSelect = $("#providerSelect");
  if (providerSelect) providerSelect.value = settings.provider;

  const darkModeEl = $("#darkMode");
  if (darkModeEl) darkModeEl.checked = !!settings.darkMode;

  const memoryEnabled = $("#memoryEnabled");
  if (memoryEnabled) memoryEnabled.checked = !!settings.memoryEnabled;

  const shortAnswers = $("#shortAnswers");
  if (shortAnswers) shortAnswers.checked = !!settings.shortAnswers;

  const memoryNote = $("#memoryNote");
  if (memoryNote) memoryNote.value = settings.memoryNote;

  const toneRadios = $$('#toneGroup input[name="tone"]');
  toneRadios.forEach((r) => { r.checked = r.value === settings.tone; });

  applyTheme();
  updateModelInfoText();
}

function updateModelInfoText() {
  const info = $("#modelInfo");
  if (!info) return;
  info.textContent = PROVIDER_INFO[settings.provider]?.desc || "";
}

function applyTheme() {
  document.body.classList.toggle("dark", !!settings.darkMode);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", settings.darkMode ? "#212121" : "#ffffff");
}

function saveSettingsFromUI() {
  settings.provider = $("#providerSelect")?.value || "openrouter";
  settings.darkMode = !!$("#darkMode")?.checked;
  settings.memoryEnabled = !!$("#memoryEnabled")?.checked;
  settings.shortAnswers = !!$("#shortAnswers")?.checked;
  settings.memoryNote = $("#memoryNote")?.value || "";

  const toneChecked = $('#toneGroup input[name="tone"]:checked');
  settings.tone = toneChecked?.value === "formal" ? "formal" : "friendly";

  applyTheme();
  updateModelInfoText();
  saveSettings();

  if (composer452 && composer452.md) {
    const newIdx = COMPOSER_MODELS.findIndex((m) => m.id === settings.provider);
    if (newIdx >= 0 && newIdx !== composer452ModelIndex) {
      composer452.md.click();
    }
  }

  closeModal("settingsModal");
  showToast("Đã lưu cài đặt.");
}

function resetSettings() {
  settings = { ...DEFAULT_SETTINGS };
  if ($("#providerSelect")) $("#providerSelect").value = settings.provider;
  if ($("#darkMode")) $("#darkMode").checked = false;
  if ($("#memoryEnabled")) $("#memoryEnabled").checked = false;
  if ($("#shortAnswers")) $("#shortAnswers").checked = false;
  if ($("#memoryNote")) $("#memoryNote").value = "";
  $$('#toneGroup input[name="tone"]').forEach((r) => { r.checked = r.value === "friendly"; });
  applyTheme();
  updateModelInfoText();
  saveSettings();
  showToast("Đã đặt lại cài đặt.");
}

function updateSubjectUI() {
  const selText = $("#subjectText");
  const options = $$("#subjectOptions .subject-option");

  if (selText) {
    if (selectedSubject && SUBJECT_NAMES[selectedSubject]) {
      const activeOpt = Array.from(options).find((o) => o.dataset.value === selectedSubject);
      selText.textContent = activeOpt ? activeOpt.textContent.trim() : SUBJECT_NAMES[selectedSubject];
    } else {
      selText.textContent = "Môn học";
    }
  }
  options.forEach((o) => o.classList.toggle("selected", o.dataset.value === selectedSubject));
}

function openModal(id) {
  $("#" + id)?.classList.remove("hidden");
  if (id === "iruModal" && iruApp) {
    iruApp.ticker.start();
    setTimeout(() => fitIruCanvas(), 50);
  }
}

function closeModal(id) {
  $("#" + id)?.classList.add("hidden");
  if (id === "iruModal" && iruApp) {
    iruApp.ticker.stop();
  }
}

function openSidebar() {
  $("#sidebar")?.classList.add("open");
  $("#sidebarOverlay")?.classList.add("visible");
}

function closeSidebar() {
  $("#sidebar")?.classList.remove("open");
  $("#sidebarOverlay")?.classList.remove("visible");
}

function usePrompt(prompt) {
  closeModal("exploreModal");
  const input = $("#userInput");
  if (!input) return;
  input.value = prompt;
  input.focus();
  if (composer452) {
    composer452.grow();
    composer452.sync();
  }
}

function initGlobe() {
  const canvas = $("#earthCanvas");
  if (!canvas || !window.THREE || globeRenderer) return;
  try {
    globeScene = new THREE.Scene();
    globeCamera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    globeRenderer = new THREE.WebGLRenderer({
      canvas, alpha: true, antialias: true, powerPreference: "high-performance"
    });
    globeRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    if ("outputColorSpace" in globeRenderer && THREE.SRGBColorSpace) {
      globeRenderer.outputColorSpace = THREE.SRGBColorSpace;
    }

    globeScene.add(new THREE.AmbientLight(0xffffff, 1.4));
    const light = new THREE.DirectionalLight(0xffffff, 2);
    light.position.set(4, 3, 5);
    globeScene.add(light);

    const earthGeometry = new THREE.SphereGeometry(1, 64, 64);
    globeObject = new THREE.Mesh(earthGeometry, new THREE.MeshPhongMaterial({
      color: 0x4a90e2, emissive: 0x1a3a6e, shininess: 24
    }));
    globeScene.add(globeObject);

    const loader = new THREE.TextureLoader();
    loader.crossOrigin = "anonymous";
    loader.load(
      "https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg",
      (texture) => {
        if (!globeScene || !globeObject) return;
        if ("colorSpace" in texture && THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
        globeObject.material = new THREE.MeshPhongMaterial({ map: texture, shininess: 8 });
        globeObject.material.needsUpdate = true;
      },
      undefined,
      () => {}
    );

    globeAtmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.035, 64, 64),
      new THREE.MeshBasicMaterial({
        color: 0x7ab8ff, transparent: true, opacity: 0.15,
        side: THREE.BackSide, depthWrite: false
      })
    );
    globeScene.add(globeAtmosphere);

    const starsGeo = new THREE.BufferGeometry();
    const positions = [];
    for (let i = 0; i < 300; i++) {
      positions.push((Math.random() - 0.5) * 16, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 8 - 2);
    }
    starsGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    globeStars = new THREE.Points(starsGeo, new THREE.PointsMaterial({
      color: 0x9bb8e0, size: 0.018, transparent: true, opacity: 0.7, depthWrite: false
    }));
    globeScene.add(globeStars);

    resizeGlobe();

    function animate() {
      globeFrame = requestAnimationFrame(animate);
      if (!REDUCED_MOTION) {
        if (globeObject) { globeObject.rotation.y += 0.0015; globeObject.rotation.x = -0.06; }
        if (globeAtmosphere) globeAtmosphere.rotation.y += 0.0015;
        if (globeStars) globeStars.rotation.y += 0.00012;
      }
      globeRenderer.render(globeScene, globeCamera);
    }
    animate();

    if (window.ResizeObserver) {
      globeResizeObserver = new ResizeObserver(resizeGlobe);
      const intro = $("#rikaIntro");
      if (intro) globeResizeObserver.observe(intro);
    }
  } catch (error) {
    console.error("Lỗi địa cầu:", error);
  }
}

function resizeGlobe() {
  if (!globeRenderer || !globeCamera) return;
  const canvas = $("#earthCanvas");
  const intro = $("#rikaIntro");
  const width = Math.max(1, Math.round(canvas?.clientWidth || intro?.clientWidth || window.innerWidth));
  const height = Math.max(1, Math.round(canvas?.clientHeight || intro?.clientHeight || window.innerHeight));
  if (width < 50 || height < 50) return;
  const aspect = width / height;
  globeCamera.aspect = aspect;
  const fovRadians = THREE.MathUtils.degToRad(globeCamera.fov);
  const radius = 1.04;
  const verticalDistance = radius / Math.tan(fovRadians / 2);
  const horizontalDistance = radius / (Math.tan(fovRadians / 2) * Math.max(aspect, 0.05));
  globeCamera.position.set(0, 0, Math.max(3.3, verticalDistance, horizontalDistance) * 1.10);
  globeCamera.lookAt(0, 0, 0);
  globeCamera.updateProjectionMatrix();
  globeRenderer.setSize(width, height, false);
}

function enterApp() {
  const intro = $("#rikaIntro");
  const app = $("#app");
  if (!intro || !app) return;
  intro.classList.add("leaving");
  setTimeout(() => {
    intro.classList.add("hidden");
    app.classList.remove("hidden");
    resizeGlobe();
    setTimeout(() => { if (!iruApp && !iruFailed) initIru(); }, 1500);
  }, 420);
}

function showIntro() {
  const intro = $("#rikaIntro");
  const app = $("#app");
  if (!intro || !app) return;
  app.classList.add("hidden");
  intro.classList.remove("hidden");
  intro.classList.remove("leaving");
  resizeGlobe();
}

function disposeIruApp() {
  if (iruResizeObserver) { iruResizeObserver.disconnect(); iruResizeObserver = null; }
  if (iruModel) { try { iruModel.destroy?.(); } catch {} iruModel = null; }
  if (iruApp) {
    try { iruApp.destroy(true, { children: true, texture: true, baseTexture: true }); } catch {}
    iruApp = null;
  }
}

function fitIruCanvas() {
  const canvas = $("#iruCanvas");
  if (!canvas) return;
  const stage = canvas.parentElement;
  if (!stage) return;
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  if (width <= 0 || height <= 0) return;
  if (iruApp) iruApp.renderer.resize(width, height);

  if (iruModel && iruModel.internalModel) {
    const mw = iruModel.internalModel.width;
    const mh = iruModel.internalModel.height;
    const scale = Math.min(width / mw, height / mh) * 0.85 * iruZoomScale;
    iruModel.scale.set(scale);
    iruModel.x = width / 2;
    iruModel.y = height / 2;
  }
}

async function initIru() {
  if (iruApp) { fitIruCanvas(); return; }
  if (iruLoading || iruFailed) return;

  const canvas = $("#iruCanvas");
  const stage = canvas?.parentElement;
  if (!canvas || !stage) return;

  iruLoading = true;
  iruFailed = false;
  const loading = $("#iruLoading");
  if (loading) {
    loading.classList.remove("hidden");
    loading.textContent = "Đang tải Rika...";
    loading.style.color = "";
  }

  try {
    if (!window.PIXI) throw new Error("Thiếu PixiJS.");
    if (!window.Live2DCubismCore) throw new Error("Thiếu Cubism Core.");
    if (!PIXI.live2d || !PIXI.live2d.Live2DModel) throw new Error("Thiếu Live2D Display.");

    disposeIruApp();

    const initialWidth = Math.max(1, stage.clientWidth || 300);
    const initialHeight = Math.max(1, stage.clientHeight || 400);

    iruApp = new PIXI.Application({
      view: canvas,
      width: initialWidth,
      height: initialHeight,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2)
    });

    iruModel = await PIXI.live2d.Live2DModel.from(RIKA_MODEL, {
      autoInteract: true,
      autoUpdate: true
    });
    if (!iruModel) throw new Error("Không tạo được mô hình.");

    if ($("#iruModal")?.classList.contains("hidden")) {
      iruApp.ticker.stop();
    }

    iruModel.interactive = true;
    iruModel.on("pointermove", (e) => {
      iruModel.focus(e.data.global.x, e.data.global.y);
    });

    iruApp.stage.addChild(iruModel);
    iruModel.anchor.set(0.5, 0.5);
    fitIruCanvas();

    if (window.ResizeObserver) {
      iruResizeObserver = new ResizeObserver(() => fitIruCanvas());
      iruResizeObserver.observe(stage);
    }

    if (loading) loading.classList.add("hidden");

    if (iruModel.internalModel?.motionManager) {
      iruModel.internalModel.motionManager.startRandomMotion("Idle");
    }
  } catch (error) {
    iruFailed = true;
    console.error("Lỗi Rika:", error);
    disposeIruApp();
    if (loading) {
      loading.classList.remove("hidden");
      loading.textContent = "Lỗi: " + (error.message || "Không rõ.");
      loading.style.color = "var(--danger)";
    }
  } finally {
    iruLoading = false;
  }
}

function bindLucianDropdown() {
  const root = document.querySelector(".sidebar-lucian .u413");
  if (!root) return;

  const tr = root.querySelector(".u413-tr");
  const pn = root.querySelector(".u413-pn");
  const hl = root.querySelector(".u413-hl");
  const its = Array.from(pn.querySelectorAll(".u413-it"));

  let open = false, cur = -1, tOpen = 0, tClose = 0, hoverAt = 0;

  const mark = (i, focus) => {
    cur = i;
    its.forEach((a, k) => a.classList.toggle("is-on", k === i));
    pn.classList.toggle("is-hl", i >= 0);
    if (i >= 0) {
      hl.style.setProperty("--hy", (its[i].offsetTop + 6) + "px");
      if (focus) its[i].focus({ preventScroll: true });
    }
  };

  const set = (v, back) => {
    clearTimeout(tOpen); clearTimeout(tClose);
    if (v === open) return;
    open = v;
    root.classList.toggle("is-open", v);
    tr.setAttribute("aria-expanded", String(v));
    if (!v) { mark(-1); if (back) tr.focus({ preventScroll: true }); }
  };

  const enter = () => {
    clearTimeout(tClose);
    if (!open) {
      clearTimeout(tOpen);
      tOpen = setTimeout(() => {
        if (root.isConnected) { hoverAt = Date.now(); set(true); }
      }, 120);
    }
  };
  const leave = () => {
    clearTimeout(tOpen);
    if (open) {
      clearTimeout(tClose);
      tClose = setTimeout(() => { if (root.isConnected) set(false); }, 240);
    }
  };

  [tr, pn].forEach((el) => {
    el.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") enter(); });
    el.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") leave(); });
  });

  its.forEach((a, i) => {
    a.addEventListener("pointerenter", () => mark(i));
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const action = a.dataset.action || "";
      set(false, true);

      if (action === "settings") openModal("settingsModal");
      else if (action === "globe") showIntro();
      else if (action === "explore") openModal("exploreModal");
      else if (action === "live2d") {
        openModal("iruModal");
        setTimeout(() => { if (!iruApp) initIru(); else fitIruCanvas(); }, 250);
      }
    });
  });

  pn.addEventListener("pointerleave", () => mark(-1));

  tr.addEventListener("click", () => {
    if (open && Date.now() - hoverAt < 500) return;
    set(!open);
  });

  tr.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      set(true);
      mark(e.key === "ArrowDown" ? 0 : its.length - 1, true);
    } else if (e.key === "Escape" && open) {
      e.preventDefault(); e.stopPropagation(); set(false, true);
    }
  });

  pn.addEventListener("keydown", (e) => {
    const n = its.length;
    const i = cur < 0 ? its.indexOf(document.activeElement) : cur;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); set(false, true); return; }
    const to = e.key === "ArrowDown" ? i + 1
      : e.key === "ArrowUp" ? i - 1
      : e.key === "Home" ? 0
      : e.key === "End" ? n - 1
      : null;
    if (to === null) return;
    e.preventDefault();
    mark((to + n) % n, true);
  });

  root.addEventListener("focusout", (e) => {
    if (open && e.relatedTarget && !root.contains(e.relatedTarget)) set(false);
  });

  document.addEventListener("pointerdown", (e) => {
    if (open && !tr.contains(e.target) && !pn.contains(e.target)) set(false);
  }, true);
}

function bindEvents() {
  $("#enterAppBtn")?.addEventListener("click", enterApp);
  $("#newChatBtn")?.addEventListener("click", createChat);
  $("#topNewChatBtn")?.addEventListener("click", createChat);
  $("#menuBtn")?.addEventListener("click", openSidebar);
  $("#closeSidebarBtn")?.addEventListener("click", closeSidebar);
  $("#sidebarOverlay")?.addEventListener("click", closeSidebar);
  
  $("#clearHistoryBtn")?.addEventListener("click", clearAllHistory);

  $("#zoomInBtn")?.addEventListener("click", () => {
    if (iruZoomScale < 2.5) { iruZoomScale += 0.15; fitIruCanvas(); }
  });
  $("#zoomOutBtn")?.addEventListener("click", () => {
    if (iruZoomScale > 0.5) { iruZoomScale -= 0.15; fitIruCanvas(); }
  });

  document.addEventListener("click", () => {
    $$(".subject-select.open").forEach((el) => {
      el.classList.remove("open");
      el.querySelector(".subject-options")?.classList.add("hidden");
    });
  });

  const subjectTrigger = $("#subjectSelected");
  const subjectOptions = $("#subjectOptions");
  const subjectDropdown = $("#subjectDropdown");
  if (subjectTrigger && subjectOptions && subjectDropdown) {
    subjectTrigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = !subjectDropdown.classList.contains("open");
      $$(".subject-select.open").forEach((el) => {
        el.classList.remove("open");
        el.querySelector(".subject-options")?.classList.add("hidden");
      });
      if (willOpen) {
        subjectDropdown.classList.add("open");
        subjectOptions.classList.remove("hidden");
      }
    });
    subjectOptions.addEventListener("click", (e) => {
      e.stopPropagation();
      const opt = e.target.closest(".subject-option");
      if (!opt) return;
      const val = opt.dataset.value || "";
      selectedSubject = val;
      try {
        if (val) localStorage.setItem(SUBJECT_KEY, val);
        else localStorage.removeItem(SUBJECT_KEY);
      } catch {}
      updateSubjectUI();
      subjectDropdown.classList.remove("open");
      subjectOptions.classList.add("hidden");
      if (val && SUBJECT_NAMES[val]) showToast("Đã chọn: " + SUBJECT_NAMES[val]);
      else showToast("Đã bỏ chọn môn.");
    });
  }

  $("#saveSettingsBtn")?.addEventListener("click", saveSettingsFromUI);
  $("#resetSettingsBtn")?.addEventListener("click", resetSettings);

  $("#attachBtn")?.addEventListener("click", (e) => {
    e.preventDefault();
    openModal("uploadModal");
    setTimeout(() => {
      const dz = $("#uploadZone .u432-dz");
      if (dz) dz.focus({ preventScroll: true });
    }, 60);
  });

  $$("[data-prompt]").forEach((btn) => {
    btn.addEventListener("click", () => {
      usePrompt(btn.dataset.prompt);
      closeSidebar();
    });
  });

  $$("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(btn.dataset.close));
  });

  window.addEventListener("resize", resizeGlobe);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeSidebar();
      ["settingsModal", "exploreModal", "confirmModal", "iruModal", "uploadModal"].forEach(closeModal);
    }
  });

  bindUploadComponent();
  bindSwitchPressFeedback();
}

function initialize() {
  try {
    loadSettings();
    normalizeChats();
    if (chats.length) currentChatId = chats[0].id;
    if (!currentChatId) {
      const chat = {
        id: makeId(),
        title: "Cuộc trò chuyện mới",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: []
      };
      chats = [chat];
      currentChatId = chat.id;
      saveChats();
    }
    renderHistory();
    renderMessages();
    renderAttachmentBar();
    updateChatTitle();
    updateSubjectUI();
    bindEvents();
    bindLucianDropdown();
    bindComposer452();
    initGlobe();
  } catch (error) {
    console.error("Lỗi khởi động:", error);
    showToast("Rika AI gặp lỗi khởi động.");
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialize, { once: true });
} else {
  initialize();
}
