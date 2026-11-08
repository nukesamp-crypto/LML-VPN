# LML VPN 1.0.1 — TheFeed TeleMirror and selected-config Windows revision

Base: source commit `b21e743d2b160b7525e971e53d422f8d6c4a4a10`; original source archive SHA-256 `9017709694c610fa413c051032a4b072d15c724b885dbcf3bcdb5780e4e87b00`. The accompanying patch applies directly to that archive, not to a previously modified or experimental-tunnel build.

## Behavior and limitations

* On selecting a tested configuration, the main power button starts that exact config by ID and chosen mode, not the previously selected Lantern or Shiro engine. An already active connection must first be disconnected; selecting an engine explicitly returns the power button to engine mode. An asynchronous config error remains visible as a config error. Direct config is the default; the two Psiphon chain modes are explicit alternatives.
* A manual search tries up to 400 distinct public Telegram channels sequentially using the bundled official TheFeed v0.41.0 TeleMirror via Google Translate. It uses a dedicated private process and does not modify the user's separate TheFeed channel list or profiles. Three consecutive transport errors stop the scan early; cancellation ends the private process and retains successful results. The section labels the source `Google`; Google does not own or endorse the configs. A completed attempt may fail or contain no supported links.
* The Google mirror sees the requested channel names and the user's IP; VPN servers see the tester's IP. Availability, rate limits, captchas and third-party server policies are not controlled by LML. Google mirroring may also be blocked or change without notice, and neither discovery nor connectivity can be guaranteed. The user-facing TheFeed feature remains separate from the dedicated private TeleMirror scanner. A new Google-specific cache avoids relabelling prior DNS/GitHub data as Google, and older mixed-source caches remain untouched.
* Acquisition can start with an LML engine connected, but verification waits until that connection is disconnected. No testing is silently chained through the active LML engine. Candidates are untrusted: URLs and public addresses are validated, and an isolated Xray HTTPS test must succeed before a candidate becomes selectable. Up to 6,000 private candidates may be queued; only up to 1,000 successful results are shown. Old cached results must be re-tested; fresh candidates take priority in short batches. Each probe races separate authenticated HTTPS targets under one time budget. Successful responses still do not guarantee that a server remains available, that all destinations work, or that its operator is trustworthy.
* Candidate and tested counts are cumulative within a search; only real completed channel attempts increment the 400-channel progress. Acquisition and testing can be stopped without removing successful partial results. Two isolated Xray probes run in parallel; the search does not install a system proxy, TUN device or network route. Availability and latency vary by network; public VPN configs can expose traffic to their operators.
* Experimental direct-config system tunneling remains removed. Direct and chain connections expose ordinary local HTTP/SOCKS proxies, optionally set as Windows system proxy for applications that respect that setting; they do not capture all system traffic. Existing `systemTunnel` settings are ignored. The installer attempts to delete the earlier experimental supervisor and adjacent `wintun.dll`. Lantern's independent service and embedded dependencies remain separate. A per-machine installer can request administrator approval, but normal direct-config use does not require the former experimental administrator mode.
* The previous Lion and Sun graphics are removed and the app uses a text-only LML logo. Existing Cyrus's tomb backgrounds, country flags and the disclaimer that cited projects did not directly help or endorse LML are retained. The ZedSecure credit points to `https://github.com/CluvexStudio/ZedSecure`. `Ather` remains disabled as `به‌زودی`.
* The unsigned installer, installer upgrade/cleanup, Windows service, Windows proxy setting and chains were not run on a Windows machine. Do not treat this as a verified Windows release or a leak-proof VPN. Linux Xray and TheFeed tests do not prove availability on the end user's ISP.

## Build inputs

Download `https://github.com/nukesamp-crypto/LML-VPN/releases/download/v1.0.1/LML-VPN-1.0.1-source.tar.xz`, verify the SHA-256 above, extract it, and apply `LML-VPN-1.0.1-LML-source.patch` from the archive root with `git apply LML-VPN-1.0.1-LML-source.patch` (the patch contains binary image data). The original archive and vendored dependencies remain required. Official Xray, Cronet, routing data, TheFeed and Psiphon binary inputs are described in `docs/BUILD.md`.

With Go 1.26.10 and a Windows-amd64 cross-build environment:

```sh
cd desktop/lantern-helper
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o ../resources/bin/lantern-ipc.exe .
```

The helper used for this build has SHA-256 `7f1b089eebca30a6af943dac48985d7c9185ed51e233ee0e04f4cc53478d4c77`; it differs from the historical helper. Do not add a standalone config-tunnel `wintun.dll` or supervisor.

Run `npm ci` and `npm test` in `desktop`; `LML_XRAY_TEST_BIN` and `LML_FEED_TEST_BIN` enable real Linux test engines, while the optional Psiphon chain test also requires `LML_PSIPHON_TEST_BIN`. Build the unsigned NSIS installer with Electron Builder and the existing configuration. The Linux build used `patch-linux-builder.cjs` to bound 7-Zip memory and extract the uninstaller without 32-bit Wine; this build-tool-only script is in the original archive.
