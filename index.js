const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { PassThrough } = require('stream');
const { sequelize, User, Chat, Message, Document } = require('./models');
const { storeDocument, getContext } = require('./utils/vectorStore');
const { extractText } = require('./utils/extractor');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
require('dotenv').config();

const app = express();
const upload = multer({ dest: 'uploads/', limits: { fileSize: 50 * 1024 * 1024 } });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const JWT_SECRET = process.env.JWT_SECRET;

app.use(cors({ exposedHeaders: ['X-Request-ID', 'X-Chat-ID'] }));
app.use(express.json());

const audioCache = new Map();

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ username, email, password: hashedPassword });
    res.status(201).json({ message: "User created" });
  } catch (err) {
    res.status(400).json({ error: "Email likely already exists" });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ where: { email } });
    if (!user) return res.status(400).json({ error: "User not found" });

    if (await bcrypt.compare(password, user.password)) {
      const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
      res.json({ token, username: user.username });
    } else {
      res.status(401).json({ error: "Invalid password" });
    }
  } catch (err) {
    res.status(500).json({ error: "Login failed" });
  }
});

const processBackgroundAudio = async (requestId, textStream, voiceId) => {
  const piperPath = path.join(__dirname, 'piper', 'piper');
  const modelFile = voiceId || 'en_US-lessac-medium.onnx';
  const modelPath = path.join(__dirname, 'piper', modelFile);

  if (!fs.existsSync(modelPath)) return;

  audioCache.set(requestId, { chunks: [], isComplete: false });

  let buffer = "";
  const generateAudioChunk = async (text) => {
    try {
      return await new Promise((resolve) => {
        const piper = spawn(piperPath, ['--model', modelPath, '--output_file', '-']);
        let chunks = [];
        piper.stdin.write(text);
        piper.stdin.end();
        piper.stdout.on('data', c => chunks.push(c));
        piper.on('close', (code) => {
          if (code === 0) resolve(Buffer.concat(chunks).toString('base64'));
          else resolve(null);
        });
      });
    } catch (e) {
      console.error("Piper Error:", e);
      return null;
    }
  };

  try {
    for await (const chunk of textStream) {
      buffer += chunk;

      let match;
      while ((match = buffer.match(/[^.!?]+[.!?]+/))) {
        const sentence = match[0];
        buffer = buffer.slice(sentence.length);

        const cleanSentence = sentence
          .replace(/[*#_`]/g, "")
          .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
          .trim();

        if (!cleanSentence) continue;

        const audio = await generateAudioChunk(cleanSentence);
        if (audio) {
          const entry = audioCache.get(requestId);
          if (entry) entry.chunks.push(audio);
        }
      }
    }
    if (buffer.trim()) {
      let cleanSentence = buffer
        .replace(/[*#_`]/g, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .trim();

      if (cleanSentence && !/[.!?]$/.test(cleanSentence)) {
        cleanSentence += ".";
      }

      if (cleanSentence) {
        const audio = await generateAudioChunk(cleanSentence);
        if (audio) {
          const entry = audioCache.get(requestId);
          if (entry) entry.chunks.push(audio);
        }
      }
    }

  } catch (err) {
    console.error("Stream Error:", err);
  } finally {
    const finalEntry = audioCache.get(requestId);
    if (finalEntry) finalEntry.isComplete = true;
  }
};

app.get('/api/history', authenticateToken, async (req, res) => {
  try {
    const chats = await Chat.findAll({
      where: { UserId: req.user.id },
      order: [['createdAt', 'DESC']],
      attributes: ['id', 'title', 'createdAt']
    });
    res.json(chats);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

app.get('/api/history/:id', authenticateToken, async (req, res) => {
  try {
    const chat = await Chat.findOne({
      where: { id: req.params.id, UserId: req.user.id },
      include: [{
        model: Message,
      }],
      order: [[Message, 'createdAt', 'ASC']]
    });

    if (!chat) return res.status(404).json({ error: "Chat not found" });
    res.json(chat);
  } catch (err) {
    console.error("Load Chat Error:", err);
    res.status(500).json({ error: "Failed to load chat" });
  }
});

app.get('/api/audio/:requestId', authenticateToken, (req, res) => {
  const entry = audioCache.get(req.params.requestId);

  if (entry) {
    res.json({ audioChunks: entry.chunks, isComplete: entry.isComplete });
  } else {
    res.json({ audioChunks: [], isComplete: true });
  }
});

app.post('/api/analyze', authenticateToken, upload.single('file'), async (req, res) => {
  const requestId = uuidv4();
  res.setHeader('X-Request-ID', requestId);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  const { PassThrough } = require('stream');
  const textForAudio = new PassThrough();
  processBackgroundAudio(requestId, textForAudio, req.body.voiceId);

  try {
    if (!req.file) return res.status(400).send('No file');

    let textForAnalysis = "";
    if (req.file.mimetype.includes('pdf') || 
        req.file.mimetype.includes('document') || 
        req.file.mimetype.includes('text') ||
        req.file.mimetype.includes('sheet')) {
            
        console.log("📄 Attempting text extraction...");
        textForAnalysis = await extractText(req.file.path, req.file.mimetype, req.file.originalname);
    }
    if (!textForAnalysis || textForAnalysis.trim().length < 50) {
        console.log("👁️ Extraction failed or Media file detected. Using Gemini Vision...");
        textForAnalysis = await generateDescriptionWithGemini(req.file.path, req.file.mimetype);
    }

    if (!textForAnalysis) {
        throw new Error("Could not extract text or generate description for this file.");
    }

    const newChat = await Chat.create({ 
        UserId: req.user.id,
        title: req.file.originalname,
        context: textForAnalysis 
    });
    res.setHeader('X-Chat-ID', newChat.id);
    await storeDocument(newChat.id, textForAnalysis);
    const promptParts = [`Analyze this content and provide a comprehensive summary:\n\n${textForAnalysis}`];
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContentStream(promptParts);
    let fullResponse = "";
    for await (const chunk of result.stream) {
      const text = chunk.text();
      fullResponse += text;
      res.write(text);
      textForAudio.write(text);
    }
    await Message.create({
      ChatId: newChat.id,
      role: 'ai',
      content: fullResponse
    });
    textForAudio.end();
    res.end();
    if (req.file) fs.unlinkSync(req.file.path);
  } catch (err) {
    console.error("Analysis Error:", err);
    res.write(`\n\n[Error: ${err.message}]`);
    res.end();
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
  }
});

app.post('/api/chat', authenticateToken, async (req, res) => {
  const requestId = uuidv4();
  res.setHeader('X-Request-ID', requestId);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  const { message, voiceId, chatId, useGeneralKnowledge = true } = req.body;
  if (chatId) {
    await Message.create({ ChatId: chatId, role: 'user', content: message });
  }
  const { PassThrough } = require('stream');
  const textForAudio = new PassThrough();
  processBackgroundAudio(requestId, textForAudio, voiceId);

  try {
    let retrievedContext = "";
    if (chatId) {
      console.log(`🔍 Searching vector context for chat: ${chatId}`);
      retrievedContext = await getContext(chatId, message);
    }

    let systemInstruction = "";

    if (useGeneralKnowledge) {

      systemInstruction = `
You are a helpful AI assistant.
Answer the user's question using the provided context as a reference, but YOU MAY use your general knowledge to explain, expand, or advise.

<context>
${retrievedContext || "No specific context found."}
</context>

User Question: ${message}

Instructions:
- If the answer is in the context, prioritize it.
- If the user asks for advice, improvements, or things NOT in the text, use your general knowledge to help.
        `;
    } else {
      systemInstruction = `
You are a strict documentation assistant. 
Answer the user's question based EXCLUSIVELY on the provided context.

<context>
${retrievedContext || "No context found."}
</context>

User Question: ${message}

Instructions:
- Do NOT use outside knowledge.
- If the answer is not in the context, state: "I cannot find this information in the document."
- Do not hallucinate or make up facts.
        `;
    }

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContentStream(systemInstruction);

    let fullResponse = "";
    for await (const chunk of result.stream) {
      const text = chunk.text();
      fullResponse += text;
      res.write(text);
      textForAudio.write(text);
    }
    if (chatId) {
      await Message.create({ ChatId: chatId, role: 'ai', content: fullResponse });
    }

    textForAudio.end();
    res.end();

  } catch (e) {
    console.error("Chat Error:", e);
    res.write("\n[Error processing request]");
    textForAudio.end();
    res.end();
  }
});

function fileToGenerativePart(path, mimeType) {
  return {
    inlineData: {
      data: fs.readFileSync(path).toString("base64"),
      mimeType
    },
  };
}

app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio uploaded' });

    const filePart = {
      inlineData: {
        data: fs.readFileSync(req.file.path).toString("base64"),
        mimeType: req.file.mimetype
      },
    };

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent([
      filePart,
      "Transcribe this audio exactly as spoken. Do not add descriptions, just the text."
    ]);

    const response = await result.response;
    const text = response.text();

    fs.unlinkSync(req.file.path);
    res.json({ text: text.trim() });

  } catch (error) {
    console.error("Transcription Error:", error);
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: "Transcription failed" });
  }
});

app.get('/api/voices', authenticateToken, (req, res) => {
  const piperDir = path.join(__dirname, 'piper');
  fs.readdir(piperDir, (err, files) => {
    if (err) return res.status(500).json({ error: 'Failed to read voices' });
    const voices = files.filter(f => f.endsWith('.onnx')).map(f => {
      const parts = f.replace('.onnx', '').split('-');
      return { id: f, name: `${parts[1].charAt(0).toUpperCase() + parts[1].slice(1)} (${parts[0]})` };
    });
    res.json({ voices });
  });
});

app.post('/api/speak', authenticateToken, async (req, res) => {
  try {
    const { text, voiceId } = req.body;
    if (!text) return res.status(400).json({ error: 'No text provided' });

    const modelFile = voiceId || 'en_US-lessac-medium.onnx';
    const modelPath = path.join(__dirname, 'piper', modelFile);

    if (!fs.existsSync(modelPath)) {
      return res.status(400).json({ error: 'Voice model not found' });
    }

    const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
    const audioChunks = [];
    const piperPath = path.join(__dirname, 'piper', 'piper');

    for (const sentence of sentences) {
      if (!sentence.trim()) continue;

      const base64Audio = await new Promise((resolve, reject) => {
        const piper = spawn(piperPath, [
          '--model', modelPath,
          '--output_file', '-'
        ]);

        let chunks = [];
        piper.stdin.write(sentence);
        piper.stdin.end();
        piper.stdout.on('data', (chunk) => chunks.push(chunk));

        piper.on('close', (code) => {
          if (code === 0) resolve(Buffer.concat(chunks).toString('base64'));
          else resolve(null);
        });
        piper.on('error', (err) => reject(err));
      });

      if (base64Audio) audioChunks.push(base64Audio);
    }

    res.json({ audioChunks });

  } catch (error) {
    console.error("Piper TTS Error:", error);
    res.status(500).json({ error: "TTS failed" });
  }
});

async function generateDescriptionWithGemini(filePath, mimeType) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const fileData = fs.readFileSync(filePath);
    const imageParts = [
      {
        inlineData: {
          data: fileData.toString("base64"),
          mimeType: mimeType
        }
      }
    ];
    const prompt = `
      Analyze this file (image, video, or scanned document) in extreme detail. 
      Your goal is to generate a comprehensive textual description that will be used for search retrieval.
      
      1. If it's a document/image: Transcribe all visible text and describe charts/diagrams.
      2. If it's a video: Describe the sequence of events, visual content, and transcribe any spoken audio.
      3. Do not summarize; be exhaustive.
    `;
    const result = await model.generateContent([prompt, ...imageParts]);
    return result.response.text();
  } catch (error) {
    console.error("Gemini Vision Error:", error);
    return null;
  }
}

sequelize.sync().then(() => {
  app.listen(5000, () => console.log('DB Synced and Server running on port 5000'));
});
