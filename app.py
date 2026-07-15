"""Story Explainer — paste a website link, text, or a PDF, get it explained as a simple story.

Two LLM backends, chosen via the LLM_BACKEND env var:
  - "ollama"  (default) : local llama3.1:8b via Ollama — for running on your Mac
  - "krutrim"           : Krutrim Cloud's hosted Llama API — for cloud deployment
                          (needs KRUTRIM_API_KEY; get one at https://cloud.olakrutrim.com)

Run locally :  .venv/bin/python app.py
Run on cloud:  LLM_BACKEND=krutrim KRUTRIM_API_KEY=... HOST=0.0.0.0 python app.py

API:
  POST /api/prepare       {input}                               -> {content, title, truncated, source}
  POST /api/prepare-file  multipart "file" (.pdf/.txt)          -> {content, title, truncated, source}
  POST /api/explain       {content, title, language, length, audience} -> streamed story text
  POST /api/followup      {content, story, chat, question, language}   -> streamed answer text
  POST /api/quiz          {content, story, language}            -> {questions: [{q, options, answer_index}]}
"""

import asyncio
import json
import os
import re

import edge_tts
import requests
from bs4 import BeautifulSoup
from flask import Flask, Response, jsonify, request, send_from_directory
from pypdf import PdfReader

app = Flask(__name__, static_folder="static")

LLM_BACKEND = os.environ.get("LLM_BACKEND", "ollama")

# --- Ollama (local) ---
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434/api/chat")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.1:8b")
NUM_CTX = 16_384

# --- Krutrim Cloud (OpenAI-compatible chat completions) ---
# Verify the base URL in Krutrim's docs: https://docs.cloud.olakrutrim.com
KRUTRIM_URL = os.environ.get("KRUTRIM_URL", "https://cloud.olakrutrim.com/v1/chat/completions")
KRUTRIM_MODEL = os.environ.get("KRUTRIM_MODEL", "Meta-Llama-3-8B-Instruct")
KRUTRIM_API_KEY = os.environ.get("KRUTRIM_API_KEY", "")

# 8B-class models: keep the prompt modest so it stays fast and in-context
MAX_CONTENT_CHARS = 24_000
MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MB

LANGUAGE_INSTRUCTIONS = {
    "english": "Write in very simple, easy English words that even a school kid can understand.",
    "hindi": "Write in simple, everyday Hindi (Devanagari script). Use easy words, no difficult shuddh-Hindi vocabulary.",
    "hinglish": "Write in Hinglish — Hindi written in Roman (English) letters, the way people chat on WhatsApp. Keep it casual and easy.",
}

LENGTH_INSTRUCTIONS = {
    "quick": "Keep the story very short: just 2-3 short paragraphs covering only the most important points.",
    "normal": "",
    "detailed": "Make the story thorough: cover all the main ideas with extra examples and comparisons, in several paragraphs.",
}

# Microsoft Edge neural voices (free, no API key) — natural Indian accents.
# Swara handles Devanagari Hindi and Roman-script Hinglish; Neerja is Indian English.
TTS_VOICES = {
    "english": os.environ.get("TTS_VOICE_ENGLISH", "en-IN-NeerjaNeural"),
    "hindi": os.environ.get("TTS_VOICE_HINDI", "hi-IN-SwaraNeural"),
    "hinglish": os.environ.get("TTS_VOICE_HINGLISH", "hi-IN-SwaraNeural"),
}
MAX_TTS_CHARS = 1_500  # per-sentence requests; anything longer is a client bug

AUDIENCE_INSTRUCTIONS = {
    "kid": "Explain it like you are talking to a curious 10-year-old child: playful tone, very simple examples from school, games, and home life.",
    "adult": "Explain it for an adult: keep it simple and friendly, but not childish.",
}

SYSTEM_PROMPT = """You are a friendly storyteller who explains anything in the simplest possible way.

You will be given the content of a website, a document, or some pasted text. Explain it like you are telling a story to a curious friend who knows nothing about the topic:

- Start with one line telling what this content is about overall.
- Then explain the main ideas as a flowing story with simple examples and comparisons from daily life.
- Break it into short paragraphs. Use a few emojis to keep it friendly.
- Avoid jargon; if a technical word is unavoidable, explain it in brackets in easy words.
- End with a short "In short..." summary of 2-3 lines.
- Only explain what is actually in the content. If the content looks like an error page or is empty, say so honestly.
"""

FOLLOWUP_SYSTEM_PROMPT = """You are a friendly helper answering follow-up questions about some content that was just explained as a story.

Rules:
- Answer ONLY using the given content and story. If the answer is not in them, say honestly that the content does not cover it.
- Keep answers short and simple (a few sentences), with easy words and everyday examples.
- {lang_instruction}
"""

QUIZ_SYSTEM_PROMPT = """You create simple quizzes to check if someone understood some content.

Create exactly 3 multiple-choice questions about the MAIN ideas of the given content. Easy, friendly questions — not trick questions.

Output STRICT JSON only — no markdown, no explanations, no text before or after. Format:
[
  {{"q": "question text", "options": ["option A", "option B", "option C", "option D"], "answer_index": 0}},
  ...
]

Rules:
- Exactly 3 questions, each with exactly 4 options and one correct answer_index (0-3).
- {lang_instruction}
"""

URL_RE = re.compile(r"^(https?://)?[\w.-]+\.[a-z]{2,}(/\S*)?$", re.IGNORECASE)


def looks_like_url(text: str) -> bool:
    text = text.strip()
    return " " not in text and "\n" not in text and bool(URL_RE.match(text))


def fetch_website_text(url: str) -> tuple[str, str]:
    """Fetch a URL and return (page_title, readable_text)."""
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    resp = requests.get(
        url,
        timeout=20,
        headers={"User-Agent": "Mozilla/5.0 (StoryExplainer; personal reading tool)"},
    )
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    for tag in soup(["script", "style", "noscript", "header", "footer", "nav", "aside", "form"]):
        tag.decompose()
    title = soup.title.get_text(strip=True) if soup.title else url
    text = " ".join(soup.get_text(separator=" ").split())
    return title, text


def truncate_content(content: str) -> tuple[str, bool]:
    if len(content) > MAX_CONTENT_CHARS:
        return content[:MAX_CONTENT_CHARS], True
    return content, False


def stream_ollama(messages):
    """Yield text pieces from local Ollama."""
    with requests.post(
        OLLAMA_URL,
        json={
            "model": OLLAMA_MODEL,
            "stream": True,
            "options": {"num_ctx": NUM_CTX},
            "messages": messages,
        },
        stream=True,
        timeout=(5, 300),
    ) as r:
        r.raise_for_status()
        for line in r.iter_lines():
            if not line:
                continue
            chunk = json.loads(line)
            if chunk.get("error"):
                yield f"\n\n[Ollama error: {chunk['error']}]"
                return
            piece = chunk.get("message", {}).get("content", "")
            if piece:
                yield piece
            if chunk.get("done"):
                return


def stream_krutrim(messages):
    """Yield text pieces from Krutrim Cloud (OpenAI-compatible SSE stream)."""
    with requests.post(
        KRUTRIM_URL,
        headers={
            "Authorization": f"Bearer {KRUTRIM_API_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "model": KRUTRIM_MODEL,
            "stream": True,
            "max_tokens": 2048,
            # reasoning models (e.g. Qwen3.5) burn tokens "thinking" before the story;
            # this vLLM flag turns that off. Harmless for non-reasoning models.
            "chat_template_kwargs": {"enable_thinking": False},
            "messages": messages,
        },
        stream=True,
        timeout=(5, 300),
    ) as r:
        r.raise_for_status()
        for line in r.iter_lines():
            if not line:
                continue
            line = line.decode() if isinstance(line, bytes) else line
            if not line.startswith("data:"):
                continue
            payload = line[len("data:"):].strip()
            if payload == "[DONE]":
                return
            chunk = json.loads(payload)
            choices = chunk.get("choices")
            if not choices:  # final usage-only chunk has an empty choices list
                continue
            piece = choices[0].get("delta", {}).get("content") or ""
            if piece:
                yield piece


def llm_stream(messages):
    backend = stream_krutrim if LLM_BACKEND == "krutrim" else stream_ollama
    return backend(messages)


def streaming_response(messages) -> Response:
    """Stream LLM output as plain text, turning connection errors into readable messages."""

    def generate():
        try:
            yield from llm_stream(messages)
        except requests.ConnectionError:
            target = "Krutrim Cloud" if LLM_BACKEND == "krutrim" else "Ollama (run: ollama serve)"
            yield f"\n\n[Error: could not connect to {target}.]"
        except requests.HTTPError as e:
            yield f"\n\n[LLM API error: {e}]"
        except requests.RequestException as e:
            yield f"\n\n[Error talking to the model: {e}]"

    return Response(generate(), mimetype="text/plain; charset=utf-8")


def llm_complete(messages) -> str:
    """Run the LLM non-streaming-style and return the full text."""
    return "".join(llm_stream(messages))


@app.get("/")
def index():
    return send_from_directory("static", "index.html")


@app.post("/api/prepare")
def prepare():
    """Turn a URL or pasted text into ready-to-explain content."""
    data = request.get_json(force=True)
    user_input = (data.get("input") or "").strip()
    if not user_input:
        return jsonify({"error": "Please paste some text or a website link."}), 400

    if looks_like_url(user_input):
        try:
            title, content = fetch_website_text(user_input)
        except requests.RequestException as e:
            return jsonify({"error": f"Could not open that website: {e}"}), 502
        if not content.strip():
            return jsonify({"error": "That page had no readable text (it may need JavaScript to load)."}), 422
        source = f'the website "{title}" ({user_input})'
    else:
        title = user_input[:60] + ("…" if len(user_input) > 60 else "")
        content = user_input
        source = "text pasted directly by the user"

    content, truncated = truncate_content(content)
    return jsonify({"content": content, "title": title, "truncated": truncated, "source": source})


@app.post("/api/prepare-file")
def prepare_file():
    """Extract readable text from an uploaded .pdf or .txt file."""
    file = request.files.get("file")
    if file is None or not file.filename:
        return jsonify({"error": "No file was uploaded."}), 400
    if request.content_length and request.content_length > MAX_UPLOAD_BYTES:
        return jsonify({"error": "File is too big — please keep it under 10 MB."}), 413

    name = file.filename
    ext = os.path.splitext(name)[1].lower()
    if ext == ".pdf":
        try:
            reader = PdfReader(file.stream)
            if reader.is_encrypted:
                return jsonify({"error": "That PDF is password-protected — please upload an unlocked one."}), 422
            content = "\n".join((page.extract_text() or "") for page in reader.pages)
        except Exception as e:
            return jsonify({"error": f"Could not read that PDF: {e}"}), 422
    elif ext == ".txt":
        try:
            content = file.read(MAX_UPLOAD_BYTES).decode("utf-8", errors="replace")
        except Exception as e:
            return jsonify({"error": f"Could not read that file: {e}"}), 422
    else:
        return jsonify({"error": "Only .pdf and .txt files are supported."}), 415

    content = " ".join(content.split())
    if not content.strip():
        return jsonify({"error": "No readable text found in that file (it may be a scanned/image PDF)."}), 422

    content, truncated = truncate_content(content)
    source = f'the uploaded file "{name}"'
    return jsonify({"content": content, "title": name, "truncated": truncated, "source": source})


def build_style_instructions(data) -> str:
    lang = LANGUAGE_INSTRUCTIONS.get(data.get("language"), LANGUAGE_INSTRUCTIONS["english"])
    length = LENGTH_INSTRUCTIONS.get(data.get("length"), "")
    audience = AUDIENCE_INSTRUCTIONS.get(data.get("audience"), "")
    return " ".join(part for part in (lang, length, audience) if part)


@app.post("/api/explain")
def explain():
    """Stream a story explaining the prepared content."""
    data = request.get_json(force=True)
    content = (data.get("content") or "").strip()
    if not content:
        return jsonify({"error": "Nothing to explain — prepare some content first."}), 400
    source = data.get("source") or "text provided by the user"
    truncated = bool(data.get("truncated"))

    trunc_note = (
        "\n\nNote: the content was very long, so only the first part is included. Mention briefly at the end that you explained the first part of a longer page."
        if truncated
        else ""
    )
    user_message = (
        f"Content taken from {source}.\n\n{build_style_instructions(data)}{trunc_note}\n\n"
        f"Here is the content to explain as a story:\n\n<content>\n{content}\n</content>"
    )
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_message},
    ]
    return streaming_response(messages)


@app.post("/api/followup")
def followup():
    """Stream an answer to a follow-up question about an explained story."""
    data = request.get_json(force=True)
    content = (data.get("content") or "").strip()
    story = (data.get("story") or "").strip()
    question = (data.get("question") or "").strip()
    if not question:
        return jsonify({"error": "Please type a question."}), 400
    if not content and not story:
        return jsonify({"error": "No story context — explain something first."}), 400

    lang = LANGUAGE_INSTRUCTIONS.get(data.get("language"), LANGUAGE_INSTRUCTIONS["english"])
    system = FOLLOWUP_SYSTEM_PROMPT.format(lang_instruction=lang) + (
        f"\nOriginal content:\n<content>\n{content}\n</content>\n\nStory told about it:\n<story>\n{story}\n</story>"
    )
    messages = [{"role": "system", "content": system}]
    for turn in (data.get("chat") or [])[-6:]:
        q, a = (turn.get("q") or "").strip(), (turn.get("a") or "").strip()
        if q and a:
            messages.append({"role": "user", "content": q})
            messages.append({"role": "assistant", "content": a})
    messages.append({"role": "user", "content": question})
    return streaming_response(messages)


async def synthesize_speech(text: str, voice: str) -> bytes:
    communicate = edge_tts.Communicate(text, voice)
    buf = bytearray()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            buf.extend(chunk["data"])
    return bytes(buf)


@app.post("/api/tts")
def tts():
    """Turn a short piece of text into MP3 speech using Edge neural voices."""
    data = request.get_json(force=True)
    text = (data.get("text") or "").strip()[:MAX_TTS_CHARS]
    if not text:
        return jsonify({"error": "No text to speak."}), 400
    voice = TTS_VOICES.get(data.get("language"), TTS_VOICES["english"])

    try:
        audio = asyncio.run(synthesize_speech(text, voice))
    except Exception as e:
        return jsonify({"error": f"Voice service unavailable: {e}"}), 502
    if not audio:
        return jsonify({"error": "Voice service returned no audio."}), 502
    return Response(audio, mimetype="audio/mpeg")


@app.post("/api/quiz")
def quiz():
    """Generate 3 multiple-choice questions about the content."""
    data = request.get_json(force=True)
    content = (data.get("content") or "").strip()
    story = (data.get("story") or "").strip()
    if not content and not story:
        return jsonify({"error": "No story context — explain something first."}), 400

    lang = LANGUAGE_INSTRUCTIONS.get(data.get("language"), LANGUAGE_INSTRUCTIONS["english"])
    system = QUIZ_SYSTEM_PROMPT.format(lang_instruction=lang)
    user_message = f"Create the quiz from this content:\n\n<content>\n{content or story}\n</content>"
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user_message},
    ]

    try:
        raw = llm_complete(messages)
    except requests.RequestException as e:
        return jsonify({"error": f"Could not reach the model: {e}"}), 502

    # The model was told strict-JSON, but 8B models sometimes wrap it in prose/markdown.
    start, end = raw.find("["), raw.rfind("]")
    if start == -1 or end <= start:
        return jsonify({"error": "The model did not return a valid quiz — please try again."}), 502
    try:
        questions = json.loads(raw[start : end + 1])
        assert isinstance(questions, list) and questions
        cleaned = []
        for item in questions[:3]:
            q = str(item["q"]).strip()
            options = [str(o).strip() for o in item["options"]][:4]
            answer_index = int(item["answer_index"])
            assert q and len(options) == 4 and 0 <= answer_index < 4
            cleaned.append({"q": q, "options": options, "answer_index": answer_index})
        assert cleaned
    except (KeyError, ValueError, TypeError, AssertionError, json.JSONDecodeError):
        return jsonify({"error": "The model did not return a valid quiz — please try again."}), 502

    return jsonify({"questions": cleaned})


if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5050"))
    app.run(host=host, port=port, debug=False)
