'use client'; // Importante: esto corre en el navegador

// import { useChat } from '@ai-sdk/react';
import { useRef, useEffect, useState } from 'react';

export default function ChatPage() {
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const messagesEndRef = useRef(null);

    // Auto-scroll hacia abajo cuando llega un mensaje nuevo
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    const handleInputChange = (e) => {
        setInput(e.target.value);
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!input.trim() || isLoading) return;

        const userMessage = { id: Date.now().toString(), role: 'user', content: input };
        setMessages(prev => [...prev, userMessage]);
        setInput('');
        setIsLoading(true);

        try {
            console.log("Sending message...", userMessage);
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: [...messages, userMessage] }),
            });

            if (!response.ok) {
                throw new Error(`Error: ${response.statusText}`);
            }

            if (!response.body) {
                throw new Error("No response body");
            }

            // Create placeholder for assistant message
            const assistantMessageId = (Date.now() + 1).toString();
            setMessages(prev => [...prev, { id: assistantMessageId, role: 'assistant', content: '' }]);

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let accumulatedResponse = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const text = decoder.decode(value, { stream: true });
                accumulatedResponse += text;

                setMessages(prev => prev.map(m =>
                    m.id === assistantMessageId
                        ? { ...m, content: accumulatedResponse }
                        : m
                ));
            }
            console.log("Stream complete");

        } catch (error) {
            console.error("Chat error:", error);
            alert("Ocurrió un error al enviar el mensaje. Revisa la consola.");
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="flex flex-col h-screen max-w-2xl mx-auto p-4 bg-gray-50">

            {/* Header */}
            <div className="mb-4 p-4 bg-white rounded-lg shadow-sm border border-gray-200">
                <h1 className="text-xl font-bold text-gray-800">Asistente de Catálogo 🤖</h1>
                <p className="text-sm text-gray-500">Pregunta sobre nuestras herramientas y servicios.</p>
            </div>

            {/* Área de Mensajes */}
            <div className="flex-1 overflow-y-auto mb-4 space-y-4 pr-2">
                {messages.length === 0 && (
                    <div className="text-center text-gray-400 mt-20">
                        <p>¿En qué puedo ayudarte hoy?</p>
                        <p className="text-sm">Prueba: "¿Qué herramientas de monitoreo tenemos?"</p>
                    </div>
                )}

                {messages.map(m => (
                    <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`
              max-w-[85%] p-3 rounded-lg text-sm leading-relaxed
              ${m.role === 'user'
                                ? 'bg-blue-600 text-white rounded-br-none'
                                : 'bg-white border border-gray-200 text-gray-800 rounded-bl-none shadow-sm'}
            `}>
                            {/* Renderizamos saltos de línea y enlaces. Soportamos tanto HTML como Markdown simple para los links */}
                            <div
                                className="chat-content"
                                dangerouslySetInnerHTML={{
                                    __html: m.content
                                        .replace(/\n/g, '<br/>')
                                        .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" class="text-blue-500 hover:underline font-bold">$1</a>')
                                }}
                            />
                        </div>
                    </div>
                ))}

                {/* Indicador de carga */}
                {isLoading && (
                    <div className="flex justify-start">
                        <div className="bg-gray-200 p-3 rounded-lg rounded-bl-none animate-pulse">
                            <span className="text-xs text-gray-500">Pensando...</span>
                        </div>
                    </div>
                )}
                <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <form onSubmit={handleSubmit} className="flex gap-2">
                <input
                    className="flex-1 p-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-black"
                    value={input}
                    onChange={handleInputChange}
                    placeholder="Escribe tu pregunta..."
                    disabled={isLoading}
                />
                <button
                    type="submit"
                    disabled={isLoading}
                    className="bg-blue-600 text-white px-6 py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                    Enviar
                </button>
            </form>

        </div>
    );
}