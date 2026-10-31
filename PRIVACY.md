# Privacy Policy for Send Link to SwarmUI

Last updated: October 31, 2026

Send Link to SwarmUI is a Chrome extension maintained by Juan Treminio. It sends links to a SwarmUI downloader and can show which Civitai model versions are already in your SwarmUI library.

The extension has no developer-operated data collection server, analytics, advertising, or tracking service. It does not automatically send your data to the developer. Its data handling is described below.

## Information the extension handles

- **Links you send.** When you choose **Send to SwarmUI**, the extension reads the clicked link or the current page URL and passes it to your configured SwarmUI downloader. This can include query parameters or fragments contained in that URL. It also reads the saved SwarmUI tab's URL to reuse that tab.
- **Settings.** Your SwarmUI server address, popup-window preference, and the identifier of the tab used for SwarmUI are saved in local extension storage.
- **Civitai model information.** On model pages at `civitai.com` and `civitai.red`, the extension observes selected model API responses that the page already requests. It extracts model names, types, model and version IDs, version names and dates, base-model names, file IDs, and available model hashes. It stores this metadata with the Civitai site of origin and capture timestamps. Response bodies are processed temporarily for parsing and are not saved as raw responses. The extension does not make additional Civitai API requests to enrich this information.
- **Matching and connection information.** When SwarmUI access is granted, the extension receives model-version match statuses and summary counts from WhatTheDuck. It stores connection status, summary counts, timestamps, and diagnostic error messages locally. Individual match results and SwarmUI API session identifiers are kept temporarily in memory rather than saved in local extension storage.

The extension does not collect a general browsing history or scan local files. Its tab access supports the link you choose to send and reuse of the SwarmUI tab.

## How information is used and shared

Information is used to forward your chosen links, display captured model metadata, show downloaded-version and update indicators, and report connection or capture errors.

Your **configured SwarmUI server** is the recipient of links you send. For version matching, the extension sends that server the relevant Civitai model IDs, version IDs, model types, and available publication timestamps. Matching runs automatically as you browse and periodically while model pages or the extension's options are open. Captured model hashes remain in the browser's local collection; the current matching requests use IDs rather than hashes. Existing browser-managed SwarmUI authentication cookies may accompany requests to that server, and the extension obtains a SwarmUI API session for those requests. It does not ask you to enter a password into the extension.

SwarmUI and its WhatTheDuck extension process these requests under the control of whoever operates your configured server. That server may keep its own logs. The extension does not send local model files, local filenames, library match results, or SwarmUI credentials to Civitai. Civitai's own website requests and data practices are separate from this extension.

There is no automatic transfer of this information to the developer, advertisers, or data brokers. The extension does not sell data or use it for advertising, profiling, or credit decisions.

## Storage, retention, and deletion

Settings and captured metadata use Chrome's local extension storage, not Chrome's storage sync service. Settings remain until changed or the extension is removed.

During collection updates, the extension removes model records that have not been seen for 30 days and limits the collection to 2,000 models and approximately 6 MiB. Size limits may remove records earlier. This cleanup runs during collection updates, so it is not a guarantee that records disappear exactly 30 days after capture.

You can inspect captured metadata in the extension's options and save a local JSON file with **Export JSON**. Exporting does not upload that file to a service. You control any subsequent sharing of the file.

Uninstalling the extension removes its local extension storage. Exported JSON files must be deleted separately. Uninstalling does not delete browser history, model files, or logs and data held by your SwarmUI server. Contact that server's operator about its retention or deletion practices.

## Permissions and connections

- **Context menus** provide the **Send to SwarmUI** right-click action.
- **Tabs** allow the extension to read the page URL you choose to send and find, update, and focus its SwarmUI tab.
- **Storage** saves settings, captured model metadata, and connection information locally.
- **Civitai site access** allows the declared content scripts to observe model responses and update model cards on `civitai.com` and `civitai.red`.
- **Optional HTTP and HTTPS server access** allows API requests to your chosen SwarmUI server. The extension requests access to the server you enter when you save its settings; it does not request access to all websites at that time.

The extension uses the HTTP or HTTPS address you configure. HTTPS encrypts traffic in transit; HTTP does not. Use HTTPS for a remote server when available. The developer does not operate or control your SwarmUI server.

## Limited use

Send Link to SwarmUI's use of information received through Chrome APIs follows the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies), including its Limited Use requirements. Information is used only for the user-facing functionality described in this policy.

## Changes and contact

This policy will be updated when the extension's data practices change. The date above identifies the latest revision.

For privacy questions, contact the maintainer through the [project's GitHub issues](https://github.com/jtreminio/SwarmUI-CivitAI-Chrome-Extension/issues). Issues are public; do not include credentials, private URLs, or other sensitive information.
