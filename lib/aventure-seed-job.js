'use strict';

/**
 * Retire les jobs de test Aventure COMMENT / migax de la file OPS.
 */
const fs = require('fs');
const path = require('path');

function dropCommentSeedJobs() {
  const { QUEUE_DIR } = require('./queue');
  if (!QUEUE_DIR || !fs.existsSync(QUEUE_DIR)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(QUEUE_DIR)) {
    if (!f.endsWith('.json') || f === 'processed-orders.json') continue;
    if (!/AVENTURE-SEED-COMMENT-MIGAX/i.test(f)) continue;
    fs.unlinkSync(path.join(QUEUE_DIR, f));
    n += 1;
  }
  return n;
}

module.exports = { dropCommentSeedJobs };
