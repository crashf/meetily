# Pund-IT Meeting Assistant

A local-first desktop meeting recorder, transcriber and summary assistant maintained by Pund-IT. The desktop application uses Tauri, a Rust core and a Next.js interface.

## Features

- Capture microphone and system audio; transcribe with local Whisper or Parakeet models.
- Review saved meetings, transcripts and summaries in a local SQLite database.
- Generate summaries with local models/Ollama or an optional external provider or OpenAI-compatible endpoint.
- Pair the browser extension with the authenticated loopback recording service.

**Local-first does not mean network-free.** External summary providers receive meeting text and prompts. Remote Ollama/custom endpoints also transfer data over the network. Model downloads, optional analytics and configured update/provider services can connect externally. See [Privacy policy](PRIVACY_POLICY.md) before recording confidential meetings. Obtain participant consent and follow your organization's recording policy.

## Installation and upgrades

Use only the Pund-IT-approved artifact for the exact tested source revision. Experimental builds are GitHub Actions artifacts, not replacements for the normal release. Extract the downloaded ZIP and run its NSIS `*-setup.exe` on Windows; the raw executable is not an installer.

Windows packages use Vulkan-enabled Whisper and require an AVX2-capable x64 CPU, not AVX-512. CUDA requires an appropriately configured source build. macOS and Linux builds require their own platform acceptance; Windows acceptance does not establish parity.

Before an upgrade, fully quit the application including its tray process, back up existing application data and retain the previous installer. Do not delete or rename existing `meetily`/`com.meetily.ai` data paths. Display branding is changing; compatibility identifiers remain intentional.

- [Distribution and artifact verification](docs/DISTRIBUTION.md)
- [Upgrade/data-preservation acceptance procedure](docs/UPGRADE_TEST.md)
- [Build from source](docs/BUILDING.md)
- [Linux builds](docs/building_in_linux.md)
- [GPU acceleration](docs/GPU_ACCELERATION.md)
- [Architecture](docs/architecture.md)
- [Contributing](CONTRIBUTING.md)

## Scope and compatibility

This rebrand does not add Ops Hub uploads, ticket attachments or new signing guarantees. Preserve executable/crate names, bundle identity, storage/database paths, preference keys and extension protocol/token pairing. Residual technical names are inventoried in [Branding compatibility](docs/BRANDING.md).

## License and upstream attribution

Derived from [Meetily by Zackriya Solutions](https://github.com/Zackriya-Solutions/meetily), under the [MIT license](LICENSE.md). Required upstream copyright and third-party notices remain unchanged. Rebranding does not remove attribution or imply ownership of upstream marks.

## Acknowledgments

- We borrowed some code from [Whisper.cpp](https://github.com/ggerganov/whisper.cpp).
- We borrowed some code from [Screenpipe](https://github.com/mediar-ai/screenpipe).
- We borrowed some code from [transcribe-rs](https://crates.io/crates/transcribe-rs).
- Thanks to **NVIDIA** for developing the **Parakeet** model.
- Thanks to [istupakov](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx) for providing the **ONNX conversion** of the Parakeet model.
