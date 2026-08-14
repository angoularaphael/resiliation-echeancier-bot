# Échéancier / résiliation bot

BotHosting : `prem-eu2.bot-hosting.net:21268`  
**Node.js 24** (panel BotHosting + `engines` du `package.json`).

Gère :
- résiliations boutique (`action: cancel`)
- vérif identité / changements d’abo
- encaissement CB Deciplus après paiement d’une relance (`action: encaisser`)
- scan Manager → Échéancier → Impayés :
  - **un seul mail** de relance (vouvoiement + bouton de paiement)
  - chaque jour à **17h** : une tentative ; à la **10e** si toujours impayé → résiliation
  - Portet : paiement PayPal ; autres salles : PayPlug + PayPal
  - au démarrage : scan sans renvoyer de mail (sauf s’il est déjà 17h)

Ventes / inscriptions restent sur `boxi-deci-bot` (`BOXPLUS_BOT_URL`).

## Déploiement

1. Copier `env.bothosting.example` → `.env` sur BotHosting (jamais committer `.env` / `env.bothosting`)
2. Remplir `DECIPLUS_*`, `DECIPLUS_IMAP_*`, `SYNC_SECRET` (identique à Vercel)
3. `BOT_REPO_URL=https://github.com/angoularaphael/resiliation-echeancier-bot.git`
4. Docker / panel : **Node 24**
5. Démarrer `node bootstrap.js`
6. Vercel : `BOXPLUS_BOT_URL_OPS=http://prem-eu2.bot-hosting.net:21268`

Scan manuel : `POST /api/echeancier/scan` avec header `x-sync-secret`.

`ECHEANCIER_DRY_RUN=1` pour lister sans résilier.

Test local :

```
node --test test/*.test.js
```
