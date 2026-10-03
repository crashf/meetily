# Pund-IT Meeting Assistant — privacy and data handling

Updated: 2026-10-03. This technical data-handling notice describes observable paths in this fork. It is not an approved Pund-IT legal privacy policy or a guarantee of compliance or complete offline operation. The in-app upstream policy link identifies a separate upstream document, not this notice.

## Recording and local storage

Microphone/system audio is captured on your device. Whisper/Parakeet transcription runs locally. Recordings, transcripts, meeting metadata and summaries are persisted locally. Browser-trigger metadata can include the meeting name and platform. You are responsible for participant consent, lawful recording, retention and authorized access.

Local files and SQLite data are not promised to be application-encrypted. Use OS full-disk encryption, appropriate filesystem permissions and protected backups. Exported files and backups are separate copies; deleting a meeting does not necessarily remove those copies or data already sent to a provider.

## Optional summary-provider transfers

Summary generation sends meeting text and prompts to the provider you configure. Cloud providers such as Claude, Groq, OpenRouter and OpenAI-compatible services process that content under their own policies. A custom endpoint or Ollama on another host also transfers data over the network. Only a locally hosted provider with locally available models avoids that provider network transfer. Review destination, transport security, retention and access controls before use; do not assume a provider has zero retention.

## Other network activity

Model/dependency downloads and configured update services require network access. Provider checks or configured licensing services may also connect externally; inspect the build configuration and deployment policy. This rebrand adds no Hub or ticket-upload integration.

Analytics is optional and disabled until enabled in settings. When enabled, the existing PostHog integration sends usage events, generated user/session identifiers and technical/device information. Generated identifiers are pseudonymous, not a guarantee of anonymity. Event schemas are visible in `frontend/src/lib/analytics.ts` and `frontend/src-tauri/src/analytics/`. Meeting content is not intended analytics payload; logs and metadata can still be sensitive. No provider retention, residency or access-control guarantee is made here. Turn analytics off to stop subsequent analytics events; this does not erase previously received data.

## Browser pairing and diagnostics

The extension sends recording-control requests and meeting metadata to the desktop service on loopback, authenticated with a bearer token. Protect the pairing token; do not paste it into support tickets. Keep existing port, protocol and token preferences through upgrades. Loopback authentication is not a cloud export API.

Application logs and the Windows startup diagnostic log can contain error details and paths. Review/redact diagnostic files before sharing; share only with authorized support through an approved channel. API keys and tokens must not be included.

## Control, support and changes

Review settings before enabling an external provider or analytics. You can view/export/delete local meeting data using the application; manage copies and provider-side data separately. For privacy questions use your established Pund-IT support contact or the fork's private issue tracker, not the upstream promotional/contact channels. Policy changes are documented in this repository; no unimplemented in-app notification promise is made.

## Open-source attribution

This fork derives from [Meetily](https://github.com/Zackriya-Solutions/meetily). The [MIT license](LICENSE.md) and required third-party notices are retained. Source visibility enables review, but is not proof of a security audit or regulatory certification.
