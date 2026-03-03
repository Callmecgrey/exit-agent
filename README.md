# NoxGuard Exit Agent

This folder contains the minimal exit-agent + systemd unit used to run WireGuard exits.

## Files
- `agent.mjs` — Node reconcile loop: fetch desired-state, render wg0.conf, apply wg-quick/up or syncconf, report status
- `noxguard-exit-agent.service` — systemd service
- `env.example` — env file template
- `install.sh` — installs into /opt + /etc + enables systemd

## Install (on exit host)
1) Ensure deps exist:
- node >= 18 (recommended 20)
- wireguard-tools (wg, wg-quick)
- perl (shasum)
- curl, jq optional

2) Copy folder onto host (git clone, scp, or curl raw files)

3) Install:
```bash
sudo bash ./install.sh
sudo nano /etc/noxguard-exit-agent.env
sudo systemctl start noxguard-exit-agent
sudo journalctl -u noxguard-exit-agent -f
