# Magpie Usage for Cindy

See Magpie gateway account quotas, the actual route used by the current task, and reset times in Cindy's status bar and usage card.

[中文](README.md)

## Features

- **Status bar pill**: follows the current task and shows the actual provider, account, and quota window. For group/task-auto it shows auto→ and reads Magpie's routing log instead of guessing from the provider's last-used account.
- **Usage card**: used/remaining quota, reset countdowns, email masking, and gateway source for every account; the latest routing chain is shown at the top.
- **Latest-route badge**: highlights the account used by the latest request, separately from "last used".
- **Multi-account / multi-window**: shows a usage range when a provider has several accounts and the session account is unknown; names the specific exhausted window (for example Credits full) instead of saying the whole account is exhausted.
- **Agent tool**: magpie_usage returns account quotas, balances, and latestRoute; supports provider filtering.
- **Multiple gateways**: reads local and configured remote Magpie gateways.

## Requirements

- Magpie running on macOS; the default gateway is http://127.0.0.1:3425.
- Cindy 0.1.137+.
- Actual per-session routing needs Magpie's routing log at ~/.config/magpie/routing/ (enabled by default). When the log is missing, the session runs remotely, or the engine does not report the same session ID, the plugin falls back to the provider's last-used account.

## Install

Search for **Magpie Usage** in Cindy's plugin market. Market updates use Cindy's normal plugin update flow.

For local development, keep the source in a separate author directory and use Cindy's plugin Forge to pack and install it. Do not edit an installed plugin directory directly.

## Development

Plain JavaScript, no build step:

- main.js: Cindy brain entry, status bar pill, and MCP tool handling.
- node/worker.cjs: Node worker; reads Magpie /v1/magpie/quotas, /v1/models, and ~/.config/magpie/routing/*.jsonl, and reads sdk_session_id from Cindy's sessions table.
- ui/detail.html: usage card.
- ghost.json: plugin manifest.

Syntax checks:

    node --check main.js
    node --check node/worker.cjs

Manual checks: open the status bar pill and usage card in Cindy for a direct model, group/task-auto, an exhausted account, and a multi-account provider.

## Contributing

Issues and PRs are welcome. Open an issue first when the change is more than a small fix. Keep PRs focused, update ghost.json version and releaseNotes, and include how you verified the change. Never commit tokens, gateways.json, or logs containing credentials.

## License

MIT
