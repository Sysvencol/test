import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { streamText } from 'ai';
import { createClient } from '@libsql/client';
import { GoogleGenerativeAI } from '@google/generative-ai';

// 1. Configuración de GEMINI (Para la respuesta final compleja)
const google = createGoogleGenerativeAI({
    apiKey: process.env.GOOGLE_API_KEY,
});



export const dynamic = 'force-dynamic';

export async function POST(req) {
    try {
        if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN || !process.env.GOOGLE_API_KEY) {
            throw new Error("Faltan variables de entorno.");
        }

        const { messages } = await req.json();
        const lastMessage = messages[messages.length - 1].content;

        // --- PASO 1: BÚSQUEDA (Sin Router - Directo) ---
        let searchQuery = lastMessage;

        // --- PASO 2: BÚSQUEDA (RAG) ---
        let context = "";

        if (searchQuery) {
            // Embeddings: Esto sí usa Google, pero es una llamada muy ligera y barata
            const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
            const modelEmbedding = genAI.getGenerativeModel({ model: "text-embedding-004" });

            const embeddingResult = await modelEmbedding.embedContent(searchQuery);
            const vector = embeddingResult.embedding.values;

            const turso = createClient({
                url: process.env.TURSO_DATABASE_URL,
                authToken: process.env.TURSO_AUTH_TOKEN,
            });

            const results = await turso.execute({
                sql: `
                SELECT content, page_number 
                FROM catalogo_embeddings 
                ORDER BY vector_distance_cos(embedding, vector(?)) ASC 
                LIMIT 3
                `,
                args: [JSON.stringify(vector)]
            });

            if (results.rows.length > 0) {
                context = results.rows.map(row =>
                    `[Página ${row.page_number}]: ${row.content}`
                ).join('\n\n');
            }
        }

        // --- PASO 3: RESPUESTA FINAL CON GEMINI ---

        const systemPrompt = `
        Eres un asistente útil.
        
        DATOS DEL CATÁLOGO:
        ${context ? context : "No se requiere catálogo."}
        
        INSTRUCCIONES:
        1. Responde al usuario usando los datos del catálogo si existen.
        2. Si citas un producto, añade el enlace: [Ver PDF](https://sysvencol.com/Catalogo.pdf#page=NUMERO)
        3. Sé amable y directo.
        `;

        // Aquí usamos Gemini Flash (o Lite si prefieres)
        const result = await streamText({
            model: google('gemini-2.5-flash-lite'),
            system: systemPrompt,
            messages: messages, // Pasamos todo el historial para mantener la conversación
        });

        return result.toTextStreamResponse();

    } catch (error) {
        console.error("API Error:", error);
        return Response.json({ error: "Error en el servidor de IA." }, { status: 500 });
    }
}