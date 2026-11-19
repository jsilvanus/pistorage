# systemd user unit

`pistorage.service` runs pistorage as a systemd user service.

Expected layout (relative to the service user's home, `%h`):

- app checkout (built, with `dist/`): `~/apps/pistorage`
- environment file: `~/apps/pistorage.env` (all settings and secrets live here, never in git)
- Node.js: `~/.local/bin/node`

Install:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/pistorage.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pistorage
loginctl enable-linger "$USER"   # once, so it runs without a login session
```

Status and logs: `systemctl --user status pistorage`, `journalctl --user -u pistorage -f`.
