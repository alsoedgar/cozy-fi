# Third-Party Notices

## librespot

Cozy-Fi packages a native `librespot` 0.8.0 playback binary for each supported operating system and CPU architecture. Generated native binaries are intentionally excluded from the source repository and are built on their matching release hosts.

- Project: https://github.com/librespot-org/librespot
- License: MIT
- Upstream tag/commit: `v0.8.0` / `d36f9f1907e8cc9d68a93f8ebc6b627b1bf7267d`
- Cozy-Fi patch: `patches/librespot-cozy-fi.patch`
- Native checksum manifest: `librespot-checksums.json`
- Windows x64 SHA-256 currently recorded in the manifest: `C232D47F9F2EC029F5884062194FB6CD4652E282CB08FE3155FEA454690F10AF`

The Cozy-Fi patch limits interactive OAuth to the `streaming` scope and leaves opening the authorization URL to Cozy-Fi so setup can remain inside the app. Run `npm run build:librespot` on Windows, macOS, or Linux to rebuild from the pinned source and record that native target's checksum. The release workflow performs the same build on each supported native runner. Bundled playback binaries are unsigned.

Copyright (c) librespot contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## LRCLIB

Cozy-Fi can make optional, keyless requests to the external [LRCLIB service](https://lrclib.net/docs) when a user opens the Lyrics tab. LRCLIB code, database contents, and lyrics are not bundled with this repository. Lyrics remain the property of their respective rightsholders and are not relicensed under Cozy-Fi's MIT license. Service availability, lyric availability, and timing accuracy are controlled by LRCLIB and its contributors.
