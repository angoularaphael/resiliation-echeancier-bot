/**
 * Dépendances système Chromium sur hébergement sans root (Pterodactyl / BotHosting).
 * Télécharge les .deb et les extrait localement → LD_LIBRARY_PATH.
 *
 * Par défaut : JAMAIS `playwright install-deps` (très lent / bloque sans root).
 * Activer explicitement : PLAYWRIGHT_INSTALL_DEPS=true
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/** Nom classique + variante t64 (Ubuntu 24.04+) */
const DEB_PACKAGES = [
  ['libatk1.0-0', 'libatk1.0-0t64'],
  ['libatk-bridge2.0-0', 'libatk-bridge2.0-0t64'],
  ['libatspi2.0-0', 'libatspi2.0-0t64'],
  ['libcups2', 'libcups2t64'],
  ['libdrm2'],
  ['libxkbcommon0'],
  ['libxcomposite1'],
  ['libxdamage1'],
  ['libxfixes3'],
  ['libxrandr2'],
  ['libgbm1'],
  ['libpango-1.0-0'],
  ['libcairo2'],
  ['libasound2', 'libasound2t64'],
  ['libnss3'],
  ['libnspr4'],
  ['libdbus-1-3'],
  ['libgtk-3-0', 'libgtk-3-0t64'],
  ['libglib2.0-0', 'libglib2.0-0t64'],
  ['libx11-6'],
  ['libxcb1'],
  ['libxext6'],
  ['libxi6'],
  ['libexpat1'],
  ['libfontconfig1'],
  ['libfreetype6'],
  ['libpixman-1-0'],
  ['libxrender1'],
  ['libgcc-s1'],
  ['libstdc++6'],
];

function libDirs(baseDir) {
  const candidates = [
    path.join(baseDir, 'usr', 'lib', 'x86_64-linux-gnu'),
    path.join(baseDir, 'usr', 'lib'),
    path.join(baseDir, 'lib', 'x86_64-linux-gnu'),
    path.join(baseDir, 'lib'),
  ];
  return candidates.filter((dir) => fs.existsSync(dir));
}

function hasAtkLib(baseDir) {
  for (const dir of libDirs(baseDir)) {
    try {
      if (fs.readdirSync(dir).some((name) => /^libatk-1\.0\.so/.test(name))) {
        return true;
      }
    } catch {
      /* ignore */
    }
  }
  return false;
}

function applyLibraryPath(baseDir) {
  const paths = libDirs(baseDir);
  if (!paths.length) return false;
  const merged = [...new Set([...paths, process.env.LD_LIBRARY_PATH].filter(Boolean))].join(':');
  process.env.LD_LIBRARY_PATH = merged;
  return true;
}

function runQuiet(cmd, cwd) {
  execSync(cmd, { stdio: 'pipe', cwd, shell: true, env: process.env });
}

function tryPlaywrightInstallDeps(cwd) {
  try {
    execSync('npx playwright install-deps chromium-headless-shell', {
      stdio: 'inherit',
      cwd,
      shell: true,
      env: process.env,
    });
    return true;
  } catch {
    try {
      execSync('npx playwright install-deps chromium', {
        stdio: 'inherit',
        cwd,
        shell: true,
        env: process.env,
      });
      return true;
    } catch {
      return false;
    }
  }
}

function wantInstallDeps() {
  return String(process.env.PLAYWRIGHT_INSTALL_DEPS || '').toLowerCase() === 'true';
}

function wantForceRetry() {
  return String(process.env.FORCE_PLAYWRIGHT_DEPS || '').toLowerCase() === 'true';
}

function markerPath(depsRoot) {
  return path.join(depsRoot, '.deps-skip');
}

function downloadOnePackage(pkg, cwd) {
  try {
    runQuiet(`apt-get download -qq ${pkg}`, cwd);
    return true;
  } catch {
    return false;
  }
}

function downloadDebPackages(depsRoot, log) {
  let ok = 0;
  for (const names of DEB_PACKAGES) {
    let got = false;
    for (const name of names) {
      if (downloadOnePackage(name, depsRoot)) {
        got = true;
        ok += 1;
        break;
      }
    }
    if (!got) {
      log(`  skip ${names[0]} (pas de candidat apt)`);
    }
  }
  try {
    runQuiet('for f in *.deb; do [ -f "$f" ] && dpkg-deb -x "$f" .; done', depsRoot);
  } catch (err) {
    log(`Extraction .deb partielle: ${err.message || err}`);
  }
  return ok;
}

function installChromiumSystemDeps({ baseDir, botDir, log = console.log } = {}) {
  if (process.platform !== 'linux') {
    return { ok: true, method: 'skip-non-linux' };
  }

  const depsRoot = baseDir || path.join(process.cwd(), 'data', 'system-libs');
  fs.mkdirSync(depsRoot, { recursive: true });
  const skipFile = markerPath(depsRoot);

  if (hasAtkLib(depsRoot)) {
    applyLibraryPath(depsRoot);
    try {
      if (fs.existsSync(skipFile)) fs.unlinkSync(skipFile);
    } catch {
      /* ignore */
    }
    log(`Deps Chromium OK (${depsRoot})`);
    return { ok: true, method: 'cached', path: depsRoot };
  }

  // Évite de reperdre du temps à chaque redémarrage si apt a déjà échoué
  if (fs.existsSync(skipFile) && !wantForceRetry()) {
    applyLibraryPath(depsRoot);
    log(
      'Deps Chromium: skip (échec précédent). ' +
        'FORCE_PLAYWRIGHT_DEPS=true pour retenter, PLAYWRIGHT_INSTALL_DEPS=true pour install-deps.'
    );
    return { ok: false, method: 'skipped-cached-failure', path: depsRoot };
  }

  log('Installation deps Chromium (apt-get download unitaire, sans root)…');
  try {
    runQuiet('apt-get update -qq 2>/dev/null || true', depsRoot);
  } catch {
    /* ignore */
  }

  const downloaded = downloadDebPackages(depsRoot, log);
  log(`Paquets téléchargés: ${downloaded}/${DEB_PACKAGES.length}`);

  if (hasAtkLib(depsRoot)) {
    applyLibraryPath(depsRoot);
    try {
      if (fs.existsSync(skipFile)) fs.unlinkSync(skipFile);
    } catch {
      /* ignore */
    }
    log('Deps extraites → LD_LIBRARY_PATH configuré');
    return { ok: true, method: 'deb-extract', path: depsRoot };
  }

  if (wantInstallDeps() && botDir) {
    log('Tentative playwright install-deps (PLAYWRIGHT_INSTALL_DEPS=true)…');
    if (tryPlaywrightInstallDeps(botDir)) {
      return { ok: true, method: 'playwright-install-deps' };
    }
  } else {
    log('install-deps ignoré (évite blocage BotHosting). PLAYWRIGHT_INSTALL_DEPS=true pour forcer.');
  }

  try {
    fs.writeFileSync(
      skipFile,
      `failed ${new Date().toISOString()}\nset FORCE_PLAYWRIGHT_DEPS=true to retry\n`,
      'utf8'
    );
  } catch {
    /* ignore */
  }

  log('ATTENTION: libatk manquante — Chromium peut échouer sur cet hébergeur');
  return { ok: false, path: depsRoot };
}

module.exports = {
  DEB_PACKAGES,
  installChromiumSystemDeps,
  applyLibraryPath,
  hasAtkLib,
};
