// --- tiny CSV parser (handles quoted fields with commas/newlines) ---
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); row = [];
      } else {
        field += c;
      }
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || r[0] !== '');
}

function toRecords(rows) {
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => {
    const rec = {};
    headers.forEach((h, i) => { rec[h] = (r[i] || '').trim(); });
    return rec;
  });
}

function parseDate(s) {
  if (!s) return null;
  const parts = s.split('/');
  if (parts.length !== 3) return null;
  const [m, d, y] = parts.map(Number);
  if (!m || !d || !y) return null;
  return new Date(y, m - 1, d);
}

function daysBetween(a, b) {
  return Math.round((b - a) / 86400000);
}

// --- state ---
let WATCHLIST = [];
let CITY_STATUS = {};
let TOTAL_ROWS = 0;
let LIVE_COUNT = 0;
let ATTENTION_COUNT = 0;
let page = 0;
const perPage = 15;

function setStatus(msg, isError) {
  const el = document.getElementById('status-msg');
  el.textContent = msg;
  el.style.color = isError ? 'var(--danger)' : 'var(--text-2)';
}

async function loadData() {
  if (!CSV_URL || CSV_URL.indexOf('PASTE_YOUR') === 0) {
    setStatus('Set CSV_URL in config.js to your published sheet link first.', true);
    return;
  }
  setStatus('Loading live data from your sheet...');
  let text;
  try {
    const resp = await fetch(CSV_URL, { cache: 'no-store' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    text = await resp.text();
  } catch (e) {
    setStatus('Could not load the sheet (' + e.message + '). Check the link in config.js is a published CSV link.', true);
    return;
  }

  const records = toRecords(parseCSV(text));
  if (!records.length) {
    setStatus('Sheet loaded but no rows were found. Check the tab published is "Contract Dump - Raw".', true);
    return;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // dedupe to latest contract per brand+city (by start_date)
  const latestByKey = {};
  records.forEach(rec => {
    const brand = rec.brand_name, city = rec.store_name || 'Unspecified';
    if (!brand) return;
    const key = brand + '|' + city;
    const startDt = parseDate(rec.start_date);
    const existing = latestByKey[key];
    if (!existing || (startDt && (!existing._start || startDt > existing._start))) {
      latestByKey[key] = { ...rec, _start: startDt, store_name: city };
    }
  });

  const latestRows = Object.values(latestByKey);
  TOTAL_ROWS = latestRows.length;

  const statusCounts = {};
  const cityStatus = {};
  const watchlist = [];
  let attention = 0;

  latestRows.forEach(rec => {
    const status = rec.status || 'UNKNOWN';
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    const city = rec.store_name || 'Unspecified';
    cityStatus[city] = cityStatus[city] || {};
    cityStatus[city][status] = (cityStatus[city][status] || 0) + 1;

    if (status === 'EXPIRED' || status === 'TERMINATED' || status === 'VENDOR_REVIEW') attention++;

    const endDt = parseDate(rec.end_date);
    const delta = endDt ? daysBetween(today, endDt) : null;
    // include every contract, tagged with a status bucket so the dropdown can filter by it
    watchlist.push([rec.brand_name, city, rec.vendor_name || '', status, rec.end_date || '—', delta, statusBucket(status)]);
  });

  // soonest-expiring first; entries with no end date sort last
  watchlist.sort((a, b) => {
    if (a[5] === null && b[5] === null) return 0;
    if (a[5] === null) return 1;
    if (b[5] === null) return -1;
    return a[5] - b[5];
  });

  CITY_STATUS = cityStatus;
  WATCHLIST = watchlist;
  LIVE_COUNT = statusCounts['LIVE'] || 0;
  ATTENTION_COUNT = attention;

  setStatus('Live · last loaded ' + new Date().toLocaleTimeString());
  renderStatusTable();
  renderLiveByCity();
  setupWatchlist();
}

function renderLiveByCity() {
  const rows = Object.keys(CITY_STATUS)
    .map(city => [city, CITY_STATUS[city].LIVE || 0])
    .filter(r => r[1] > 0 && r[0] !== 'Unspecified')
    .sort((a, b) => b[1] - a[1]);
  const el = document.getElementById('live-by-city');
  el.className = 'cards';
  el.innerHTML = rows.map(([city, count]) => (
    '<div class="card">' +
      '<div class="label">' + city + '</div>' +
      '<div class="value" style="color:var(--success);">' + count + '</div>' +
    '</div>'
  )).join('') || '<div style="padding:8px 0;color:var(--text-muted);font-size:13px;">No live brands found.</div>';
}

function renderStatusTable() {
  const inProgress = s => (s.PENDING || 0) + (s.APPROVED_BY_VENDOR || 0) + (s.VENDOR_REVIEW || 0) + (s.APPROVED_BY_ADMIN || 0);
  const rows = Object.keys(CITY_STATUS).map(city => {
    const s = CITY_STATUS[city];
    const live = s.LIVE || 0;
    const prog = inProgress(s);
    const exp = s.EXPIRED || 0;
    const term = s.TERMINATED || 0;
    return { city, live, prog, exp, term, total: live + prog + exp + term };
  }).sort((a, b) => b.total - a.total);

  const tbody = document.getElementById('status-table-body');
  tbody.innerHTML = rows.map(r => (
    '<tr style="border-bottom:1px solid var(--border);">' +
      '<td style="padding:8px 6px;font-weight:600;">' + r.city + '</td>' +
      '<td style="padding:8px 6px;text-align:right;color:var(--success);">' + r.live + '</td>' +
      '<td style="padding:8px 6px;text-align:right;color:var(--warning);">' + r.prog + '</td>' +
      '<td style="padding:8px 6px;text-align:right;color:var(--danger);">' + r.exp + '</td>' +
      '<td style="padding:8px 6px;text-align:right;color:var(--text-2);">' + r.term + '</td>' +
      '<td style="padding:8px 6px;text-align:right;font-weight:600;">' + r.total + '</td>' +
    '</tr>'
  )).join('');
}

// groups the raw sheet status values into the 4 buckets shown in the dropdown
function statusBucket(status) {
  if (status === 'LIVE') return 'Live';
  if (status === 'PENDING' || status === 'APPROVED_BY_VENDOR' || status === 'VENDOR_REVIEW' || status === 'APPROVED_BY_ADMIN') return 'In progress';
  if (status === 'EXPIRED') return 'Expired';
  if (status === 'TERMINATED') return 'Terminated';
  return 'Other';
}

// e.g. "APPROVED_BY_VENDOR" -> "Approved By Vendor"
function formatStatus(status) {
  return (status || 'Unknown').split('_').map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
}

function statusBadge(status, bucket) {
  const cls = bucket === 'Live' ? 'live'
    : bucket === 'In progress' ? 'pending'
    : bucket === 'Expired' ? 'expired'
    : bucket === 'Terminated' ? 'terminated'
    : 'other';
  return '<span class="badge ' + cls + '">' + formatStatus(status) + '</span>';
}

function setupWatchlist() {
  const hiddenCities = ['BW-VAS', 'Unspecified'];
  const citySet = [...new Set(WATCHLIST.map(r => r[1]))].filter(c => !hiddenCities.includes(c)).sort();
  const citySelect = document.getElementById('wl-city');
  citySelect.innerHTML = '<option value="">All cities</option>';
  citySet.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; citySelect.appendChild(o); });

  const statusSet = [...new Set(WATCHLIST.map(r => r[6]))].sort();
  const order = ['Live', 'In progress', 'Expired', 'Terminated', 'Other'];
  statusSet.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const statusSelect = document.getElementById('wl-status');
  statusSelect.innerHTML = '<option value="">All statuses</option>';
  statusSet.forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s; statusSelect.appendChild(o); });

  page = 0;
  renderWatchlist();
}

function renderWatchlist() {
  const q = document.getElementById('wl-search').value.toLowerCase();
  const cityFilter = document.getElementById('wl-city').value;
  const statusFilter = document.getElementById('wl-status').value;
  const filtered = WATCHLIST.filter(r => {
    const matchesQ = !q || r[0].toLowerCase().includes(q) || r[2].toLowerCase().includes(q) || r[1].toLowerCase().includes(q);
    const matchesCity = !cityFilter || r[1] === cityFilter;
    const matchesStatus = !statusFilter || r[6] === statusFilter;
    return matchesQ && matchesCity && matchesStatus;
  });
  document.getElementById('wl-count').textContent = filtered.length + ' contract' + (filtered.length === 1 ? '' : 's');
  const maxPage = Math.max(0, Math.ceil(filtered.length / perPage) - 1);
  if (page > maxPage) page = maxPage;
  const slice = filtered.slice(page * perPage, page * perPage + perPage);
  const list = document.getElementById('wl-list');
  list.innerHTML = slice.map(r => (
    '<div class="row">' +
      '<div class="left-col">' +
        '<div class="name">' + r[0] + '</div>' +
        '<div class="meta">' + r[2] + ' &middot; ' + r[1] + '</div>' +
      '</div>' +
      statusBadge(r[3], r[6]) +
      '<div class="date">' + r[4] + '</div>' +
      '<div class="days">' + (r[5] === null ? '—' : r[5] + 'd left') + '</div>' +
    '</div>'
  )).join('') || '<div style="padding:16px 0;color:var(--text-muted);font-size:13px;">No matches.</div>';
  document.getElementById('wl-page').textContent = 'Page ' + (page + 1) + ' of ' + (maxPage + 1);
}

document.getElementById('wl-search').addEventListener('input', () => { page = 0; renderWatchlist(); });
document.getElementById('wl-city').addEventListener('change', () => { page = 0; renderWatchlist(); });
document.getElementById('wl-status').addEventListener('change', () => { page = 0; renderWatchlist(); });
document.getElementById('wl-prev').addEventListener('click', () => { if (page > 0) { page--; renderWatchlist(); } });
document.getElementById('wl-next').addEventListener('click', () => { page++; renderWatchlist(); });
document.getElementById('reload-btn').addEventListener('click', loadData);

loadData();
