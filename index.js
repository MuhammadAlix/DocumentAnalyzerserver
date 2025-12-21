const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { PassThrough } = require('stream');
const sequelize = require('./config/database');
const Document = require('./models/Document');
const { extractText } = require('./utils/extractor');
const { spawn } = require('child_process');
const path = require('path');
require('dotenv').config();

const app = express();
const upload = multer({ dest: 'uploads/', limits: { fileSize: 50 * 1024 * 1024 } });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.use(cors({ exposedHeaders: ['X-Request-ID'] }));
app.use(express.json());

const audioCache = new Map();

// Background Audio Generator
const processBackgroundAudio = async (requestId, textStream, voiceId) => {
  const piperPath = path.join(__dirname, 'piper', 'piper');
  const modelFile = voiceId || 'en_US-lessac-medium.onnx';
  const modelPath = path.join(__dirname, 'piper', modelFile);

  if (!fs.existsSync(modelPath)) return;


  let buffer = "";
  audioCache.set(requestId, []);

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

      try {
        const base64Audio = await new Promise((resolve) => {
          const piper = spawn(piperPath, ['--model', modelPath, '--output_file', '-']);
          let chunks = [];
          
          piper.stdin.write(cleanSentence); 
          piper.stdin.end();
          
          piper.stdout.on('data', c => chunks.push(c));
          piper.on('close', (code) => {
            if (code === 0) resolve(Buffer.concat(chunks).toString('base64'));
            else resolve(null);
          });
        });

        if (base64Audio) {
          const currentCache = audioCache.get(requestId) || [];
          currentCache.push(base64Audio);
          audioCache.set(requestId, currentCache);
        }
      } catch (e) {
        console.error("Bg Audio Error:", e);
      }
    }
  }

  if (buffer.trim()) {
  }
};

app.get('/api/audio/:requestId', (req, res) => {
  const id = req.params.requestId;
  const audio = audioCache.get(id);
  
  if (audio && audio.length > 0) {
    res.json({ audioChunks: audio }); 
  } else {
    res.json({ audioChunks: [] });
  }
});

app.post('/api/analyze', upload.single('file'), async (req, res) => {
  const requestId = uuidv4();
  res.setHeader('X-Request-ID', requestId);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  const { PassThrough } = require('stream');
  const textForAudio = new PassThrough(); 

  try {
    if (!req.file) return res.status(400).send('No file');
    
    processBackgroundAudio(requestId, textForAudio, req.body.voiceId);

    let promptParts = [];
    const textData = await extractText(req.file.path, req.file.mimetype, req.file.originalname);

    if (textData) {
      promptParts = [`Analyze this content and provide a summary:\n\n${textData.substring(0, 5000)}`];
    } else {
      const filePart = {
        inlineData: {
          data: fs.readFileSync(req.file.path).toString("base64"),
          mimeType: req.file.mimetype
        },
      };
      promptParts = [filePart, "Analyze this document/media and provide a comprehensive summary."];
    }

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContentStream(promptParts);

    for await (const chunk of result.stream) {
      const text = chunk.text();
      res.write(text);
      textForAudio.write(text);
    }
    
    textForAudio.end();
    res.end();
    
    if (req.file) fs.unlinkSync(req.file.path);

  } catch (err) {
    console.error("Analysis Error:", err);
    res.end();
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
  }
});

app.post('/api/chat', async (req, res) => {
  const requestId = uuidv4();
  res.setHeader('X-Request-ID', requestId);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  const { message, context, voiceId } = req.body;
  
  const textForAudio = new PassThrough();
  processBackgroundAudio(requestId, textForAudio, voiceId);

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContentStream(`Context: ${context}\n\nQ: ${message}`);

    for await (const chunk of result.stream) {
      const text = chunk.text();
      res.write(text);
      textForAudio.write(text);
    }
    
    textForAudio.end();
    res.end();
  } catch (e) {
    console.error(e);
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

app.get('/api/voices', (req, res) => {
  const piperDir = path.join(__dirname, 'piper');
  
  fs.readdir(piperDir, (err, files) => {
    if (err) return res.status(500).json({ error: 'Failed to read voices' });

    const voices = files
      .filter(f => f.endsWith('.onnx'))
      .map(f => {
        const nameParts = f.replace('.onnx', '').split('-');
        const lang = nameParts[0].replace('_', '-');
        const name = nameParts[1].charAt(0).toUpperCase() + nameParts[1].slice(1); // Amy
        return {
          id: f,
          name: `${name} (${lang})`,
          lang: lang
        };
      });

    res.json({ voices });
  });
});

app.post('/api/speak', async (req, res) => {
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

sequelize.sync().then(() => {
  app.listen(5000, () => console.log('Server running on port 5000'));
});
