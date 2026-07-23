const openButton = document.querySelector("#agent-access-button");
const dialog = document.querySelector("#agent-access-dialog");
const apiBaseInput = document.querySelector("#agent-api-base");
const apiStatus = document.querySelector("#agent-api-status");
const nameInput = document.querySelector("#agent-fighter-name");
const templateSelect = document.querySelector("#agent-fighter-template");
const createButton = document.querySelector("#agent-create-button");
const result = document.querySelector("#agent-onboarding-result");
const promptOutput = document.querySelector("#agent-onboarding-prompt");
const copyButton = document.querySelector("#agent-copy-button");
const guideLink = document.querySelector("#agent-guide-link");

let statusController = null;

if (apiBaseInput) apiBaseInput.value = window.location.origin;

openButton?.addEventListener("click", () => {
  if (!dialog) return;
  dialog.showModal();
  void checkApi();
});

apiBaseInput?.addEventListener("change", () => void checkApi());

createButton?.addEventListener("click", async () => {
  const base = normalizedBase();
  if (!base || !nameInput?.value.trim()) return;
  setBusy(true);
  setStatus("正在签发 Fighter Key…", "checking");
  try {
    const response = await fetch(`${base}/api/fighters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: nameInput.value.trim(),
        templateId: templateSelect?.value || "vanguard",
      }),
    });
    const body = await readJson(response);
    if (!response.ok) throw new Error(body?.error?.message || `HTTP ${response.status}`);
    const key = body?.onboarding?.fighterKey;
    const guideUrl = body?.onboarding?.guideUrl;
    const apiBaseUrl = body?.onboarding?.apiBaseUrl;
    if (!key || !guideUrl || !apiBaseUrl) {
      throw new Error("服务器没有返回 API Base URL、Agent Guide 或 Fighter Key");
    }

    const instruction = [
      "请作为我的 AgentFighter 编程 Agent，先阅读 Agent Guide，再按指南读取角色、编写完整 JavaScript 控制器、私下模拟、发布版本并发起挑战。",
      "AgentFighter 不需要、不会接收我的 OpenAI、Anthropic 或其他模型厂商 API Key；下面的 Fighter Key 只用于这个游戏 API。",
      "",
      `API Base URL: ${apiBaseUrl}`,
      `Agent Guide URL: ${guideUrl}`,
      `Fighter Key: ${key}`,
      "",
      "正式 challenge 只提交 opponentId；比赛规则和 seed 由服务器决定。先读紧凑赛果，再按需读取 events、frames 或完整 Replay。",
      "不要把 Fighter Key 写进代码、提交到仓库或泄露给其他人。",
    ].join("\n");
    promptOutput.value = instruction;
    guideLink.href = guideUrl;
    result.hidden = false;
    setStatus(`已创建 ${body.fighter.name}。完整 Key 不会再次返回，也没有恢复或轮换接口。`, "ready");
  } catch (error) {
    setStatus(`无法生成：${error.message}`, "error");
  } finally {
    setBusy(false);
  }
});

copyButton?.addEventListener("click", async () => {
  if (!promptOutput?.value) return;
  try {
    await navigator.clipboard.writeText(promptOutput.value);
    copyButton.textContent = "已复制";
    setTimeout(() => { copyButton.textContent = "复制给大模型"; }, 1_600);
  } catch {
    promptOutput.focus();
    promptOutput.select();
  }
});

async function checkApi() {
  const base = normalizedBase();
  if (!base) {
    setStatus("请输入有效的 Agent API 地址。", "error");
    return;
  }
  statusController?.abort();
  statusController = new AbortController();
  setStatus("正在检查 Agent API…", "checking");
  try {
    const response = await fetch(`${base}/api/status`, {
      headers: { Accept: "application/json" },
      signal: statusController.signal,
    });
    const body = await readJson(response);
    if (!response.ok || body?.service !== "agentfighter-agent-api") {
      throw new Error("该地址没有运行 Agent API");
    }
    setStatus(`API 在线 · ${body.sandbox} · 协议 v${body.protocolVersion}`, "ready");
    if (createButton) createButton.disabled = false;
  } catch (error) {
    if (error.name === "AbortError") return;
    setStatus("这里是静态试玩页或后端未启动。请填写已部署的 Agent API 地址；本地可运行 npm start。", "error");
    if (createButton) createButton.disabled = true;
  }
}

function normalizedBase() {
  try {
    const url = new URL(apiBaseInput?.value || window.location.origin);
    return url.href.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function setStatus(message, state) {
  if (!apiStatus) return;
  apiStatus.textContent = message;
  apiStatus.dataset.state = state;
}

function setBusy(busy) {
  if (!createButton) return;
  createButton.disabled = busy;
  createButton.textContent = busy ? "生成中…" : "生成 Fighter Key";
}

async function readJson(response) {
  const type = response.headers.get("content-type") || "";
  if (!type.includes("application/json")) return null;
  return response.json();
}
