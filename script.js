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

const SUBJECT_NAMES = {
  toan: "Toán", ly: "Vật Lý", hoa: "Hóa Học", van: "Ngữ Văn",
  anh: "Tiếng Anh", sinh: "Sinh Học", su: "Lịch Sử", dia: "Địa Lý", tin: "Tin Học"
};

const PROVIDER_INFO = {
  openrouter: { name: "Rika 0.1", desc: "OpenRouter — tự động chọn model miễn phí tốt nhất" },
  openai: { name: "Rika 0.2", desc: "OpenAI — GPT-4o-mini, cân bằng tốc độ & trí tuệ" }
};

const DEFAULT_SETTINGS = {
  memoryEnabled: false,
  memoryNote: "",
  darkMode: false,
  provider: "openrouter"
};

const REDUCED_MOTION = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || false;

let chats = [];
let currentChatId = null;
let settings = { ...DEFAULT_SETTINGS };
let isSending = false;
let toastTimer = null;
let selectedSubject = "";

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
    .replace(/'/g, "&#039;");
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn("Không lưu được:", error);
    if (error.name === "QuotaExceededError" && key === STORAGE_KEY && chats.length > 1) {
      chats = chats.slice(0, Math.max(1, chats.length - 1));
      try { localStorage.setItem(key, JSON.stringify(chats)); } catch {}
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

function showConfirmDialog(title, message, onConfirm) {
  const modal = $("#confirmModal");
  if (!modal) return;
  $("#confirmTitle").textContent = title;
  $("#confirmMessage").textContent = message;
  modal.classList.remove("hidden");

  const okBtn = $("#confirmOkBtn");
  const cancelBtn = $("#confirmCancelBtn");
  const backdrop = modal.querySelector(".modal-backdrop");

  const newOk = okBtn.cloneNode(true);
  const newCancel = cancelBtn.cloneNode(true);
  okBtn.parentNode.replaceChild(newOk, okBtn);
  cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);

  const close = () => modal.classList.add("hidden");
  newOk.addEventListener("click", () => { close(); onConfirm(); }, { once: true });
  newCancel.addEventListener("click", close, { once: true });
  backdrop?.addEventListener("click", close, { once: true });
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
          modelName: m.modelName || null
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
  const sendBtn = $("#sendBtn"); if (sendBtn) sendBtn.disabled = false;
  removeTypingIndicator();
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
  currentChatId = chat.id;
  renderHistory();
  renderMessages();
  updateChatTitle();
  closeSidebar();
}

function deleteChat(id) {
  if (!chats.find((item) => item.id === id)) return;
  showConfirmDialog("Xóa cuộc trò chuyện", "Bạn có chắc muốn xóa cuộc trò chuyện này?", () => {
    chats = chats.filter((item) => item.id !== id);
    if (currentChatId === id) currentChatId = chats[0]?.id || null;
    saveChats();
    if (!currentChatId) { createChat(); showToast("Đã xóa."); return; }
    renderHistory();
    renderMessages();
    updateChatTitle();
    showToast("Đã xóa.");
  });
}

function clearAllHistory() {
  if (!chats.length) { showToast("Chưa có lịch sử."); return; }
  showConfirmDialog("Xóa toàn bộ lịch sử", "Xóa toàn bộ lịch sử trò chuyện?", () => {
    chats = [];
    currentChatId = null;
    saveChats();
    createChat();
    showToast("Đã xóa lịch sử.");
  });
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
    const key = `\u0000PH${placeholders.length}\u0000`;
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

  output = output.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
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

  output = output.replace(/\u0000PH(\d+)\u0000/g, (_, i) => placeholders[Number(i)] || "");
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

function renderMessage(message) {
  const wrapper = document.createElement("article");
  wrapper.className = "message " + message.role;

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
  wrapper.innerHTML = `
    <div class="message-avatar">R</div>
    <div class="message-content">
      <div class="message-name">Rika</div>
      <div class="message-body"><span class="typing-dots"><i></i><i></i><i></i></span></div>
    </div>`;
  box.appendChild(wrapper);
  scrollToBottom();
}

function removeTypingIndicator() {
  $("#typingIndicator")?.remove();
}

function buildContextualPrompt() {
  let prompt = "";
  if (selectedSubject && SUBJECT_NAMES[selectedSubject]) {
    prompt += `NGƯỜI DÙNG ĐANG HỌC MÔN: ${SUBJECT_NAMES[selectedSubject]}. Trả lời CHI TIẾT, RÕ RÀNG, có cấu trúc theo các bước. Giải từng bước một, ghi rõ công thức, đơn vị, kết luận đáp án.`;
  } else {
    prompt += "Người dùng KHÔNG chọn môn. Trả lời NGẮN GỌN, đi thẳng vào đáp án chính.";
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
  currentAbortController = new AbortController();
  const signal = currentAbortController.signal;
  const timeoutId = setTimeout(() => {
    try { currentAbortController?.abort(); } catch {}
  }, API_TIMEOUT_MS);

  const messages = conversation.slice(-MAX_CONTEXT_MESSAGES);

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        provider: settings.provider,
        contextNote
      }),
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
    currentAbortController = null;
  }
}

async function sendMessage(text) {
  const cleanText = String(text || "").trim();
  if (!cleanText || isSending) return;

  let chat = getCurrentChat();
  if (!chat) { createChat(); chat = getCurrentChat(); }
  if (!chat) return;
  if (chat.messages.length >= MAX_MESSAGES_PER_CHAT) {
    showToast("Đã đạt giới hạn chat.");
    return;
  }

  chat.messages.push({ role: "user", content: cleanText });
  if (chat.messages.filter((m) => m.role === "user").length === 1) {
    chat.title = makeTitle(cleanText);
  }
  chat.updatedAt = Date.now();
  saveChats();
  renderHistory();
  renderMessages();
  updateChatTitle();

  const input = $("#userInput");
  if (input) { input.value = ""; input.style.height = "auto"; }
  isSending = true;
  const sendBtn = $("#sendBtn"); if (sendBtn) sendBtn.disabled = true;
  appendTypingIndicator();

  const chatIdSnapshot = chat.id;
  const currentModelName = PROVIDER_INFO[settings.provider]?.name || "Rika";

  try {
    const conversation = chat.messages.map((m) => ({ role: m.role, content: m.content }));
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
      showToast("Đã huỷ hoặc quá thời gian chờ.");
    }
  } finally {
    isSending = false;
    if (sendBtn) sendBtn.disabled = false;
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

  const providerSelect = $("#providerSelect");
  if (providerSelect) providerSelect.value = settings.provider;

  const darkModeEl = $("#darkMode");
  if (darkModeEl) darkModeEl.checked = !!settings.darkMode;

  const memoryEnabled = $("#memoryEnabled");
  if (memoryEnabled) memoryEnabled.checked = !!settings.memoryEnabled;

  const memoryNote = $("#memoryNote");
  if (memoryNote) memoryNote.value = settings.memoryNote;

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
  settings.memoryNote = $("#memoryNote")?.value || "";
  applyTheme();
  updateModelInfoText();
  saveSettings();
  closeModal("settingsModal");
  showToast("Đã lưu cài đặt.");
}

function resetSettings() {
  settings = { ...DEFAULT_SETTINGS };
  if ($("#providerSelect")) $("#providerSelect").value = settings.provider;
  if ($("#darkMode")) $("#darkMode").checked = false;
  if ($("#memoryEnabled")) $("#memoryEnabled").checked = false;
  if ($("#memoryNote")) $("#memoryNote").value = "";
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
  autoResizeInput();
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
    const loader = new THREE.TextureLoader();
    loader.crossOrigin = "anonymous";
    loader.load(
      "https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg",
      (texture) => {
        if (!globeScene) return;
        if ("colorSpace" in texture && THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
        globeObject = new THREE.Mesh(earthGeometry, new THREE.MeshPhongMaterial({ map: texture, shininess: 8 }));
        globeScene.add(globeObject);
      },
      undefined,
      () => {
        if (!globeScene) return;
        globeObject = new THREE.Mesh(earthGeometry, new THREE.MeshPhongMaterial({
          color: 0x4a90e2, emissive: 0x1a3a6e, shininess: 24
        }));
        globeScene.add(globeObject);
      }
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
  if (iruLoading) return;
  if (iruFailed) return;

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

    iruModel.interactive = true;
    iruModel.on('pointermove', (e) => {
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

    if ($("#iruModal")?.classList.contains("hidden")) {
      iruApp.ticker.stop();
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

function autoResizeInput() {
  const input = $("#userInput");
  if (!input) return;
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
}

function bindEvents() {
  $("#enterAppBtn")?.addEventListener("click", enterApp);
  $("#newChatBtn")?.addEventListener("click", createChat);
  $("#topNewChatBtn")?.addEventListener("click", createChat);
  $("#menuBtn")?.addEventListener("click", openSidebar);
  $("#closeSidebarBtn")?.addEventListener("click", closeSidebar);
  $("#sidebarOverlay")?.addEventListener("click", closeSidebar);
  $("#exploreBtn")?.addEventListener("click", () => { closeSidebar(); openModal("exploreModal"); });
  $("#settingsBtn")?.addEventListener("click", () => { closeSidebar(); openModal("settingsModal"); });
  $("#showIntroBtn")?.addEventListener("click", showIntro);
  $("#clearHistoryBtn")?.addEventListener("click", clearAllHistory);

  $("#showIruModalBtn")?.addEventListener("click", () => {
    closeSidebar();
    openModal("iruModal");
    setTimeout(() => {
      if (!iruApp) initIru();
      else fitIruCanvas();
    }, 250);
  });

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

  $("#chatForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    sendMessage($("#userInput")?.value);
  });
  $("#userInput")?.addEventListener("input", autoResizeInput);
  $("#userInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage($("#userInput").value);
    }
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
      ["settingsModal", "exploreModal", "confirmModal", "iruModal"].forEach(closeModal);
    }
  });
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
    updateChatTitle();
    updateSubjectUI();
    bindEvents();
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