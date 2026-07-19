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

// mirrors the "Expiry Flag" logic from the original brand x city workbook
function computeExpiryFlag(status, endDt, today) {
  if (status === 'EXPIRED' || status === 'TERMINATED') return 'Expired';
  if (endDt) {
    const delta = daysBetween(today, endDt);
    if (delta >= 0 && delta <= 60) return 'Expiring Soon (<=60d)';
    if (delta < 0) return 'Past End Date - Check';
  }
  return 'Active';
}

// Monthly Rental = fixed agreement value spread evenly over the contract duration (in months)
function computeMonthlyRental(agreementValue, startDt, endDt) {
  const v = parseFloat(agreementValue);
  if (!v || !startDt || !endDt || endDt <= startDt) return null;
  const months = Math.max(1, Math.round(daysBetween(startDt, endDt) / 30.44));
  return Math.round(v / months);
}

// Revenue depends on the agreement type:
// FIXED = rental only, MARGIN = commission only, AND = rental + commission,
// OR (and any other/unrecognized type) = whichever of rental/commission is higher.
function computeRevenue(agreementType, rental, commission) {
  const type = (agreementType || '').trim().toUpperCase();
  const hasRental = rental !== null && rental !== undefined;
  const hasCommission = commission !== null && commission !== undefined;
  if (!hasRental && !hasCommission) return null;
  const r = hasRental ? rental : 0;
  const c = hasCommission ? commission : 0;
  if (type === 'FIXED') return hasRental ? rental : null;
  if (type === 'MARGIN') return hasCommission ? commission : null;
  if (type === 'AND') return r + c;
  return Math.max(r, c);
}

// If the commission base excludes GST (e.g. "Customer Selling Price without GST",
// or anything not MRP/selling-price based), knock 18% GST off the commission%
// before using it to compute money figures.
function effectiveCommissionPct(commissionOn, pct) {
  const basis = (commissionOn || '').toLowerCase();
  if (basis.indexOf('without') !== -1 || (basis.indexOf('mrp') === -1 && basis.indexOf('selling price') === -1)) {
    return pct * (1 - 0.18);
  }
  return pct;
}

// --- state ---
let WATCHLIST = [];
let CITY_STATUS = {};
let CATEGORY_STATUS = {};
let ALL_CONTRACTS = [];
let TOTAL_ROWS = 0;
let LIVE_COUNT = 0;
let ATTENTION_COUNT = 0;
let page = 0;
const perPage = 15;
let wlSortKey = '5';
let wlSortDir = 'asc';
let stSortKey = 'total';
let stSortDir = 'desc';
let cdPage = 0;
const cdPerPage = 20;
let cdSortKey = 'brand';
let cdSortDir = 'asc';
let rvPage = 0;
const rvPerPage = 20;
let rvSortKey = 'monthlyRental';
let rvSortDir = 'desc';
// junk/placeholder city labels, excluded from city + category rollups (still visible under "All cities")
const HIDDEN_CITIES = ['BW-VAS', 'Unspecified'];

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

  // brand -> {category, subCategory}, from the "Primary Brand Mapping" tab (best-effort; ok if it fails)
  const brandMap = {};
  if (typeof MAPPING_CSV_URL === 'string' && MAPPING_CSV_URL && MAPPING_CSV_URL.indexOf('PASTE_YOUR') !== 0) {
    try {
      const mapResp = await fetch(MAPPING_CSV_URL, { cache: 'no-store' });
      if (mapResp.ok) {
        const mapText = await mapResp.text();
        const mapRecords = toRecords(parseCSV(mapText));
        mapRecords.forEach(rec => {
          const brand = (rec.brand_name || '').trim();
          if (!brand) return;
          brandMap[brand.toLowerCase()] = {
            category: rec.changed_category || '',
            subCategory: rec.changed_sub_category || ''
          };
        });
      }
    } catch (e) {
      // mapping tab is optional — Category/Sub category just stay blank if this fails
    }
  }

  // brand|city -> { lm, l2m, lmMrp, l2mMrp }, from the "Previous Month" tab
  // (month_delta: 1 = last month (LM), 2 = 2 months ago (L2M))
  const prevMonthMap = {};
  if (typeof PREV_MONTH_CSV_URL === 'string' && PREV_MONTH_CSV_URL && PREV_MONTH_CSV_URL.indexOf('PASTE_YOUR') !== 0) {
    try {
      const resp2 = await fetch(PREV_MONTH_CSV_URL, { cache: 'no-store' });
      if (resp2.ok) {
        const text2 = await resp2.text();
        toRecords(parseCSV(text2)).forEach(rec => {
          const brand = (rec.brand || '').trim();
          const city = (rec.city || '').trim();
          if (!brand || !city) return;
          const key = brand.toLowerCase() + '|' + city.toLowerCase();
          const sales = parseFloat(rec.net_sales) || 0;
          const mrp = parseFloat(rec.mrp) || 0;
          const delta = parseInt(rec.month_delta, 10);
          if (!prevMonthMap[key]) prevMonthMap[key] = { lm: 0, l2m: 0, lmMrp: 0, l2mMrp: 0 };
          if (delta === 1) { prevMonthMap[key].lm += sales; prevMonthMap[key].lmMrp += mrp; }
          else if (delta === 2) { prevMonthMap[key].l2m += sales; prevMonthMap[key].l2mMrp += mrp; }
        });
      }
    } catch (e) {
      // optional — LM/L2M columns just stay blank if this fails
    }
  }

  // brand|city -> { netSales, mrp } logged so far this month, from the "Forecast Dump" tab
  const cmMap = {};
  if (typeof FORECAST_CSV_URL === 'string' && FORECAST_CSV_URL && FORECAST_CSV_URL.indexOf('PASTE_YOUR') !== 0) {
    try {
      const resp3 = await fetch(FORECAST_CSV_URL, { cache: 'no-store' });
      if (resp3.ok) {
        const text3 = await resp3.text();
        toRecords(parseCSV(text3)).forEach(rec => {
          const brand = (rec.brand || '').trim();
          const city = (rec.city || '').trim();
          if (!brand || !city) return;
          const key = brand.toLowerCase() + '|' + city.toLowerCase();
          const sales = parseFloat(rec.net_sales) || 0;
          const mrp = parseFloat(rec.mrp) || 0;
          if (!cmMap[key]) cmMap[key] = { netSales: 0, mrp: 0 };
          cmMap[key].netSales += sales;
          cmMap[key].mrp += mrp;
        });
      }
    } catch (e) {
      // optional — CM columns just stay blank if this fails
    }
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // dedupe to latest contract per brand+city (by start_date)
  const latestByKey = {};
  records.forEach(rec => {
    const brand = rec.brand_name, city = rec.store_name || 'Unspecified';
    if (!brand) return;
    if (/^(grand\s*)?total$/i.test(brand.trim())) return; // skip subtotal/summary rows
    if (!rec.contract_id) return; // real contracts always have a contract_id; blank means it's not an actual row
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
  const categoryStatus = {};
  const watchlist = [];
  let attention = 0;

  latestRows.forEach(rec => {
    const status = rec.status || 'UNKNOWN';
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    const city = rec.store_name || 'Unspecified';
    const isHiddenCity = HIDDEN_CITIES.includes(city);
    if (!isHiddenCity) {
      cityStatus[city] = cityStatus[city] || {};
      cityStatus[city][status] = (cityStatus[city][status] || 0) + 1;
    }

    const mapped = brandMap[(rec.brand_name || '').trim().toLowerCase()] || {};
    const category = mapped.category || 'Uncategorized';
    // keep this in sync with the city table above: same contracts excluded from both,
    // so the two dashboard summaries always add up to the same grand total
    if (!isHiddenCity) {
      categoryStatus[category] = categoryStatus[category] || {};
      categoryStatus[category][status] = (categoryStatus[category][status] || 0) + 1;
    }

    if (status === 'EXPIRED' || status === 'TERMINATED' || status === 'VENDOR_REVIEW') attention++;

    const endDt = parseDate(rec.end_date);
    const delta = endDt ? daysBetween(today, endDt) : null;
    // include every contract, tagged with a status bucket so the dropdown can filter by it
    watchlist.push([rec.brand_name, city, rec.vendor_name || '', status, rec.end_date || '—', delta, statusBucket(status), category]);
  });

  // full contract detail rows, one per unique brand+city (latest contract), for the "Contract details" tab
  const allContracts = latestRows.map(rec => {
    const status = rec.status || 'UNKNOWN';
    const startDt = parseDate(rec.start_date);
    const endDt = parseDate(rec.end_date);
    const brandKey = (rec.brand_name || '').trim().toLowerCase();
    const cityKey = (rec.store_name || '').trim().toLowerCase();
    const mapped = brandMap[brandKey] || {};
    const joinKey = brandKey + '|' + cityKey;
    const rawCommissionPct = parseFloat(rec.margin_percnt) || 0;
    const commissionPct = effectiveCommissionPct(rec.margin_calculation_on, rawCommissionPct);

    const cmEntry = cmMap[joinKey];
    const netSalesCM = cmEntry ? Math.round(cmEntry.netSales) : null;
    const mrpCM = cmEntry ? Math.round(cmEntry.mrp) : null;
    const prevMonth = prevMonthMap[joinKey];
    const netSalesLM = prevMonth ? Math.round(prevMonth.lm) : null;
    const netSalesL2M = prevMonth ? Math.round(prevMonth.l2m) : null;
    const mrpLM = prevMonth ? Math.round(prevMonth.lmMrp) : null;
    const mrpL2M = prevMonth ? Math.round(prevMonth.l2mMrp) : null;

    // commission is calculated against MRP when "applicable on" says MRP, otherwise against Net Sales (Customer Selling Price)
    const onMrp = (rec.margin_calculation_on || '').toLowerCase().indexOf('mrp') !== -1;
    const baseCM = onMrp ? mrpCM : netSalesCM;
    const baseLM = onMrp ? mrpLM : netSalesLM;
    const baseL2M = onMrp ? mrpL2M : netSalesL2M;
    const monthlyRental = computeMonthlyRental(rec.agreement_value, startDt, endDt);
    const commissionCM = baseCM != null ? Math.round(baseCM * commissionPct / 100) : null;
    const commissionLM = baseLM != null ? Math.round(baseLM * commissionPct / 100) : null;
    const commissionL2M = baseL2M != null ? Math.round(baseL2M * commissionPct / 100) : null;

    // an expired contract still counts for LM/L2M revenue (it was active then), but earns
    // nothing this month — keep it on the Revenue tab only if it expired within the last ~2
    // months, and always show 0 for its current-month (CM) revenue
    const daysSinceEnd = endDt ? daysBetween(endDt, today) : null;
    const recentlyExpired = status === 'EXPIRED' && daysSinceEnd !== null && daysSinceEnd <= 60;

    return {
      id: rec.contract_id || '',
      brand: rec.brand_name || '',
      city: rec.store_name || 'Unspecified',
      vendor: rec.vendor_name || '',
      category: mapped.category || '',
      subCategory: mapped.subCategory || '',
      kam: rec.bw_spoc_name || '',
      start: rec.start_date || '',
      end: rec.end_date || '',
      startTs: startDt ? startDt.getTime() : null,
      endTs: endDt ? endDt.getTime() : null,
      status: status,
      bucket: statusBucket(status),
      liveDate: rec.agrmnt_live_date || '',
      lob: rec.vendor_model || '',
      agreementType: rec.agrmnt_model || '',
      commission: rec.margin_percnt || '',
      actualCommission: rawCommissionPct ? Math.round(commissionPct) : '',
      commissionOn: rec.margin_calculation_on || '',
      monthlyRental: monthlyRental,
      lockin: rec.lockin_period || '',
      notice: rec.exit_notice_period || '',
      fnf: rec.exit_settlement_period || '',
      expiryFlag: computeExpiryFlag(status, endDt, today),
      // Net Sales Exp. (CM) / Net Sales (LM) / Net Sales (L2M)
      netSalesCM: netSalesCM,
      netSalesLM: netSalesLM,
      netSalesL2M: netSalesL2M,
      // MRP Exp. (CM) / MRP (LM) / MRP (L2M)
      mrpCM: mrpCM,
      mrpLM: mrpLM,
      mrpL2M: mrpL2M,
      // Commission = MRP or Net Sales (whichever the contract's commission basis is) x Commission%
      commissionCM: commissionCM,
      commissionLM: commissionLM,
      commissionL2M: commissionL2M,
      // Revenue depends on agreement type: FIXED=rental, MARGIN=commission, AND=rental+commission, OR=higher of the two
      // expired contracts show 0 for the current month (no longer earning), but keep their LM/L2M revenue
      revenueCM: status === 'EXPIRED' ? 0 : computeRevenue(rec.agrmnt_model, monthlyRental, commissionCM),
      revenueLM: computeRevenue(rec.agrmnt_model, monthlyRental, commissionLM),
      revenueL2M: computeRevenue(rec.agrmnt_model, monthlyRental, commissionL2M),
      recentlyExpired: recentlyExpired
    };
  }).sort((a, b) => a.brand.localeCompare(b.brand) || a.city.localeCompare(b.city));

  CITY_STATUS = cityStatus;
  CATEGORY_STATUS = categoryStatus;
  WATCHLIST = watchlist;
  ALL_CONTRACTS = allContracts;
  LIVE_COUNT = statusCounts['LIVE'] || 0;
  ATTENTION_COUNT = attention;

  setStatus('Live · last loaded ' + new Date().toLocaleTimeString());
  renderStatusTable();
  renderLiveByCity();
  setupWatchlist();
  setupDetails();
  setupRevenue();
  renderSummary();
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
  }).sort((a, b) => compareRows(a, b, stSortKey, stSortDir));

  const grand = rows.reduce((acc, r) => {
    acc.live += r.live; acc.prog += r.prog; acc.exp += r.exp; acc.term += r.term; acc.total += r.total;
    return acc;
  }, { live: 0, prog: 0, exp: 0, term: 0, total: 0 });

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
  )).join('') + (
    '<tr style="border-top:2px solid var(--border);">' +
      '<td style="padding:8px 6px;font-weight:700;">Total</td>' +
      '<td style="padding:8px 6px;text-align:right;font-weight:700;color:var(--success);">' + grand.live + '</td>' +
      '<td style="padding:8px 6px;text-align:right;font-weight:700;color:var(--warning);">' + grand.prog + '</td>' +
      '<td style="padding:8px 6px;text-align:right;font-weight:700;color:var(--danger);">' + grand.exp + '</td>' +
      '<td style="padding:8px 6px;text-align:right;font-weight:700;color:var(--text-2);">' + grand.term + '</td>' +
      '<td style="padding:8px 6px;text-align:right;font-weight:700;">' + grand.total + '</td>' +
    '</tr>'
  );
}

function renderCategoryTable() {
  const inProgress = s => (s.PENDING || 0) + (s.APPROVED_BY_VENDOR || 0) + (s.VENDOR_REVIEW || 0) + (s.APPROVED_BY_ADMIN || 0);
  const rows = Object.keys(CATEGORY_STATUS).map(category => {
    const s = CATEGORY_STATUS[category];
    const live = s.LIVE || 0;
    const prog = inProgress(s);
    const exp = s.EXPIRED || 0;
    const term = s.TERMINATED || 0;
    return { category, live, prog, exp, term, total: live + prog + exp + term };
  }).sort((a, b) => b.total - a.total);

  const grand = rows.reduce((acc, r) => {
    acc.live += r.live; acc.prog += r.prog; acc.exp += r.exp; acc.term += r.term; acc.total += r.total;
    return acc;
  }, { live: 0, prog: 0, exp: 0, term: 0, total: 0 });

  const tbody = document.getElementById('category-table-body');
  tbody.innerHTML = rows.map(r => (
    '<tr style="border-bottom:1px solid var(--border);">' +
      '<td style="padding:8px 6px;font-weight:600;">' + r.category + '</td>' +
      '<td style="padding:8px 6px;text-align:right;color:var(--success);">' + r.live + '</td>' +
      '<td style="padding:8px 6px;text-align:right;color:var(--warning);">' + r.prog + '</td>' +
      '<td style="padding:8px 6px;text-align:right;color:var(--danger);">' + r.exp + '</td>' +
      '<td style="padding:8px 6px;text-align:right;color:var(--text-2);">' + r.term + '</td>' +
      '<td style="padding:8px 6px;text-align:right;font-weight:600;">' + r.total + '</td>' +
    '</tr>'
  )).join('') + (
    '<tr style="border-top:2px solid var(--border);">' +
      '<td style="padding:8px 6px;font-weight:700;">Total</td>' +
      '<td style="padding:8px 6px;text-align:right;font-weight:700;color:var(--success);">' + grand.live + '</td>' +
      '<td style="padding:8px 6px;text-align:right;font-weight:700;color:var(--warning);">' + grand.prog + '</td>' +
      '<td style="padding:8px 6px;text-align:right;font-weight:700;color:var(--danger);">' + grand.exp + '</td>' +
      '<td style="padding:8px 6px;text-align:right;font-weight:700;color:var(--text-2);">' + grand.term + '</td>' +
      '<td style="padding:8px 6px;text-align:right;font-weight:700;">' + grand.total + '</td>' +
    '</tr>'
  );
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
  const citySet = [...new Set(WATCHLIST.map(r => r[1]))].filter(c => !HIDDEN_CITIES.includes(c)).sort();
  const citySelect = document.getElementById('wl-city');
  citySelect.innerHTML = '<option value="">All cities</option>';
  citySet.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; citySelect.appendChild(o); });

  const statusSet = [...new Set(WATCHLIST.map(r => r[6]))].sort();
  const order = ['Live', 'In progress', 'Expired', 'Terminated', 'Other'];
  statusSet.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const statusSelect = document.getElementById('wl-status');
  statusSelect.innerHTML = '<option value="">All Status</option>';
  statusSet.forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s; statusSelect.appendChild(o); });

  const categorySet = [...new Set(WATCHLIST.map(r => r[7] || 'Uncategorized'))].sort();
  const categorySelect = document.getElementById('wl-category');
  categorySelect.innerHTML = '<option value="">All categories</option>';
  categorySet.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; categorySelect.appendChild(o); });

  page = 0;
  renderWatchlist();
}

function renderWatchlist() {
  const q = document.getElementById('wl-search').value.toLowerCase();
  const cityFilter = document.getElementById('wl-city').value;
  const statusFilter = document.getElementById('wl-status').value;
  const categoryFilter = document.getElementById('wl-category').value;
  const filtered = WATCHLIST.filter(r => {
    const matchesQ = !q || r[0].toLowerCase().includes(q) || r[2].toLowerCase().includes(q) || r[1].toLowerCase().includes(q);
    const matchesCity = !cityFilter || r[1] === cityFilter;
    const matchesStatus = !statusFilter || r[6] === statusFilter;
    const matchesCategory = !categoryFilter || (r[7] || 'Uncategorized') === categoryFilter;
    return matchesQ && matchesCity && matchesStatus && matchesCategory;
  }).sort((a, b) => compareRows(a, b, wlSortKey, wlSortDir));
  document.getElementById('wl-count').textContent = filtered.length + ' contract' + (filtered.length === 1 ? '' : 's');
  const maxPage = Math.max(0, Math.ceil(filtered.length / perPage) - 1);
  if (page > maxPage) page = maxPage;
  const slice = filtered.slice(page * perPage, page * perPage + perPage);
  const list = document.getElementById('wl-list');
  list.innerHTML = slice.map(r => (
    '<div class="row">' +
      '<div class="left-col">' +
        '<div class="name">' + r[0] + '</div>' +
        '<div class="meta">' + r[2] + ' &middot; ' + r[1] + ' &middot; ' + (r[7] || 'Uncategorized') + '</div>' +
      '</div>' +
      '<div style="width:150px;flex-shrink:0;">' + statusBadge(r[3], r[6]) + '</div>' +
      '<div class="date">' + r[4] + '</div>' +
    '</div>'
  )).join('') || '<div style="padding:16px 0;color:var(--text-muted);font-size:13px;">No matches.</div>';
  document.getElementById('wl-page').textContent = 'Page ' + (page + 1) + ' of ' + (maxPage + 1);
}

document.getElementById('wl-search').addEventListener('input', () => { page = 0; renderWatchlist(); });
document.getElementById('wl-city').addEventListener('change', () => { page = 0; renderWatchlist(); });
document.getElementById('wl-status').addEventListener('change', () => { page = 0; renderWatchlist(); });
document.getElementById('wl-category').addEventListener('change', () => { page = 0; renderWatchlist(); });
document.getElementById('wl-prev').addEventListener('click', () => { if (page > 0) { page--; renderWatchlist(); } });
document.getElementById('wl-next').addEventListener('click', () => { page++; renderWatchlist(); });
document.getElementById('reload-btn').addEventListener('click', loadData);

function updateWlSortIndicators() {
  document.querySelectorAll('.row .sortable').forEach(el => {
    el.classList.remove('sort-asc', 'sort-desc');
    if (el.dataset.key === wlSortKey) el.classList.add(wlSortDir === 'asc' ? 'sort-asc' : 'sort-desc');
  });
}

document.querySelectorAll('.row .sortable').forEach(el => {
  el.addEventListener('click', () => {
    const key = el.dataset.key;
    if (wlSortKey === key) {
      wlSortDir = wlSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      wlSortKey = key;
      wlSortDir = el.dataset.type === 'str' ? 'asc' : 'desc';
    }
    updateWlSortIndicators();
    page = 0;
    renderWatchlist();
  });
});
updateWlSortIndicators();

function updateStSortIndicators() {
  document.querySelectorAll('#status-table th.sortable').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.key === stSortKey) th.classList.add(stSortDir === 'asc' ? 'sort-asc' : 'sort-desc');
  });
}

document.querySelectorAll('#status-table th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.key;
    if (stSortKey === key) {
      stSortDir = stSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      stSortKey = key;
      stSortDir = th.dataset.type === 'str' ? 'asc' : 'desc';
    }
    updateStSortIndicators();
    renderStatusTable();
  });
});
updateStSortIndicators();

// --- Contract details tab ---
function setupDetails() {
  const citySet = [...new Set(ALL_CONTRACTS.map(r => r.city))].filter(c => !HIDDEN_CITIES.includes(c)).sort();
  const citySelect = document.getElementById('cd-city');
  citySelect.innerHTML = '<option value="">All cities</option>';
  citySet.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; citySelect.appendChild(o); });

  const statusSet = [...new Set(ALL_CONTRACTS.map(r => r.bucket))];
  const order = ['Live', 'In progress', 'Expired', 'Terminated', 'Other'];
  statusSet.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const statusSelect = document.getElementById('cd-status');
  statusSelect.innerHTML = '<option value="">All Status</option>';
  statusSet.forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s; statusSelect.appendChild(o); });

  const categorySet = [...new Set(ALL_CONTRACTS.map(r => r.category || 'Uncategorized'))].sort();
  const categorySelect = document.getElementById('cd-category');
  categorySelect.innerHTML = '<option value="">All categories</option>';
  categorySet.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; categorySelect.appendChild(o); });

  cdPage = 0;
  renderDetails();
}

function cell(val, cls) {
  return '<td' + (cls ? ' class="' + cls + '"' : '') + '>' + (val || val === 0 ? val : '—') + '</td>';
}

function renderDetails() {
  const q = document.getElementById('cd-search').value.toLowerCase();
  const cityFilter = document.getElementById('cd-city').value;
  const statusFilter = document.getElementById('cd-status').value;
  const categoryFilter = document.getElementById('cd-category').value;
  const filtered = ALL_CONTRACTS.filter(r => {
    const matchesQ = !q || r.brand.toLowerCase().includes(q) || r.vendor.toLowerCase().includes(q) ||
      r.city.toLowerCase().includes(q) || r.id.toLowerCase().includes(q) ||
      r.category.toLowerCase().includes(q) || r.subCategory.toLowerCase().includes(q);
    const matchesCity = !cityFilter || r.city === cityFilter;
    const matchesStatus = !statusFilter || r.bucket === statusFilter;
    const matchesCategory = !categoryFilter || (r.category || 'Uncategorized') === categoryFilter;
    return matchesQ && matchesCity && matchesStatus && matchesCategory;
  }).sort((a, b) => compareRows(a, b, cdSortKey, cdSortDir));
  document.getElementById('cd-count').textContent = filtered.length + ' contract' + (filtered.length === 1 ? '' : 's');
  const maxPage = Math.max(0, Math.ceil(filtered.length / cdPerPage) - 1);
  if (cdPage > maxPage) cdPage = maxPage;
  const slice = filtered.slice(cdPage * cdPerPage, cdPage * cdPerPage + cdPerPage);
  const tbody = document.getElementById('details-table-body');
  tbody.innerHTML = slice.map(r => (
    '<tr>' +
      cell(r.brand, 'brand-cell') + cell(r.city) + cell(r.category) + cell(r.subCategory) + cell(r.kam) +
      cell(r.start) + '<td>' + statusBadge(r.status, r.bucket) + '</td>' + cell(r.end) +
      cell(r.agreementType) + cell(r.commissionOn) +
      cell(r.monthlyRental !== null ? '₹' + r.monthlyRental.toLocaleString('en-IN') : null, 'money') +
      cell(r.commission ? r.commission + '%' : null, 'money') +
      cell(r.actualCommission !== '' ? r.actualCommission + '%' : null, 'money') +
    '</tr>'
  )).join('') || '<tr><td colspan="13" style="color:var(--text-muted);">No matches.</td></tr>';
  document.getElementById('cd-page').textContent = 'Page ' + (cdPage + 1) + ' of ' + (maxPage + 1);
}

document.getElementById('cd-search').addEventListener('input', () => { cdPage = 0; renderDetails(); });
document.getElementById('cd-city').addEventListener('change', () => { cdPage = 0; renderDetails(); });
document.getElementById('cd-status').addEventListener('change', () => { cdPage = 0; renderDetails(); });
document.getElementById('cd-category').addEventListener('change', () => { cdPage = 0; renderDetails(); });
document.getElementById('cd-prev').addEventListener('click', () => { if (cdPage > 0) { cdPage--; renderDetails(); } });
document.getElementById('cd-next').addEventListener('click', () => { cdPage++; renderDetails(); });

function updateCdSortIndicators() {
  document.querySelectorAll('#details-table th.sortable').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.key === cdSortKey) th.classList.add(cdSortDir === 'asc' ? 'sort-asc' : 'sort-desc');
  });
}

document.querySelectorAll('#details-table th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.key;
    if (cdSortKey === key) {
      cdSortDir = cdSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      cdSortKey = key;
      cdSortDir = th.dataset.type === 'str' ? 'asc' : 'desc';
    }
    updateCdSortIndicators();
    cdPage = 0;
    renderDetails();
  });
});
updateCdSortIndicators();

// --- Revenue tab (Brand, City, Category, Sub category, KAM, Agreement Type, Monthly Rental, Commission%) ---
function setupRevenue() {
  const activeContracts = ALL_CONTRACTS.filter(r => r.bucket !== 'Expired' || r.recentlyExpired);
  const categorySet = [...new Set(activeContracts.map(r => r.category || 'Uncategorized'))].sort();
  const categorySelect = document.getElementById('rv-category');
  categorySelect.innerHTML = '<option value="">All categories</option>';
  categorySet.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; categorySelect.appendChild(o); });

  const citySet = [...new Set(activeContracts.map(r => r.city))].filter(c => !HIDDEN_CITIES.includes(c)).sort();
  const citySelect = document.getElementById('rv-city');
  citySelect.innerHTML = '<option value="">All cities</option>';
  citySet.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; citySelect.appendChild(o); });

  rvPage = 0;
  renderRevenue();
}

function renderRevenue() {
  const q = document.getElementById('rv-search').value.toLowerCase();
  const categoryFilter = document.getElementById('rv-category').value;
  const cityFilter = document.getElementById('rv-city').value;
  const filtered = ALL_CONTRACTS.filter(r => {
    if (r.bucket === 'Expired' && !r.recentlyExpired) return false;
    const matchesQ = !q || r.brand.toLowerCase().includes(q) || r.city.toLowerCase().includes(q) || r.kam.toLowerCase().includes(q);
    const matchesCategory = !categoryFilter || (r.category || 'Uncategorized') === categoryFilter;
    const matchesCity = !cityFilter || r.city === cityFilter;
    return matchesQ && matchesCategory && matchesCity;
  }).sort((a, b) => compareRows(a, b, rvSortKey, rvSortDir));

  document.getElementById('rv-count').textContent = filtered.length + ' row' + (filtered.length === 1 ? '' : 's');
  const maxPage = Math.max(0, Math.ceil(filtered.length / rvPerPage) - 1);
  if (rvPage > maxPage) rvPage = maxPage;
  const slice = filtered.slice(rvPage * rvPerPage, rvPage * rvPerPage + rvPerPage);
  const rupee = v => v !== null && v !== undefined ? '₹' + Math.round(v).toLocaleString('en-IN', { maximumFractionDigits: 0 }) : null;
  const tbody = document.getElementById('revenue-table-body');
  tbody.innerHTML = slice.map(r => (
    '<tr>' +
      cell(r.brand, 'brand-cell') + cell(r.city) + cell(r.category) + cell(r.subCategory) + cell(r.kam) + cell(r.agreementType) +
      cell(r.monthlyRental !== null ? rupee(r.monthlyRental) : null, 'money') +
      cell(r.actualCommission !== '' ? r.actualCommission + '%' : null, 'money') +
      cell(rupee(r.mrpCM)) + cell(rupee(r.mrpLM)) + cell(rupee(r.mrpL2M)) +
      cell(rupee(r.netSalesCM)) + cell(rupee(r.netSalesLM)) + cell(rupee(r.netSalesL2M)) +
      cell(rupee(r.commissionCM), 'money') + cell(rupee(r.commissionLM), 'money') + cell(rupee(r.commissionL2M), 'money') +
      cell(rupee(r.revenueCM), 'money') + cell(rupee(r.revenueLM), 'money') + cell(rupee(r.revenueL2M), 'money') +
    '</tr>'
  )).join('') || '<tr><td colspan="20" style="color:var(--text-muted);">No matches.</td></tr>';
  document.getElementById('rv-page').textContent = 'Page ' + (rvPage + 1) + ' of ' + (maxPage + 1);
}

document.getElementById('rv-search').addEventListener('input', () => { rvPage = 0; renderRevenue(); });
document.getElementById('rv-category').addEventListener('change', () => { rvPage = 0; renderRevenue(); });
document.getElementById('rv-city').addEventListener('change', () => { rvPage = 0; renderRevenue(); });
document.getElementById('rv-prev').addEventListener('click', () => { if (rvPage > 0) { rvPage--; renderRevenue(); } });
document.getElementById('rv-next').addEventListener('click', () => { rvPage++; renderRevenue(); });

// nulls always sort last, regardless of direction; numeric-looking values compare numerically, everything else as text
function compareRows(a, b, key, dir) {
  const av = a[key], bv = b[key];
  const aEmpty = av === null || av === undefined || av === '';
  const bEmpty = bv === null || bv === undefined || bv === '';
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  const numPattern = /^-?[\d.]+$/;
  const bothNumeric = (typeof av === 'number' && typeof bv === 'number') ||
    (numPattern.test(String(av).trim()) && numPattern.test(String(bv).trim()));
  const cmp = bothNumeric ? parseFloat(av) - parseFloat(bv) : String(av).localeCompare(String(bv));
  return dir === 'asc' ? cmp : -cmp;
}

function updateRvSortIndicators() {
  document.querySelectorAll('#revenue-table th.sortable').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.key === rvSortKey) th.classList.add(rvSortDir === 'asc' ? 'sort-asc' : 'sort-desc');
  });
}

document.querySelectorAll('#revenue-table th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.key;
    if (rvSortKey === key) {
      rvSortDir = rvSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      rvSortKey = key;
      rvSortDir = th.dataset.type === 'str' ? 'asc' : 'desc';
    }
    updateRvSortIndicators();
    rvPage = 0;
    renderRevenue();
  });
});
updateRvSortIndicators();

// --- Summary tab: Revenue totaled by Category x City x CM/LM/L2M ---
const SUMMARY_CITY_COLORS = [
  { bg: '#1d5fe0', color: '#ffffff' }, // blue
  { bg: '#f5c344', color: '#111827' }, // amber
  { bg: '#b39ddb', color: '#111827' }, // purple
  { bg: '#93cf93', color: '#111827' }, // green
  { bg: '#f2a0a0', color: '#111827' }, // pink
  { bg: '#8ecae6', color: '#111827' }  // light blue
];

function renderSummary() {
  const wrap = document.getElementById('summary-wrap');
  if (!wrap) return;

  const kpiRevenueEl = document.getElementById('sum-kpi-revenue');
  const kpiChangeEl = document.getElementById('sum-kpi-revenue-change');
  const kpiCityEl = document.getElementById('sum-kpi-top-city');
  const kpiCityValEl = document.getElementById('sum-kpi-top-city-value');
  const kpiCatEl = document.getElementById('sum-kpi-top-category');
  const kpiCatValEl = document.getElementById('sum-kpi-top-category-value');
  const cityChartEl = document.getElementById('sum-city-chart');
  const catChartEl = document.getElementById('sum-category-chart');

  // same contracts the Revenue tab shows: hidden cities out, long-expired contracts out
  const source = ALL_CONTRACTS.filter(r => !HIDDEN_CITIES.includes(r.city) && (r.bucket !== 'Expired' || r.recentlyExpired));

  const cities = [...new Set(source.map(r => r.city))].sort();
  const categories = [...new Set(source.map(r => r.category || 'Uncategorized'))].sort();

  if (!cities.length || !categories.length) {
    wrap.innerHTML = '<p style="color:var(--text-muted);font-size:13px;padding:12px;">No data to summarize yet.</p>';
    if (cityChartEl) cityChartEl.innerHTML = '';
    if (catChartEl) catChartEl.innerHTML = '';
    if (kpiRevenueEl) kpiRevenueEl.textContent = '—';
    if (kpiCityEl) kpiCityEl.textContent = '—';
    if (kpiCatEl) kpiCatEl.textContent = '—';
    return;
  }

  // agg[category][city] = { cm, lm, l2m }
  const agg = {};
  categories.forEach(cat => {
    agg[cat] = {};
    cities.forEach(city => { agg[cat][city] = { cm: 0, lm: 0, l2m: 0 }; });
  });
  source.forEach(r => {
    const cat = r.category || 'Uncategorized';
    const cell = agg[cat][r.city];
    cell.cm += r.revenueCM || 0;
    cell.lm += r.revenueLM || 0;
    cell.l2m += r.revenueL2M || 0;
  });

  const rupee = v => '₹' + Math.round(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

  // roll up cm/lm/l2m totals by city and by category, plus the grand total
  const cityTotals = {};
  cities.forEach(city => { cityTotals[city] = { cm: 0, lm: 0, l2m: 0 }; });
  const categoryTotals = {};
  categories.forEach(cat => { categoryTotals[cat] = { cm: 0, lm: 0, l2m: 0 }; });
  let grandCM = 0, grandLM = 0;
  categories.forEach(cat => {
    cities.forEach(city => {
      const v = agg[cat][city];
      cityTotals[city].cm += v.cm; cityTotals[city].lm += v.lm; cityTotals[city].l2m += v.l2m;
      categoryTotals[cat].cm += v.cm; categoryTotals[cat].lm += v.lm; categoryTotals[cat].l2m += v.l2m;
      grandCM += v.cm; grandLM += v.lm;
    });
  });

  // KPI 1: total revenue this month + month-over-month change
  if (kpiRevenueEl) kpiRevenueEl.textContent = rupee(grandCM);
  if (kpiChangeEl) {
    if (grandLM > 0) {
      const pct = ((grandCM - grandLM) / grandLM) * 100;
      const up = pct >= 0;
      kpiChangeEl.textContent = (up ? '▲ ' : '▼ ') + Math.abs(Math.round(pct)) + '% vs last month';
      kpiChangeEl.style.color = up ? 'var(--success)' : 'var(--danger)';
    } else {
      kpiChangeEl.textContent = 'No last-month data yet';
      kpiChangeEl.style.color = 'var(--text-muted)';
    }
  }

  // KPI 2/3: top city and top category by current-month revenue
  const topCity = cities.reduce((best, c) => (!best || cityTotals[c].cm > cityTotals[best].cm) ? c : best, null);
  if (kpiCityEl) kpiCityEl.textContent = topCity || '—';
  if (kpiCityValEl) kpiCityValEl.textContent = topCity ? rupee(cityTotals[topCity].cm) + ' this month' : '';

  const topCategory = categories.reduce((best, c) => (!best || categoryTotals[c].cm > categoryTotals[best].cm) ? c : best, null);
  if (kpiCatEl) kpiCatEl.textContent = topCategory || '—';
  if (kpiCatValEl) kpiCatValEl.textContent = topCategory ? rupee(categoryTotals[topCategory].cm) + ' this month' : '';

  // chart: revenue by city — one box per city, highest first
  if (cityChartEl) {
    const sortedCities = [...cities].sort((a, b) => cityTotals[b].cm - cityTotals[a].cm);
    cityChartEl.innerHTML = sortedCities.map(city => {
      const i = cities.indexOf(city);
      const col = SUMMARY_CITY_COLORS[i % SUMMARY_CITY_COLORS.length];
      return '<div class="card" style="border-left:4px solid ' + col.bg + ';">' +
        '<div class="label">' + city + '</div>' +
        '<div class="value">' + rupee(cityTotals[city].cm) + '</div>' +
      '</div>';
    }).join('');
  }

  // chart: revenue by category (horizontal bars, highest first)
  if (catChartEl) {
    const sortedCats = [...categories].sort((a, b) => categoryTotals[b].cm - categoryTotals[a].cm);
    const maxCat = Math.max(1, ...sortedCats.map(c => categoryTotals[c].cm));
    catChartEl.innerHTML = sortedCats.map(cat => {
      const pct = Math.max(2, Math.round((categoryTotals[cat].cm / maxCat) * 100));
      return '<div>' +
        '<div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-2);margin-bottom:3px;">' +
          '<span style="font-weight:600;color:var(--text);">' + cat + '</span><span>' + rupee(categoryTotals[cat].cm) + '</span>' +
        '</div>' +
        '<div style="background:var(--surface-2);border-radius:5px;height:8px;">' +
          '<div style="background:var(--accent);width:' + pct + '%;height:8px;border-radius:5px;"></div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  // full pivot table, collapsed behind a <details> for anyone who wants row-level detail.
  // one metric shown at a time (picked via the dropdown) so the table stays narrow — a
  // Category x City grid instead of Category x (City x 3 columns)
  const metricSelect = document.getElementById('summary-metric');
  const metric = metricSelect ? metricSelect.value : 'cm';

  const cityHeaderRow = '<tr class="city-row">' +
    '<th class="cat-cell">Category</th>' +
    cities.map((city, i) => {
      const c = SUMMARY_CITY_COLORS[i % SUMMARY_CITY_COLORS.length];
      return '<th style="background:' + c.bg + ';color:' + c.color + ';">' + city + '</th>';
    }).join('') +
    '</tr>';

  const bodyRows = categories.map(cat => (
    '<tr>' +
      '<td class="cat-cell">' + cat + '</td>' +
      cities.map(city => '<td>' + rupee(agg[cat][city][metric]) + '</td>').join('') +
    '</tr>'
  )).join('');

  const totalRow = '<tr>' +
    '<td class="cat-cell">Total</td>' +
    cities.map(city => '<td>' + rupee(cityTotals[city][metric]) + '</td>').join('') +
    '</tr>';

  wrap.innerHTML =
    '<table id="summary-table">' +
      '<thead>' + cityHeaderRow + '</thead>' +
      '<tbody>' + bodyRows + totalRow + '</tbody>' +
    '</table>';
}

document.getElementById('summary-metric').addEventListener('change', renderSummary);

loadData();
