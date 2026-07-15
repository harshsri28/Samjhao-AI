# Story Explainer 📖

Paste a website link, any text, or upload a **PDF/TXT** → get it explained like a simple story in **English**, **हिंदी**, or **Hinglish**.

## Why use it?

Ever opened an article and felt it was written for experts? Drop it here instead — the app retells it like a friend explaining over chai. ☕

- 📰 **News & articles** — paste a link to a dense news story, editorial, or blog post and get the "so what does this actually mean?" version
- 📑 **Reports & PDFs** — policy documents, school notes, office reports → simple stories with everyday examples
- 🧑‍🎓 **Learning something new** — a Wikipedia page or technical tutorial explained the way a 10-year-old (or a busy adult) would get it
- 👨‍👩‍👧 **Explaining to family** — read something in English, share it in हिंदी or Hinglish with the speak-aloud voice for parents/grandparents
- ✅ **Check your understanding** — take the built-in 3-question quiz after the story, and ask follow-up questions in a chat till it clicks

Paste → pick language, length, audience → get the story → listen, quiz yourself, ask doubts.

Runs **fully on your Mac** using your local Llama model (`llama3.1:8b` via Ollama). No API key, no cost, works offline (except fetching the website itself).

## Features

- 🔗 **Links, text, or files** — websites, pasted text, or uploaded `.pdf` / `.txt` files
- 📏 **Length control** — Quick (2–3 paragraphs), Normal, or Detailed
- 🧒 **Audience control** — explain for a 10-year-old or an adult
- 💬 **Follow-up questions** — ask about the story in a chat below it
- 🎯 **Quiz mode** — "Test me" makes 3 multiple-choice questions to check understanding
- 🕘 **Story history** — last 20 stories saved in your browser; reopen, re-ask, delete
- ⏹ **Stop & 🔄 Regenerate** — cancel mid-stream, or retell with different settings (no re-fetch)
- 🌙 **Dark mode** — remembered across visits
- 🔊 **Speak aloud** — the story is read out sentence-by-sentence as it streams, using free Microsoft Edge **neural Indian voices** (hi-IN Swara for Hindi/Hinglish, en-IN Neerja for English) via `edge-tts`; needs internet, and falls back to the browser's built-in voice offline. Override with `TTS_VOICE_HINDI` / `TTS_VOICE_HINGLISH` / `TTS_VOICE_ENGLISH` env vars (`edge-tts --list-voices` shows options, e.g. male `hi-IN-MadhurNeural`).

## Run it

```sh
# 1. Make sure Ollama is running (skip if already running)
ollama serve

# 2. In another terminal, start the app
cd ~/Livspace/story-explainer
./.venv/bin/python app.py
```

Then open **http://localhost:5050** in your browser.

## How it works

- **Prepare**: a link is downloaded and stripped to readable text; a PDF is parsed with `pypdf`; pasted text is used directly (`POST /api/prepare`, `POST /api/prepare-file`).
- **Explain**: the content plus your language/length/audience choices go to the local `llama3.1:8b` model, and the story streams back word by word (`POST /api/explain`).
- **Follow-up / Quiz**: the same content and story are sent back as context (`POST /api/followup`, `POST /api/quiz`).
- The browser keeps the prepared content, so Regenerate, follow-ups, quizzes, and history all work without re-fetching.

## Notes

- Pages behind a login or that need JavaScript to render won't work — you'll get a clear error.
- Very long content is trimmed to the first ~24,000 characters so the 8B model stays fast and accurate (the story will mention this).
- Scanned/image-only PDFs have no extractable text and will be rejected with a clear message.
- Hindi/Hinglish quality is decent but not perfect on an 8B model — English is its strongest language.
- Quiz JSON from an 8B model occasionally comes back malformed — the app asks you to just try again.
- To use a different Ollama model later, change `OLLAMA_MODEL` at the top of `app.py`.

## Privacy 🔒

This app stores **no user data on the server** — no accounts, no database, no cookies.

- **Your history stays in your browser.** Saved stories, chats, and preferences live in your browser's `localStorage` on your own device. The server never sees them, and "Clear all" in the History drawer wipes them.
- **Nothing is written to disk.** Uploaded PDFs are parsed in memory and discarded; stories are streamed and forgotten.
- **What leaves the server (only to do the job):** the content you ask about goes to the LLM backend you configured (local Ollama = nothing leaves your machine; Krutrim Cloud = their API processes it), and sentences being spoken aloud go to Microsoft's Edge TTS service. Pasted links are fetched from the target website directly.
- **Standard web-server logs** (IP address, endpoint, timestamp — never your content) are the only trace a request leaves.

## Packages

Already installed in `.venv/`. To reinstall: `./.venv/bin/pip install -r requirements.txt` (flask, requests, beautifulsoup4, pypdf)

## Deploying on Krutrim Cloud

The app supports two LLM backends via the `LLM_BACKEND` env var:

| Backend | Where the model runs | Use for |
|---|---|---|
| `ollama` (default) | Your Mac (llama3.1:8b) | Local use |
| `krutrim` | Krutrim's hosted `Meta-Llama-3-8B-Instruct` API | Cloud deployment |

Steps:

1. Sign up at https://cloud.olakrutrim.com and create an **API key** (for the model) — verify the inference base URL in https://docs.cloud.olakrutrim.com and set `KRUTRIM_URL` if it differs.
2. Create a small **CPU VM** (2 vCPU / 2GB is plenty — the model runs on Krutrim's side, not your VM).
3. On the VM:
   ```sh
   sudo apt update && sudo apt install -y python3-venv git
   # copy this folder to the VM (git or scp), then:
   cd story-explainer
   python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
   LLM_BACKEND=krutrim KRUTRIM_API_KEY=your-key HOST=0.0.0.0 PORT=80 \
     nohup ./.venv/bin/python app.py > server.log 2>&1 &
   ```
4. Open the VM's public IP in a browser. Allow port 80 in the VM's security group / firewall.

Optional overrides: `KRUTRIM_MODEL` (default `Meta-Llama-3-8B-Instruct`), `KRUTRIM_URL`.
