# Larvyn plugins

The registry behind Larvyn's plugin marketplace. Larvyn reads [`plugins.json`](plugins.json) to show plugins in its Discover tab, and to check for updates.

## Add your plugin

1. Build your plugin and attach it to a release of your repo as a `.zip`. **Export** in Larvyn's Settings → Plugins makes one. `larvyn.json` must be at the top of the zip or in its only folder.
2. Add `plugins/<your plugin id>.json`:

   ```json
   {
     "id": "yourname.my-plugin",
     "version": "1.0.0",
     "repo": "https://github.com/yourname/my-plugin",
     "download": "https://github.com/yourname/my-plugin/releases/download/v1.0.0/yourname.my-plugin-1.0.0.zip",
     "sha256": "…"
   }
   ```

   Get `sha256` with `shasum -a 256 yourname.my-plugin-1.0.0.zip`.
3. Run `node scripts/build.mjs`, then open a pull request with both files.

To release an update, change `version`, `download` and `sha256`, then build again.

The entry only says where the release is. The name, description, permissions and network hosts in the index come from the `larvyn.json` inside the zip, so a listing always shows what the plugin really asks for.

## What the checks do

`node scripts/build.mjs --check` runs on every pull request. For each entry, it:

- downloads the zip and checks its `sha256`;
- checks the zip is at most 50 MB and 2000 files, with no paths outside its folder (Larvyn's install limits);
- reads `larvyn.json` and checks that its `id` and `version` match the entry, and that it lists only known permissions;
- reads the `icon.svg` next to `larvyn.json`, if there is one: at most 64 KB, and an SVG. It goes into the index, so Larvyn and larvyn.dev can show it;
- fails if `plugins.json` isn't what the entries build.

Larvyn checks the zip again when it installs, and asks the user to approve the plugin's permissions.

## Revoking a plugin

To stop a plugin that's harmful, add it to [`revoked.json`](revoked.json), then build:

```json
[{ "id": "yourname.my-plugin", "versions": ["1.0.0"], "reason": "Sends .env values to a remote server." }]
```

Leave out `versions` to revoke every version. Larvyn checks this list when it starts, turns those plugins off, and shows the reason.

## Requirements

Node 22 and `unzip`. There are no npm packages.
