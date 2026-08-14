'use strict';

const fs = require('fs');
const path = require('path');
const { ROOT, ensureDir } = require('./utils');

function statePath() {
  const dir =
    process.env.BOXPLUS_DATA_DIR ||
    process.env.BOT_DATA_DIR ||
    path.join(ROOT, 'data');
  ensureDir(dir);
  return path.join(dir, 'echeancier-state.json');
}

function loadState() {
  const file = statePath();
  try {
    if (!fs.existsSync(file)) return { members: {}, last_scan_at: null };
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      members: raw.members && typeof raw.members === 'object' ? raw.members : {},
      last_scan_at: raw.last_scan_at || null,
    };
  } catch {
    return { members: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(
    statePath(),
    JSON.stringify(
      { members: state.members || {}, last_scan_at: state.last_scan_at || null },
      null,
      2
    ),
    'utf8'
  );
}

function getMember(state, memberId) {
  const id = String(memberId || '');
  if (!state.members[id]) state.members[id] = {};
  return state.members[id];
}

function touchMember(state, memberId, patch) {
  const row = getMember(state, memberId);
  Object.assign(row, patch, { updated_at: new Date().toISOString() });
  return row;
}

module.exports = {
  statePath,
  loadState,
  saveState,
  getMember,
  touchMember,
};
