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

        // --- PASO 1: ROUTER ---
        const { text: routerOutput } = await generateText({
            model: groq('llama-3.1-8b-instant'),
            messages: [
                {
                    role: 'system',
                    content: `Eres el Router técnico de SYSVENCOL. 
                    - Si detectas "Packer", "Empacadura", "Lista", "Colgadores/Liner Hanger", "Valvulas", "Tapones", responde: "ÍNDICE GENERAL PRODUCTOS".
                    - Solo responde keywords o NO_SEARCH.
                    - Si es servicio devuelve el indice pero en la pagina 5
                    `
                },
                ...messages.slice(-3)
            ],
        });

        const cleanRouter = routerOutput.trim().toUpperCase();
        console.log("⚡ ANÁLISIS ROUTER (RAW):", cleanRouter);

        let context = "";
        if (!cleanRouter.includes("NO_SEARCH")) {
            const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
            const modelEmbedding = genAI.getGenerativeModel({ model: "text-embedding-004" });
            const embeddingResult = await modelEmbedding.embedContent(cleanRouter);
            const turso = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

            const isIndexSearch = /ÍNDICE|INDICE|GENERAL/.test(cleanRouter);
            const sqlLimit = isIndexSearch ? 3 : 5;

            const results = await turso.execute({
                sql: `SELECT content, page_number FROM catalogo_embeddings 
                      ORDER BY vector_distance_cos(embedding, vector(?)) ASC LIMIT ${sqlLimit}`,
                args: [JSON.stringify(embeddingResult.embedding.values)]
            });

            if (results.rows.length > 0) {
                context = results.rows.map(row => {
                    if (row.page_number === 4 || row.page_number === 5) {
                        return `[ÍNDICE]: ${row.content.replace(/\.+/g, ' ')}`;
                    }
                    return `[DETALLE Pág ${row.page_number}]: ${row.content.substring(0, 1000)}`;
                }).join('\n\n');
            }
        }

        // --- PASO 3: ASISTENTE (LISTA OBLIGATORIA) ---
        const systemPrompt = `Eres Sysven de SYSVENCOL.
        REGLAS DE ORO:
        1. INTRODUCCIÓN: Empieza SOLO con "Hola, un gusto saludarte. Aquí tienes la lista de productos relacionados con tu búsqueda:".
        2. FORMATO DE LISTA: Todo debe ser una lista. No escribas párrafos largos de descripción. (Liner Hanger o Colgadores no son Packers ni Empacaduras, asi que no muestres si no lo piden)
        3. ESTRUCTURA POR ITEM: <p>- <strong>NOMBRE COMPLETO DEL PRODUCTO</strong>. (<a href="https://sysvencol.com/Catalogo.pdf#page=N" target="_blank">Ver</a>)</p>
        "N" debe ser el número de página real.
        4. FILTRO: Si el usuario pidió "Colgadores", solo lista los productos que sean colgadores / liner hangers. 
        5. HTML: Solo <p>, <strong>, <a> en minúsculas.
        6. CIERRE: "<p>Contamos con más soluciones en nuestro catálogo completo.</p>".
        
        CONTEXTO: ${context || "VACÍO"}`;

        const result = await streamText({
            model: groq('llama-3.1-8b-instant'),
            messages: [{ role: 'system', content: systemPrompt }, ...messages.slice(-4)],
            onFinish: ({ text }) => {
                console.log("🤖 RESPUESTA FINAL ENVIADA.");
                console.log("========================================================\n");
            }
        });

        return result.toTextStreamResponse();

    } catch (error) {
        console.error("❌ ERROR:", error);
        return Response.json({ error: error.message }, { status: 500 });
    }
}