# softctl — MeshCentral plugin

Catalogue logiciels du Lycée + déploiement silencieux sur les postes.

## Phases

- **Phase 1** *(actuelle)* : lecture du catalogue depuis le partage NAS monté localement, UI de sélection logiciels + postes, dry-run.
- **Phase 2** *(à venir)* : ajout / upload d'un nouveau logiciel depuis l'UI.
- **Phase 3** *(à venir)* : exécution réelle — l'agent MeshCentral télécharge le `.exe` depuis MC via HTTPS et l'installe avec ses `silentArgs`.

## Prérequis serveur MeshCentral

NAS monté en NFS (ou CIFS) :

```bash
sudo apt install -y nfs-common
sudo mkdir -p /mnt/software
sudo bash -c 'echo "NAS_IP:/volume3/SAUV-03-GVS /mnt/software nfs defaults,nofail 0 0" >> /etc/fstab'
sudo systemctl daemon-reload
sudo mount -a
ls /mnt/software/LOGICIELS
```

## Format du catalogue

Un sous-dossier par logiciel dans `softwareDir`, chacun contenant :

```
/mnt/software/LOGICIELS/
  ├── firefox/
  │     ├── metadata.json
  │     └── firefox-setup.exe
  ├── 7zip/
  │     ├── metadata.json
  │     └── 7z2301-x64.msi
```

`metadata.json` minimal :
```json
{
  "name": "Firefox",
  "version": "120.0",
  "vendor": "Mozilla",
  "silentArgs": "/S",
  "installer": "firefox-setup.exe"
}
```

Le champ `installer` est optionnel : si absent, le plugin prend le premier `.exe`/`.msi` du dossier.

## Installation du plugin

1. Crée le repo GitHub `V3locidad/softctl-meshcentral`, push ce dossier.
2. Plugins MeshCentral → Add Plugin → URL :
   `https://raw.githubusercontent.com/V3locidad/softctl-meshcentral/main/config.json`
3. Sur le serveur :
   ```bash
   cd /home/maintenance/meshcentral-data/plugins/softctl
   cp softctl-config.json.example softctl-config.json
   # édite softwareDir si besoin
   ```
4. Recharge depuis MeshCentral.

## Actions HTTP

- `?action=ping` — smoke test du catalogue.
- `?action=catalog` — liste des logiciels (`softwares`) + dossiers ignorés.
- `?action=agents` — liste des agents MeshCentral.
- `?action=dryRun` (POST) — `{ softIds: [...], nodeIds: [...] }` → preview du plan, n'envoie rien.
