import './globals.css'

export const metadata = {
    title: 'Asistente de Catálogo',
    description: 'Chatbot para consultar el catálogo de herramientas',
}

export default function RootLayout({ children }) {
    return (
        <html lang="es">
            <body>{children}</body>
        </html>
    )
}
