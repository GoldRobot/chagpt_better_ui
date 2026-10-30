# ChatGPT Better UI

A standalone Tampermonkey userscript for ChatGPT, including Work mode.

Current version: **1.1.10**.

## Features

- **Enter** inserts a newline; **Ctrl+Enter** or **Cmd+Enter** sends.
- **Shift+Enter** keeps its normal newline behavior.
- Compact session and weekly allowance gauges next to Work-style composers.
- Each gauge fills across its entire frame according to the percentage remaining.
- Reset countdowns appear in the headings, such as `Session · 2h 20m`.
- The whole gauge opens the usage dashboard when clicked.
- Usage refreshes automatically every minute while the tab is visible, and when returning to the tab.
- An opaque, theme-aware background keeps text behind the gauges from showing through.

## Installation

1. Install Tampermonkey in Firefox if it is not already installed.
2. Open [`chatgpt-better-ui.user.js`](./chatgpt-better-ui.user.js) and copy the complete file contents.
3. In Tampermonkey, choose **Create a new script**.
4. Replace the template with the copied code and save.
5. Disable other Enter-key extensions or older copies of this script, then reload ChatGPT.

No build process, npm installation, or unsigned Firefox add-on settings are needed.
Tampermonkey retains the script across browser restarts.

## Automatic updates

The userscript's `@updateURL` and `@downloadURL` point to the script on this
repository's `master` branch. Tampermonkey can check its `@version` and download
newer versions according to the script manager's update settings.

Install or reinstall version **1.1.10** once to use the GitHub-domain Raw URLs.
Future releases must increase `@version` for update checks to find them.

This repository is private. Tampermonkey must be able to authenticate when reading
the GitHub raw URLs; the GitHub connection used to maintain this repository does
not authenticate Tampermonkey. If those URLs are inaccessible to the script
manager, automatic installation and updates will fail. Manual copying from GitHub
remains available. No access tokens are included in the update URLs.

For a direct installation, sign into GitHub in Firefox, then open the
[Raw install/update link](https://github.com/GoldRobot/chagpt_better_ui/raw/refs/heads/master/chatgpt-better-ui.user.js).
Tampermonkey may offer to install or update the script. This GitHub-domain URL
allows GitHub to authenticate the request before redirecting to the file, rather
than starting with an unauthenticated `raw.githubusercontent.com` URL. Background
update access still needs testing with your browser's cookie/container setup.
If installation is unavailable, use the copy-and-paste steps above.

## Usage data

The gauges read ChatGPT's existing `/backend-api/wham/usage` endpoint. They use the
primary and secondary usage windows reported by the service, rather than counting
messages or estimating consumption.

The script observes same-origin ChatGPT requests and reuses the current session's
authorization and account headers in memory to fetch usage. These headers, account
identifiers, and usage readings are not written to persistent storage or sent to
another host. No account credentials are embedded in the repository.

If a refresh fails, the script keeps the last known reading and displays a status.
After a reset time passes, it waits for a fresh server response before displaying
the new allowance. It does not assume that a reset means 100% remains.

## Limitations

This is an unofficial customization. ChatGPT's page structure and internal usage
endpoint can change and may require script updates. Gauges depend on the page
supplying a valid signed-in session. They describe Work/Codex allowance, rather
than separate regular-chat model limits.

## Development

Edit `chatgpt-better-ui.user.js`, then copy it into Tampermonkey and reload the page.
The script has no external runtime dependencies. Its latest imported version was
checked for JavaScript syntax and the ESLint `curly` and `no-loop-func` rules.

The keyboard behavior was originally inspired by
[namulab/enter-newline-for-ai](https://github.com/namulab/enter-newline-for-ai),
whose Firefox release declares the MIT License. The Work integration and gauges
were adapted for this project. See [LICENSE](./LICENSE).
