const { Pinecone } = require('@pinecone-database/pinecone');
const { RecursiveCharacterTextSplitter } = require('@langchain/textsplitters');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const index = pc.index('ai-docs-index'); 

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });

async function storeDocument(chatId, userId, fullText) {
  try {
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1000,
      chunkOverlap: 200,
    });
    const chunks = await splitter.createDocuments([fullText]);
    
    const safeChatId = String(chatId); 
    const safeUserId = String(userId);

    const vectors = [];
    
    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i].pageContent;
      const result = await embeddingModel.embedContent(chunkText);
      const embedding = result.embedding.values;

      vectors.push({
        id: `${safeChatId}_${i}`,
        values: embedding,
        metadata: {
          chatId: safeChatId,
          userId: safeUserId,
          text: chunkText
        }
      });
    }

    const batchSize = 50;
    for (let i = 0; i < vectors.length; i += batchSize) {
        const batch = vectors.slice(i, i + batchSize);
        await index.upsert(batch);
    }
    
    console.log(`✅ Stored ${vectors.length} vectors for Chat ${safeChatId} (User ${safeUserId})`);
    return true;
  } catch (error) {
    console.error("Vector Store Error:", error);
    return false;
  }
}

async function getContext(chatId, userId, query) {
  try {
    const result = await embeddingModel.embedContent(query);
    const queryVector = result.embedding.values;

    const safeChatId = String(chatId);
    const safeUserId = String(userId);

    const searchResponse = await index.query({
      vector: queryVector,
      topK: 5,
      filter: { 
        chatId: safeChatId,
        userId: safeUserId
      }, 
      includeMetadata: true
    });

    console.log(`🔎 Query for Chat [${safeChatId}] User [${safeUserId}] found ${searchResponse.matches.length} matches.`);

    if (searchResponse.matches.length === 0) return "";

    return searchResponse.matches
      .map(match => match.metadata.text)
      .join("\n\n---\n\n");

  } catch (error) {
    console.error("Retrieval Error:", error);
    return "";
  }
}

module.exports = { storeDocument, getContext };