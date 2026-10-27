
"use strict";

/* ==================================================
   RIKA AI — BẢN HOÀN CHỈNH
   GitHub Pages -> Cloudflare Worker -> OpenRouter

   Giữ nguyên:
   - Trò chuyện AI
   - Lịch sử, tạo và xóa cuộc trò chuyện
   - Cài đặt màu, nền sáng, màu tự chọn
   - Ghi chú ghi nhớ, phong cách trả lời
   - Khám phá, chế độ bí mật
   - Quả địa cầu 3D
   - Nhân vật Haru Live2D
   - Tự động sửa lỗi tải và căn kích thước Haru
   - TÍNH NĂNG ẨN: THANHTHUY
================================================== */

const $ = (selector) => document.querySelector(selector);

const API_URL =
  "https://rika-ai-api.nguyentiendungdz765hd.workers.dev";

const HARU_MODEL = "./Haru.model3.json";

const STORAGE_KEY = "rika_ai_conversations_v2";
const SETTINGS_KEY = "rika_ai_settings_v1";
const MODE_KEY = "rikaMode";

const MAX_HISTORY = 40;
const MAX_MESSAGES_PER_CHAT = 100;

const DEFAULT_SETTINGS = {
  memoryEnabled: false,
  memoryNote: "",
  replyStyle: "balanced",
  buttonPreset: "purple",
  customAccent: "#b49aff",
  customAccentStrong: "#8b5cf6",
  whiteBackground: false,
  haruVisible: true
};

const THEMES = {
  purple: ["#b49aff", "#8b5cf6"],
  blue: ["#7ab8ff", "#3878e8"],
  green: ["#7ee0b0", "#20a875"],
  pink: ["#ff9ed2", "#e45ca9"],
  red: ["#ff929d", "#df425e"],
  white: ["#ded5ff", "#9881e8"]
};

let chats = [];
let currentChatId = null;
let settings = { ...DEFAULT_SETTINGS };
let isSending = false;
let toastTimer = null;
let secretMode = false;

try {
  secretMode = localStorage.getItem(MODE_KEY) === "em-gai-mua";
} catch {}

let globeRenderer = null;
let globeScene = null;
let globeCamera = null;
let globeObject = null;
let globeAtmosphere = null;
let globeStars = null;
let globeFrame = null;
let globeResizeObserver = null;

let haruApp = null;
let haruModel = null;
let haruLoadStarted = false;
let haruLoadFailed = false;
let haruResizeObserver = null;
let haruResizeHandler = null;
let haruOriginalWidth = 0;
let haruOriginalHeight = 0;


/* ==================================================
   1. TIỆN ÍCH
================================================== */

function makeId() {
  return Date.now().toString(36) +
    Math.random().toString(36).slice(2, 9);
}

function showToast(message) {
  const toast = $("#toast");
  if (!toast) return;

  toast.textContent = message;
  toast.classList.add("show");

  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 2600);
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
    console.warn("Không lưu được dữ liệu:", error);
    showToast("Không thể lưu dữ liệu trên thiết bị.");
  }
}

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function makeTitle(text) {
  const clean = String(text || "Cuộc trò chuyện mới")
    .replace(/\s+/g, " ")
    .trim();

  return clean.length > 32
    ? clean.slice(0, 32) + "…"
    : clean || "Cuộc trò chuyện mới";
}

function getCurrentChat() {
  return chats.find(
    (chat) => chat.id === currentChatId
  ) || null;
}

function saveChats() {
  chats = chats.slice(0, MAX_HISTORY);
  saveJSON(STORAGE_KEY, chats);
}

function saveSettings() {
  saveJSON(SETTINGS_KEY, settings);
}

function getReplyStyleInstruction() {
  const styles = {
    balanced: "Trả lời cân bằng, rõ ràng và hữu ích.",
    short: "Ưu tiên trả lời ngắn gọn, đi thẳng vào trọng tâm.",
    detailed: "Giải thích chi tiết từng bước, thêm ví dụ khi phù hợp.",
    friendly: "Dùng giọng thân thiện, tự nhiên và dễ hiểu."
  };

  return styles[settings.replyStyle] || styles.balanced;
}


/* ==================================================
   2. LỊCH SỬ TRÒ CHUYỆN
================================================== */

function normalizeChats() {
  const stored = loadJSON(STORAGE_KEY, []);

  if (!Array.isArray(stored)) {
    chats = [];
    return;
  }

  chats = stored
    .filter((chat) => chat && Array.isArray(chat.messages))
    .map((chat) => ({
      id: String(chat.id || makeId()),
      title: makeTitle(chat.title),
      createdAt: Number(chat.createdAt) || Date.now(),
      updatedAt: Number(chat.updatedAt) || Date.now(),

      messages: chat.messages
        .filter((message) =>
          message &&
          ["user", "assistant"].includes(message.role) &&
          typeof message.content === "string"
        )
        .slice(-MAX_MESSAGES_PER_CHAT)
        .map((message) => ({
          role: message.role,
          content: message.content
        }))
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_HISTORY);
}

function createChat() {
  const chat = {
    id: makeId(),
    title: "Cuộc trò chuyện mới",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: []
  };

  chats.unshift(chat);
  currentChatId = chat.id;

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

  currentChatId = chat.id;

  renderHistory();
  renderMessages();
  updateChatTitle();
  closeSidebar();
}

function deleteChat(id) {
  const chat = chats.find((item) => item.id === id);
  if (!chat) return;

  if (!confirm("Bạn có chắc muốn xóa cuộc trò chuyện này?")) {
    return;
  }

  chats = chats.filter((item) => item.id !== id);

  if (currentChatId === id) {
    currentChatId = chats[0]?.id || null;
  }

  saveChats();

  if (!currentChatId) {
    createChat();
    showToast("Đã xóa cuộc trò chuyện.");
    return;
  }

  renderHistory();
  renderMessages();
  updateChatTitle();

  showToast("Đã xóa cuộc trò chuyện.");
}

function clearAllHistory() {
  if (!chats.length) {
    showToast("Chưa có lịch sử để xóa.");
    return;
  }

  if (!confirm(
    "Xóa toàn bộ lịch sử trò chuyện trên thiết bị này?"
  )) {
    return;
  }

  chats = [];
  currentChatId = null;

  saveChats();
  createChat();

  showToast("Đã xóa lịch sử.");
}

function renderHistory() {
  const list = $("#historyList");
  if (!list) return;

  list.replaceChildren();

  chats.forEach((chat) => {
    const row = document.createElement("div");
    row.className = "history-item";

    const open = document.createElement("button");

    open.className =
      "history-open" +
      (chat.id === currentChatId ? " selected" : "");

    open.textContent = chat.title;
    open.title = chat.title;
    open.addEventListener("click", () => openChat(chat.id));

    const remove = document.createElement("button");

    remove.className = "history-delete";
    remove.textContent = "×";
    remove.title = "Xóa cuộc trò chuyện";
    remove.setAttribute("aria-label", "Xóa " + chat.title);

    remove.addEventListener("click", () => deleteChat(chat.id));

    row.append(open, remove);
    list.appendChild(row);
  });
}

function updateChatTitle() {
  const chat = getCurrentChat();
  const title = $("#chatTitle");

  if (title) {
    title.textContent = chat
      ? chat.title
      : "Rika AI";
  }
}


/* ==================================================
   3. HIỂN THỊ TIN NHẮN VÀ MARKDOWN
================================================== */

function markdownToHTML(text) {
  let output = escapeHTML(text);

  output = output.replace(
    /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g,
    (_, language, code) =>
      '<pre><code class="language-' +
      language +
      '">' +
      code.trim() +
      "</code></pre>"
  );

  output = output.replace(
    /`([^`\n]+)`/g,
    "<code>$1</code>"
  );

  output = output.replace(
    /\*\*([^*]+)\*\*/g,
    "<strong>$1</strong>"
  );

  output = output.replace(
    /(^|[^*])\*([^*\n]+)\*/g,
    "$1<em>$2</em>"
  );

  output = output.replace(
    /^### (.+)$/gm,
    "<h3>$1</h3>"
  );

  output = output.replace(
    /^## (.+)$/gm,
    "<h2>$1</h2>"
  );

  output = output.replace(
    /^# (.+)$/gm,
    "<h1>$1</h1>"
  );

  output = output.replace(/^---$/gm, "<hr>");

  output = output.replace(
    /^\s*[-*] (.+)$/gm,
    "<li>$1</li>"
  );

  output = output.replace(
    /(?:<li>.*?<\/li>\n?)+/gs,
    (items) => "<ul>" + items + "</ul>"
  );

  output = output.replace(/\n/g, "<br>");

  output = output
    .replace(
      /<br>(?=<\/?(?:h[1-3]|ul|li|pre|hr))/g,
      ""
    )
    .replace(
      /<\/(h[1-3]|ul|pre)><br>/g,
      "</$1>"
    );

  return output;
}

async function copyText(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMessage);
  } catch {
    showToast("Không thể sao chép trên trình duyệt này.");
  }
}

function renderMessage(message) {
  const wrapper = document.createElement("article");
  wrapper.className = "message " + message.role;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = message.role === "user" ? "B" : "R";

  const content = document.createElement("div");
  content.className = "message-content";

  const name = document.createElement("div");
  name.className = "message-name";

  name.textContent = message.role === "user"
    ? "Bạn"
    : (secretMode ? "Em Gái Mưa 🌧️" : "Rika AI");

  const body = document.createElement("div");
  body.className = "message-body";
  body.innerHTML = markdownToHTML(message.content);

  content.append(name, body);

  if (message.role === "assistant") {
    const copy = document.createElement("button");

    copy.className = "copy-answer";
    copy.textContent = "Sao chép câu trả lời";

    copy.addEventListener("click", () => {
      copyText(message.content, "Đã sao chép câu trả lời.");
    });

    content.appendChild(copy);
  }

  body.querySelectorAll("pre").forEach((pre) => {
    const button = document.createElement("button");

    button.className = "code-copy";
    button.textContent = "Sao chép mã";

    button.addEventListener("click", () => {
      const code = pre.querySelector("code")?.textContent || "";
      copyText(code, "Đã sao chép mã.");
    });

    pre.insertAdjacentElement("afterend", button);
  });

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

  messages.forEach((message) => {
    box.appendChild(renderMessage(message));
  });

  scrollToBottom();
}

function scrollToBottom() {
  const box = $("#chatBox");
  if (!box) return;

  requestAnimationFrame(() => {
    box.scrollTop = box.scrollHeight;
  });
}

function appendTypingIndicator() {
  const box = $("#messages");
  if (!box) return;

  removeTypingIndicator();

  const wrapper = document.createElement("article");
  wrapper.className = "message";
  wrapper.id = "typingIndicator";

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = "R";

  const content = document.createElement("div");
  content.className = "message-content";

  const name = document.createElement("div");
  name.className = "message-name";
  name.textContent = secretMode
    ? "Em Gái Mưa 🌧️"
    : "Rika AI";

  const body = document.createElement("div");
  body.className = "message-body";

  const dots = document.createElement("span");
  dots.className = "typing-dots";
  dots.innerHTML = "<i></i><i></i><i></i>";

  body.appendChild(dots);
  content.append(name, body);
  wrapper.append(avatar, content);
  box.appendChild(wrapper);

  scrollToBottom();
}

function removeTypingIndicator() {
  $("#typingIndicator")?.remove();
}


/* ==================================================
   4. KẾT NỐI AI
================================================== */

function buildSystemPrompt() {
  let prompt =
    "Bạn là Rika AI, một trợ lý AI hữu ích. " +
    "Trả lời bằng tiếng Việt nếu người dùng không yêu cầu " +
    "ngôn ngữ khác. Trình bày rõ ràng, trung thực, " +
    "không bịa đặt khi không biết. " +
    getReplyStyleInstruction();

  if (settings.memoryEnabled && settings.memoryNote.trim()) {
    prompt +=
      "\n\nGhi chú người dùng đã cung cấp:\n" +
      settings.memoryNote.trim();
  }

  if (secretMode) {
    prompt +=
      "\n\nBạn đang ở chế độ Em Gái Mưa. " +
      "Hãy dùng giọng nhẹ nhàng, thân thiện và dễ hiểu.";
  }

  return prompt;
}

async function requestAI(conversation) {
  const messages = [
    {
      role: "system",
      content: buildSystemPrompt()
    },
    ...conversation
  ];

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ messages })
  });

  let data = {};

  try {
    data = await response.json();
  } catch {
    throw new Error("Máy chủ trả về dữ liệu không hợp lệ.");
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(
        "Máy chủ chưa xác thực được API. Hãy kiểm tra Worker."
      );
    }

    if (response.status === 402) {
      throw new Error(
        "Dịch vụ AI đã hết hạn mức hoặc cần số dư."
      );
    }

    if (response.status === 403) {
      throw new Error(
        "Yêu cầu bị từ chối. Hãy kiểm tra quyền truy cập API."
      );
    }

    if (response.status === 429) {
      throw new Error(
        "Bạn gửi quá nhanh hoặc dịch vụ AI đang quá tải. Hãy đợi."
      );
    }

    throw new Error(
      data.error ||
      data.message ||
      ("Máy chủ gặp lỗi HTTP " + response.status + ".")
    );
  }

  if (typeof data.reply === "string") return data.reply;
  if (typeof data.message === "string") return data.message;
  if (typeof data.content === "string") return data.content;

  const content = data.choices?.[0]?.message?.content;

  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content.map((item) => item.text || "").join("\n");
  }

  throw new Error(
    "AI chưa trả về câu trả lời hợp lệ. Hãy kiểm tra Worker."
  );
}


/* ==================================================
   4.1. GỬI TIN NHẮN
   Đã tích hợp tính năng ẩn THANHTHUY
================================================== */

async function sendMessage(text) {
  const cleanText = String(text || "").trim();

  if (!cleanText || isSending) return;

  // TÍNH NĂNG ẨN:
  // Nhập "thanhthuy" để nhận câu trả lời cố định.
  // Không gửi yêu cầu đến API AI.
  if (cleanText.toLowerCase() === "thanhthuy") {
    let chat = getCurrentChat();

    if (!chat) {
      createChat();
      chat = getCurrentChat();
    }

    if (!chat) return;

    // Cần chỗ cho cả tin nhắn người dùng và câu trả lời.
    if (chat.messages.length + 2 > MAX_MESSAGES_PER_CHAT) {
      showToast(
        "Cuộc trò chuyện đã đạt giới hạn. Hãy tạo chat mới."
      );
      return;
    }

    chat.messages.push({
      role: "user",
      content: cleanText
    });

    chat.messages.push({
      role: "assistant",
      content:
        "xin chào bạn nước xanh yêu giấu ,chúc một ngày tốt lành😊😊"
    });

    if (
      chat.messages.filter(
        (item) => item.role === "user"
      ).length === 1
    ) {
      chat.title = makeTitle(cleanText);
    }

    chat.updatedAt = Date.now();

    saveChats();
    renderHistory();
    renderMessages();
    updateChatTitle();

    const input = $("#userInput");
    if (input) {
      input.value = "";
      input.style.height = "auto";
    }

    return;
  }

  // Chế độ bí mật hiện có.
  if (cleanText.toLowerCase() === "dungxha") {
    secretMode = true;

    try {
      localStorage.setItem(MODE_KEY, "em-gai-mua");
    } catch {}

    renderMessages();
    showToast("Đã bật chế độ Em Gái Mưa 🌧️.");

    const input = $("#userInput");
    if (input) input.value = "";

    return;
  }

  if (cleanText.toLowerCase() === "rika normal") {
    secretMode = false;

    try {
      localStorage.removeItem(MODE_KEY);
    } catch {}

    renderMessages();
    showToast("Đã trở về chế độ Rika AI bình thường.");

    const input = $("#userInput");
    if (input) input.value = "";

    return;
  }

  let chat = getCurrentChat();

  if (!chat) {
    createChat();
    chat = getCurrentChat();
  }

  if (!chat) return;

  if (chat.messages.length >= MAX_MESSAGES_PER_CHAT) {
    showToast(
      "Cuộc trò chuyện đã đạt giới hạn. Hãy tạo chat mới."
    );
    return;
  }

  chat.messages.push({
    role: "user",
    content: cleanText
  });

  if (
    chat.messages.filter((item) => item.role === "user").length === 1
  ) {
    chat.title = makeTitle(cleanText);
  }

  chat.updatedAt = Date.now();

  saveChats();
  renderHistory();
  renderMessages();
  updateChatTitle();

  const input = $("#userInput");
  if (input) {
    input.value = "";
    input.style.height = "auto";
  }

  isSending = true;

  const sendBtn = $("#sendBtn");
  if (sendBtn) sendBtn.disabled = true;

  appendTypingIndicator();

  try {
    const conversation = chat.messages
      .slice(-MAX_MESSAGES_PER_CHAT)
      .map((item) => ({
        role: item.role,
        content: item.content
      }));

    const answer = await requestAI(conversation);

    const targetChat = chats.find(
      (item) => item.id === chat.id
    );

    if (targetChat) {
      targetChat.messages.push({
        role: "assistant",
        content: String(
          answer || "Mình chưa nhận được câu trả lời."
        )
      });

      targetChat.messages =
        targetChat.messages.slice(-MAX_MESSAGES_PER_CHAT);

      targetChat.updatedAt = Date.now();
      saveChats();
    }
  } catch (error) {
    const targetChat = chats.find(
      (item) => item.id === chat.id
    );

    if (targetChat) {
      targetChat.messages.push({
        role: "assistant",
        content:
          "Mình chưa thể trả lời lúc này.\n\n" +
          "**Thông báo:** " +
          (error.message || "Lỗi kết nối.") +
          "\n\nHãy kiểm tra Cloudflare Worker và hạn mức dịch vụ AI."
      });

      targetChat.messages =
        targetChat.messages.slice(-MAX_MESSAGES_PER_CHAT);

      targetChat.updatedAt = Date.now();
      saveChats();
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


/* ==================================================
   5. CÀI ĐẶT VÀ MÀU CHỦ ĐỀ
================================================== */

function loadSettings() {
  const saved = loadJSON(SETTINGS_KEY, {});

  settings = {
    ...DEFAULT_SETTINGS,
    ...(saved && typeof saved === "object" ? saved : {})
  };

  if (
    !THEMES[settings.buttonPreset] &&
    settings.buttonPreset !== "custom"
  ) {
    settings.buttonPreset = "purple";
  }

  if (!["balanced", "short", "detailed", "friendly"]
      .includes(settings.replyStyle)) {
    settings.replyStyle = "balanced";
  }

  $("#themeSelect").value = settings.buttonPreset;
  $("#customAccent").value = settings.customAccent;
  $("#customAccentStrong").value = settings.customAccentStrong;
  $("#whiteBackground").checked = !!settings.whiteBackground;
  $("#replyStyle").value = settings.replyStyle;
  $("#memoryEnabled").checked = !!settings.memoryEnabled;
  $("#memoryNote").value = settings.memoryNote || "";

  $("#customColors").classList.toggle(
    "hidden",
    settings.buttonPreset !== "custom"
  );

  applyTheme();
}

function applyTheme() {
  let colors = THEMES[settings.buttonPreset] || THEMES.purple;

  if (settings.buttonPreset === "custom") {
    colors = [
      settings.customAccent || "#b49aff",
      settings.customAccentStrong || "#8b5cf6"
    ];
  }

  document.documentElement.style.setProperty("--accent", colors[0]);
  document.documentElement.style.setProperty("--accent-strong", colors[1]);

  document.body.classList.toggle(
    "white-background",
    !!settings.whiteBackground
  );

  if ($("#themeSelect")) {
    $("#themeSelect").value = settings.buttonPreset;
  }

  $("#customColors")?.classList.toggle(
    "hidden",
    settings.buttonPreset !== "custom"
  );
}

function saveSettingsFromUI() {
  settings.buttonPreset = $("#themeSelect").value;
  settings.customAccent = $("#customAccent").value;
  settings.customAccentStrong = $("#customAccentStrong").value;
  settings.whiteBackground = $("#whiteBackground").checked;
  settings.replyStyle = $("#replyStyle").value;
  settings.memoryEnabled = $("#memoryEnabled").checked;
  settings.memoryNote = $("#memoryNote").value;

  applyTheme();
  saveSettings();

  closeModal("settingsModal");
  showToast("Đã lưu cài đặt.");
}

function resetTheme() {
  settings.buttonPreset = "purple";
  settings.customAccent = "#b49aff";
  settings.customAccentStrong = "#8b5cf6";
  settings.whiteBackground = false;

  $("#themeSelect").value = "purple";
  $("#customAccent").value = settings.customAccent;
  $("#customAccentStrong").value = settings.customAccentStrong;
  $("#whiteBackground").checked = false;

  applyTheme();
  saveSettings();

  showToast("Đã đặt lại giao diện.");
}


/* ==================================================
   6. HỘP THOẠI VÀ THANH BÊN
================================================== */

function openModal(id) {
  $("#" + id)?.classList.remove("hidden");
}

function closeModal(id) {
  $("#" + id)?.classList.add("hidden");
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


/* ==================================================
   7. QUẢ ĐỊA CẦU THREE.JS
================================================== */

function initGlobe() {
  const canvas = $("#earthCanvas");

  if (!canvas || !window.THREE || globeRenderer) return;

  try {
    globeScene = new THREE.Scene();

    globeCamera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);

    globeRenderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: "high-performance"
    });

    globeRenderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, 1.5)
    );

    if ("outputColorSpace" in globeRenderer && THREE.SRGBColorSpace) {
      globeRenderer.outputColorSpace = THREE.SRGBColorSpace;
    }

    globeScene.add(new THREE.AmbientLight(0xffffff, 1.5));

    const light = new THREE.DirectionalLight(0xffffff, 2.1);
    light.position.set(4, 3, 5);
    globeScene.add(light);

    const earthGeometry = new THREE.SphereGeometry(1, 64, 64);
    const loader = new THREE.TextureLoader();
    loader.crossOrigin = "anonymous";

    loader.load(
      "https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg",
      (texture) => {
        if (!globeScene) return;

        if ("colorSpace" in texture && THREE.SRGBColorSpace) {
          texture.colorSpace = THREE.SRGBColorSpace;
        }

        globeObject = new THREE.Mesh(
          earthGeometry,
          new THREE.MeshPhongMaterial({
            map: texture,
            shininess: 10
          })
        );

        globeScene.add(globeObject);
      },
      undefined,
      () => {
        if (!globeScene) return;

        globeObject = new THREE.Mesh(
          earthGeometry,
          new THREE.MeshPhongMaterial({
            color: 0x547ee8,
            emissive: 0x172a61,
            shininess: 28
          })
        );

        globeScene.add(globeObject);
        console.warn("Không tải được ảnh Trái Đất.");
      }
    );

    globeAtmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.035, 64, 64),
      new THREE.MeshBasicMaterial({
        color: 0x9881ff,
        transparent: true,
        opacity: 0.11,
        side: THREE.BackSide,
        depthWrite: false
      })
    );

    globeScene.add(globeAtmosphere);

    const starsGeometry = new THREE.BufferGeometry();
    const starPositions = [];

    for (let i = 0; i < 350; i++) {
      starPositions.push(
        (Math.random() - 0.5) * 16,
        (Math.random() - 0.5) * 12,
        (Math.random() - 0.5) * 8 - 2
      );
    }

    starsGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(starPositions, 3)
    );

    globeStars = new THREE.Points(
      starsGeometry,
      new THREE.PointsMaterial({
        color: 0xc8bbff,
        size: 0.018,
        transparent: true,
        opacity: 0.8,
        depthWrite: false
      })
    );

    globeScene.add(globeStars);

    resizeGlobe();

    function animateGlobe() {
      globeFrame = requestAnimationFrame(animateGlobe);

      if (globeObject) {
        globeObject.rotation.y += 0.0015;
        globeObject.rotation.x = -0.06;
      }

      if (globeAtmosphere) {
        globeAtmosphere.rotation.y += 0.0015;
      }

      if (globeStars) {
        globeStars.rotation.y += 0.00012;
      }

      globeRenderer.render(globeScene, globeCamera);
    }

    animateGlobe();

    if (window.ResizeObserver) {
      globeResizeObserver = new ResizeObserver(resizeGlobe);

      const intro = $("#rikaIntro");
      if (intro) globeResizeObserver.observe(intro);
    }
  } catch (error) {
    console.error("Không thể khởi tạo địa cầu:", error);
  }
}

function resizeGlobe() {
  if (!globeRenderer || !globeCamera) return;

  const canvas = $("#earthCanvas");
  const intro = $("#rikaIntro");

  const width = Math.max(
    1,
    Math.round(canvas?.clientWidth || intro?.clientWidth || window.innerWidth)
  );

  const height = Math.max(
    1,
    Math.round(canvas?.clientHeight || intro?.clientHeight || window.innerHeight)
  );

  const aspect = width / height;
  globeCamera.aspect = aspect;

  const fovRadians = THREE.MathUtils.degToRad(globeCamera.fov);
  const radius = 1.04;

  const verticalDistance = radius / Math.tan(fovRadians / 2);

  const horizontalDistance =
    radius / (Math.tan(fovRadians / 2) * Math.max(aspect, 0.05));

  globeCamera.position.set(
    0,
    0,
    Math.max(3.3, verticalDistance, horizontalDistance) * 1.10
  );

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
  }, 520);
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


/* ==================================================
   8. HARU LIVE2D — SỬA LỖI KHUNG TRẮNG
================================================== */

function showHaruError(message) {
  const loading = $("#haruLoading");

  if (loading) {
    loading.classList.remove("hidden");
    loading.textContent = message;
    loading.style.display = "block";
    loading.style.position = "relative";
    loading.style.zIndex = "10";
    loading.style.padding = "16px";
    loading.style.color = "#c026d3";
    loading.style.textAlign = "center";
    loading.style.overflowWrap = "anywhere";
  }
}

function disposeHaruApp() {
  if (haruResizeObserver) {
    haruResizeObserver.disconnect();
    haruResizeObserver = null;
  }

  if (haruResizeHandler) {
    window.removeEventListener("resize", haruResizeHandler);
    haruResizeHandler = null;
  }

  if (haruApp) {
    try {
      haruApp.destroy(false, {
        children: true,
        texture: false,
        baseTexture: false
      });
    } catch (error) {
      console.warn("Không thể dọn ứng dụng Haru cũ:", error);
    }
  }

  haruApp = null;
  haruModel = null;
  haruOriginalWidth = 0;
  haruOriginalHeight = 0;
}

async function initHaru() {
  if (haruLoadStarted && !haruLoadFailed) return;

  const loading = $("#haruLoading");
  const widget = $("#haruWidget");
  const canvas = $("#haruCanvas");
  const stage = $("#haruStage");

  if (!widget || !canvas || !stage) return;

  haruLoadStarted = true;
  haruLoadFailed = false;

  if (loading) {
    loading.classList.remove("hidden");
    loading.textContent = "Đang tải Haru...";
    loading.style.display = "block";
  }

  try {
    if (!window.PIXI) {
      throw new Error(
        "PixiJS chưa tải. Kiểm tra mạng và thư viện trong HTML."
      );
    }

    if (
      !PIXI.live2d ||
      !PIXI.live2d.Live2DModel
    ) {
      throw new Error(
        "Thư viện Live2D chưa sẵn sàng. Kiểm tra Cubism Core và pixi-live2d-display."
      );
    }

    disposeHaruApp();

    const initialWidth = Math.max(1, stage.clientWidth || 300);
    const initialHeight = Math.max(1, stage.clientHeight || 400);

    haruApp = new PIXI.Application({
      view: canvas,
      width: initialWidth,
      height: initialHeight,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2)
    });

    haruModel = await PIXI.live2d.Live2DModel.from(
      HARU_MODEL,
      { autoInteract: true }
    );

    if (!haruModel) {
      throw new Error("Không tạo được mô hình Haru.");
    }

    haruApp.stage.addChild(haruModel);

    haruModel.scale.set(1);
    haruModel.anchor.set(0.5, 0.5);

    const bounds = haruModel.getLocalBounds();

    haruOriginalWidth = bounds.width;
    haruOriginalHeight = bounds.height;

    if (
      !Number.isFinite(haruOriginalWidth) ||
      !Number.isFinite(haruOriginalHeight) ||
      haruOriginalWidth <= 0 ||
      haruOriginalHeight <= 0
    ) {
      throw new Error(
        "Kích thước mô hình không hợp lệ. Hãy kiểm tra tệp Haru.model3.json."
      );
    }

    function fitHaru() {
      if (!haruApp || !haruModel) return;

      const width = stage.clientWidth;
      const height = stage.clientHeight;

      if (width <= 0 || height <= 0) return;

      haruApp.renderer.resize(
        Math.max(1, Math.round(width)),
        Math.max(1, Math.round(height))
      );

      const scale = Math.min(
        width / haruOriginalWidth,
        height / haruOriginalHeight
      );

      haruModel.scale.set(scale * 0.94);
      haruModel.x = width / 2;
      haruModel.y = height * 0.54;
    }

    fitHaru();

    if (window.ResizeObserver) {
      haruResizeObserver = new ResizeObserver(() => {
        fitHaru();
      });

      haruResizeObserver.observe(stage);
    } else {
      haruResizeHandler = fitHaru;
      window.addEventListener("resize", haruResizeHandler);
    }

    if (loading) {
      loading.classList.add("hidden");
      loading.style.display = "none";
    }

    const storedVisible = settings.haruVisible !== false;

    widget.classList.toggle("hidden", !storedVisible);

    const toggleButton = $("#toggleHaruBtn");

    if (toggleButton) {
      toggleButton.textContent = storedVisible
        ? "✦ Ẩn Haru"
        : "✦ Haru";
    }

    console.log("Haru Live2D đã tải thành công.");
  } catch (error) {
    haruLoadFailed = true;

    console.error("Lỗi tải Haru Live2D:", error);

    disposeHaruApp();

    widget.classList.remove("hidden");

    showHaruError(
      "Haru chưa tải được.\n" +
      (error.message || "Lỗi không xác định.") +
      "\n\nKiểm tra tệp mô hình và đường dẫn trên GitHub."
    );

    const toggleButton = $("#toggleHaruBtn");

    if (toggleButton) {
      toggleButton.textContent = "✦ Ẩn Haru";
    }
  }
}

function toggleHaru() {
  const widget = $("#haruWidget");
  const button = $("#toggleHaruBtn");

  if (!widget) return;

  const willShow = widget.classList.contains("hidden");

  widget.classList.toggle("hidden", !willShow);

  settings.haruVisible = willShow;
  saveSettings();

  if (button) {
    button.textContent = willShow
      ? "✦ Ẩn Haru"
      : "✦ Haru";
  }

  if (willShow && (!haruLoadStarted || haruLoadFailed)) {
    haruLoadStarted = false;
    haruLoadFailed = false;
    initHaru();
  }
}

function hideHaru() {
  $("#haruWidget")?.classList.add("hidden");

  settings.haruVisible = false;
  saveSettings();

  const button = $("#toggleHaruBtn");

  if (button) {
    button.textContent = "✦ Haru";
  }
}


/* ==================================================
   9. TỰ ĐỘNG THU GIÃN Ô NHẬP
================================================== */

function autoResizeInput() {
  const input = $("#userInput");
  if (!input) return;

  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 150) + "px";
}


/* ==================================================
   10. GẮN SỰ KIỆN
================================================== */

function bindEvents() {
  $("#enterAppBtn")?.addEventListener("click", enterApp);

  $("#newChatBtn")?.addEventListener("click", createChat);
  $("#topNewChatBtn")?.addEventListener("click", createChat);

  $("#menuBtn")?.addEventListener("click", openSidebar);
  $("#closeSidebarBtn")?.addEventListener("click", closeSidebar);
  $("#sidebarOverlay")?.addEventListener("click", closeSidebar);

  $("#historyToggleBtn")?.addEventListener("click", () => {
    closeSidebar();
    showToast("Chọn một cuộc trò chuyện trong mục Gần đây.");
  });

  $("#exploreBtn")?.addEventListener("click", () => {
    closeSidebar();
    openModal("exploreModal");
  });

  $("#settingsBtn")?.addEventListener("click", () => {
    closeSidebar();
    openModal("settingsModal");
  });

  $("#showIntroBtn")?.addEventListener("click", showIntro);
  $("#clearHistoryBtn")?.addEventListener("click", clearAllHistory);

  $("#chatForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    sendMessage($("#userInput")?.value);
  });

  $("#userInput")?.addEventListener("input", autoResizeInput);

  $("#userInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage($("#userInput").value);
    }
  });

  document.querySelectorAll("[data-prompt]").forEach((button) => {
    button.addEventListener("click", () => {
      usePrompt(button.dataset.prompt);
      closeSidebar();
    });
  });

  document.querySelectorAll("[data-close]").forEach((button) => {
    button.addEventListener("click", () => {
      closeModal(button.dataset.close);
    });
  });

  $("#themeSelect")?.addEventListener("change", () => {
    settings.buttonPreset = $("#themeSelect").value;
    applyTheme();
  });

  $("#customAccent")?.addEventListener("input", () => {
    settings.customAccent = $("#customAccent").value;

    if (settings.buttonPreset === "custom") {
      applyTheme();
    }
  });

  $("#customAccentStrong")?.addEventListener("input", () => {
    settings.customAccentStrong = $("#customAccentStrong").value;

    if (settings.buttonPreset === "custom") {
      applyTheme();
    }
  });

  $("#whiteBackground")?.addEventListener("change", () => {
    settings.whiteBackground = $("#whiteBackground").checked;
    applyTheme();
  });

  $("#saveSettingsBtn")?.addEventListener(
    "click",
    saveSettingsFromUI
  );

  $("#resetThemeBtn")?.addEventListener("click", resetTheme);

  $("#toggleHaruBtn")?.addEventListener("click", toggleHaru);
  $("#hideHaruBtn")?.addEventListener("click", hideHaru);

  window.addEventListener("resize", resizeGlobe);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeSidebar();
      closeModal("settingsModal");
      closeModal("exploreModal");
    }
  });
}


/* ==================================================
   11. KHỞI ĐỘNG RIKA AI
================================================== */

function initialize() {
  try {
    loadSettings();
    normalizeChats();

    if (chats.length) {
      currentChatId = chats[0].id;
    }

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

    bindEvents();
    initGlobe();

    if (settings.haruVisible !== false) {
      initHaru();
    }
  } catch (error) {
    console.error("Không thể khởi động Rika AI:", error);
    showToast("Rika AI gặp lỗi khi khởi động. Hãy tải lại trang.");
  }
}

if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    initialize,
    { once: true }
  );
} else {
  initialize();
}
