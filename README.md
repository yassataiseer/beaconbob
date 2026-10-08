# BeaconBob

Pair programming over your local network, with no cloud in between. BeaconBob finds the people around you, lets you chat in groups and direct messages, share your workspace for live co-editing with visible cursors, and talk over voice. Everything stays on your LAN: there are no accounts, no servers, and nothing leaves the network.

Works in **Cursor** and **VS Code** (and other VS Code-based editors).

## Features

- **Zero-config discovery.** Anyone on the same network with BeaconBob open shows up automatically (mDNS, `_beaconbob._tcp.local`).
- **Approved, encrypted connections.** Every connection must be accepted by the other person, who sees your key fingerprint so they can check it is really you. Traffic is end-to-end encrypted (Ed25519-authenticated handshake, X25519 key exchange, AES-256-GCM).
- **Chat.** Direct messages, plus named groups: public groups anyone nearby can ask to join, and private invite-only groups. Typing indicators, unread counts, recent history for people who join late.
- **Shared editing.** The host of a group shares their workspace folder; members browse it and open files live. Edits merge in real time (Yjs CRDTs), everyone's cursor and selection is shown with their name, and you can jump to where someone is working. Members are read-only until the host grants edit access. `.gitignore`d files and secrets like `.env` and keys are never shared.
- **Voice.** Group voice calls and 1:1 calls, with mute and speaking indicators. Audio goes directly between participants over WebRTC on your LAN.

## Getting started

1. Install BeaconBob on two machines on the same network (or in both Cursor and VS Code on one machine).
2. Open the **BeaconBob** panel from the activity bar. Nothing is advertised until you do.
3. Click **Connect** next to someone, and have them accept. Compare the fingerprint they see with the one under **You** in your panel.
4. Chat, create a group with **+ New group**, share your workspace from a group you host, or start a call.

### Voice

Editor webviews cannot use the microphone, so joining a call opens a small **BeaconBob voice** page in your normal browser. It is served by your own editor on `127.0.0.1` and carries the audio; keep it open during the call. Your browser asks for microphone access the first time.

### Shared editing

In a group you host, click **Share workspace**. Members get a **Shared files** view (and can add the folder to their Explorer), and see a banner with who is sharing. Tick **Can edit** next to a member to let them edit. Their changes appear in your editor as unsaved changes; saving from either side saves your file.

## Requirements

- Everyone on the **same local network** (same subnet; mDNS multicast must not be blocked).
- The firewall must allow incoming TCP connections to your editor on ports **42520-42560** (change with `beaconbob.portRange`).
- **macOS:** allow your editor under *System Settings, Privacy & Security, Local Network*, or discovery will not work.
- **Voice:** a Chromium-based browser, Firefox or Safari for the voice page, plus a microphone.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `beaconbob.displayName` | your OS user name | Name shown to others. |
| `beaconbob.portRange` | `42520-42560` | Ports for incoming connections. |
| `beaconbob.sharing.exclude` | `.git/`, `node_modules/`, `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*` | Extra patterns hidden from guests when you share, on top of your root `.gitignore`. |

## Privacy and security

- Your name, workspace name, key fingerprint, and the names of public groups you host are announced on the local network while the BeaconBob panel has been opened in that window.
- Nobody can connect without your approval. Connections from outside private LAN address ranges are refused.
- Shared files: only the folder you share, never anything outside it (symlinks included), never ignored or excluded files, and only to members of that group. Guests cannot create, delete or rename files.
- Voice: audio is encrypted by WebRTC (DTLS-SRTP) and goes directly between participants. The local voice page only accepts connections carrying a one-time token from your editor.
- There is no telemetry and no external server of any kind.

## Limitations

- Groups and chat history last as long as the host's editor is open.
- Guests over `beaconbob://` get syntax highlighting but no IntelliSense, terminal or debugging.
- One shared workspace per host at a time; voice calls hold up to 8 people.

## Development

```bash
npm install
npm run build        # extension + sidebar
npm test             # unit, session, multi-process and browser tests
npm run test:vscode  # integration tests inside a real VS Code
npm run package      # builds beaconbob.vsix
```

Use the **BeaconBob: Alice + Bob** launch configuration to run two isolated editor windows side by side.

## License

[MIT](LICENSE)
