import fs from 'fs';
import { createRequire } from 'module';
import { createClient } from '@libsql/client';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

const require = createRequire(import.meta.url);
let pdfParseLib = require('pdf-parse');

// LOGGING LIBRARY STRUCTURE
fs.writeFileSync('reindex_log.txt', "Starting investigation...\n");
fs.appendFileSync('reindex_log.txt', `Lib type: ${typeof pdfParseLib}\n`);

let pdfParseFunc;
let PDFParseClass;

if (typeof pdfParseLib === 'function') {
    pdfParseFunc = pdfParseLib;
    fs.appendFileSync('reindex_log.txt', "Selected: Direct function\n");
} else if (pdfParseLib.default && typeof pdfParseLib.default === 'function') {
    pdfParseFunc = pdfParseLib.default;
    fs.appendFileSync('reindex_log.txt', "Selected: default export\n");
} else if (pdfParseLib.PDFParse) {
    PDFParseClass = pdfParseLib.PDFParse;
    fs.appendFileSync('reindex_log.txt', "Selected: named export Class PDFParse\n");
} else {
    fs.appendFileSync('reindex_log.txt', "Fallback: Using lib object as is\n");
    pdfParseFunc = pdfParseLib;
}

// --- CONFIGURACIÓN ---
const PDF_PATH = './Catalogo.pdf';
const TABLE_NAME = 'catalogo_embeddings_v2'; // NEW TABLE V2

// 1. Inicializar clientes
let turso, genAI, model;

try {
    console.log("Initializing clients...");
    turso = createClient({
        url: process.env.TURSO_DATABASE_URL,
        authToken: process.env.TURSO_AUTH_TOKEN,
    });

    genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
    model = genAI.getGenerativeModel({ model: "models/gemini-embedding-001" });
    console.log("Clients initialized.");
} catch (e) {
    console.error("Client Init Error:", e);
    fs.appendFileSync('reindex_error.txt', `Client Init Error: ${e.message}\n`);
}

// --- FUNCIONES ---

async function setupDatabase() {
    console.log('🛠️  Creando tabla en Turso si no existe...');

    // Explicitly drop index first
    try {
        await turso.execute(`DROP INDEX IF EXISTS idx_catalogo_embedding_v2`);
    } catch (e) { console.log("Index drop warning:", e.message); }

    await turso.execute(`DROP TABLE IF EXISTS ${TABLE_NAME}`);

    // Create with 768 dimensions
    await turso.execute(`
    CREATE TABLE ${TABLE_NAME} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT,
      page_number INTEGER,
      embedding FLOAT32(768)
    );
    `);

    // Use NEW index name to avoid caching issues
    // MOVED TO END OF SCRIPT to allow data-based inference
    // await turso.execute(`
    // CREATE INDEX IF NOT EXISTS idx_catalogo_embedding_v2
    // ON ${TABLE_NAME} (libsql_vector_idx(embedding, 'dims=768'));
    // `);

    // VERIFY SCHEMA
    const schemaCheck = await turso.execute(`SELECT sql FROM sqlite_master WHERE name='${TABLE_NAME}'`);
    if (schemaCheck.rows.length > 0) {
        fs.appendFileSync('reindex_log.txt', `VERIFIED SCHEMA: ${schemaCheck.rows[0].sql}\n`);
    } else {
        fs.appendFileSync('reindex_log.txt', `VERIFIED SCHEMA: Table not found in master!\n`);
    }

    console.log('✅ Base de datos lista (Sin índice aún).');
}

async function processPDF() {
    console.log('📄 Leyendo PDF...');
    const dataBuffer = fs.readFileSync(PDF_PATH);
    let text = "";

    try {
        if (PDFParseClass) {
            console.log("Using PDFParse Class");
            fs.appendFileSync('reindex_log.txt', "Using Class instantiation method.\n");
            const parser = new PDFParseClass({ data: dataBuffer });
            const result = await parser.getText();
            text = result.text || "";
        } else {
            console.log("Using PDFParse Function");
            fs.appendFileSync('reindex_log.txt', "Using Function call method.\n");
            const pdfData = await pdfParseFunc(dataBuffer);
            text = pdfData.text || "";
        }
    } catch (e) {
        fs.appendFileSync('reindex_error.txt', `PDF Parsing failed: ${e.message}\n`);
        throw e;
    }

    console.log(`📜 Texto extraído. Longitud total: ${text.length} caracteres.`);

    const chunks = [];
    const chunkSize = 1000;
    const overlap = 100;

    for (let i = 0; i < text.length; i += (chunkSize - overlap)) {
        const chunkContent = text.substring(i, i + chunkSize).trim();
        if (chunkContent.length > 50) {
            chunks.push({
                page: Math.floor(i / chunkSize) + 1,
                content: chunkContent
            });
        }
    }

    console.log(`📚 Se generaron ${chunks.length} fragmentos de contenido.`);
    return chunks;
}

async function generateEmbedding(text) {
    const cleanText = text.replace(/\s+/g, ' ').substring(0, 8000);
    try {
        const result = await model.embedContent(cleanText);
        return result.embedding.values;
    } catch (err) {
        console.log('ERROR ❌', err.message);
        fs.appendFileSync('reindex_error.txt', `Processing Error: ${err.message}\n${err.stack}\n`);
        throw err;
    }
}

async function main() {
    try {
        fs.appendFileSync('reindex_log.txt', "Starting reindex main()...\n");
        await setupDatabase();
        fs.appendFileSync('reindex_log.txt', "Database setup complete.\n");

        const chunks = await processPDF();
        fs.appendFileSync('reindex_log.txt', `PDF processed. ${chunks.length} chunks.\n`);

        console.log('🧠 Generando vectores y guardando en Turso...');

        for (const chunk of chunks) {
            process.stdout.write(`   Procesando fragmento ${chunk.page}... `);
            fs.appendFileSync('reindex_log.txt', `Processing chunk ${chunk.page}...\n`);

            try {
                const vector = await generateEmbedding(chunk.content);
                console.log(`Vector Length: ${vector.length}`); // Verify dimension

                await turso.execute({
                    sql: `INSERT INTO ${TABLE_NAME} (content, page_number, embedding) VALUES (?, ?, vector(?))`,
                    args: [chunk.content, chunk.page, JSON.stringify(vector)]
                });

                console.log('OK ✅');
            } catch (err) {
                console.log('ERROR ❌', err.message);
                fs.appendFileSync('reindex_error.txt', `Row Error: ${err.message}\n`);
            }

            // Rate limiting
            await new Promise(r => setTimeout(r, 1000));
        }

        console.log('🔨 Creando índice vectorial...');
        await turso.execute(`
            CREATE INDEX IF NOT EXISTS idx_catalogo_embedding_v2
            ON ${TABLE_NAME} (libsql_vector_idx(embedding));
        `);

        console.log('\n🚀 ¡Reindexación completada!');
        fs.appendFileSync('reindex_log.txt', "Reindex complete.\n");

    } catch (error) {
        console.error('Fatal error:', error);
        fs.appendFileSync('reindex_error.txt', `Fatal Error: ${error.message}\n${error.stack}\n`);
    }
}

main();
