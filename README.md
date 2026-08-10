# Échéancier / résiliation bot

BotHosting : `prem-eu2.bot-hosting.net:21268`

Gère :
- résiliations boutique (`action: cancel`)
- vérif identité / changements d’abo
- scan Manager → Échéancier → Impayés (2 impayés consécutifs mois en cours → résil comptant / sans engagement)

Ventes / inscriptions restent sur `boxi-deci-bot` (`BOXPLUS_BOT_URL`).

## Déploiement

1. Copier `env.bothosting.example` → `.env` sur BotHosting (jamais committer `.env` / `env.bothosting`)
2. Remplir `DECIPLUS_*`, `DECIPLUS_IMAP_*`, `SYNC_SECRET`
3. `BOT_REPO_URL=https://github.com/angoularaphael/resiliation-echeancier-bot.git`
4. Démarrer `node bootstrap.js`
5. Vercel : `BOXPLUS_BOT_URL_OPS=http://prem-eu2.bot-hosting.net:21268`

Scan manuel : `POST /api/echeancier/scan` avec header `x-sync-secret`.

`ECHEANCIER_DRY_RUN=1` pour lister sans résilier.
