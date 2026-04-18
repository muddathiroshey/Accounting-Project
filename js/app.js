
// ========== DATA LAYER ==========

const state = {
  accounts: [],
  journals: [],
  openingBalances: {}
};

const SNAPSHOT_STORAGE_KEY = 'accounting-github-pages-snapshot-v2';
const PAGE_STORAGE_KEY = 'accounting-github-pages-current-page-v1';
const LEGACY_SNAPSHOT_STORAGE_KEYS = ['accounting-github-pages-snapshot-v1'];

let currentPage = 'accounts';
let isBundledSnapshotMode = false;

const LEVEL_LABELS = {
  1: 'Main Classes',
  3: 'Groups',
  6: 'Subgroups',
  9: 'Posting Accounts'
};

const INCOME_SECTIONS = [
  { key: 'revenue', label: 'Revenues', className: 'revenue', totalLabel: 'Total Revenues', positive: true },
  { key: 'cost_of_goods_sold', label: 'Cost of Goods Sold', className: 'cogs', totalLabel: 'Total Cost of Goods Sold', positive: false },
  { key: 'operating_expenses', label: 'Operating Expenses', className: 'opex', totalLabel: 'Total Operating Expenses', positive: false },
  { key: 'other_income', label: 'Other Income', className: 'other-income', totalLabel: 'Total Other Income', positive: true }
];

async function apiRequest(url, options = {}) {
  const isFormData = options.body instanceof FormData;
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
        ...(options.headers || {})
      }
    });
  } catch (error) {
    throw new Error('تعذر الوصول إلى الخادم');
  }

  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    throw new Error(payload?.message || 'حدث خطأ غير متوقع');
  }

  return payload;
}

function normalizeCollection(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.value)) return value.value;
  return [];
}

function normalizeOpeningBalances(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return {};
}

function normalizeSnapshot(snapshot) {
  return {
    accounts: normalizeCollection(snapshot?.accounts),
    journals: normalizeCollection(snapshot?.journals),
    openingBalances: normalizeOpeningBalances(snapshot?.openingBalances)
  };
}

function applySnapshot(snapshot) {
  const normalized = normalizeSnapshot(snapshot);
  state.accounts = normalized.accounts;
  state.journals = normalized.journals;
  state.openingBalances = normalized.openingBalances;
  updatePostingAccountsList();
}

function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

function getCurrentSnapshot() {
  const normalized = normalizeSnapshot(state);
  return {
    accounts: cloneData(normalized.accounts),
    journals: cloneData(normalized.journals),
    openingBalances: cloneData(normalized.openingBalances)
  };
}

function loadLocalSnapshot() {
  try {
    const raw = localStorage.getItem(SNAPSHOT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return normalizeSnapshot(parsed);
  } catch (error) {
    return null;
  }
}

function saveLocalSnapshot(snapshot) {
  try {
    localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot));
  } catch (error) {
    // Ignore storage quota issues in browser-only mode.
  }
}

function clearLegacyLocalSnapshots() {
  try {
    LEGACY_SNAPSHOT_STORAGE_KEYS.forEach(key => localStorage.removeItem(key));
  } catch (error) {
    // Ignore storage access issues.
  }
}

function persistSnapshotLocally(snapshot) {
  const normalized = normalizeSnapshot(snapshot);
  const persisted = {
    accounts: normalized.accounts,
    journals: normalized.journals.slice().sort((left, right) => {
      const dateCompare = String(left.date || '').localeCompare(String(right.date || ''));
      if (dateCompare !== 0) return dateCompare;
      return (parseInt(left.workbook_no || left.no, 10) || 0) - (parseInt(right.workbook_no || right.no, 10) || 0);
    }),
    openingBalances: normalized.openingBalances
  };

  saveLocalSnapshot(persisted);
  applySnapshot(persisted);
  return persisted;
}

function isClientOnlyMode() {
  return true;
}

function saveCurrentPage(page) {
  try {
    localStorage.setItem(PAGE_STORAGE_KEY, page);
  } catch (error) {
    // Ignore browser storage issues.
  }
}

function loadSavedPage() {
  try {
    return localStorage.getItem(PAGE_STORAGE_KEY) || 'accounts';
  } catch (error) {
    return 'accounts';
  }
}

function getBundledSnapshot() {
  const bundled = window.__ACCOUNTING_FALLBACK__;
  if (!bundled) return null;

  return normalizeSnapshot({
    accounts: JSON.parse(JSON.stringify(bundled.accounts || [])),
    journals: JSON.parse(JSON.stringify(bundled.journals || [])),
    openingBalances: JSON.parse(JSON.stringify(bundled.openingBalances || {}))
  });
}

async function fetchJsonFile(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Unable to load ${path}`);
  }

  return response.json();
}

async function fetchStaticSnapshot() {
  const [accounts, journals, openingBalances] = await Promise.all([
    fetchJsonFile('data/accounts.json'),
    fetchJsonFile('data/journals.json'),
    fetchJsonFile('data/opening-balances.json')
  ]);

  return normalizeSnapshot({
    accounts,
    journals,
    openingBalances
  });
}

async function refreshState() {
  const localSnapshot = loadLocalSnapshot();
  if (localSnapshot) {
    isBundledSnapshotMode = true;
    applySnapshot(localSnapshot);
    return localSnapshot;
  }

  try {
    const snapshot = await fetchStaticSnapshot();
    isBundledSnapshotMode = true;
    applySnapshot(snapshot);
    saveLocalSnapshot(snapshot);
    return snapshot;
  } catch (error) {
    const fallbackSnapshot = getBundledSnapshot();
    if (!fallbackSnapshot) {
      throw error;
    }

    isBundledSnapshotMode = true;
    applySnapshot(fallbackSnapshot);
    saveLocalSnapshot(fallbackSnapshot);
    return fallbackSnapshot;
  }
}

// ========== ACCOUNT HELPERS ==========

function getAccounts() { return state.accounts || []; }
function getJournals() { return state.journals || []; }
function getOpeningBalances() { return state.openingBalances || {}; }

function getPostingAccounts() {
  return getAccounts().filter(a => a.is_posting);
}

// Determine account type from code prefix (rule-based, dynamic)
function inferAccountProps(code) {
  const first = code[0];
  const len = code.length;
  const isPosting = len === 9;

  const typeMap = {
    '1': { type: 'asset', natural_balance: 'debit', fs_section: 'balance_sheet' },
    '2': { type: 'liability_equity', natural_balance: 'credit', fs_section: 'balance_sheet' },
    '3': { type: 'expense', natural_balance: 'debit', fs_section: 'income_statement' },
    '4': { type: 'revenue', natural_balance: 'credit', fs_section: 'income_statement' }
  };
  const base = typeMap[first] || { type: 'other', natural_balance: 'debit', fs_section: 'other' };

  // Income statement sub-section
  let is_subsection = null;
  if (first === '3') {
    if (code.startsWith('301')) is_subsection = 'cost_of_goods_sold';
    else is_subsection = 'operating_expenses';
  } else if (first === '4') {
    if (code.startsWith('401')) is_subsection = 'revenue';
    else is_subsection = 'other_income';
  }

  return { ...base, is_subsection, is_posting: isPosting };
}

// Get the parent code from child code
function getParentCode(code) {
  const normalized = String(code || '');
  const len = normalized.length;
  if (len === 9) return normalized.slice(0, 6);
  if (len === 6) return normalized.slice(0, 3);
  if (len === 3) return normalized.slice(0, 1);
  return null;
}

// Get the level description
function getLevelName(level) {
  return LEVEL_LABELS[level] || 'Unknown';
}

function getTypeLabel(type) {
  const map = { asset: 'Asset', liability_equity: 'Liability/Equity', expense: 'Expense', revenue: 'Revenue' };
  return map[type] || type;
}

function getAccountByCode(code) {
  const normalized = String(code || '');
  return getAccounts().find(account => String(account.code) === normalized) || null;
}

function getCodeLevel(code) {
  return String(code || '').length;
}

function getChildLevel(parentCode) {
  const level = getCodeLevel(parentCode);
  if (level === 1) return 3;
  if (level === 3) return 6;
  if (level === 6) return 9;
  return null;
}

function getAccountEntityName(level) {
  const labels = {
    1: 'Main Class',
    3: 'Group',
    6: 'Subgroup',
    9: 'Posting Account'
  };

  return labels[level] || 'Account';
}

function canAddChildAccount(account) {
  return [1, 3, 6].includes(getCodeLevel(account?.code));
}

function canDeleteAccountNode(account) {
  return [3, 6, 9].includes(getCodeLevel(account?.code));
}

function canEditAccountNode(account) {
  return getCodeLevel(account?.code) === 9;
}

function sortAccountsByCode(accounts) {
  return [...accounts].sort((left, right) => String(left.code).localeCompare(String(right.code)));
}

function getBranchInheritedProps(parentCode, suggestedCode = '') {
  const sibling = getAccounts().find(account => getParentCode(account.code) === parentCode);
  if (sibling) {
    return {
      type: sibling.type,
      natural_balance: sibling.natural_balance,
      fs_section: sibling.fs_section,
      is_subsection: sibling.is_subsection,
      is_posting: getCodeLevel(suggestedCode || sibling.code) === 9
    };
  }

  return inferAccountProps(suggestedCode || parentCode);
}

function getDescendantAccounts(code) {
  const baseCode = String(code);
  return getAccounts().filter(account => {
    const accountCode = String(account.code);
    return accountCode === baseCode || (accountCode.startsWith(baseCode) && accountCode.length > baseCode.length);
  });
}

function rerenderAfterAccountChange() {
  renderAccountsTree(document.getElementById('accountSearch')?.value || '');
  renderJournalList();
  if (currentPage === 'trial') renderTrialBalance();
  if (currentPage === 'income') renderIncomeStatement();
  if (currentPage === 'balance') renderBalanceSheet();
}

function getAccountProps(accountOrCode) {
  if (!accountOrCode) return inferAccountProps('');
  const account = typeof accountOrCode === 'string' ? getAccountByCode(accountOrCode) : accountOrCode;
  const code = typeof accountOrCode === 'string' ? accountOrCode : accountOrCode.code;
  const inferred = inferAccountProps(String(code || ''));

  return {
    ...inferred,
    ...(account || {})
  };
}

function getAncestorCodeForLevel(code, level) {
  const normalized = String(code || '');
  if (level === 1) return normalized.slice(0, 1);
  if (level === 3) return normalized.slice(0, 3);
  if (level === 6) return normalized.slice(0, 6);
  return normalized.slice(0, 9);
}

function getAccountPath(code) {
  const parts = [];
  let currentCode = code;

  while (currentCode) {
    const current = getAccountByCode(currentCode);
    if (!current) break;
    parts.unshift(current.name);
    currentCode = getParentCode(currentCode);
  }

  return parts.join(' / ');
}

// Find next available child code under a parent
function getNextChildCode(parentCode) {
  const normalizedParentCode = String(parentCode || '');
  const accounts = getAccounts();
  const parentLen = normalizedParentCode.length;
  let childLen;
  if (parentLen === 1) childLen = 3;
  else if (parentLen === 3) childLen = 6;
  else if (parentLen === 6) childLen = 9;
  else return null;

  // Find all existing children
  const children = accounts.filter(a => {
    const cStr = String(a.code || '');
    return cStr.length === childLen && cStr.startsWith(normalizedParentCode);
  });

  if (childLen === 3) {
    // e.g., parent = '1', children are 3-digit starting with '1'
    const nums = children.map(a => parseInt(String(a.code).slice(parentLen), 10));
    const max = nums.length ? Math.max(...nums) : 0;
    const next = max + 1;
    return normalizedParentCode + String(next).padStart(childLen - parentLen, '0');
  } else if (childLen === 6) {
    // parent = '101', children are '101001', '101002', ...
    const nums = children.map(a => parseInt(String(a.code).slice(parentLen), 10));
    const max = nums.length ? Math.max(...nums) : 0;
    const next = max + 1;
    return normalizedParentCode + String(next).padStart(3, '0');
  } else if (childLen === 9) {
    // parent = '101001', children are '101001001', ...
    const nums = children.map(a => parseInt(String(a.code).slice(parentLen), 10));
    const max = nums.length ? Math.max(...nums) : 0;
    const next = max + 1;
    return normalizedParentCode + String(next).padStart(3, '0');
  }
  return null;
}

// ========== LEDGER / BALANCES ==========

function computeAccountBalances() {
  const journals = getJournals();
  const openings = getOpeningBalances();
  const balances = {}; // code -> { openDr, openCr, movDr, movCr }

  // Seed all accounts
  getAccounts().forEach(a => {
    balances[a.code] = { openDr: 0, openCr: 0, movDr: 0, movCr: 0 };
  });

  // Opening balances (only for posting accounts)
  Object.entries(openings).forEach(([code, bal]) => {
    if (!balances[code]) balances[code] = { openDr: 0, openCr: 0, movDr: 0, movCr: 0 };
    balances[code].openDr = parseFloat(bal.dr) || 0;
    balances[code].openCr = parseFloat(bal.cr) || 0;
  });

  // Journal movements
  journals.forEach(entry => {
    entry.lines.forEach(line => {
      const code = line.code;
      if (!balances[code]) balances[code] = { openDr: 0, openCr: 0, movDr: 0, movCr: 0 };
      balances[code].movDr += parseFloat(line.dr) || 0;
      balances[code].movCr += parseFloat(line.cr) || 0;
    });
  });

  // Aggregate totals for each account (totals = openings + movements)
  // Net balance (by natural balance side)
  Object.keys(balances).forEach(code => {
    const b = balances[code];
    b.totalDr = b.openDr + b.movDr;
    b.totalCr = b.openCr + b.movCr;
    const diff = b.totalDr - b.totalCr;
    b.balDr = diff > 0 ? diff : 0;
    b.balCr = diff < 0 ? -diff : 0;
  });

  // Roll up to parent accounts
  const accounts = getAccounts();
  // Sort by code length desc so leaves are processed first
  const sorted = [...accounts].sort((a, b) => b.code.length - a.code.length);
  sorted.forEach(acc => {
    const parent = getParentCode(acc.code);
    if (parent && balances[parent] && balances[acc.code]) {
      const pb = balances[parent];
      const cb = balances[acc.code];
      pb.openDr += cb.openDr;
      pb.openCr += cb.openCr;
      pb.movDr += cb.movDr;
      pb.movCr += cb.movCr;
    }
  });

  // Recompute totals for parents
  Object.keys(balances).forEach(code => {
    const b = balances[code];
    b.totalDr = b.openDr + b.movDr;
    b.totalCr = b.openCr + b.movCr;
    const diff = b.totalDr - b.totalCr;
    b.balDr = diff > 0 ? diff : 0;
    b.balCr = diff < 0 ? -diff : 0;
  });

  return balances;
}

function getTrialBalanceRows(level) {
  const balances = computeAccountBalances();

  return getAccounts()
    .filter(account => account.code.length === level)
    .slice()
    .sort((left, right) => left.code.localeCompare(right.code))
    .map(account => {
      const props = getAccountProps(account);
      const balance = balances[account.code] || {};

      return {
        account,
        code: account.code,
        name: account.name,
        path: getAccountPath(account.code),
        type: props.type,
        natural_balance: props.natural_balance,
        fs_section: props.fs_section,
        is_subsection: props.is_subsection,
        openDr: balance.openDr || 0,
        openCr: balance.openCr || 0,
        movDr: balance.movDr || 0,
        movCr: balance.movCr || 0,
        totalDr: balance.totalDr || 0,
        totalCr: balance.totalCr || 0,
        balDr: balance.balDr || 0,
        balCr: balance.balCr || 0
      };
    });
}

function getIncomeLineAmount(row) {
  if (row.type === 'revenue') return row.totalCr - row.totalDr;
  if (row.type === 'expense') return row.totalDr - row.totalCr;
  return 0;
}

function buildIncomeSectionRows(level) {
  const sectionMaps = Object.fromEntries(INCOME_SECTIONS.map(section => [section.key, new Map()]));

  getTrialBalanceRows(9).forEach(postingRow => {
    if (postingRow.totalDr === 0 && postingRow.totalCr === 0) return;

    const sectionKey = postingRow.is_subsection;
    const targetMap = sectionMaps[sectionKey];
    if (!targetMap) return;

    const ancestorCode = getAncestorCodeForLevel(postingRow.code, level);
    const ancestor = getAccountByCode(ancestorCode);
    if (!ancestor) return;

    const props = getAccountProps(ancestor);
    const amount = getIncomeLineAmount(postingRow);
    if (amount === 0) return;

    const existing = targetMap.get(ancestorCode) || {
      code: ancestorCode,
      name: ancestor.name,
      path: getAccountPath(ancestorCode),
      type: props.type,
      amount: 0
    };

    existing.amount += amount;
    targetMap.set(ancestorCode, existing);
  });

  return Object.fromEntries(
    INCOME_SECTIONS.map(section => [
      section.key,
      Array.from(sectionMaps[section.key].values()).sort((left, right) => left.code.localeCompare(right.code))
    ])
  );
}

// ========== NUMBER FORMAT ==========

function fmt(n) {
  if (!n || n === 0) return '-';
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function fmtNum(n) {
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);
}

// ========== TOAST ==========

function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type} show`;
  setTimeout(() => t.className = 'toast', 2800);
}

// ========== NAVIGATION ==========

function navigate(page) {
  currentPage = page;
  saveCurrentPage(page);
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`page-${page}`).classList.add('active');
  document.querySelector(`.nav-item[data-page="${page}"]`).classList.add('active');

  if (page === 'trial') renderTrialBalance();
  if (page === 'income') renderIncomeStatement();
  if (page === 'balance') renderBalanceSheet();
  if (page === 'journal') renderJournalList();
}

// ========== ACCOUNTS TREE ==========

function buildTree(accounts) {
  const map = {};
  accounts.forEach(a => { map[a.code] = { ...a, children: [] }; });
  const roots = [];
  accounts.forEach(a => {
    const parent = getParentCode(a.code);
    if (parent && map[parent]) {
      map[parent].children.push(map[a.code]);
    } else {
      roots.push(map[a.code]);
    }
  });
  return roots;
}

function renderAccountNode(node, depth) {
  const level = getCodeLevel(node.code);
  const childLevel = getChildLevel(node.code);
  const childEntityName = getAccountEntityName(childLevel);
  const allowAdd = canAddChildAccount(node);
  const allowDelete = canDeleteAccountNode(node);
  const allowEdit = canEditAccountNode(node);
  const div = document.createElement('div');
  div.className = `tree-node node-level-${node.code.length}`;
  div.dataset.code = node.code;

  const hasChildren = node.children && node.children.length > 0;
  const typeLabel = getTypeLabel(node.type);

  const header = document.createElement('div');
  header.className = 'tree-node-header';
  header.innerHTML = `
    <span class="tree-toggle ${hasChildren ? '' : 'invisible'}">${hasChildren ? '▶' : '○'}</span>
    <span class="tree-code">${node.code}</span>
    <span class="tree-name">${node.name}</span>
    <span class="tree-type-tag type-${node.type}">${typeLabel}</span>
    <div class="tree-actions">
      ${allowAdd ? `<button class="btn-tree add-child-btn" data-code="${node.code}">Add ${childEntityName}</button>` : ''}
      ${allowEdit ? `<button class="btn-tree edit-account-btn" data-code="${node.code}">Edit</button>` : ''}
      ${allowDelete ? `<button class="btn-tree danger delete-account-btn" data-code="${node.code}">Delete</button>` : ''}
      <button class="btn-tree copy-code-btn" data-code="${node.code}">Copy Code</button>
    </div>
  `;

  div.appendChild(header);

  if (hasChildren) {
    const children = document.createElement('div');
    children.className = 'tree-children';
    node.children.forEach(child => children.appendChild(renderAccountNode(child, depth + 1)));
    div.appendChild(children);

    header.querySelector('.tree-toggle').addEventListener('click', (e) => {
      e.stopPropagation();
      const tog = header.querySelector('.tree-toggle');
      const ch = div.querySelector('.tree-children');
      ch.classList.toggle('open');
      tog.classList.toggle('open');
    });
  }

  const copyBtn = header.querySelector('.copy-code-btn');
  if (copyBtn) copyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await copyCode(node.code);
  });

  const addBtn = header.querySelector('.add-child-btn');
  if (addBtn) addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openAddAccountModal(node.code);
  });

  const editBtn = header.querySelector('.edit-account-btn');
  if (editBtn) editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditAccountModal(node.code);
  });

  const deleteBtn = header.querySelector('.delete-account-btn');
  if (deleteBtn) deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteAccount(node.code);
  });

  return div;
}

async function copyCode(code) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(code);
    } else {
      const helper = document.createElement('textarea');
      helper.value = code;
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      helper.focus();
      helper.select();
      document.execCommand('copy');
      document.body.removeChild(helper);
    }

    showToast(`Copied code: ${code}`, 'success');
  } catch (error) {
    showToast('Unable to copy the account code', 'error');
  }
}

function renderAccountsTree(filter = '') {
  const container = document.getElementById('accountsTree');
  const accounts = getAccounts();

  let filtered = accounts;
  if (filter) {
    const f = filter.toLowerCase();
    const matchedCodes = new Set(accounts.filter(a =>
      a.name.includes(filter) || a.code.includes(filter) || a.name.toLowerCase().includes(f)
    ).map(account => account.code));

    Array.from(matchedCodes).forEach(code => {
      let currentCode = getParentCode(code);
      while (currentCode) {
        matchedCodes.add(currentCode);
        currentCode = getParentCode(currentCode);
      }
    });

    filtered = accounts.filter(account => matchedCodes.has(account.code));
  }

  container.innerHTML = '';
  if (!filtered.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div><p>No matching accounts</p></div>';
    return;
  }

  const tree = buildTree(sortAccountsByCode(filtered));
  tree.forEach(root => {
    const node = renderAccountNode(root, 0);
    container.appendChild(node);
  });

  container.querySelectorAll('.tree-node').forEach(node => {
    const code = node.dataset.code || '';
    if (code.length > 3) return;

    const children = Array.from(node.children).find(child => child.classList?.contains('tree-children'));
    const header = Array.from(node.children).find(child => child.classList?.contains('tree-node-header'));
    const toggle = header?.querySelector('.tree-toggle');
    if (children) {
      children.classList.add('open');
      if (toggle) toggle.classList.add('open');
    }
  });
}

async function deleteAccount(code) {
  const account = getAccountByCode(code);
  if (!account) {
    showToast('Account not found', 'error');
    return;
  }

  if (!canDeleteAccountNode(account)) {
    showToast('This account level cannot be deleted', 'error');
    return;
  }

  const accountsToDelete = getDescendantAccounts(code);
  const codesToDelete = new Set(accountsToDelete.map(item => item.code));
  const usedInOpening = Object.keys(getOpeningBalances()).filter(accountCode => codesToDelete.has(accountCode));
  const usedInJournals = getJournals().some(journal => journal.lines.some(line => codesToDelete.has(line.code)));

  if (usedInOpening.length || usedInJournals) {
    showToast('Cannot delete an account branch that already has opening balances or journal entries', 'error');
    return;
  }

  const itemLabel = getAccountEntityName(getCodeLevel(code));
  const deleteMessage = accountsToDelete.length > 1
    ? `Delete this ${itemLabel} and all accounts under it?`
    : `Delete this ${itemLabel}?`;

  if (!confirm(deleteMessage)) {
    return;
  }

  if (isClientOnlyMode()) {
    const snapshot = getCurrentSnapshot();
    snapshot.accounts = sortAccountsByCode(snapshot.accounts.filter(accountItem => !codesToDelete.has(accountItem.code)));
    persistSnapshotLocally(snapshot);
    rerenderAfterAccountChange();
    showToast(`${itemLabel} deleted`, 'success');
    return;
  }

  try {
    const snapshot = await apiRequest(`/api/accounts/${encodeURIComponent(code)}`, { method: 'DELETE' });
    applySnapshot(snapshot);
    rerenderAfterAccountChange();
    showToast(`${itemLabel} deleted`, 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// ========== ADD ACCOUNT MODAL ==========

const accountModalState = {
  mode: 'add',
  targetCode: null,
  parentCode: null
};

function updateInheritancePreview(accountCode, parentCode) {
  const preview = document.getElementById('inheritancePreview');
  const details = document.getElementById('inheritanceDetails');
  if (!accountCode || !parentCode) {
    preview.style.display = 'none';
    details.innerHTML = '';
    return;
  }

  const props = getBranchInheritedProps(parentCode, accountCode);
  preview.style.display = 'block';
  details.innerHTML = `
    <span class="inherit-tag">Type: ${getTypeLabel(props.type)}</span>
    <span class="inherit-tag">Natural Balance: ${props.natural_balance === 'debit' ? 'Dr' : 'Cr'}</span>
    <span class="inherit-tag">Statement: ${props.fs_section === 'balance_sheet' ? 'Balance Sheet' : 'Income Statement'}</span>
    ${props.is_subsection ? `<span class="inherit-tag">${props.is_subsection}</span>` : ''}
    ${getCodeLevel(accountCode) === 9 ? '<span class="inherit-tag">✓ Posting Account</span>' : ''}
  `;
}

function openAddAccountModal(parentCode) {
  const parent = getAccountByCode(parentCode);
  if (!parent || !canAddChildAccount(parent)) {
    showToast('You cannot add a child account here', 'error');
    return;
  }

  const suggested = getNextChildCode(parentCode);
  if (!suggested) {
    showToast('No code is available in this branch', 'error');
    return;
  }

  accountModalState.mode = 'add';
  accountModalState.targetCode = null;
  accountModalState.parentCode = parentCode;

  const childLabel = getAccountEntityName(getChildLevel(parentCode));
  document.getElementById('accountModalTitle').textContent = `Add ${childLabel}`;
  document.getElementById('accountCodeLabel').textContent = `${childLabel} Code`;
  document.getElementById('confirmAddAccount').textContent = `Add ${childLabel}`;
  document.getElementById('parentCode').value = parentCode;
  document.getElementById('parentInfo').textContent = `Parent account: ${parent.name}`;
  document.getElementById('newAccountName').value = '';
  document.getElementById('suggestedCode').value = suggested || '';
  updateInheritancePreview(suggested, parentCode);
  document.getElementById('addAccountModal').style.display = 'flex';
  document.getElementById('newAccountName').focus();
}

function openEditAccountModal(code) {
  const account = getAccountByCode(code);
  if (!account || !canEditAccountNode(account)) {
    showToast('Only posting accounts can be edited', 'error');
    return;
  }

  const parentCode = getParentCode(code);
  const parent = getAccountByCode(parentCode);

  accountModalState.mode = 'edit';
  accountModalState.targetCode = code;
  accountModalState.parentCode = parentCode;

  document.getElementById('accountModalTitle').textContent = 'Edit Posting Account';
  document.getElementById('accountCodeLabel').textContent = 'Account Code';
  document.getElementById('confirmAddAccount').textContent = 'Save Changes';
  document.getElementById('parentCode').value = parentCode || '';
  document.getElementById('parentInfo').textContent = parent ? `Parent account: ${parent.name}` : '';
  document.getElementById('newAccountName').value = account.name || '';
  document.getElementById('suggestedCode').value = code;
  updateInheritancePreview(code, parentCode);
  document.getElementById('addAccountModal').style.display = 'flex';
  document.getElementById('newAccountName').focus();
  document.getElementById('newAccountName').select();
}

function closeAddAccountModal() {
  document.getElementById('addAccountModal').style.display = 'none';
  document.getElementById('newAccountName').value = '';
  document.getElementById('parentCode').value = '';
  document.getElementById('parentInfo').textContent = '';
  document.getElementById('suggestedCode').value = '';
  updateInheritancePreview('', '');
  accountModalState.mode = 'add';
  accountModalState.targetCode = null;
  accountModalState.parentCode = null;
}

async function confirmAddAccount() {
  const name = document.getElementById('newAccountName').value.trim();
  const parentCode = accountModalState.parentCode;

  if (!name) {
    showToast('Enter the account name', 'error');
    return;
  }

  if (accountModalState.mode === 'edit') {
    const targetCode = accountModalState.targetCode;
    const account = getAccountByCode(targetCode);
    if (!account || !canEditAccountNode(account)) {
      showToast('Only posting accounts can be edited', 'error');
      return;
    }

    if (isClientOnlyMode()) {
      const snapshot = getCurrentSnapshot();
      snapshot.accounts = snapshot.accounts.map(accountItem =>
        accountItem.code === targetCode ? { ...accountItem, name } : accountItem
      );
      snapshot.journals = snapshot.journals.map(journal => ({
        ...journal,
        lines: journal.lines.map(line => line.code === targetCode ? { ...line, name } : line)
      }));

      persistSnapshotLocally(snapshot);
      closeAddAccountModal();
      rerenderAfterAccountChange();
      showToast('Posting account name updated', 'success');
      return;
    }

    showToast('Editing posting accounts requires local save mode', 'error');
    return;
  }

  if (!parentCode) {
    showToast('Choose a parent account', 'error');
    return;
  }

  const createdCode = getNextChildCode(parentCode);
  if (!createdCode) {
    showToast('No code is available in this branch', 'error');
    return;
  }

  const props = getBranchInheritedProps(parentCode, createdCode);
  const newAccount = {
    code: createdCode,
    name,
    level: getCodeLevel(createdCode),
    type: props.type,
    natural_balance: props.natural_balance,
    fs_section: props.fs_section,
    is_subsection: props.is_subsection ?? null,
    is_posting: getCodeLevel(createdCode) === 9
  };

  if (isClientOnlyMode()) {
    const snapshot = getCurrentSnapshot();
    snapshot.accounts = sortAccountsByCode([...snapshot.accounts, newAccount]);
    persistSnapshotLocally(snapshot);
    closeAddAccountModal();
    rerenderAfterAccountChange();
    showToast(`${getAccountEntityName(getCodeLevel(createdCode))} added: ${name} (${createdCode})`, 'success');
    return;
  }

  try {
    const snapshot = await apiRequest('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({ parent_code: parentCode, name })
    });

    applySnapshot(snapshot);
    closeAddAccountModal();
    rerenderAfterAccountChange();
    showToast(`${getAccountEntityName(getCodeLevel(createdCode))} added: ${name} (${createdCode})`, 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// ========== OPENING BALANCES ==========

let openingBalanceCode = null;

function openOpeningBalanceModal(code, name) {
  openingBalanceCode = code;
  document.getElementById('openingAccountName').textContent = `${code} - ${name}`;
  const bal = getOpeningBalances()[code] || { dr: 0, cr: 0 };
  document.getElementById('openingDr').value = bal.dr || '';
  document.getElementById('openingCr').value = bal.cr || '';
  document.getElementById('openingBalanceModal').style.display = 'flex';
}

async function persistOpeningBalanceRecord(code, dr, cr, showSuccessToast = true) {
  if (isClientOnlyMode()) {
    const snapshot = getCurrentSnapshot();
    if (dr === 0 && cr === 0) {
      delete snapshot.openingBalances[code];
    } else {
      snapshot.openingBalances[code] = { dr, cr };
    }

    persistSnapshotLocally(snapshot);
    if (currentPage === 'trial') renderTrialBalance();
    if (currentPage === 'income') renderIncomeStatement();
    if (currentPage === 'balance') renderBalanceSheet();
    if (showSuccessToast) showToast('Beginning of year values saved', 'success');
    return;
  }

  const snapshot = await apiRequest(`/api/opening-balances/${encodeURIComponent(code)}`, {
    method: 'PUT',
    body: JSON.stringify({ dr, cr })
  });

  applySnapshot(snapshot);
  if (currentPage === 'trial') renderTrialBalance();
  if (currentPage === 'income') renderIncomeStatement();
  if (currentPage === 'balance') renderBalanceSheet();
  if (showSuccessToast) showToast('Beginning of year values saved', 'success');
}

async function confirmOpeningBalance() {
  const dr = parseFloat(document.getElementById('openingDr').value) || 0;
  const cr = parseFloat(document.getElementById('openingCr').value) || 0;

  if (dr > 0 && cr > 0) {
    showToast('Beginning of year values must be debit or credit only', 'error');
    return;
  }

  try {
    await persistOpeningBalanceRecord(openingBalanceCode, dr, cr, true);
    document.getElementById('openingBalanceModal').style.display = 'none';
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function saveOpeningBalanceFromTrial(code, side, rawValue) {
  const current = getOpeningBalances()[code] || { dr: 0, cr: 0 };
  const parsed = parseFloat(rawValue);
  const normalizedValue = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  let nextDr = side === 'dr' ? normalizedValue : (parseFloat(current.dr) || 0);
  let nextCr = side === 'cr' ? normalizedValue : (parseFloat(current.cr) || 0);

  if (normalizedValue > 0) {
    if (side === 'dr') nextCr = 0;
    if (side === 'cr') nextDr = 0;
  }

  try {
    await persistOpeningBalanceRecord(code, nextDr, nextCr, false);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// ========== JOURNAL ENTRY ==========

let entryCounter = 0;

function getNextEntryNo() {
  const journals = getJournals();
  if (!journals.length) return '1';
  const nums = journals.map(j => parseInt(j.workbook_no || j.no, 10) || 0);
  return String(Math.max(...nums) + 1);
}

function updatePostingAccountsList() {
  const datalist = document.getElementById('postingAccountsList');
  if (!datalist) return;
  const posting = getPostingAccounts();
  datalist.innerHTML = posting.map(a => `<option value="${a.code}" label="${a.name}">`).join('');
}

function createEntryLineRow() {
  const tr = document.createElement('tr');
  tr.className = 'entry-line-row';
  tr.innerHTML = `
    <td><input type="text" class="form-control code-input" placeholder="Code" list="postingAccountsList" autocomplete="off"></td>
    <td><input type="text" class="form-control name-display" readonly placeholder="Account name"></td>
    <td><input type="number" class="form-control dr-input" placeholder="0.00" min="0" step="0.01"></td>
    <td><input type="number" class="form-control cr-input" placeholder="0.00" min="0" step="0.01"></td>
    <td><input type="text" class="form-control type-display" readonly placeholder="Type of Account"></td>
    <td><button class="btn-remove-line">✕</button></td>
  `;

  // Code input -> auto-fill name
  const codeInput = tr.querySelector('.code-input');
  const nameDisplay = tr.querySelector('.name-display');
  const typeDisplay = tr.querySelector('.type-display');
  codeInput.addEventListener('input', () => {
    const code = codeInput.value.trim();
    const acc = getAccounts().find(a => a.code === code);
    if (acc) {
      if (!acc.is_posting) {
        nameDisplay.value = 'Non-posting account';
        typeDisplay.value = '';
        nameDisplay.style.color = 'var(--red)';
      } else {
        nameDisplay.value = acc.name;
        typeDisplay.value = getTypeLabel(acc.type);
        nameDisplay.style.color = '';
      }
    } else {
      nameDisplay.value = '';
      typeDisplay.value = '';
    }
    updateEntryTotals();
  });

  tr.querySelector('.dr-input').addEventListener('input', updateEntryTotals);
  tr.querySelector('.cr-input').addEventListener('input', updateEntryTotals);
  tr.querySelector('.btn-remove-line').addEventListener('click', () => {
    tr.remove();
    updateEntryTotals();
  });

  return tr;
}

function updateEntryTotals() {
  let totalDr = 0, totalCr = 0;
  document.querySelectorAll('#entryLinesBody .entry-line-row').forEach(row => {
    totalDr += parseFloat(row.querySelector('.dr-input').value) || 0;
    totalCr += parseFloat(row.querySelector('.cr-input').value) || 0;
  });
  document.getElementById('totalDr').textContent = fmtNum(totalDr);
  document.getElementById('totalCr').textContent = fmtNum(totalCr);

  const indicator = document.getElementById('balanceIndicator');
  const diff = Math.abs(totalDr - totalCr);
  if (totalDr > 0 && diff < 0.01) {
    indicator.innerHTML = '<span class="balance-status">Balanced</span>';
    indicator.className = 'balance-indicator balanced';
  } else {
    const diffFmt = fmtNum(Math.abs(totalDr - totalCr));
    indicator.innerHTML = `<span class="balance-status">Difference: ${diffFmt}</span>`;
    indicator.className = 'balance-indicator unbalanced';
  }
}

function showEntryForm() {
  const form = document.getElementById('entryForm');
  form.style.display = 'block';
  document.getElementById('entryDate').value = new Date().toISOString().split('T')[0];
  document.getElementById('entryNo').value = getNextEntryNo();
  document.getElementById('entryDesc').value = '';
  document.getElementById('entryCostCenter').value = '';
  document.getElementById('entryReferenceNo').value = '';

  // Reset lines
  const body = document.getElementById('entryLinesBody');
  body.innerHTML = '';
  body.appendChild(createEntryLineRow());
  body.appendChild(createEntryLineRow());
  updateEntryTotals();
  form.scrollIntoView({ behavior: 'smooth' });
}

function formatDateDisplay(value) {
  if (!value) return '';
  const normalized = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const [year, month, day] = normalized.split('-');
    return `${month}/${day}/${year}`;
  }

  return normalized;
}

function getFilteredJournals() {
  const search = document.getElementById('journalSearch')?.value?.trim().toLowerCase() || '';
  const fromDate = document.getElementById('journalFromDate')?.value;
  const toDate = document.getElementById('journalToDate')?.value;

  return getJournals().filter(entry => {
    const entryDate = String(entry.date || '');
    if (fromDate && entryDate < fromDate) return false;
    if (toDate && entryDate > toDate) return false;

    if (!search) return true;

    const entryFields = [
      entry.no,
      entry.workbook_no,
      entry.date,
      entry.description,
      entry.cost_center,
      entry.reference_no
    ]
      .map(value => String(value || '').toLowerCase());

    const lineFields = (entry.lines || []).some(line =>
      [line.code, line.name, line.type]
        .map(value => String(value || '').toLowerCase())
        .some(value => value.includes(search))
    );

    return entryFields.some(value => value.includes(search)) || lineFields;
  });
}

async function saveEntry() {
  const date = document.getElementById('entryDate').value;
  const no = document.getElementById('entryNo').value;
  const description = document.getElementById('entryDesc').value.trim();
  const costCenter = document.getElementById('entryCostCenter').value.trim();
  const referenceNo = document.getElementById('entryReferenceNo').value.trim();

  if (!date) { showToast('يرجى تحديد تاريخ القيد', 'error'); return; }

  const lines = [];
  let totalDr = 0, totalCr = 0;
  let valid = true;

  document.querySelectorAll('#entryLinesBody .entry-line-row').forEach(row => {
    const code = row.querySelector('.code-input').value.trim();
    const dr = parseFloat(row.querySelector('.dr-input').value) || 0;
    const cr = parseFloat(row.querySelector('.cr-input').value) || 0;
    if (!code && dr === 0 && cr === 0) return; // skip empty

    const acc = getAccounts().find(a => a.code === code);
    if (!acc) { showToast(`الحساب ${code} غير موجود`, 'error'); valid = false; return; }
    if (!acc.is_posting) { showToast(`${acc.name}: ليس حساب ترحيل`, 'error'); valid = false; return; }
    if ((dr === 0 && cr === 0) || (dr > 0 && cr > 0)) { showToast('كل سطر يجب أن يحتوي على مدين أو دائن فقط', 'error'); valid = false; return; }

    lines.push({ code, name: acc.name, dr, cr, type: getTypeLabel(acc.type) });
    totalDr += dr;
    totalCr += cr;
  });

  if (!valid) return;
  if (lines.length < 2) { showToast('القيد غير متزن', 'error'); return; }
  if (Math.abs(totalDr - totalCr) > 0.01) { showToast('القيد غير متوازن', 'error'); return; }

  const entry = {
    no,
    workbook_no: no,
    date,
    description,
    cost_center: costCenter,
    reference_no: referenceNo,
    lines
  };

  if (isClientOnlyMode()) {
    const snapshot = getCurrentSnapshot();
    snapshot.journals = snapshot.journals || [];
    snapshot.journals.push({
      id: `journal-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      ...entry
    });

    persistSnapshotLocally(snapshot);
    document.getElementById('entryForm').style.display = 'none';
    renderJournalList();
    if (currentPage === 'trial') renderTrialBalance();
    if (currentPage === 'income') renderIncomeStatement();
    if (currentPage === 'balance') renderBalanceSheet();
    showToast('Entry saved', 'success');
    return;
  }

  try {
    const snapshot = await apiRequest('/api/journals', {
      method: 'POST',
      body: JSON.stringify(entry)
    });

    applySnapshot(snapshot);
    document.getElementById('entryForm').style.display = 'none';
    renderJournalList();
    if (currentPage === 'trial') renderTrialBalance();
    if (currentPage === 'income') renderIncomeStatement();
    if (currentPage === 'balance') renderBalanceSheet();
    showToast('Entry saved', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function renderJournalList() {
  const body = document.getElementById('journalBody');
  body.innerHTML = '';
  const filtered = getFilteredJournals();

  if (!filtered.length) {
    body.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--text3);padding:40px">No journal entries found</td></tr>';
    return;
  }

  filtered.forEach(entry => {
    entry.lines.forEach((line, idx) => {
      const tr = document.createElement('tr');
      if (idx === 0) tr.className = 'journal-entry-group';
      const journalNo = entry.workbook_no || entry.no || '';
      tr.innerHTML = `
        <td>${formatDateDisplay(entry.date)}</td>
        <td class="code-cell">${line.code}</td>
        <td>${line.name}</td>
        <td class="num debit">${line.dr > 0 ? fmt(line.dr) : '-'}</td>
        <td class="num credit">${line.cr > 0 ? fmt(line.cr) : '-'}</td>
        <td>${journalNo}</td>
        <td>${entry.description || ''}</td>
        <td>${entry.cost_center || ''}</td>
        <td>${line.type || ''}</td>
        <td>${entry.reference_no || ''}</td>
        <td>${idx === 0 ? `<button class="btn-delete" data-no="${entry.no}">🗑</button>` : ''}</td>
      `;
      if (idx === 0) {
        tr.querySelector('.btn-delete').addEventListener('click', () => {
          if (confirm(`Delete journal ${journalNo}?`)) deleteEntry(entry.no);
        });
      }
      body.appendChild(tr);
    });

    const separator = document.createElement('tr');
    separator.className = 'journal-entry-separator';
    separator.innerHTML = '<td colspan="11"></td>';
    body.appendChild(separator);
  });
}

function clearJournalFilters() {
  document.getElementById('journalSearch').value = '';
  document.getElementById('journalFromDate').value = '';
  document.getElementById('journalToDate').value = '';
  renderJournalList();
}

async function deleteEntry(no) {
  if (isClientOnlyMode()) {
    const snapshot = getCurrentSnapshot();
    snapshot.journals = (snapshot.journals || []).filter(entry => String(entry.no) !== String(no) && String(entry.id) !== String(no));
    persistSnapshotLocally(snapshot);
    renderJournalList();
    if (currentPage === 'trial') renderTrialBalance();
    if (currentPage === 'income') renderIncomeStatement();
    if (currentPage === 'balance') renderBalanceSheet();
    showToast('Entry deleted', 'success');
    return;
  }

  try {
    const snapshot = await apiRequest(`/api/journals/${encodeURIComponent(no)}`, { method: 'DELETE' });
    applySnapshot(snapshot);
    renderJournalList();
    if (currentPage === 'trial') renderTrialBalance();
    if (currentPage === 'income') renderIncomeStatement();
    if (currentPage === 'balance') renderBalanceSheet();
    showToast('Entry deleted', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// ========== TRIAL BALANCE ==========

function renderTrialBalance() {
  const level = parseInt(document.getElementById('trialLevel').value) || 9;
  const rows = getTrialBalanceRows(level).filter(row => row.totalDr !== 0 || row.totalCr !== 0);

  const body = document.getElementById('trialBody');
  const foot = document.getElementById('trialFoot');
  body.innerHTML = '';
  foot.innerHTML = '';

  let totOpenDr = 0, totOpenCr = 0, totMovDr = 0, totMovCr = 0, totTotDr = 0, totTotCr = 0, totBalDr = 0, totBalCr = 0;

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--text3);padding:32px">No accounts with values in this view</td></tr>';
    return;
  }

  rows.forEach(row => {
    const {
      code,
      name,
      openDr,
      openCr,
      movDr,
      movCr,
      totalDr,
      totalCr,
      balDr,
      balCr
    } = row;

    totOpenDr += openDr; totOpenCr += openCr;
    totMovDr += movDr; totMovCr += movCr;
    totTotDr += totalDr; totTotCr += totalCr;
    totBalDr += balDr; totBalCr += balCr;

    const tr = document.createElement('tr');
    const openingDrCell = level === 9
      ? `<td class="trial-input-cell"><input type="number" class="form-control trial-opening-input" data-code="${code}" data-side="dr" min="0" step="0.01" placeholder="" value="${openDr ? openDr : ''}"></td>`
      : `<td class="num">${fmt(openDr)}</td>`;
    const openingCrCell = level === 9
      ? `<td class="trial-input-cell"><input type="number" class="form-control trial-opening-input" data-code="${code}" data-side="cr" min="0" step="0.01" placeholder="" value="${openCr ? openCr : ''}"></td>`
      : `<td class="num">${fmt(openCr)}</td>`;

    tr.innerHTML = `
      <td class="code-cell">${code}</td>
      <td>${name}</td>
      ${openingDrCell}
      ${openingCrCell}
      <td class="num">${fmt(movDr)}</td>
      <td class="num">${fmt(movCr)}</td>
      <td class="num">${fmt(totalDr)}</td>
      <td class="num">${fmt(totalCr)}</td>
      <td class="num debit">${fmt(balDr)}</td>
      <td class="num credit">${fmt(balCr)}</td>
    `;
    body.appendChild(tr);
  });

  if (level === 9) {
    body.querySelectorAll('.trial-opening-input').forEach(input => {
      input.addEventListener('change', () => saveOpeningBalanceFromTrial(input.dataset.code, input.dataset.side, input.value));
    });
  }

  foot.innerHTML = `
    <tr>
      <td colspan="2"><strong>Total</strong></td>
      <td class="num"><strong>${fmtNum(totOpenDr)}</strong></td>
      <td class="num"><strong>${fmtNum(totOpenCr)}</strong></td>
      <td class="num"><strong>${fmtNum(totMovDr)}</strong></td>
      <td class="num"><strong>${fmtNum(totMovCr)}</strong></td>
      <td class="num"><strong>${fmtNum(totTotDr)}</strong></td>
      <td class="num"><strong>${fmtNum(totTotCr)}</strong></td>
      <td class="num debit"><strong>${fmtNum(totBalDr)}</strong></td>
      <td class="num credit"><strong>${fmtNum(totBalCr)}</strong></td>
    </tr>
  `;
}

// ========== INCOME STATEMENT ==========

function renderIncomeStatement() {
  const level = parseInt(document.getElementById('incomeLevel').value) || 9;
  const sectionRows = buildIncomeSectionRows(level);
  const container = document.getElementById('incomeStatementContent');
  container.innerHTML = '';

  const revenueRows = [
    ...(sectionRows.revenue || []),
    ...(sectionRows.other_income || [])
  ].sort((left, right) => left.code.localeCompare(right.code));

  const expenseRows = [
    ...(sectionRows.cost_of_goods_sold || []),
    ...(sectionRows.operating_expenses || [])
  ].sort((left, right) => left.code.localeCompare(right.code));

  const renderSimpleSection = (title, rows, className, totalLabel, positive) => {
    const total = rows.reduce((sum, row) => sum + row.amount, 0);
    const sectionDiv = document.createElement('div');
    sectionDiv.className = 'income-section';
    sectionDiv.innerHTML = `<div class="income-section-header ${className}"><span>${title}</span><span>${getLevelName(level)}</span></div>`;

    if (!rows.length) {
      sectionDiv.innerHTML += '<div class="income-line"><div class="income-line-main"><span class="income-name">No balances</span><span class="income-path">This section has no values at the selected view.</span></div><span class="amount">-</span></div>';
    } else {
      rows.forEach(row => {
        sectionDiv.innerHTML += `
          <div class="income-line">
            <div class="income-line-main">
              <span class="income-name">${row.code} - ${row.name}</span>
              <span class="income-path">${row.path}</span>
            </div>
            <span class="amount">${fmtNum(row.amount)}</span>
          </div>
        `;
      });
    }

    sectionDiv.innerHTML += `
      <div class="income-subtotal">
        <span>${totalLabel}</span>
        <span class="amount ${positive ? 'num-positive' : 'num-negative'}">${fmtNum(total)}</span>
      </div>
    `;

    container.appendChild(sectionDiv);
    return total;
  };

  const totalRevenues = renderSimpleSection('Revenues', revenueRows, 'revenue', 'Total Revenues', true);
  const totalExpenses = renderSimpleSection('Expenses', expenseRows, 'opex', 'Total Expenses', false);

  const netIncome = totalRevenues - totalExpenses;
  const netIncomeDiv = document.createElement('div');
  netIncomeDiv.className = 'net-profit';
  netIncomeDiv.innerHTML = `<span>Net Income</span><span class="amount ${netIncome >= 0 ? 'positive' : 'negative'}">${fmtNum(netIncome)}</span>`;
  container.appendChild(netIncomeDiv);
}

// ========== BALANCE SHEET ==========

function renderBalanceSheet() {
  const postingRows = getTrialBalanceRows(9);
  const container = document.getElementById('balanceSheetContent');
  container.innerHTML = '';

  const isDrawingsRow = row => /مسحوبات|مسحوب|سحب|draw/i.test(row.name || '');
  const isContraAssetRow = row => row.code.startsWith('203007');
  const isEquityRow = row => row.code.startsWith('201') && row.code !== '201003001' && !isDrawingsRow(row);
  const isLiabilityRow = row => row.code.startsWith('2') && !isContraAssetRow(row) && !isEquityRow(row);

  const incomeRows = buildIncomeSectionRows(9);
  const totalRevenues = [...(incomeRows.revenue || []), ...(incomeRows.other_income || [])]
    .reduce((sum, row) => sum + row.amount, 0);
  const totalExpenses = [...(incomeRows.cost_of_goods_sold || []), ...(incomeRows.operating_expenses || [])]
    .reduce((sum, row) => sum + row.amount, 0);
  const netIncome = totalRevenues - totalExpenses;

  function groupBalanceRows(rows, groupLevel, amountResolver, groupNameFormatter) {
    const groups = new Map();

    rows.forEach(row => {
      const amount = amountResolver(row);
      if (Math.abs(amount) < 0.01) return;

      const groupCode = getAncestorCodeForLevel(row.code, groupLevel) || row.code;
      const groupAccount = getAccountByCode(groupCode);
      const groupName = groupNameFormatter?.(groupAccount, groupCode) || groupAccount?.name || row.name;

      if (!groups.has(groupCode)) {
        groups.set(groupCode, { code: groupCode, name: groupName, items: [], total: 0 });
      }

      const group = groups.get(groupCode);
      group.items.push({ code: row.code, name: row.name, amount });
      group.total += amount;
    });

    return Array.from(groups.values())
      .map(group => ({
        ...group,
        items: group.items.sort((left, right) => left.code.localeCompare(right.code))
      }))
      .sort((left, right) => left.code.localeCompare(right.code));
  }

  function formatBalanceAmount(amount) {
    const abs = fmtNum(Math.abs(amount));
    return amount < 0 ? `- ${abs}` : abs;
  }

  function appendSection(column, title, items, total) {
    if (!items.length && Math.abs(total) < 0.01) return;

    const section = document.createElement('div');
    section.className = 'balance-section';
    section.innerHTML = `<div class="balance-section-title">${title}</div>`;

    items.forEach(item => {
      const amountClass = item.amount < 0 ? 'num-negative' : '';
      section.innerHTML += `
        <div class="balance-line">
          <span>${item.name}</span>
          <span class="amount ${amountClass}">${formatBalanceAmount(item.amount)}</span>
        </div>
      `;
    });

    const totalClass = total < 0 ? 'num-negative' : '';
    section.innerHTML += `
      <div class="balance-subtotal">
        <span>Total</span>
        <span class="amount ${totalClass}">${formatBalanceAmount(total)}</span>
      </div>
    `;

    column.appendChild(section);
  }

  const assetGroups = groupBalanceRows(
    postingRows.filter(row => row.type === 'asset'),
    3,
    row => row.balDr || 0
  );

  const contraAssetGroups = groupBalanceRows(
    postingRows.filter(isContraAssetRow),
    6,
    row => -(row.balCr || 0),
    (groupAccount, groupCode) => groupAccount?.name || `Contra Assets ${groupCode}`
  );

  const liabilityGroups = groupBalanceRows(
    postingRows.filter(isLiabilityRow),
    6,
    row => row.balCr || 0
  );

  const equityGroups = groupBalanceRows(
    postingRows.filter(isEquityRow),
    6,
    row => (row.balCr || 0) - (row.balDr || 0)
  );

  const drawingsAmount = postingRows
    .filter(isDrawingsRow)
    .reduce((sum, row) => sum + (row.balDr || row.balCr || 0), 0);

  let totalAssets = 0;
  let totalLiabilities = 0;
  let totalEquity = 0;

  const assetsCol = document.createElement('div');
  assetsCol.className = 'balance-col';
  assetsCol.innerHTML = `<div class="balance-col-header assets">Assets</div>`;

  assetGroups.forEach(group => {
    if (Math.abs(group.total) < 0.01) return;
    totalAssets += group.total;
    appendSection(assetsCol, group.name, group.items, group.total);
  });

  contraAssetGroups.forEach(group => {
    if (Math.abs(group.total) < 0.01) return;
    totalAssets += group.total;
    appendSection(assetsCol, `${group.name} (Deduction)`, group.items, group.total);
  });

  assetsCol.innerHTML += `<div class="balance-total"><span>Total Assets</span><span class="amount">${formatBalanceAmount(totalAssets)}</span></div>`;

  const liabCol = document.createElement('div');
  liabCol.className = 'balance-col';
  liabCol.innerHTML = `<div class="balance-col-header liabilities">Liabilities / Equity</div>`;

  liabilityGroups.forEach(group => {
    if (Math.abs(group.total) < 0.01) return;
    totalLiabilities += group.total;
    appendSection(liabCol, group.name, group.items, group.total);
  });

  const equityItems = [];
  equityGroups.forEach(group => {
    if (Math.abs(group.total) < 0.01) return;
    totalEquity += group.total;
    equityItems.push({ name: group.name, amount: group.total });
  });

  if (Math.abs(netIncome) >= 0.01) {
    equityItems.push({ name: 'Net Income', amount: netIncome });
    totalEquity += netIncome;
  }

  if (Math.abs(drawingsAmount) >= 0.01) {
    equityItems.push({ name: 'Drawings', amount: -drawingsAmount });
    totalEquity -= drawingsAmount;
  }

  const balancingEquity = totalAssets - (totalLiabilities + totalEquity);
  if (Math.abs(balancingEquity) >= 0.01) {
    equityItems.push({ name: 'Opening Equity Balance', amount: balancingEquity });
    totalEquity += balancingEquity;
  }

  appendSection(
    liabCol,
    'Equity',
    equityItems.map((item, index) => ({ code: `equity-${index}`, ...item })),
    totalEquity
  );

  liabCol.innerHTML += `<div class="balance-total"><span>Total Liabilities / Equity</span><span class="amount">${formatBalanceAmount(totalLiabilities + totalEquity)}</span></div>`;

  container.appendChild(assetsCol);
  container.appendChild(liabCol);
}

// ========== INIT ==========

document.addEventListener('DOMContentLoaded', async () => {
  clearLegacyLocalSnapshots();

  try {
    await refreshState();
  } catch (error) {
    showToast(error.message, 'error');
  }

  // Navigation
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => navigate(item.dataset.page));
  });

  // Accounts tree
  renderAccountsTree();
  document.getElementById('accountSearch').addEventListener('input', (e) => renderAccountsTree(e.target.value));

  document.getElementById('confirmAddAccount')?.addEventListener('click', confirmAddAccount);
  document.getElementById('cancelAddAccount')?.addEventListener('click', closeAddAccountModal);
  document.getElementById('addAccountModal')?.addEventListener('click', (event) => {
    if (event.target?.id === 'addAccountModal') closeAddAccountModal();
  });

  // Opening balance modal
  document.getElementById('confirmOpeningBalance')?.addEventListener('click', confirmOpeningBalance);
  document.getElementById('cancelOpeningBalance')?.addEventListener('click', () => {
    document.getElementById('openingBalanceModal').style.display = 'none';
  });

  // Journal
  document.getElementById('newEntryBtn').addEventListener('click', showEntryForm);
  document.getElementById('addLineBtn').addEventListener('click', () => {
    document.getElementById('entryLinesBody').appendChild(createEntryLineRow());
  });
  document.getElementById('saveEntryBtn').addEventListener('click', saveEntry);
  document.getElementById('cancelEntryBtn').addEventListener('click', () => {
    document.getElementById('entryForm').style.display = 'none';
  });
  document.getElementById('searchJournalBtn').addEventListener('click', renderJournalList);
  document.getElementById('clearJournalFilterBtn').addEventListener('click', clearJournalFilters);
  document.getElementById('journalSearch').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') renderJournalList();
  });
  document.getElementById('journalFromDate').addEventListener('change', renderJournalList);
  document.getElementById('journalToDate').addEventListener('change', renderJournalList);

  // Trial balance
  document.getElementById('trialLevel').addEventListener('change', renderTrialBalance);
  document.getElementById('incomeLevel').addEventListener('change', renderIncomeStatement);

  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.style.display = 'none';
    });
  });

  renderJournalList();
  const savedPage = loadSavedPage();
  if (savedPage && document.getElementById(`page-${savedPage}`)) {
    navigate(savedPage);
  }
});
