/* =========================================================
   KSEA at University of Michigan — Jobs & Internships Board
   ---------------------------------------------------------
   100% static: postings are fetched in the browser from a
   published Google Sheet (via OpenSheet) or Supabase REST.
   See JOBS_SETUP.md in the project root for setup steps.
   ========================================================= */

/* ===================== CONFIGURATION ===================== */

// 1) Paste your OpenSheet URL here, e.g.
//    "https://opensheet.elk.sh/1AbC...xyz/Jobs"
//    (Alternative: a Supabase REST URL such as
//    "https://YOUR-PROJECT.supabase.co/rest/v1/jobs?select=*")
const DATA_SOURCE_URL = "https://opensheet.elk.sh/1jvhaKscTj1T8ROky0hCgoD5o2UzFXuC0Rxi5s9B7bfQ/Jobs";

// 2) ONLY if you use Supabase: paste the project's public "anon" key.
//    Leave empty ("") for Google Sheets / OpenSheet.
const SUPABASE_ANON_KEY = "";

// How long to wait for the remote source before timing out.
const FETCH_TIMEOUT_MS = 8000;

/* ========================================================= */

(() => {
  "use strict";

  const VIEW_STORAGE_KEY = "ksea-jobs-view";
  const DAY_MS = 24 * 60 * 60 * 1000;

  /* ---------- Date helpers ---------- */
  function startOfToday() {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  // Parses "2026-12-05", "12/5/2026", "Dec 5, 2026" as a LOCAL date (no UTC shift).
  function parseDate(value) {
    if (value === null || value === undefined) return null;
    const s = String(value).trim();
    if (!s) return null;

    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);

    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (m) {
      const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      return new Date(year, +m[1] - 1, +m[2]);
    }

    const t = Date.parse(s);
    if (Number.isNaN(t)) return null;
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
  const formatDate = (d) => (d ? dateFmt.format(d) : "");

  /* ---------- Normalization ---------- */
  function normalizeKeys(row) {
    const out = {};
    Object.keys(row || {}).forEach((k) => {
      const key = String(k).trim().toLowerCase().replace(/[\s-]+/g, "_");
      out[key] = row[k] === null || row[k] === undefined ? "" : String(row[k]).trim();
    });
    return out;
  }

  function normalizeType(raw) {
    const t = (raw || "").toLowerCase();
    if (t.includes("intern") || t.includes("co-op") || t.includes("coop")) return "Internship";
    if (t.includes("research") || t.includes("lab")) return "Research / Lab";
    if (t.includes("part")) return "Part-Time";
    if (t.includes("full")) return "Full-Time";
    return raw ? raw : "Other";
  }

  const MI_PATTERN = /michigan|\bmi\b|detroit|dearborn|ypsilanti|troy|novi|southfield|lansing|grand rapids|livonia|auburn hills|warren|farmington|kalamazoo|flint|plymouth|canton|pontiac|royal oak|birmingham|rochester hills|sterling heights|brighton|saline/i;
  const A2_PATTERN = /ann arbor|campus|\bu-?m\b|umich|university of michigan|a2\b/i;

  function locationTags(location) {
    const loc = location || "";
    const remote = /remote|virtual|online|anywhere/i.test(loc);
    const annArbor = A2_PATTERN.test(loc);
    const michigan = annArbor || MI_PATTERN.test(loc);
    return { remote, annArbor, michigan };
  }

  function buildApplyLink(raw) {
    const s = (raw || "").trim();
    if (!s) return null;
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (/^mailto:/i.test(s)) return { href: s, kind: "email", label: s.replace(/^mailto:/i, "").split("?")[0] };
    if (emailRe.test(s)) return { href: `mailto:${s}`, kind: "email", label: s };
    let url = s;
    if (/^www\./i.test(url)) url = `https://${url}`;
    if (!/^https?:\/\//i.test(url)) return null; // reject javascript:, data:, etc.
    try {
      const u = new URL(url);
      return { href: u.href, kind: "url", label: u.hostname.replace(/^www\./, "") };
    } catch (_) {
      return null;
    }
  }

  function normalizeJob(row, index, today) {
    const r = normalizeKeys(row);
    const title = r.title;
    if (!title) return null;

    const rawStatus = (r.status || "open").toLowerCase();
    if (["hidden", "draft", "hide"].includes(rawStatus)) return null;

    const deadline = parseDate(r.deadline);
    const posted = parseDate(r.posted_date || r.posted || r.date_posted);
    const expired = !!(deadline && deadline < today);
    const markedClosed = ["closed", "filled", "expired", "inactive", "archived"].includes(rawStatus);
    const isOpen = !markedClosed && !expired;

    const daysLeft = deadline ? Math.round((deadline - today) / DAY_MS) : null;

    return {
      key: `job-${index}`,
      id: r.id || String(index + 1),
      title,
      company: r.company || "—",
      location: r.location || "Location TBD",
      type: normalizeType(r.type),
      category: r.category || "",
      isOpen,
      autoClosed: expired && !markedClosed,
      posted,
      deadline,
      daysLeft,
      summary: r.summary || "",
      description: r.description || r.details || "",
      eligibility: r.eligibility || r.requirements || r.qualifications || "",
      apply: buildApplyLink(r.apply_url || r.apply_link || r.url),
      loc: locationTags(r.location),
      haystack: [title, r.company, r.location, r.summary, r.category, r.description].join(" ").toLowerCase()
    };
  }

  /* ---------- Data fetching ---------- */
  function isPlaceholderUrl(url) {
    return !url || /PASTE_|YOUR_|<|>/i.test(url) || !/^https:\/\//i.test(url);
  }

  async function fetchRemoteRows() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const headers = { Accept: "application/json" };
    if (SUPABASE_ANON_KEY) {
      headers.apikey = SUPABASE_ANON_KEY;
      headers.Authorization = `Bearer ${SUPABASE_ANON_KEY}`;
    }
    try {
      const res = await fetch(DATA_SOURCE_URL, { headers, signal: controller.signal, cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const rows = Array.isArray(data) ? data : Array.isArray(data && data.data) ? data.data : null;
      if (!rows) throw new Error(data && data.error ? data.error : "Unexpected response format");
      return rows;
    } finally {
      clearTimeout(timer);
    }
  }

  async function loadJobs() {
    if (isPlaceholderUrl(DATA_SOURCE_URL)) {
      return { rows: [], source: "placeholder" };
    }
    try {
      const rows = await fetchRemoteRows();
      return { rows, source: "live" };
    } catch (err) {
      console.warn("[KSEA Jobs] Could not load live postings:", err);
      return { rows: [], source: "offline" };
    }
  }

  /* ---------- State ---------- */
  const state = {
    jobs: [],
    search: "",
    type: "All",
    location: "All",
    sort: "newest",
    view: "gallery",
    showClosed: false
  };

  try {
    const saved = localStorage.getItem(VIEW_STORAGE_KEY);
    if (saved === "list" || saved === "gallery") state.view = saved;
  } catch (_) { /* storage disabled */ }

  /* ---------- DOM ---------- */
  const $ = (sel) => document.querySelector(sel);
  const els = {
    search: $("#searchInput"),
    searchClear: $("#searchClear"),
    sort: $("#sortSelect"),
    viewBtns: document.querySelectorAll(".view-btn"),
    typeBtns: document.querySelectorAll("#typeFilters .pill"),
    locBtns: document.querySelectorAll("#locationFilters .pill"),
    results: $("#results"),
    count: $("#resultCount"),
    closedToggle: $("#closedToggle"),
    closedToggleText: $("#closedToggleText"),
    archiveBanner: $("#archiveBanner"),
    sourceNotice: $("#sourceNotice"),
    sourceNoticeText: $("#sourceNoticeText"),
    modal: $("#jobModal"),
    modalBadges: $("#modalBadges"),
    modalTitle: $("#modalTitle"),
    modalCompany: $("#modalCompany"),
    modalFacts: $("#modalFacts"),
    modalSections: $("#modalSections"),
    modalFooter: $("#modalFooter"),
    modalClose: $("#modalClose")
  };

  function escapeHtml(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* ---------- Filtering & sorting ---------- */
  function filtersActive() {
    return state.search.trim() !== "" || state.type !== "All" || state.location !== "All";
  }

  function matches(job) {
    if (job.isOpen === state.showClosed) return false;
    if (state.type !== "All" && job.type !== state.type) return false;
    if (state.location === "Remote" && !job.loc.remote) return false;
    if (state.location === "Ann Arbor" && !job.loc.annArbor) return false;
    if (state.location === "Michigan" && !job.loc.michigan) return false;
    const terms = state.search.toLowerCase().split(/\s+/).filter(Boolean);
    return terms.every((t) => job.haystack.includes(t));
  }

  function compareJobs(a, b) {
    if (state.sort === "deadline") {
      const da = a.deadline ? a.deadline.getTime() : Infinity;
      const db = b.deadline ? b.deadline.getTime() : Infinity;
      // In the closed archive, "soonest" = most recently closed first.
      if (da !== db) return state.showClosed ? db - da : da - db;
    } else if (state.sort === "company") {
      const c = a.company.localeCompare(b.company, undefined, { sensitivity: "base" });
      if (c !== 0) return c;
    } else {
      const pa = a.posted ? a.posted.getTime() : -Infinity;
      const pb = b.posted ? b.posted.getTime() : -Infinity;
      if (pa !== pb) return pb - pa;
    }
    return a.title.localeCompare(b.title);
  }

  /* ---------- Rendering helpers ---------- */
  function deadlineInfo(job) {
    if (!job.deadline) return { text: "Rolling", urgent: false, chip: "" };
    const date = formatDate(job.deadline);
    if (!job.isOpen) return { text: job.autoClosed ? `Closed ${date}` : date, urgent: false, chip: "" };
    const d = job.daysLeft;
    let chip = "";
    if (d === 0) chip = "Closes today";
    else if (d === 1) chip = "Closes tomorrow";
    else if (d <= 7) chip = `${d} days left`;
    return { text: date, urgent: d <= 7, chip };
  }

  function typeBadge(job) {
    return `<span class="badge badge-type" data-type="${escapeHtml(job.type)}">${escapeHtml(job.type)}</span>`;
  }

  function applyButton(job, compact) {
    if (!job.isOpen) {
      return `<button class="btn btn-primary" type="button" disabled aria-disabled="true"><i class="fas fa-lock" aria-hidden="true"></i> Closed</button>`;
    }
    if (!job.apply) {
      return `<button class="btn btn-primary" type="button" data-action="details">Details</button>`;
    }
    const isEmail = job.apply.kind === "email";
    const icon = isEmail ? "fa-envelope" : "fa-arrow-up-right-from-square";
    const label = compact ? "Apply" : isEmail ? "Apply via Email" : "Apply Now";
    const target = isEmail ? "" : ` target="_blank" rel="noopener noreferrer"`;
    return `<a class="btn btn-primary" href="${escapeHtml(job.apply.href)}"${target} aria-label="${escapeHtml(`${label}: ${job.title} at ${job.company}`)}"><i class="fas ${icon}" aria-hidden="true"></i> ${label}</a>`;
  }

  function renderCard(job) {
    const dl = deadlineInfo(job);
    const badges = [
      typeBadge(job),
      job.category ? `<span class="badge badge-cat">${escapeHtml(job.category)}</span>` : "",
      !job.isOpen ? `<span class="badge badge-closed">Closed</span>` : "",
      dl.chip ? `<span class="badge badge-urgent"><i class="fas fa-clock" aria-hidden="true"></i> ${escapeHtml(dl.chip)}</span>` : ""
    ].join("");

    return `
      <article class="job-card${job.isOpen ? "" : " is-closed"}" data-key="${job.key}">
        <div class="card-badges">${badges}</div>
        <div>
          <h3 class="job-title">${escapeHtml(job.title)}</h3>
          <p class="job-company">${escapeHtml(job.company)}</p>
        </div>
        <div class="job-meta">
          <span><i class="fas fa-map-marker-alt" aria-hidden="true"></i>${escapeHtml(job.location)}</span>
          <span class="deadline-text${dl.urgent ? " urgent" : ""}"><i class="far fa-calendar" aria-hidden="true"></i>Deadline: ${escapeHtml(dl.text)}</span>
        </div>
        ${job.summary ? `<p class="job-summary">${escapeHtml(job.summary)}</p>` : ""}
        <div class="card-actions">
          ${applyButton(job, false)}
          <button class="btn btn-ghost" type="button" data-action="details" aria-label="${escapeHtml(`View details: ${job.title} at ${job.company}`)}">Details</button>
        </div>
      </article>`;
  }

  function renderRow(job) {
    const dl = deadlineInfo(job);
    return `
      <div class="job-row${job.isOpen ? "" : " is-closed"}" data-key="${job.key}">
        <div class="row-role">
          <button class="job-title row-title-btn" type="button" data-action="details" aria-label="${escapeHtml(`View details: ${job.title} at ${job.company}`)}">${escapeHtml(job.title)}</button>
          <div class="job-company">${escapeHtml(job.company)}${job.category ? ` · ${escapeHtml(job.category)}` : ""}</div>
        </div>
        <div class="row-cell row-type">${typeBadge(job)}${!job.isOpen ? ` <span class="badge badge-closed">Closed</span>` : ""}</div>
        <div class="row-cell row-loc"><span class="cell-label">Location:</span>${escapeHtml(job.location)}</div>
        <div class="row-cell row-dl deadline-text${dl.urgent ? " urgent" : ""}"><span class="cell-label">Deadline:</span>${escapeHtml(dl.text)}${dl.chip ? `<br><small>${escapeHtml(dl.chip)}</small>` : ""}</div>
        <div class="row-apply">${applyButton(job, true)}</div>
      </div>`;
  }

  function renderEmpty(openCount, closedCount) {
    const label = state.showClosed ? "closed" : "open";
    if (filtersActive()) {
      return `
        <div class="empty-state">
          <div class="empty-icon"><i class="fas fa-search" aria-hidden="true"></i></div>
          <h2>No ${label} opportunities match your filters</h2>
          <p>Try a different keyword, or clear your filters to see everything.</p>
          <button class="pill active" type="button" data-action="reset">Reset Filters</button>
        </div>`;
    }
    const showSwitchBtn = state.showClosed ? openCount > 0 : closedCount > 0;
    return `
      <div class="empty-state">
        <div class="empty-icon"><i class="fas ${state.showClosed ? "fa-archive" : "fa-briefcase"}" aria-hidden="true"></i></div>
        <h2>${state.showClosed ? "No closed postings yet" : "No open postings right now"}</h2>
        <p>${state.showClosed
          ? "Expired and filled roles will appear here for reference."
          : "New opportunities are added regularly. Check back soon, or follow us on Instagram for announcements!"}</p>
        ${showSwitchBtn
          ? `<button class="pill active" type="button" data-action="toggle-closed">${state.showClosed ? "Back to Open Jobs" : "View Closed Jobs"}</button>`
          : ""}
      </div>`;
  }

  /* ---------- Main render ---------- */
  function render() {
    const openCount = state.jobs.filter((j) => j.isOpen).length;
    const closedCount = state.jobs.length - openCount;
    const pool = state.showClosed ? closedCount : openCount;
    const visible = state.jobs.filter(matches).sort(compareJobs);
    const label = state.showClosed ? "closed" : "open";

    // Toggle + banner
    els.closedToggle.classList.toggle("viewing-closed", state.showClosed);
    els.closedToggle.setAttribute("aria-pressed", String(state.showClosed));
    els.closedToggle.querySelector("i").className = state.showClosed ? "fas fa-arrow-left" : "fas fa-archive";
    els.closedToggleText.textContent = state.showClosed
      ? `Back to Open Jobs (${openCount})`
      : `View Closed Jobs (${closedCount})`;
    els.archiveBanner.hidden = !state.showClosed;

    // Count
    const noun = pool === 1 ? "opportunity" : "opportunities";
    els.count.innerHTML = visible.length === pool
      ? `Showing <strong>${pool}</strong> ${label} ${noun}`
      : `Showing <strong>${visible.length}</strong> of ${pool} ${label} ${noun}`;

    // Results
    if (!visible.length) {
      els.results.innerHTML = renderEmpty(openCount, closedCount);
    } else if (state.view === "list") {
      els.results.innerHTML = `
        <div class="jobs-list${state.showClosed ? " closed-mode" : ""}">
          <div class="list-head" aria-hidden="true">
            <span>Role / Company</span><span>Type</span><span>Location</span><span>Deadline</span><span style="text-align:right">Apply</span>
          </div>
          ${visible.map(renderRow).join("")}
        </div>`;
    } else {
      els.results.innerHTML = `<div class="jobs-grid">${visible.map(renderCard).join("")}</div>`;
    }
    els.results.setAttribute("aria-busy", "false");
  }

  function setPressed(buttons, attr, value) {
    buttons.forEach((b) => {
      const on = b.dataset[attr] === value;
      b.setAttribute("aria-pressed", String(on));
      b.classList.toggle("active", on);
    });
  }

  function syncControls() {
    els.search.value = state.search;
    els.searchClear.classList.toggle("show", state.search !== "");
    els.sort.value = state.sort;
    setPressed(els.typeBtns, "type", state.type);
    setPressed(els.locBtns, "location", state.location);
    els.viewBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === state.view)));
  }

  function resetFilters() {
    state.search = "";
    state.type = "All";
    state.location = "All";
    syncControls();
    render();
  }

  /* ---------- Modal ---------- */
  let lastFocused = null;

  function openModal(job) {
    lastFocused = document.activeElement;
    const dl = deadlineInfo(job);

    els.modalBadges.innerHTML = [
      typeBadge(job),
      job.category ? `<span class="badge badge-cat">${escapeHtml(job.category)}</span>` : "",
      !job.isOpen ? `<span class="badge badge-closed">Closed</span>` : ""
    ].join("");
    els.modalTitle.textContent = job.title;
    els.modalCompany.textContent = job.company;

    const facts = [
      ["Location", job.location],
      ["Deadline", dl.chip ? `${dl.text} (${dl.chip})` : dl.text],
      ["Posted", job.posted ? formatDate(job.posted) : "—"],
      ["Status", job.isOpen ? "Accepting applications" : job.autoClosed ? "Closed (deadline passed)" : "Closed"]
    ];
    els.modalFacts.innerHTML = facts.map(([k, v]) => `
      <div class="fact"><div class="fact-label">${escapeHtml(k)}</div><div class="fact-value">${escapeHtml(v)}</div></div>`).join("");

    const sections = [];
    const about = [job.summary, job.description].filter(Boolean).join("\n\n");
    if (about) sections.push(["About the Role", about]);
    if (job.eligibility) sections.push(["Eligibility & Details", job.eligibility]);
    let howTo;
    if (!job.isOpen) howTo = "This posting is no longer accepting applications. Keep an eye on the board — many employers re-post similar roles each cycle.";
    else if (!job.apply) howTo = "Application details are coming soon. Reach out to the KSEA E-Board on Instagram if you have questions.";
    else if (job.apply.kind === "email") howTo = `Email your resume and a short note about your interest to ${job.apply.label}. Mention that you found the role through KSEA Michigan!`;
    else howTo = `Apply directly on ${job.apply.label}. Want a resume review before you submit? Come to a KSEA professional event or message the E-Board.`;
    sections.push(["How to Apply", howTo]);

    els.modalSections.innerHTML = sections.map(([h, p]) => `
      <div class="modal-section"><h3>${escapeHtml(h)}</h3><p>${escapeHtml(p)}</p></div>`).join("");

    let hint = "";
    if (job.isOpen && job.apply) {
      hint = job.apply.kind === "email" ? "Opens your email app" : `Opens ${escapeHtml(job.apply.label)} in a new tab`;
    }
    els.modalFooter.innerHTML = `
      ${hint ? `<span class="apply-hint">${hint}</span>` : ""}
      <button class="btn btn-ghost" type="button" data-action="close">Close</button>
      ${job.isOpen && job.apply ? applyButton(job, false)
        : `<button class="btn btn-primary" type="button" disabled aria-disabled="true"><i class="fas fa-lock" aria-hidden="true"></i> ${job.isOpen ? "Link Coming Soon" : "Applications Closed"}</button>`}`;

    document.body.classList.add("modal-open");
    if (typeof els.modal.showModal === "function") els.modal.showModal();
    else els.modal.setAttribute("open", "");
    els.modalClose.focus();
  }

  function closeModal() {
    if (typeof els.modal.close === "function" && els.modal.open) els.modal.close();
    else { els.modal.removeAttribute("open"); onModalClosed(); }
  }

  function onModalClosed() {
    document.body.classList.remove("modal-open");
    if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
  }

  /* ---------- Events ---------- */
  function bindEvents() {
    els.search.addEventListener("input", () => {
      state.search = els.search.value;
      els.searchClear.classList.toggle("show", state.search !== "");
      render();
    });
    els.search.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && els.search.value) { e.preventDefault(); state.search = ""; syncControls(); render(); }
    });
    els.searchClear.addEventListener("click", () => {
      state.search = "";
      syncControls();
      render();
      els.search.focus();
    });

    els.sort.addEventListener("change", () => { state.sort = els.sort.value; render(); });

    els.typeBtns.forEach((b) => b.addEventListener("click", () => {
      state.type = b.dataset.type;
      setPressed(els.typeBtns, "type", state.type);
      render();
    }));

    els.locBtns.forEach((b) => b.addEventListener("click", () => {
      state.location = b.dataset.location;
      setPressed(els.locBtns, "location", state.location);
      render();
    }));

    els.viewBtns.forEach((b) => b.addEventListener("click", () => {
      state.view = b.dataset.view;
      try { localStorage.setItem(VIEW_STORAGE_KEY, state.view); } catch (_) { /* ignore */ }
      syncControls();
      render();
    }));

    const toggleClosed = () => { state.showClosed = !state.showClosed; render(); };
    els.closedToggle.addEventListener("click", toggleClosed);

    // Delegated clicks inside results (cards, rows, reset, etc.)
    els.results.addEventListener("click", (e) => {
      const actionEl = e.target.closest("[data-action]");
      if (actionEl) {
        const action = actionEl.dataset.action;
        if (action === "reset") return resetFilters();
        if (action === "toggle-closed") return toggleClosed();
      }
      if (e.target.closest("a")) return; // let Apply links work normally
      if (e.target.closest("button[disabled]")) return;
      const item = e.target.closest("[data-key]");
      if (!item) return;
      const job = state.jobs.find((j) => j.key === item.dataset.key);
      if (job) openModal(job);
    });

    els.modalClose.addEventListener("click", closeModal);
    els.modalFooter.addEventListener("click", (e) => {
      if (e.target.closest('[data-action="close"]')) closeModal();
    });
    els.modal.addEventListener("click", (e) => { if (e.target === els.modal) closeModal(); }); // backdrop
    els.modal.addEventListener("close", onModalClosed);
  }

  /* ---------- Init ---------- */
  async function init() {
    syncControls();
    bindEvents();

    const { rows, source } = await loadJobs();
    const today = startOfToday();
    state.jobs = rows.map((r, i) => normalizeJob(r, i, today)).filter(Boolean);

    if (source !== "live") {
      els.sourceNotice.hidden = false;
      els.sourceNoticeText.textContent = source === "placeholder"
        ? "No live job sheet is connected yet. E-Board: connect a sheet by following JOBS_SETUP.md."
        : "We couldn't reach the live job board right now. Please refresh in a moment.";
    }

    render();
  }

  init();
})();
