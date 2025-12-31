# 📄 AI Document Analyzer (Backend)

A powerful, pure Node.js backend for analyzing documents, images, and video using **Retrieval-Augmented Generation (RAG)**. This system extracts text from multiple file formats, generates intelligent summaries using **Google Gemini 2.5**, stores semantic embeddings in **Pinecone**, and provides local, neural-quality text-to-speech using **Piper**.

![Node.js](https://img.shields.io/badge/Node.js-v20%2B-green)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-DB-blue)
![Pinecone](https://img.shields.io/badge/Pinecone-Vector%20DB-black)
![Gemini](https://img.shields.io/badge/AI-Google%20Gemini-orange)

## ✨ Key Features

* **Advanced RAG Architecture:** Uses **Pinecone** to store and retrieve semantic text chunks, allowing for deep follow-up questions without token limits.
* **Multimodal Analysis:** Supports **PDFs, Word Docs, Excel, PowerPoint, Images, and Video**.
    * *Text Files:* Extracted via `pdfjs-dist` (Mozilla engine), `mammoth`, and `exceljs`.
    * *Media/Scanned Files:* Analyzed via **Gemini Vision** (OCR & Video description) for seamless retrieval.
* **Hybrid Intelligence:** Supports a "General Knowledge" toggle, allowing the AI to switch between strict document-based answers and broader advice.
* **Real-Time Streaming:** Streams AI text responses instantly to the client while generating audio in the background.
* **Local TTS (Piper):** Generates voice audio locally using the Piper binary (privacy-focused, free, & offline).

## 🛠️ Tech Stack

* **Runtime:** Node.js (Express.js)
* **Database:** PostgreSQL (Sequelize ORM) for user/chat metadata.
* **Vector Database:** Pinecone (for semantic embeddings).
* **AI Model:** Google Gemini 2.5 Flash (Text & Vision).
* **Embedding Model:** `text-embedding-004`.
* **Text Extraction:** `pdfjs-dist` (PDF), `mammoth` (DOCX), `exceljs` (XLSX), `adm-zip` (PPTX).
* **Text-to-Speech:** Piper (Local Binary).

---

## 🚀 Getting Started

### Prerequisites

* **Node.js** (v20 or higher recommended)
* **PostgreSQL** (Running locally)
* **Google Cloud API Key** (Gemini enabled)
* **Pinecone API Key** (Free tier works)

### 1. Clone & Install

```bash
git clone https://github.com/MuhammadAlix/DocumentAnalyzerserver.git
cd DocumentAnalyzerserver
npm install
```


### 2. Database & Vector Store Setup

**PostgreSQL:** Create a database (e.g., ai_docs_db).

**Pinecone:**

* Go to the [Pinecone Console](https://app.pinecone.io/organizations/-OhYfPmEVLetRsljpFle/projects/e4ce0c5b-3861-4b75-9bca-22f5fcd220ad/indexes).

* Create an index named `ai-docs-index`.

* Dimensions: `768`.

* Metric: `Cosine`.

### 3. Environment Configuration

Create a `.env` file in the root directory:
```bash
PORT=5000
JWT_SECRET=your_super_secure_random_string

# AI Keys
GEMINI_API_KEY=your_google_api_key_here
PINECONE_API_KEY=your_pinecone_api_key_here

# Database Config
DB_USERNAME=postgres
DB_PASSWORD=your_db_password
DB_NAME=ai_docs_db
DB_HOST=127.0.0.1

```

## 🗣️ Setting up Local Text-to-Speech (Piper)

This project uses Piper for offline neural text-to-speech. You must download the binary manually as it is excluded from Git.

### Step 1: Download the Binary

1. Go to the [Piper GitHub Releases](https://github.com/rhasspy/piper/releases).

2. Download the archive for your architecture (`usually piper_linux_x86_64.tar.gz`).

3. Extract the contents into the `server/piper/` directory.


### Step 2: Download Voice Models

1. Visit the [Hugging Face Piper Voices](https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US).

2. Download the `.onnx` and `.onnx.json` files for your desired voice (e.g., `en_US-lessac-medium`).

3. Place them inside `server/piper/`


### Required Structure:

```
server/
├── index.js
├── piper/
│   ├── piper
│   ├── libpiper_phonemize.so
│   └── ... (other libs)
```

## 🏃‍♂️ Running the Server

### Development Mode:

```bash
node index.js
```
The server will start on `http://localhost:5000.`

## 📡 API Endpoints Overview

| Method | Endpoint         | Description                                                                                               |
|--------|------------------|-----------------------------------------------------------------------------------------------------------|
| POST   | `/api/analyze`   | Upload file (PDF/Img/Vid). Extracts text/vision data, stores embeddings in Pinecone, and streams summary. |
| POST   | `/api/chat`      | RAG Chat. Retrieves context from Pinecone and streams answer. Supports "General Knowledge" toggle.        |
| GET    | `/api/audio/:id` | Streams generated TTS audio chunks.                                                                       |
| POST   | `/api/auth/*`    | Login/Register endpoints.                                                                                 |

📄 License

[MIT](https://choosealicense.com/licenses/mit/)