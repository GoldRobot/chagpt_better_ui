# ChatGPT Better UI

A standalone Tampermonkey userscript for ChatGPT, including Work mode.

Current version: **1.1.18**.

## Features

- **Enter** inserts a newline; **Ctrl+Enter** or **Cmd+Enter** sends.
- **Shift+Enter** keeps its normal newline behavior. Keyboard handling is restricted to known chat composers; Ctrl/Cmd+Enter selects the local visible Send control and ignores held-key repeats.
- Links in assistant and user messages have a permanent underline and a soft background derived from their current text color, with stronger hover and keyboard-focus effects. For Work links with colored inline mentions, the highlight is applied to the inner text element so it uses the visible accent color instead of the anchor's neutral color.
- Citation links receive the same treatment while preserving their chip layout. Styles apply automatically to newly rendered messages and chat switches. File references rendered as ordinary message links are included; specialized file widgets are not yet verified.
- Compact session and weekly allowance gauges next to Work-style composers.
- Limits are identified by duration: five-hour Session and seven-day Weekly. Accounts reporting only a weekly limit show only Weekly; explicitly absent gauges are hidden. Unreadable or unsupported windows produce an unavailable status instead of silently disappearing.
- Gauges follow the visible composer when switching chats, including when inactive chats remain mounted but hidden with CSS.
- Each gauge fills across its entire frame according to the percentage remaining.
- Reset countdowns appear in the headings, such as `Session · 2h 20m`.
- The whole gauge opens the usage dashboard when clicked.
- One scheduler refreshes usage while a Work composer is visible and the browser is online. It reuses fresh app readings for up to a minute, refreshes at reset time, and fetches overdue data when returning to the tab.
- Older responses cannot overwrite newer readings. Failed requests back off automatically and respect the server's `Retry-After` header.
- Composer detection filters unrelated page changes; gauges update only when their displayed values change.
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

Install or reinstall once from the [direct Raw install/update link](https://raw.githubusercontent.com/GoldRobot/chagpt_better_ui/master/chatgpt-better-ui.user.js)
so Tampermonkey records the current source and metadata. The script uses the same
stable `raw.githubusercontent.com/OWNER/REPOSITORY/BRANCH/FILE.user.js` URL for
both update checks and downloads, without a GitHub-domain redirect.

The repository is public; no GitHub login or access token is required.
Future releases must increase `@version`. Enable update checks and automatic
installation in Tampermonkey according to your preferred schedule.

Changing this repository does not change an installed copy's saved update URL
until that copy is updated or reinstalled. If updates still fail after reinstalling,
check the script's update/download URL overrides and whether update checks and
automatic installation are enabled. A locally modified script may also require
confirming a manual update. Raw responses can be cached, so an immediate check
can briefly return an older version.

## Usage data

The gauges read ChatGPT's existing `/backend-api/wham/usage` endpoint. They use the
primary and secondary usage windows reported by the service, rather than counting
messages or estimating consumption.

The script observes same-origin ChatGPT requests and reuses the current session's
authorization and account headers in memory to fetch usage. These headers, account
identifiers, and usage readings are not written to persistent storage or sent to
another host. No account credentials are embedded in the repository.

If a refresh fails, the script keeps the last known reading and displays a status.
For a recognized window with unreadable data, it displays an em dash. Unknown
window durations receive an explicit status; an existing gauge is kept visible
as unavailable until a readable response or explicit absence is received.
After a reset time passes, it waits for a fresh server response before displaying
the new allowance. It does not assume that a reset means 100% remains.

## Limitations

This is an unofficial customization. ChatGPT's page structure and internal usage
endpoint can change and may require script updates. Gauges depend on the page
supplying a valid signed-in session. They describe Work/Codex allowance, rather
than separate regular-chat model limits.

## Development

The installed script has no external runtime dependencies or build step.
Development checks use Node.js (24.15+ in the Node 24 line, or another version
allowed by `package.json`) and jsdom. From the repository directory, run:

```sh
npm ci
npm run check
npm test
```

The regression suite executes the complete userscript against synthetic pages,
mock responses, and a deterministic clock. It covers response ordering, account
changes, Plus/Pro limits, invalid data, background/offline behavior, retries,
composer replacement/visibility, unnecessary DOM work, keyboard targeting, and
link selector coverage. It makes no real ChatGPT API requests and contains no
captured account data. jsdom does not provide browser layout: visibility is
modeled in the harness, so native editor behavior and appearance need the manual
Firefox check below.

After an edit, run the checks and increase `@version` before publishing. Install
from the direct Raw link so automatic updates keep working. A manually edited
Tampermonkey copy may require confirming an overwrite.

### Firefox smoke check

1. In regular chat and Work, verify Enter inserts a newline, Ctrl/Cmd+Enter sends,
   and Shift+Enter and IME composition retain their normal behavior.
2. Switch between several chats and the file viewer; confirm the gauges follow
   the visible Work composer. Test returning to a previously opened chat.
3. Check session/weekly or weekly-only readings against the usage dashboard.
4. Hide the tab or go offline, then return/reconnect; confirm automatic recovery.
5. Check ordinary links, user-message links, and citations in light/dark themes,
   including hover and keyboard focus. Specialized file widgets remain unverified.

The keyboard behavior was originally inspired by
[namulab/enter-newline-for-ai](https://github.com/namulab/enter-newline-for-ai),
whose Firefox release declares the MIT License. The Work integration and gauges
were adapted for this project. See [LICENSE](./LICENSE).

