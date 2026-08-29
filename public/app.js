const CHANNEL_COLORS = {
  SMS: "#5B9EE8",
  Email: "#E8B84B",
  WhatsApp: "#4FCE9E",
  FB: "#7B8FF0",
  IG: "#E86EA8",
  GMB: "#4FCE9E",
  Live_Chat: "#B78CE8",
  Call: "#FF6B4A",
};
function channelColor(c) { return CHANNEL_COLORS[c] || "#8A93A3"; }

let state = { conversations: [], activeId: null, filters: {} };

const $ = (sel) => document.querySelector(sel);
const threadList = $("#threadList");
const threadDetail = $("#threadDetail");

function timeAgo(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return d.toLocaleDateString();
}

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

function buildQuery() {
  const f = state.filters;
  const params = new URLSearchParams();
  if (f.search) params.set("search", f.search);
  if (f.channel) params.set("channel", f.channel);
  if (f.status) params.set("status", f.status);
  if (f.assignedTo) params.set("assignedTo", f.assignedTo);
  if (f.tag) params.set("tag", f.tag);
  if (f.sort) params.set("sort", f.sort);
  return params.toString();
}

async function loadFilters() {
  const opts = await api("/conversations/filters");
  const fill = (sel, values, placeholder) => {
    const el = $(sel);
    el.innerHTML = `<option value="">${placeholder}</option>` +
      values.map((v) => `<option value="${v}">${v}</option>`).join("");
  };
  fill("#fChannel", opts.channels, "All channels");
  fill("#fAssignee", opts.assignees, "Anyone");
  fill("#fTag", opts.tags.filter(Boolean), "Any tag");
}

async function loadConversations() {
  threadList.innerHTML = `<div class="empty-state">Loading…</div>`;
  const rows = await api(`/conversations?${buildQuery()}`);
  state.conversations = rows;
  renderThreadList();
  updateStats(rows);
}

function updateStats(rows) {
  $("#statTotal").textContent = rows.length;
  $("#statUnread").textContent = rows.filter((r) => r.unread_count > 0).length;
  $("#statAction").textContent = rows.filter((r) => r.action_needed).length;
}

function renderThreadList() {
  if (!state.conversations.length) {
    threadList.innerHTML = `<div class="empty-state">No conversations match these filters.</div>`;
    return;
  }
  threadList.innerHTML = state.conversations.map((c) => `
    <div class="thread-card ${c.id === state.activeId ? "active" : ""}" data-id="${c.id}">
      <div class="channel-stripe" style="background:${channelColor(c.channel)}"></div>
      <div class="thread-card-body">
        <div class="thread-card-top">
          <span class="thread-name">${escapeHtml(c.contact_name || "Unknown")}</span>
          <span class="thread-time">${timeAgo(c.last_message_at)}</span>
        </div>
        <div class="thread-snippet">${escapeHtml(c.last_message_body || "")}</div>
        ${c.summary ? `<div class="thread-summary">${escapeHtml(c.summary)}</div>` : ""}
        <div class="thread-tags">
          <span class="tag-chip">${c.channel || "?"}</span>
          ${c.assigned_to ? `<span class="tag-chip">${escapeHtml(c.assigned_to)}</span>` : ""}
          ${c.action_needed ? `<span class="tag-chip alert">needs reply</span>` : ""}
        </div>
      </div>
      ${c.unread_count > 0 ? `<div class="unread-dot"></div>` : ""}
    </div>
  `).join("");

  threadList.querySelectorAll(".thread-card").forEach((el) => {
    el.addEventListener("click", () => openThread(Number(el.dataset.id)));
  });

  renderChannelBars();
}

function renderChannelBars() {
  const counts = {};
  state.conversations.forEach((c) => { counts[c.channel || "?"] = (counts[c.channel || "?"] || 0) + 1; });
  const max = Math.max(1, ...Object.values(counts));
  $("#channelBars").innerHTML = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([ch, count]) => `
    <div class="channel-bar-row">
      <span class="label">${ch}</span>
      <div class="channel-bar-track"><div class="channel-bar-fill" style="width:${(count / max) * 100}%; background:${channelColor(ch)}"></div></div>
      <span class="count">${count}</span>
    </div>
  `).join("");
}

async function openThread(id) {
  state.activeId = id;
  renderThreadList();
  threadDetail.innerHTML = `<div class="empty-state">Loading thread…</div>`;
  const data = await api(`/conversations/${id}`);
  renderThreadDetail(data);
}

function renderThreadDetail(data) {
  const c = data.conversation;
  threadDetail.innerHTML = `
    <div class="detail-head">
      <div class="name">${escapeHtml(c.contact_name || "Unknown")}</div>
      <div class="meta">${c.channel || ""} · ${c.email || c.phone || "no contact info"} ${c.assigned_to ? `· assigned to ${escapeHtml(c.assigned_to)}` : ""}</div>
    </div>
    ${c.summary ? `
      <div class="detail-summary-box ${c.action_needed ? "alert" : ""}">
        <b>${c.sentiment ? c.sentiment.toUpperCase() : ""}</b> — ${escapeHtml(c.summary)}
      </div>` : `
      <div class="detail-summary-box">
        No AI summary yet. <a href="#" id="summarizeLink" style="color:var(--accent-info)">Generate one</a>
      </div>`}
    <div class="messages" id="messagesPane">
      ${data.messages.map((m) => `
        <div class="msg ${m.direction === "inbound" ? "inbound" : "outbound"}">
          ${escapeHtml(m.body || "")}
          <span class="msg-time">${new Date(m.created_at).toLocaleString()}</span>
        </div>
      `).join("") || `<div class="empty-state">No messages synced for this thread yet.</div>`}
    </div>
    <div class="reply-box">
      <textarea id="replyText" placeholder="Type a reply — sends as ${c.channel || "the thread's channel"}…"></textarea>
      <button class="btn btn-primary" id="sendReplyBtn">Send</button>
    </div>
  `;

  const pane = $("#messagesPane");
  if (pane) pane.scrollTop = pane.scrollHeight;

  const sLink = $("#summarizeLink");
  if (sLink) sLink.addEventListener("click", async (e) => {
    e.preventDefault();
    sLink.textContent = "Summarizing…";
    try {
      await api(`/conversations/${c.id}/summarize`, { method: "POST" });
      openThread(c.id);
      loadConversations();
    } catch (err) {
      alert("Couldn't summarize: " + err.message);
    }
  });

  $("#sendReplyBtn").addEventListener("click", async () => {
    const text = $("#replyText").value.trim();
    if (!text) return;
    const btn = $("#sendReplyBtn");
    btn.disabled = true;
    btn.textContent = "Sending…";
    try {
      await api(`/conversations/${c.id}/reply`, {
        method: "POST",
        body: JSON.stringify({ message: text }),
      });
      openThread(c.id);
    } catch (err) {
      alert("Send failed: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Send";
    }
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Filter bindings ----------
["fSearch", "fChannel", "fStatus", "fAssignee", "fTag", "fSort"].forEach((id) => {
  const el = $(`#${id}`);
  const key = { fSearch: "search", fChannel: "channel", fStatus: "status", fAssignee: "assignedTo", fTag: "tag", fSort: "sort" }[id];
  const evt = el.tagName === "SELECT" ? "change" : "input";
  let debounce;
  el.addEventListener(evt, () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.filters[key] = el.value;
      loadConversations();
    }, evt === "input" ? 300 : 0);
  });
});

$("#clearFilters").addEventListener("click", () => {
  ["fSearch", "fChannel", "fStatus", "fAssignee", "fTag"].forEach((id) => { $(`#${id}`).value = ""; });
  $("#fSort").value = "newest";
  state.filters = {};
  loadConversations();
});

$("#syncBtn").addEventListener("click", async () => {
  const btn = $("#syncBtn");
  btn.disabled = true;
  btn.textContent = "Syncing…";
  try {
    const r = await api("/sync", { method: "POST", body: JSON.stringify({}) });
    await loadConversations();
    btn.textContent = `Synced ${r.convosSynced}`;
  } catch (err) {
    alert("Sync failed: " + err.message);
    btn.textContent = "Sync now";
  } finally {
    btn.disabled = false;
    setTimeout(() => { btn.textContent = "Sync now"; }, 2000);
  }
});

$("#reportBtn").addEventListener("click", async () => {
  $("#reportModal").classList.remove("hidden");
  $("#reportBody").textContent = "Generating overview — summarizing new threads first, this can take a minute…";
  try {
    const r = await api("/report", { method: "POST", body: JSON.stringify({}) });
    $("#reportBody").innerHTML = `
      <div style="margin-bottom:14px; font-family:var(--mono); font-size:12px; color:var(--muted)">
        ${r.stats.total_conversations} total · ${r.stats.unread_conversations} unread · ${r.stats.needs_action} need a reply
      </div>
      ${escapeHtml(r.overview)}
    `;
    loadConversations();
  } catch (err) {
    $("#reportBody").textContent = "Report generation failed: " + err.message;
  }
});
$("#closeReport").addEventListener("click", () => $("#reportModal").classList.add("hidden"));

// ---------- Init ----------
(async function init() {
  await loadFilters();
  await loadConversations();
})();
