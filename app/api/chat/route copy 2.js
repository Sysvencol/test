import { createGroq } from '@ai-sdk/groq';
import { streamText, generateText } from 'ai';
import { createClient } from '@libsql/client';
import { GoogleGenerativeAI } from '@google/generative-ai';

const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });
export const dynamic = 'force-dynamic';

export async function POST(req) {
    try {
        const { messages } = await req.json();
        const lastUserMessage = messages.filter(m => m.role === 'user').pop()?.content || "";

        console.log("\n==================== MONITOREO SYSVEN ====================");
        console.log("📩 ENTRADA USUARIO:", lastUserMessage);

        // --- PASO 1: ROUTER TÉCNICO ---
        let searchQuery = null;
        const { text: routerOutput } = await generateText({
            model: groq('llama-3.1-8b-instant'),
            messages: [
                {
                    role: 'system',
                    content: `Eres el Router técnico de SYSVENCOL. 
                    - Si detectas "Packer" o "Empacadura", responde ÚNICAMENTE: "ÍNDICE GENERAL PRODUCTOS".
                    - Si pide un producto específico, usa su nombre.
                    - Solo responde NO_SEARCH si es charla trivial sin relación a herramientas.`
                },
                ...messages.slice(-3)
            ],
        });

        const cleanRouter = routerOutput.trim().toUpperCase();
        console.log("⚡ ANÁLISIS ROUTER (RAW):", cleanRouter);

        if (cleanRouter !== "NO_SEARCH" && !cleanRouter.includes("LO SIENTO")) {
            searchQuery = cleanRouter;
        }

        // --- PASO 2: DB Y LIMPIEZA ---
        let context = "";
        if (searchQuery) {
            console.log("🔍 BUSCANDO EN TURSO:", searchQuery);
            const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
            const modelEmbedding = genAI.getGenerativeModel({ model: "text-embedding-004" });
            const embeddingResult = await modelEmbedding.embedContent(searchQuery);
            const vector = embeddingResult.embedding.values;

            const turso = createClient({
                url: process.env.TURSO_DATABASE_URL,
                authToken: process.env.TURSO_AUTH_TOKEN
            });

            const results = await turso.execute({
                sql: `SELECT content, page_number FROM catalogo_embeddings 
                      ORDER BY vector_distance_cos(embedding, vector(?)) ASC LIMIT 5`,
                args: [JSON.stringify(vector)]
            });

            console.log(`📊 DB ENCONTRÓ: ${results.rows.length} filas.`);

            if (results.rows.length > 0) {
                context = results.rows.map(row => {
                    console.log(`   📂 Procesando Pág ${row.page_number}`);
                    if (row.page_number === 4) {
                        return `[Pág 4 - ÍNDICE]: ${row.content.replace(/\.+/g, '')}`;
                    }
                    const cleanContent = row.content.split('\n').filter(line => {
                        const l = line.trim();
                        const isTableData = /(\d+\.?\d*(\s+)){3,}/.test(l);
                        return l.length > 4 && !isTableData;
                    }).join(' ').replace(/\s+/g, ' ');
                    return `[Pág ${row.page_number}]: ${cleanContent}`;
                }).join('\n\n');
            }
        }

        // --- PASO 3: ASISTENTE ---
        const systemPrompt = `Eres Sysven de SYSVENCOL. Fuente: CONTEXTO DEL CATÁLOGO.
        REGLAS:
        Siempre antes de mostrar lo que pidio el usuario di algo como: "Aquí tienes la información que solicitaste:" y luego muestra la información.
        1. LISTA COMPLETA: Si tienes el ÍNDICE en el contexto, DEBES listar CADA producto mencionado allí. No te detengas en el primero. (A menos de que el producto no tenga que ver con la respuesta)
        2. FORMATO HTML: <p><strong>- NOMBRE</strong>. (<a href="https://sysvencol.com/Catalogo.pdf#page=N" target="_blank">Ver</a>)</p>
        3. ETIQUETAS: Usa siempre <strong> en minúsculas. Prohibido <Strong>.
        4. HTML PERMITIDO: Solo <p>, <strong>, <a>.
        
        CONTEXTO: ${context || "VACÍO"}`;

        console.log("🤖 GENERANDO RESPUESTA FINAL...");
        const result = await streamText({
            model: groq('llama-3.1-8b-instant'),
            messages: [{ role: 'system', content: systemPrompt }, ...messages.slice(-4)],
            onFinish: ({ text }) => {
                console.log("🤖 AI RESPONDIÓ:", text);
                console.log("========================================================\n");
            }
        });

        return result.toTextStreamResponse();

    } catch (error) {
        console.error("❌ ERROR:", error);
        return Response.json({ error: error.message }, { status: 500 });
    }
}