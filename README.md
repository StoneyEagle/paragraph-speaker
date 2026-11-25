# Paragraph Speaker

**Read any part of a Claude Code reply aloud, in a natural voice, with each word marked as it is spoken.**

Long answers are easier to take in when you can listen and follow along. Select a paragraph, a list or a table, and the mod reads it to you while the word being spoken is marked in the reply itself, so your eyes follow your ears. Tables are explained in plain words instead of being read cell by cell, and the cells being talked about are marked as it goes.

The voice ([Kokoro](https://huggingface.co/hexgrad/Kokoro-82M)) runs on your own computer.

<!-- Demo video: add the link here -->

## Install

**1. Add the mod.** In Claude Code in a terminal, type:

```
/plugin install paragraph-speaker --marketplace nidnawatha-L26/paragraph-speaker
```

Answer `y` to add the marketplace, then choose the **user** scope so the mod is on in all your sessions.

**2. Install the natural voice (once).** Type:

```
/speak setup
```

This takes a few minutes, and the status line shows each step. It:

- finds Python 3.10 to 3.13 on your computer (3.12 recommended, from [python.org](https://www.python.org/downloads/)),
- creates a separate Python environment in `%LOCALAPPDATA%\paragraph-speaker`, so nothing is added to your system Python,
- installs [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) there,
- downloads the voice model, about 340 MB, from the kokoro-onnx releases and checks each file's SHA-256 before using it.

You can also run the same script by hand: `tts\setup_voice.ps1` in the mod's folder.

Until the voice is installed, the mod reads with the built-in Windows voice, which works but cannot mark each word.

## Use

| Where | How |
|---|---|
| Claude desktop app (Code tab) | Select text in a reply, right-click, and choose **🔊 Read aloud** |
| Terminal | Select text with the mouse, then type `/speak` (the selection needs the terminal's fullscreen layout) |

| Command | What it does |
|---|---|
| `/speak` | Reads the text you selected |
| `/speak stop` | Stops reading |
| `/speak voice` | Lists the voices; `/speak voice bm_george` picks one |
| `/speak mark orange` | How the spoken word is marked: `orange` (default), `color`, `code` or `bold` |
| `/speak setup` | Installs the natural voice |

## Where it works

- **Windows only for now.** Sound, stopping and the setup use Windows tools. Mac support may come later.
- **The desktop app's Code tab** has everything, including the right-click menu.
- **In the terminal**, select text with the mouse and type `/speak`. The right-click menu is only in the desktop app.
- **The VS Code extension** has not been tested yet.

Tested with Claude Code 2.1.330 on Windows 11.

## Privacy

Speech is made on your computer, and the text you listen to is not sent anywhere to be spoken. When your selection holds a table, the table is sent to Claude Haiku through your own Claude Code session to explain it, as any prompt is.

## Remove

Uninstall it from `/plugin`. To remove the voice too, delete the folder `%LOCALAPPDATA%\paragraph-speaker`. If the setup ran from the desktop app, it may be under `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\paragraph-speaker` instead.

## Credits

The voice is [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) by hexgrad, run with [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) by thewh1teagle.

## License

MIT. See [LICENSE](LICENSE).
