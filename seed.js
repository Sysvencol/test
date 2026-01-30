import fs from 'fs';
import { createClient } from '@libsql/client';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

dotenv.config();

// --- CONFIGURACIÓN ---
const PDF_PATH = './Catalogo.pdf';
const TABLE_NAME = 'catalogo_embeddings';

// 1. Inicializar clientes
const turso = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
});

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: "text-embedding-004" });

// --- FUNCIONES ---

async function setupDatabase() {
    console.log('🛠️  Creando tabla en Turso si no existe...');
    await turso.execute(`DROP TABLE IF EXISTS ${TABLE_NAME}`);
    await turso.execute(`
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT,
      page_number INTEGER,
      embedding FLOAT32(768)
    );
  `);

    await turso.execute(`
    CREATE INDEX IF NOT EXISTS idx_catalogo_embedding 
    ON ${TABLE_NAME} (libsql_vector_idx(embedding));
  `);
    console.log('✅ Base de datos lista.');
}

function cleanText(text) {
    if (!text) return "";
    // 1. Fix spaced out text (e.g. "T I T U L O" -> "TITULO")
    // Matches uppercase or lowercase letter followed by space, if followed by another letter+space or end of word.
    let cleaned = text.replace(/([a-zA-ZÁÉÍÓÚÑ])\s(?=[a-zA-ZÁÉÍÓÚÑ]\s|[a-zA-ZÁÉÍÓÚÑ]$)/g, '$1');

    // 2. Normalize spaces
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    return cleaned;
}

async function processPDF() {
    console.log('📄 Leyendo PDF con estrategia mejorada (Line Buckets + Dedupe)...');

    try {
        const dataBuffer = fs.readFileSync(PDF_PATH);
        const data = new Uint8Array(dataBuffer);

        const loadingTask = getDocument({
            data: data,
        });

        const doc = await loadingTask.promise;
        console.log(`📚 PDF cargado. Total páginas: ${doc.numPages}`);

        const pages = [];

        for (let i = 1; i <= doc.numPages; i++) {
            const page = await doc.getPage(i);
            const content = await page.getTextContent();

            // 1. Extract items with coordinates
            let items = content.items.map(item => ({
                str: item.str,
                x: item.transform[4],
                y: item.transform[5], // Y increases upwards from bottom
                w: item.width,
                h: item.height || item.transform[0] // fallback to font size approx
            }));

            // 2. Deduplication (Shadow detection)
            // Filter out items that are virtually identical in position and text to a previous item
            // We use a simple O(N^2) for page items (usually < 500 items, so it's fast enough)
            const uniqueItems = [];
            const used = new Set();

            for (let j = 0; j < items.length; j++) {
                if (used.has(j)) continue;
                uniqueItems.push(items[j]);
                used.add(j);

                for (let k = j + 1; k < items.length; k++) {
                    if (used.has(k)) continue;
                    const itemA = items[j];
                    const itemB = items[k];

                    // If text matches and is very close (< 2 units distance)
                    const dist = Math.hypot(itemA.x - itemB.x, itemA.y - itemB.y);
                    if (itemA.str === itemB.str && dist < 1.5) {
                        used.add(k); // Mark as duplicate/shadow
                    }
                }
            }
            items = uniqueItems;

            // 3. Group into lines (Bucket Sort by Y)
            // We group items that have similar Y (within a tolerance, e.g., height/2 or fixed value)
            const lines = [];
            const Y_TOLERANCE = 5;

            // Sort by Y descending first to process top-down
            items.sort((a, b) => b.y - a.y);

            let currentLine = [];
            let currentY = -Infinity;

            for (const item of items) {
                if (currentLine.length === 0) {
                    currentLine.push(item);
                    currentY = item.y;
                } else {
                    // Check if belongs to same line
                    if (Math.abs(item.y - currentY) < Y_TOLERANCE) {
                        currentLine.push(item);
                    } else {
                        // New line
                        lines.push(currentLine);
                        currentLine = [item];
                        currentY = item.y;
                    }
                }
            }
            if (currentLine.length > 0) lines.push(currentLine);

            // 4. Sort items within each line by X (Left to Right) and build string
            let pageText = '';

            for (const line of lines) {
                // Sort by X
                line.sort((a, b) => a.x - b.x);

                let lineText = '';
                let lastX = -100;
                let lastW = 0;

                for (const item of line) {
                    // Add space if distance from previous word is significant
                    // Heuristic: if gap > 2 * char_width (approx) or fixed value?
                    // Let's use a small fixed value for now, e.g. 5 units.
                    if (lastX > 0 && (item.x - (lastX + lastW)) > 5) {
                        lineText += ' ';
                    } else if (lastX > 0 && item.x > (lastX + lastW) && item.str.match(/^[A-Z]/)) {
                        // If it's a new Title-cased word, likely needs space even if close
                        lineText += ' ';
                    }

                    lineText += item.str;
                    lastX = item.x;
                    lastW = item.w;
                }

                // Add header/footer filter here? 
                // e.g. if lineText is just "www.example.com" or "Page X" we might skip it 
                // but let's keep it for now.

                pageText += lineText + '\n';
            }

            const finalContent = cleanText(pageText);

            if (finalContent.length > 20) { // Min length filter
                pages.push({
                    page: i,
                    content: finalContent
                });
            }
        }

        console.log(`✅ Se procesaron ${pages.length} páginas.`);
        return pages;

    } catch (e) {
        console.error("Error procesando PDF:", e);
        return [];
    }
}

async function generateEmbedding(text) {
    const cleanText = text.substring(0, 8000);
    const result = await model.embedContent(cleanText);
    return result.embedding.values;
}

async function main() {
    try {
        await setupDatabase();

        const pages = await processPDF();

        console.log('🧠 Generando vectores y guardando en Turso...');

        for (const page of pages) {
            process.stdout.write(`   Procesando pág ${page.page}... `);
            try {
                const vector = await generateEmbedding(page.content);
                await turso.execute({
                    sql: `INSERT INTO ${TABLE_NAME} (content, page_number, embedding) VALUES (?, ?, vector(?))`,
                    args: [page.content, page.page, JSON.stringify(vector)]
                });
                console.log('OK ✅');
            } catch (err) {
                console.log('ERROR ❌', err.message);
                if (err.message.includes('429')) {
                    console.log('Rate limit, esperando 10s...');
                    await new Promise(r => setTimeout(r, 10000));
                }
            }
            await new Promise(r => setTimeout(r, 1500));
        }

        console.log('\n🚀 ¡Todo listo! Tu catálogo ya está en la "mente" de la IA.');

    } catch (error) {
        console.error('Fatal error:', error);
    }
}

main();