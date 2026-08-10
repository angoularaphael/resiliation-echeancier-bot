/**
 * Détection et résiliation des ventes test Deciplus (BOXPLUS).
 */
const fs = require('fs');
const path = require('path');
const { randomDelay } = require('../lib/utils');
const { logInfo } = require('../lib/logger');
const { QUEUE_DIR } = require('../lib/queue');
const { getAccessToken } = require('./auth');
const { openMemberCheck } = require('./wallet');
const { searchMember } = require('./member');
const {
  memberHasActiveContracts,
  cancelAllMemberSales,
  cancelNextMemberSale,
} = require('./cancel-sale');

const API_BASE = 'https://api.deciplus.pro/staff/v1';

const TEST_ORDER_PREFIXES = /^(LOCAL-BADGE|TEST-BADGE|STORE-|DEMO-)/i;

/** Noms / emails évidents de tests manuels (clavier, demo, etc.) */
function isKeyboardTestName(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v || v.length > 40) return false;
  return /^(azert(y|ty)?\d*|qwert(y|y)?\d*|test\d*|badg(e?\d*)|box\d*|josko\d*|demo\d*)$/i.test(v);
}

function isObviousTestEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return false;
  if (e.endsWith('@boxplus-test.local')) return true;
  if (e === 'test@teste.com') return true;
  if (/^test[-+]?/i.test(e) && /@(example|teste?|boxplus)/i.test(e)) return true;
  if (/azert/i.test(e) && /@(azerty|azert2y|example|test)/i.test(e)) return true;
  if (/^badge[-+]/i.test(e)) return true;
  return false;
}

function isAzertyLikeMember(nom, prenom) {
  const n = String(nom || '').trim();
  const p = String(prenom || '').trim();
  if (isKeyboardTestName(n) || isKeyboardTestName(p)) return true;
  if (n && p && n.toLowerCase() === p.toLowerCase() && /^(azert|test|badge|box|josko)/i.test(n)) {
    return true;
  }
  return false;
}

function matchesTestMemberRecord(member, { strict = false } = {}) {
  if (!member || typeof member !== 'object') return false;

  const email = String(member.email || member.mail || member.jemail || '').toLowerCase();
  const nom = String(member.nom || member.lastName || member.last_name || '').trim();
  const prenom = String(member.prenom || member.firstName || member.first_name || '').trim();
  const info = String(member.info_compta || member.infoCompta || '').toLowerCase();
  const admin = String(member.info_admin || member.infoAdmin || '').toLowerCase();
  const blob = `${info} ${admin}`;

  if (isObviousTestEmail(email)) return true;
  if (isAzertyLikeMember(nom, prenom)) return true;
  if (/^badge/i.test(nom) && /^test$/i.test(prenom)) return true;
  if (/^box/i.test(nom) && /^test$/i.test(prenom)) return true;

  if (strict) return false;

  if (/test automatique/i.test(member.adr1 || member.address || '')) return true;
  if (/commande:\s*(local-badge|test-badge|store-|demo-)/i.test(blob)) return true;
  if (/source:\s*boxplus/i.test(blob)) return true;
  if (/azert/i.test(email)) return true;

  return false;
}

function loadProcessedOrders() {
  const file = path.join(QUEUE_DIR, 'processed-orders.json');
  if (!fs.existsSync(file)) return { orders: {} };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function collectMemberIdsFromProcessed() {
  const data = loadProcessedOrders();
  const ids = new Set();
  for (const [orderId, record] of Object.entries(data.orders || {})) {
    if (record?.deciplus_member_id) ids.add(String(record.deciplus_member_id));
    if (TEST_ORDER_PREFIXES.test(orderId) && record?.deciplus_member_id) {
      ids.add(String(record.deciplus_member_id));
    }
  }
  return [...ids];
}

function collectMemberIdsFromFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => /^\d+$/.test(line));
}

function parseIdRange(rangeStr) {
  if (!rangeStr) return [];
  const m = String(rangeStr).match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return [];
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const ids = [];
  for (let id = start; id <= end; id += 1) ids.push(String(id));
  return ids;
}

async function fetchMemberApi(page, memberId, token) {
  const response = await page.context().request.get(`${API_BASE}/member/${memberId}`, {
    headers: {
      Accept: 'application/json',
      'x-access-token': token,
      'Deciplus-Client-Type': 'manager',
    },
  });
  if (!response.ok()) return null;
  const json = await response.json().catch(() => null);
  return json?.response || json || null;
}

async function discoverTestMembersInRange(page, token, rangeStr) {
  const ids = parseIdRange(rangeStr);
  const found = [];
  for (const memberId of ids) {
    const member = await fetchMemberApi(page, memberId, token);
    if (member && matchesTestMemberRecord(member, { strict: true })) {
      found.push({
        member_id: memberId,
        email: member.email || member.mail || null,
        nom: member.nom || member.lastName || null,
        prenom: member.prenom || member.firstName || null,
        source: 'scan-range',
      });
    }
  }
  return found;
}

async function discoverTestMembersBySearch(page) {
  const queries = [
    '@boxplus-test.local',
    'boxplus-test.local',
    'test@teste.com',
    'azerty@azerty.com',
    'azerty',
    'AZERTY',
  ];
  const found = [];
  const seen = new Set();

  for (const query of queries) {
    const result = await searchMember(page, query);
    if (result.found && result.member_id && !seen.has(result.member_id)) {
      seen.add(result.member_id);
      found.push({
        member_id: result.member_id,
        email: query.includes('@') ? query : null,
        source: 'search',
      });
    }
  }

  return found;
}

async function readMemberCheckSummary(page, memberId) {
  await openMemberCheck(page, memberId);
  await randomDelay(600, 900);
  const text = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  const hasConsulter = await memberHasActiveContracts(page);
  return {
    text: text.slice(0, 500),
    hasConsulter,
  };
}

async function cancelAllMemberSalesForTest(page, memberId, options) {
  return cancelAllMemberSales(page, memberId, options);
}

async function buildCleanupPlan(page, options = {}) {
  const {
    extraIds = [],
    scanRange = process.env.CLEANUP_SCAN_ID_RANGE || '',
    includeProcessed = true,
    includeSearch = true,
  } = options;

  const token = await getAccessToken(page);
  const byId = new Map();

  function addMember(entry) {
    if (!entry?.member_id) return;
    const id = String(entry.member_id);
    if (!/^\d+$/.test(id)) return;
    byId.set(id, { ...byId.get(id), ...entry, member_id: id });
  }

  if (includeProcessed) {
    for (const id of collectMemberIdsFromProcessed()) {
      addMember({ member_id: id, source: 'processed-orders' });
    }
  }

  for (const id of extraIds) {
    addMember({ member_id: id, source: 'manual-list' });
  }

  if (scanRange && token) {
    const scanned = await discoverTestMembersInRange(page, token, scanRange);
    for (const entry of scanned) addMember(entry);
  }

  if (includeSearch) {
    const searched = await discoverTestMembersBySearch(page);
    for (const entry of searched) addMember(entry);
  }

  if (token) {
    for (const id of [...byId.keys()]) {
      const member = await fetchMemberApi(page, id, token);
      if (member) {
        const fromProcessed = (byId.get(id)?.source || '').includes('processed');
        const fromManual = (byId.get(id)?.source || '').includes('manual');
        addMember({
          member_id: id,
          email: member.email || member.mail || byId.get(id)?.email || null,
          nom: member.nom || member.lastName || null,
          prenom: member.prenom || member.firstName || null,
          is_test: fromProcessed || fromManual || matchesTestMemberRecord(member),
        });
      }
    }
  }

  const plan = [];
  for (const entry of byId.values()) {
    const summary = await readMemberCheckSummary(page, entry.member_id);
    plan.push({
      ...entry,
      is_test: entry.is_test !== false,
      check_preview: summary.text,
      has_consulter: summary.hasConsulter,
    });
  }

  plan.sort((a, b) => Number(a.member_id) - Number(b.member_id));
  return plan;
}

async function runTestCleanup(page, options = {}) {
  const { execute = false, onlyTest = true } = options;
  const plan = await buildCleanupPlan(page, options);
  const targets = onlyTest ? plan.filter((p) => p.is_test !== false) : plan;

  const results = [];
  for (const member of targets) {
    if (!execute) {
      results.push({ ...member, action: 'dry-run', cancelled_count: null });
      continue;
    }

    if (!member.has_consulter) {
      results.push({ ...member, action: 'skipped', cancelled_count: 0, reason: 'no_active_sale' });
      continue;
    }

    const outcome = await cancelAllMemberSalesForTest(page, member.member_id);
    results.push({ ...member, action: 'cancelled', ...outcome });
  }

  return { execute, total: targets.length, results };
}

module.exports = {
  matchesTestMemberRecord,
  isAzertyLikeMember,
  isObviousTestEmail,
  collectMemberIdsFromProcessed,
  collectMemberIdsFromFile,
  parseIdRange,
  buildCleanupPlan,
  cancelAllMemberSales: cancelAllMemberSalesForTest,
  cancelNextMemberSale,
  runTestCleanup,
};
