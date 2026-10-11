# SCS SDK pin and redistribution

Source: the official [SCS Telemetry SDK page](https://modding.scssoft.com/wiki/Documentation/Engine/SDK/Telemetry) and its [SDK 1.15 archive](https://download.eurotrucksimulator2.com/scs_sdk_1_15.zip).

Archive SHA-256: `77504f14d2ac1405ba70ee3a97351662adbb39c0cf9d3a085423f01d37bc28ec`.

The ET-003 worker used the previously downloaded, ignored research archive after checking this exact digest. No SP-01 plugin source was reused. `scs-sdk-1.15/include`, `readme.txt`, and `LICENSE.txt` are unmodified archive bytes (`sdk_license.txt` is renamed to `LICENSE.txt`). `SHA256SUMS` records every redistributed source file; CMake verifies these hashes before generating targets. The narrow repository `.gitattributes` rule disables text conversion in this pinned directory so a fresh Windows checkout retains the same bytes.

The original [license](scs-sdk-1.15/LICENSE.txt) permits use, copying, modification and redistribution with the copyright and permission notices retained. The original README documents the SDK calling-context restrictions and negotiation. The headers are the only build dependency; there is no SDK binary or third-party runtime to redistribute. Preserve the SDK notice when packaging the plugin.

Archive **1.15**, telemetry API **1.00/1.01**, game telemetry versions (ETS2 up to **1.20**, ATS up to **1.07** in these headers), and installed game patch versions are separate identifiers. This pin does not establish runtime channel availability or game/TruckersMP compatibility.
